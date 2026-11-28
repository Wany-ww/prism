//! PRISM 네이티브 엔진 (Python 확장 모듈 `prism_core`).
//!
//! - 저장: parquet 읽기/쓰기, 스키마 맞추기, 행 범위/선택 읽기, upsert 키 비교, CSV 내보내기
//! - 수집: 설비 로그 CSV 파서 (Parser 코드에서 prism.read_csv)
//! - 매칭: Match 노드의 키 정규화와 짝 찾기 (exact / asof)
//!
//! 사용자 Parser·노드 코드는 그대로 Python(pandas) 으로 실행되고, 이 모듈은 그 앞뒤의 무거운 부분만 맡는다.

mod convert;
mod csvread;
mod fmt;
mod frame;
mod keys;
mod matching;
mod pq;
mod types;

use std::path::PathBuf;
use std::sync::Arc;

use arrow_array::*;
use numpy::{PyArray1, PyReadonlyArray1};
use pyo3::exceptions::{PyIOError, PyKeyError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use rustc_hash::FxHashSet;

use frame::Frame;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn verr(e: String) -> PyErr {
    PyValueError::new_err(e)
}

fn ioerr(e: String) -> PyErr {
    PyIOError::new_err(e)
}

type PySchema = Vec<(String, String)>;

fn schema_to_py(s: &frame::Schema) -> PySchema {
    s.iter().map(|(n, t)| (n.clone(), types::type_name(t).to_string())).collect()
}

fn schema_from_py(s: &PySchema) -> frame::Schema {
    s.iter().map(|(n, t)| (n.clone(), types::type_from_name(t))).collect()
}

/// 열 단위 표 (pyarrow.Table 대신). 값은 Rust 쪽에만 있고 Python 에는 to_numpy() 로 꺼낼 때만 넘어간다.
#[pyclass(module = "prism_core", frozen)]
pub struct Table {
    inner: Frame,
}

impl Table {
    fn wrap(inner: Frame) -> Table {
        Table { inner }
    }
}

#[pymethods]
impl Table {
    /// payloads: [(종류, 값 배열, null 마스크|None)] — app/engine/native.py 의 column_payload 참고
    #[staticmethod]
    fn from_columns(py: Python<'_>, names: Vec<String>, payloads: Vec<(String, Bound<'_, PyAny>, Option<Bound<'_, PyAny>>)>, rows: usize) -> PyResult<Table> {
        if names.len() != payloads.len() {
            return Err(PyValueError::new_err("names and payloads differ in length"));
        }
        let mut cols = Vec::with_capacity(payloads.len());
        for (name, (kind, values, mask)) in names.iter().zip(payloads.iter()) {
            let arr = convert::array_from_py(py, kind, values, mask.as_ref(), rows)
                .map_err(|e| PyValueError::new_err(format!("column '{}': {}", name, e)))?;
            if arr.len() != rows {
                return Err(PyValueError::new_err(format!("column '{}' has {} rows, expected {}", name, arr.len(), rows)));
            }
            cols.push(arr);
        }
        Ok(Table::wrap(Frame::new(names, cols, rows)))
    }

    #[staticmethod]
    fn empty(schema: PySchema) -> Table {
        Table::wrap(Frame::empty(&schema_from_py(&schema)))
    }

    #[getter]
    fn num_rows(&self) -> usize {
        self.inner.rows
    }

    #[getter]
    fn num_columns(&self) -> usize {
        self.inner.names.len()
    }

    #[getter]
    fn column_names(&self) -> Vec<String> {
        self.inner.names.clone()
    }

    fn schema(&self) -> PySchema {
        schema_to_py(&self.inner.schema())
    }

    /// [(이름, 종류, numpy 배열)] — 종류: f64 / i64 / bool / ts(int64 us) / str / obj
    fn to_numpy<'py>(&self, py: Python<'py>) -> PyResult<Vec<(String, &'static str, Bound<'py, PyAny>)>> {
        let mut out = Vec::with_capacity(self.inner.cols.len());
        for (n, c) in self.inner.names.iter().zip(&self.inner.cols) {
            let (kind, arr) = convert::array_to_py(py, c)?;
            out.push((n.clone(), kind, arr));
        }
        Ok(out)
    }

    /// pandas 블록 단위로: [(종류, 배열, 컬럼 위치들)] — native.to_pandas 참고
    fn to_blocks<'py>(&self, py: Python<'py>) -> PyResult<Vec<(&'static str, Bound<'py, PyAny>, Vec<i64>)>> {
        convert::blocks_to_py(py, &self.inner.cols, self.inner.rows)
    }

    #[pyo3(signature = (path, row_group_size = 10_000))]
    fn write_parquet(&self, py: Python<'_>, path: PathBuf, row_group_size: usize) -> PyResult<()> {
        let f = &self.inner;
        py.detach(|| pq::write(f, &path, row_group_size)).map_err(ioerr)
    }

    fn slice(&self, offset: usize, length: usize) -> Table {
        Table::wrap(self.inner.slice(offset, length))
    }

    fn take(&self, py: Python<'_>, indices: PyReadonlyArray1<'_, i64>) -> PyResult<Table> {
        let n = self.inner.rows as i64;
        let view = indices.as_array();
        let mut idx = Vec::with_capacity(view.len());
        for &i in view.iter() {
            if i < 0 || i >= n {
                return Err(PyValueError::new_err(format!("row index {} out of range", i)));
            }
            idx.push(i as u64);
        }
        let idx = UInt64Array::from(idx);
        let f = &self.inner;
        py.detach(|| f.take(&idx)).map(Table::wrap).map_err(verr)
    }

    fn filter(&self, py: Python<'_>, mask: PyReadonlyArray1<'_, bool>) -> PyResult<Table> {
        let view = mask.as_array();
        if view.len() != self.inner.rows {
            return Err(PyValueError::new_err("mask length mismatch"));
        }
        let m = BooleanArray::from(view.to_vec());
        let f = &self.inner;
        py.detach(|| f.filter(&m)).map(Table::wrap).map_err(verr)
    }

    /// 있는 컬럼만 요청 순서대로 (없는 이름은 무시)
    fn select(&self, names: Vec<String>) -> Table {
        Table::wrap(self.inner.select(&names))
    }

    fn append_str(&self, name: String, value: &str) -> Table {
        let mut f = self.inner.clone();
        f.push(name, frame::const_str(value, f.rows));
        Table::wrap(f)
    }

    fn append_i64(&self, name: String, values: PyReadonlyArray1<'_, i64>) -> PyResult<Table> {
        let view = values.as_array();
        if view.len() != self.inner.rows {
            return Err(PyValueError::new_err("length mismatch"));
        }
        let mut f = self.inner.clone();
        f.push(name, Arc::new(Int64Array::from(view.to_vec())));
        Ok(Table::wrap(f))
    }

    /// schema 의 컬럼 순서·타입으로 (없는 컬럼은 null, 타입이 다르면 변환)
    fn conform(&self, py: Python<'_>, schema: PySchema) -> Table {
        let s = schema_from_py(&schema);
        let f = &self.inner;
        Table::wrap(py.detach(|| f.conform(&s)))
    }

    /// 헤더 없는 CSV (값만). 시각은 2026-11-24 10:00:00, 결측은 빈 칸.
    fn to_csv<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        let f = &self.inner;
        let bytes = py.detach(|| -> Result<Vec<u8>, String> {
            let mut w = csv::WriterBuilder::new().has_headers(false).quote_style(csv::QuoteStyle::Necessary).from_writer(Vec::new());
            for i in 0..f.rows {
                let rec: Vec<String> = f.cols.iter().map(|c| types::value_string(c, i).unwrap_or_default()).collect();
                w.write_record(&rec).map_err(|e| e.to_string())?;
            }
            w.into_inner().map_err(|e| e.to_string())
        });
        Ok(PyBytes::new(py, &bytes.map_err(verr)?))
    }

    /// upsert 키 집합 (예전 frames._key_strings 와 같은 키 표기)
    fn key_set(&self, keys: Vec<String>) -> PyResult<KeySet> {
        let cols = key_cols(&self.inner, &keys)?;
        Ok(KeySet { keys: keys::row_keys(&cols, self.inner.rows).into_iter().collect() })
    }

    /// 각 행의 키가 set 에 있는지
    fn key_hits<'py>(&self, py: Python<'py>, keys: Vec<String>, set: &KeySet) -> PyResult<Bound<'py, PyArray1<bool>>> {
        let cols = key_cols(&self.inner, &keys)?;
        let hits: Vec<bool> = keys::row_keys(&cols, self.inner.rows).iter().map(|k| set.keys.contains(k)).collect();
        Ok(PyArray1::from_vec(py, hits))
    }

    fn __len__(&self) -> usize {
        self.inner.rows
    }

    fn __repr__(&self) -> String {
        format!("prism_core.Table({} rows x {} columns)", self.inner.rows, self.inner.names.len())
    }
}

