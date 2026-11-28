//! parquet 읽기/쓰기. 컬럼이 수천 개인 넓은 데이터를 위해 컬럼 묶음 단위로 여러 스레드에서 동시에 인코딩/디코딩한다.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::TimestampMicrosecondType;
use arrow_array::*;
use arrow_schema::{DataType, Field, Schema as ArrowSchema};
use arrow_select::concat::concat;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder, RowSelection};
use parquet::arrow::arrow_writer::{compute_leaves, ArrowColumnChunk, ArrowRowGroupWriterFactory};
use parquet::arrow::{ArrowSchemaConverter, ProjectionMask};
use parquet::basic::Compression;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::types::ColumnPath;
use rayon::prelude::*;

use crate::frame::{Frame, Schema};
use crate::types;

pub type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------- 쓰기 ----------------

pub fn write(frame: &Frame, path: &Path, row_group: usize) -> Res<()> {
    let row_group = row_group.max(1);
    let fields: Vec<Field> =
        frame.names.iter().zip(&frame.cols).map(|(n, c)| Field::new(n, c.data_type().clone(), true)).collect();
    let schema = Arc::new(ArrowSchema::new(fields.clone()));
    // 사전(dictionary) 인코딩은 문자열 컬럼에만: 수치 컬럼까지 하면 넓은 표에서 쓰기가 느려지고 파일도 커짐
    let mut props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_dictionary_enabled(false)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_max_row_group_row_count(Some(row_group));
    for (n, c) in frame.names.iter().zip(&frame.cols) {
        if c.data_type() == &DataType::Utf8 {
            props = props.set_column_dictionary_enabled(ColumnPath::from(n.as_str()), true);
        }
    }
    let props = Arc::new(props.build());
    let parquet_schema = ArrowSchemaConverter::new().with_coerce_types(props.coerce_types()).convert(&schema).map_err(err)?;
    let file = File::create(path).map_err(err)?;
    let mut writer =
        SerializedFileWriter::new(BufWriter::with_capacity(1 << 20, file), parquet_schema.root_schema_ptr(), props.clone()).map_err(err)?;
    let factory = ArrowRowGroupWriterFactory::try_new(&writer, schema.clone()).map_err(err)?;
    let trace = std::env::var_os("PRISM_TRACE").is_some();
    let t0 = std::time::Instant::now();
    let mut start = 0;
    let mut rg_index = 0;
    while start < frame.rows {
        let len = row_group.min(frame.rows - start);
        let t1 = std::time::Instant::now();
        let writers = factory.create_column_writers(rg_index).map_err(err)?;
        if trace {
            eprintln!("rg{rg_index}: writers {:?}", t1.elapsed());
        }
        let t1 = std::time::Instant::now();
        let chunks: Res<Vec<ArrowColumnChunk>> = writers
            .into_par_iter()
            .zip(frame.cols.par_iter().zip(fields.par_iter()))
            .map(|(mut w, (col, field))| {
                let arr = col.slice(start, len);
                for leaf in compute_leaves(field, &arr).map_err(err)? {
                    w.write(&leaf).map_err(err)?;
                }
                w.close().map_err(err)
            })
            .collect();
        if trace {
            eprintln!("rg{rg_index}: encode {:?}", t1.elapsed());
        }
        let t1 = std::time::Instant::now();
        let mut rg = writer.next_row_group().map_err(err)?;
        for chunk in chunks? {
            chunk.append_to_row_group(&mut rg).map_err(err)?;
        }
        rg.close().map_err(err)?;
        if trace {
            eprintln!("rg{rg_index}: append {:?}", t1.elapsed());
        }
        start += len;
        rg_index += 1;
    }
    let t1 = std::time::Instant::now();
    writer.close().map_err(err)?;
    if trace {
        eprintln!("close {:?} total {:?}", t1.elapsed(), t0.elapsed());
    }
    Ok(())
}

// ---------------- 읽기 ----------------

pub struct Opened {
    path: std::path::PathBuf,
    meta: ArrowReaderMetadata,
}