fn key_cols(f: &Frame, keys: &[String]) -> PyResult<Vec<ArrayRef>> {
    keys.iter()
        .map(|k| f.column(k).cloned().ok_or_else(|| PyKeyError::new_err(format!("key column '{}' does not exist", k))))
        .collect()
}

#[pyclass(module = "prism_core", frozen)]
pub struct KeySet {
    keys: FxHashSet<String>,
}

#[pymethods]
impl KeySet {
    fn __len__(&self) -> usize {
        self.keys.len()
    }
}

// ---------------- parquet ----------------

/// path 의 columns(없는 이름 무시, None=전체)를 읽음. since/until(마이크로초) 를 주면 ts_col 시각 범위 행만.
#[pyfunction]
#[pyo3(signature = (path, columns = None, since_us = None, until_us = None, ts_col = "_ts"))]
fn read_parquet(py: Python<'_>, path: PathBuf, columns: Option<Vec<String>>, since_us: Option<i64>, until_us: Option<i64>, ts_col: &str) -> PyResult<Table> {
    py.detach(|| pq::read_filtered(&path, columns.as_deref(), ts_col, since_us, until_us)).map(Table::wrap).map_err(ioerr)
}

/// 파일 안 행 번호(오름차순)들만 읽음 (필요한 row group 만)
#[pyfunction]
#[pyo3(signature = (path, indices, columns = None))]
fn read_rows(py: Python<'_>, path: PathBuf, indices: PyReadonlyArray1<'_, i64>, columns: Option<Vec<String>>) -> PyResult<Table> {
    let idx = indices.as_array().to_vec();
    if idx.is_empty() {
        let f = py.detach(|| pq::Opened::open(&path)).map_err(ioerr)?;
        let s = f.schema();
        let wanted: frame::Schema = match &columns {
            None => s,
            Some(c) => c.iter().filter_map(|n| s.iter().find(|(x, _)| x == n).cloned()).collect(),
        };
        return Ok(Table::wrap(Frame::empty(&wanted)));
    }
    py.detach(|| pq::Opened::open(&path)?.read_rows(&idx, columns.as_deref())).map(Table::wrap).map_err(ioerr)
}