impl Opened {
    pub fn open(path: &Path) -> Res<Opened> {
        let file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let meta = ArrowReaderMetadata::load(&file, ArrowReaderOptions::new()).map_err(|e| format!("{}: {}", path.display(), e))?;
        Ok(Opened { path: path.to_path_buf(), meta })
    }

    pub fn names(&self) -> Vec<String> {
        self.meta.schema().fields().iter().map(|f| f.name().clone()).collect()
    }

    /// 표준 타입으로 바꾼 스키마 (읽을 때 바뀌는 타입과 같게)
    pub fn schema(&self) -> Schema {
        self.meta
            .schema()
            .fields()
            .iter()
            .map(|f| (f.name().clone(), canonical(f.data_type())))
            .collect()
    }

    pub fn num_rows(&self) -> usize {
        self.meta.metadata().file_metadata().num_rows().max(0) as usize
    }

    pub fn row_group_rows(&self) -> Vec<usize> {
        self.meta.metadata().row_groups().iter().map(|r| r.num_rows().max(0) as usize).collect()
    }

    fn indices(&self, columns: Option<&[String]>) -> Vec<usize> {
        let names = self.names();
        match columns {
            None => (0..names.len()).collect(),
            Some(cols) => {
                let pos: HashMap<&str, usize> =
                    names.iter().enumerate().rev().map(|(i, n)| (n.as_str(), i)).collect();
                let mut seen = std::collections::HashSet::new();
                cols.iter().filter_map(|c| pos.get(c.as_str()).copied()).filter(|i| seen.insert(*i)).collect()
            }
        }
    }

    /// columns(없는 이름 무시) 를 row_groups 범위에서, selection 행만 읽음. 결과 컬럼 순서는 columns 순서.
    pub fn read(&self, columns: Option<&[String]>, row_groups: Option<Vec<usize>>, selection: Option<&BooleanArray>) -> Res<Frame> {
        let wanted = self.indices(columns);
        let all_rows: usize = match &row_groups {
            Some(rgs) => {
                let sizes = self.row_group_rows();
                rgs.iter().map(|i| sizes[*i]).sum()
            }
            None => self.num_rows(),
        };
        let rows = selection.map(|m| m.true_count()).unwrap_or(all_rows);
        let names = self.names();
        if wanted.is_empty() {
            return Ok(Frame::new(vec![], vec![], rows));
        }
        let mut sorted = wanted.clone();
        sorted.sort_unstable();
        // 스레드 수만큼 컬럼을 나눠 각자 파일을 열고 같은 메타데이터로 읽음 (메타데이터 해석은 한 번만)
        let threads = rayon::current_num_threads().max(1);
        let chunk = sorted.len().div_ceil(threads).max(16);
        let parts: Res<Vec<Vec<(usize, ArrayRef)>>> = sorted
            .par_chunks(chunk)
            .map(|idx| {
                let file = File::open(&self.path).map_err(err)?;
                let mut b = ParquetRecordBatchReaderBuilder::new_with_metadata(file, self.meta.clone())
                    .with_projection(ProjectionMask::roots(self.meta.parquet_schema(), idx.iter().copied()))
                    .with_batch_size(rows.clamp(1, 1 << 20));
                if let Some(rgs) = &row_groups {
                    b = b.with_row_groups(rgs.clone());
                }
                if let Some(mask) = selection {
                    b = b.with_row_selection(RowSelection::from_filters(&[mask.clone()]));
                }
                let reader = b.build().map_err(err)?;
                let batches: Vec<RecordBatch> = reader.collect::<Result<_, _>>().map_err(err)?;
                let mut out = Vec::with_capacity(idx.len());
                for (j, i) in idx.iter().enumerate() {
                    let arr = if batches.len() == 1 {
                        batches[0].column(j).clone()
                    } else if batches.is_empty() {
                        new_null_array(self.meta.schema().field(*i).data_type(), 0)
                    } else {
                        let refs: Vec<&dyn Array> = batches.iter().map(|b| b.column(j).as_ref()).collect();
                        concat(&refs).map_err(err)?
                    };
                    out.push((*i, types::normalize(&arr)));
                }
                Ok(out)
            })
            .collect();
        let mut by_index: HashMap<usize, ArrayRef> = parts?.into_iter().flatten().collect();
        let cols: Vec<ArrayRef> = wanted.iter().map(|i| by_index.remove(i).unwrap()).collect();
        let out_names = wanted.iter().map(|i| names[*i].clone()).collect();
        Ok(Frame::new(out_names, cols, rows))
    }