/// 여러 parquet 를 schema 로 맞춰 이어 붙임 (schema=None 이면 파일들의 스키마를 합친 것)
#[pyfunction]
#[pyo3(signature = (paths, schema = None, columns = None))]
fn read_tables(py: Python<'_>, paths: Vec<PathBuf>, schema: Option<PySchema>, columns: Option<Vec<String>>) -> PyResult<Table> {
    py.detach(|| -> Result<Frame, String> {
        if paths.is_empty() {
            return Ok(Frame::default());
        }
        let opened: Vec<pq::Opened> = paths.iter().map(|p| pq::Opened::open(p)).collect::<Result<_, _>>()?;
        let full = match &schema {
            Some(s) => schema_from_py(s),
            None => frame::unify_schemas(&opened.iter().map(|o| o.schema()).collect::<Vec<_>>()),
        };
        let target: frame::Schema = match &columns {
            None => full,
            Some(c) => {
                let mut seen = FxHashSet::default();
                c.iter().filter(|n| seen.insert(n.as_str())).filter_map(|n| full.iter().find(|(x, _)| x == n).cloned()).collect()
            }
        };
        let names: Vec<String> = target.iter().map(|(n, _)| n.clone()).collect();
        let mut frames = Vec::with_capacity(opened.len());
        for o in &opened {
            frames.push(o.read(Some(&names), None, None)?.conform(&target));
        }
        frame::concat_frames(&frames)
    })
    .map(Table::wrap)
    .map_err(ioerr)
}

#[pyfunction]
fn read_schema(py: Python<'_>, path: PathBuf) -> PyResult<PySchema> {
    py.detach(|| pq::Opened::open(&path).map(|o| schema_to_py(&o.schema()))).map_err(ioerr)
}

/// (전체 행 수, row group 별 행 수)
#[pyfunction]
fn parquet_info(py: Python<'_>, path: PathBuf) -> PyResult<(usize, Vec<usize>)> {
    py.detach(|| pq::Opened::open(&path).map(|o| (o.num_rows(), o.row_group_rows()))).map_err(ioerr)
}

#[pyfunction]
fn unify_schemas(schemas: Vec<PySchema>) -> PySchema {
    schema_to_py(&frame::unify_schemas(&schemas.iter().map(schema_from_py).collect::<Vec<_>>()))
}

#[pyfunction]
fn concat(py: Python<'_>, tables: Vec<PyRef<'_, Table>>) -> PyResult<Table> {
    let frames: Vec<Frame> = tables.iter().map(|t| t.inner.clone()).collect();
    py.detach(|| frame::concat_frames(&frames)).map(Table::wrap).map_err(verr)
}

/// parquet 를 row group 단위로 차례로 (큰 데이터셋 CSV 내보내기용)
#[pyclass(module = "prism_core", unsendable)]
pub struct ParquetBatches {
    file: pq::Opened,
    row_groups: Vec<usize>,
    next: usize,
}

#[pymethods]
impl ParquetBatches {
    #[new]
    fn new(path: PathBuf) -> PyResult<Self> {
        let file = pq::Opened::open(&path).map_err(ioerr)?;
        let row_groups = file.row_group_rows();
        Ok(ParquetBatches { file, row_groups, next: 0 })
    }

    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__(&mut self) -> PyResult<Option<Table>> {
        if self.next >= self.row_groups.len() {
            return Ok(None);
        }
        let g = self.next;
        self.next += 1;
        self.file.read(None, Some(vec![g]), None).map(|t| Some(Table::wrap(t))).map_err(ioerr)
    }
}

// ---------------- 매칭 ----------------

type KeyPayload<'py> = (String, Bound<'py, PyAny>, Option<Bound<'py, PyAny>>);

fn compose_keys(py: Python<'_>, cols: Vec<KeyPayload<'_>>, normalize: bool, upper: bool, side: char) -> PyResult<matching::Keys> {
    let mut strs = Vec::with_capacity(cols.len());
    let mut rows = None;
    for (kind, values, mask) in cols {
        let ks = keys::key_strings(py, &keys::KeyInput { kind, values, mask }, normalize, upper)?;
        if let Some(r) = rows {
            if r != ks.len() {
                return Err(PyValueError::new_err("key columns differ in length"));
            }
        }
        rows = Some(ks.len());
        strs.push(ks);
    }
    Ok(matching::compose(strs, rows.unwrap_or(0), side))
}

/// Match 노드 짝 찾기. 반환: (왼쪽 행 번호, 오른쪽 행 번호) int64 배열, 짝이 없으면 -1.
#[pyfunction]
#[pyo3(signature = (left, right, normalize = true, upper = false, how = "inner", strategy = "exact", duplicates = "all", left_time = None, right_time = None, tolerance_us = None))]
#[allow(clippy::too_many_arguments)]
fn match_pairs<'py>(
    py: Python<'py>,
    left: Vec<KeyPayload<'py>>,
    right: Vec<KeyPayload<'py>>,
    normalize: bool,
    upper: bool,
    how: &str,
    strategy: &str,
    duplicates: &str,
    left_time: Option<PyReadonlyArray1<'py, i64>>,
    right_time: Option<PyReadonlyArray1<'py, i64>>,
    tolerance_us: Option<i64>,
) -> PyResult<(Bound<'py, PyArray1<i64>>, Bound<'py, PyArray1<i64>>)> {
    if !matches!(how, "inner" | "left" | "right" | "outer") {
        return Err(PyValueError::new_err(format!("Unknown join type: {how}")));
    }
    let lk = compose_keys(py, left, normalize, upper, 'L')?;
    let rk = compose_keys(py, right, normalize, upper, 'R')?;
    let (li, ri) = if strategy == "exact" {
        py.detach(|| matching::exact(&lk, &rk, how, duplicates))
    } else {
        let direction = match strategy {
            "nearest_after" => "forward",
            "nearest_before" => "backward",
            "nearest" => "nearest",
            other => return Err(PyValueError::new_err(format!("Unknown match strategy: {other}"))),
        };
        let (Some(lt), Some(rt)) = (left_time, right_time) else {
            return Err(PyValueError::new_err("time columns are required for nearest matching"));
        };
        let lt = lt.as_array().to_vec();
        let rt = rt.as_array().to_vec();
        if lt.len() != lk.keys.len() || rt.len() != rk.keys.len() {
            return Err(PyValueError::new_err("time column length mismatch"));
        }
        let how = if how == "right" { "left" } else { how };
        py.detach(|| matching::asof(&lk, &rk, &lt, &rt, how, direction, tolerance_us))
    };
    Ok((PyArray1::from_vec(py, li), PyArray1::from_vec(py, ri)))
}