    /// 파일 안 행 번호(오름차순) 들만, 해당 row group 만 읽음
    pub fn read_rows(&self, idx: &[i64], columns: Option<&[String]>) -> Res<Frame> {
        let sizes = self.row_group_rows();
        let mut starts = Vec::with_capacity(sizes.len() + 1);
        let mut acc = 0usize;
        starts.push(0);
        for s in &sizes {
            acc += s;
            starts.push(acc);
        }
        let mut rgs: Vec<usize> = Vec::new();
        for &r in idx {
            if r < 0 || r as usize >= acc {
                return Err(format!("row {} out of range", r));
            }
            let g = starts.partition_point(|s| *s <= r as usize) - 1;
            if rgs.last() != Some(&g) && !rgs.contains(&g) {
                rgs.push(g);
            }
        }
        rgs.sort_unstable();
        // 선택한 row group 들을 이은 위치 기준으로 행 마스크
        let mut offset_of = HashMap::new();
        let mut total = 0usize;
        for g in &rgs {
            offset_of.insert(*g, total);
            total += sizes[*g];
        }
        let mut mask = vec![false; total];
        for &r in idx {
            let r = r as usize;
            let g = starts.partition_point(|s| *s <= r) - 1;
            mask[offset_of[&g] + (r - starts[g])] = true;
        }
        let mask = BooleanArray::from(mask);
        self.read(columns, Some(rgs), Some(&mask))
    }
}

pub fn canonical(t: &DataType) -> DataType {
    use DataType::*;
    match t {
        Null | Boolean | Int64 | Float64 | Utf8 => t.clone(),
        Timestamp(_, _) | Date32 | Date64 => types::ts_type(),
        Int8 | Int16 | Int32 | UInt8 | UInt16 | UInt32 | UInt64 => Int64,
        Float16 | Float32 | Decimal32(..) | Decimal64(..) | Decimal128(..) | Decimal256(..) => Float64,
        Dictionary(_, v) => canonical(v),
        _ => Utf8,
    }
}

/// 시각 컬럼이 [since, until] 안인 행만 (시각 컬럼이 없으면 전체). 해당 행이 없으면 다른 컬럼은 읽지도 않음.
pub fn read_filtered(path: &Path, columns: Option<&[String]>, ts_col: &str, since: Option<i64>, until: Option<i64>) -> Res<Frame> {
    let f = Opened::open(path)?;
    let has_ts = f.names().iter().any(|n| n == ts_col);
    let cols = columns;
    if !has_ts || (since.is_none() && until.is_none()) {
        return f.read(cols, None, None);
    }
    let ts = f.read(Some(&[ts_col.to_string()]), None, None)?;
    let arr = ts.cols[0].clone();
    if !matches!(arr.data_type(), DataType::Timestamp(..)) {
        return f.read(cols, None, None);
    }
    let t = arr.as_primitive::<TimestampMicrosecondType>();
    let mask: BooleanArray = (0..t.len())
        .map(|i| {
            Some(
                t.is_valid(i)
                    && since.map(|s| t.value(i) >= s).unwrap_or(true)
                    && until.map(|u| t.value(i) <= u).unwrap_or(true),
            )
        })
        .collect();
    let n = mask.true_count();
    if n == t.len() {
        return f.read(cols, None, None);
    }
    if n == 0 {
        let schema: Schema = f.schema();
        let wanted: Schema = match cols {
            None => schema,
            Some(c) => c.iter().filter_map(|n| schema.iter().find(|(s, _)| s == n).cloned()).collect(),
        };
        return Ok(Frame::empty(&wanted));
    }
    f.read(cols, None, Some(&mask))
}