// ---------------- CSV ----------------

/// 설비 로그 CSV 를 읽어 (Table, meta) 로. meta_prefix 로 시작하는 줄은 'Key=Value' 메타 정보로 따로 모음.
#[pyfunction]
#[pyo3(signature = (path = None, text = None, encoding = "utf-8", sep = ",", skip_rows = 0, header = true, meta_prefix = None, comment = None, errors = "strict"))]
#[allow(clippy::too_many_arguments)]
fn read_csv(
    py: Python<'_>,
    path: Option<PathBuf>,
    text: Option<String>,
    encoding: &str,
    sep: &str,
    skip_rows: usize,
    header: bool,
    meta_prefix: Option<String>,
    comment: Option<String>,
    errors: &str,
) -> PyResult<(Table, Vec<(String, String)>)> {
    let sep_b = match sep.as_bytes() {
        [b] => *b,
        b"\\t" => b'\t',
        _ => return Err(PyValueError::new_err("sep must be a single character")),
    };
    let comment_b = match comment.as_deref().map(str::as_bytes) {
        None => None,
        Some([b]) => Some(*b),
        Some(_) => return Err(PyValueError::new_err("comment must be a single character")),
    };
    let opts = csvread::Options {
        encoding: encoding.to_string(),
        errors_replace: errors == "replace",
        sep: sep_b,
        skip_rows,
        header,
        meta_prefix,
        comment: comment_b,
    };
    let parsed = py.detach(|| -> Result<csvread::Parsed, String> {
        let owned;
        let body: &str = match (&path, &text) {
            (_, Some(t)) => t,
            (Some(p), None) => {
                let t0 = std::time::Instant::now();
                let bytes = std::fs::read(p).map_err(|e| format!("{}: {}", p.display(), e))?;
                owned = csvread::decode(bytes, &opts.encoding, opts.errors_replace)?;
                if std::env::var_os("PRISM_TRACE").is_some() {
                    eprintln!("csv: read+decode {:?}", t0.elapsed());
                }
                &owned
            }
            (None, None) => return Err("path or text is required".into()),
        };
        csvread::parse(body, &opts)
    });
    let parsed = parsed.map_err(verr)?;
    Ok((Table::wrap(parsed.frame), parsed.meta))
}

#[pyfunction]
fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[pymodule]
fn prism_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Table>()?;
    m.add_class::<KeySet>()?;
    m.add_class::<ParquetBatches>()?;
    m.add_function(wrap_pyfunction!(read_parquet, m)?)?;
    m.add_function(wrap_pyfunction!(read_rows, m)?)?;
    m.add_function(wrap_pyfunction!(read_tables, m)?)?;
    m.add_function(wrap_pyfunction!(read_schema, m)?)?;
    m.add_function(wrap_pyfunction!(parquet_info, m)?)?;
    m.add_function(wrap_pyfunction!(unify_schemas, m)?)?;
    m.add_function(wrap_pyfunction!(concat, m)?)?;
    m.add_function(wrap_pyfunction!(match_pairs, m)?)?;
    m.add_function(wrap_pyfunction!(read_csv, m)?)?;
    m.add_function(wrap_pyfunction!(version, m)?)?;
    Ok(())
}
