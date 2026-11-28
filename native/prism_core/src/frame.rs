//! 열 단위 표 (이름 + Arrow 배열). pyarrow.Table 대신 쓰는 최소한의 표 구조.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::*;
use arrow_schema::DataType;
use arrow_select::concat::concat;
use rayon::prelude::*;

use crate::types;

pub type Schema = Vec<(String, DataType)>;

#[derive(Clone, Default)]
pub struct Frame {
    pub names: Vec<String>,
    pub cols: Vec<ArrayRef>,
    pub rows: usize,
}

impl Frame {
    pub fn new(names: Vec<String>, cols: Vec<ArrayRef>, rows: usize) -> Self {
        Frame { names, cols, rows }
    }

    pub fn empty(schema: &Schema) -> Self {
        Frame {
            names: schema.iter().map(|(n, _)| n.clone()).collect(),
            cols: schema.iter().map(|(_, t)| new_null_array(t, 0)).collect(),
            rows: 0,
        }
    }

    pub fn schema(&self) -> Schema {
        self.names.iter().cloned().zip(self.cols.iter().map(|c| c.data_type().clone())).collect()
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|n| n == name)
    }

    pub fn column(&self, name: &str) -> Option<&ArrayRef> {
        self.index_of(name).map(|i| &self.cols[i])
    }

    pub fn slice(&self, offset: usize, len: usize) -> Frame {
        let offset = offset.min(self.rows);
        let len = len.min(self.rows - offset);
        Frame {
            names: self.names.clone(),
            cols: self.cols.iter().map(|c| c.slice(offset, len)).collect(),
            rows: len,
        }
    }

    pub fn take(&self, idx: &UInt64Array) -> Result<Frame, String> {
        let cols: Result<Vec<ArrayRef>, _> =
            self.cols.par_iter().map(|c| arrow_select::take::take(c.as_ref(), idx, None)).collect();
        Ok(Frame { names: self.names.clone(), cols: cols.map_err(|e| e.to_string())?, rows: idx.len() })
    }

    pub fn filter(&self, mask: &BooleanArray) -> Result<Frame, String> {
        let rows = mask.true_count();
        if rows == self.rows {
            return Ok(self.clone());
        }
        let pred = arrow_select::filter::FilterBuilder::new(mask).optimize().build();
        let cols: Result<Vec<ArrayRef>, _> = self.cols.par_iter().map(|c| pred.filter(c.as_ref())).collect();
        Ok(Frame { names: self.names.clone(), cols: cols.map_err(|e| e.to_string())?, rows })
    }

    /// 이름이 있는 컬럼만 (없는 이름은 무시), 요청한 순서대로
    pub fn select(&self, names: &[String]) -> Frame {
        let mut out_n = Vec::new();
        let mut out_c = Vec::new();
        for n in names {
            if let Some(i) = self.index_of(n) {
                out_n.push(n.clone());
                out_c.push(self.cols[i].clone());
            }
        }
        Frame { names: out_n, cols: out_c, rows: self.rows }
    }

    pub fn push(&mut self, name: String, col: ArrayRef) {
        self.names.push(name);
        self.cols.push(col);
    }

    /// schema 의 컬럼 순서/타입으로 맞춤 (없는 컬럼은 null)
    pub fn conform(&self, schema: &Schema) -> Frame {
        let cols = schema
            .par_iter()
            .map(|(n, t)| match self.column(n) {
                Some(c) => types::cast_to(c, t),
                None => new_null_array(t, self.rows),
            })
            .collect();
        Frame { names: schema.iter().map(|(n, _)| n.clone()).collect(), cols, rows: self.rows }
    }
}

/// 같은 이름이 여러 번 나오면 (이름, n번째) 로 구분
fn keyed(names: &[String]) -> Vec<(String, usize)> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    names
        .iter()
        .map(|n| {
            let k = seen.entry(n.as_str()).or_insert(0);
            let out = (n.clone(), *k);
            *k += 1;
            out
        })
        .collect()
}

/// 여러 스키마를 하나로: 처음 나온 순서대로, 타입은 types::unify
pub fn unify_schemas(schemas: &[Schema]) -> Schema {
    let mut order: Vec<(String, usize)> = Vec::new();
    let mut types_: HashMap<(String, usize), DataType> = HashMap::new();
    for s in schemas {
        let names: Vec<String> = s.iter().map(|(n, _)| n.clone()).collect();
        for (k, (_, t)) in keyed(&names).into_iter().zip(s.iter()) {
            match types_.get_mut(&k) {
                Some(old) => *old = types::unify(old, t),
                None => {
                    types_.insert(k.clone(), t.clone());
                    order.push(k);
                }
            }
        }
    }
    order.into_iter().map(|k| (k.0.clone(), types_.remove(&k).unwrap())).collect()
}

/// 표들을 위아래로 이어 붙임. 컬럼이 다르면 합집합, 타입이 다르면 맞춤.
pub fn concat_frames(frames: &[Frame]) -> Result<Frame, String> {
    if frames.is_empty() {
        return Ok(Frame::default());
    }
    if frames.len() == 1 {
        return Ok(frames[0].clone());
    }
    let schema = unify_schemas(&frames.iter().map(|f| f.schema()).collect::<Vec<_>>());
    let rows: usize = frames.iter().map(|f| f.rows).sum();
    let keyed_frames: Vec<HashMap<(String, usize), usize>> = frames
        .iter()
        .map(|f| keyed(&f.names).into_iter().enumerate().map(|(i, k)| (k, i)).collect())
        .collect();
    let out_keys = keyed(&schema.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>());
    let cols: Result<Vec<ArrayRef>, String> = out_keys
        .par_iter()
        .zip(schema.par_iter())
        .map(|(k, (_, t))| {
            let parts: Vec<ArrayRef> = frames
                .iter()
                .zip(&keyed_frames)
                .map(|(f, km)| match km.get(k) {
                    Some(&i) => types::cast_to(&f.cols[i], t),
                    None => new_null_array(t, f.rows),
                })
                .collect();
            let refs: Vec<&dyn Array> = parts.iter().map(|a| a.as_ref()).collect();
            concat(&refs).map_err(|e| e.to_string())
        })
        .collect();
    Ok(Frame { names: schema.into_iter().map(|(n, _)| n).collect(), cols: cols?, rows })
}

pub fn const_str(value: &str, rows: usize) -> ArrayRef {
    // 같은 값 반복은 dictionary 로 만들었다가 풀면 빠르지만, 행 수가 크지 않아 단순하게
    let mut b = arrow_array::builder::StringBuilder::with_capacity(rows, rows * value.len());
    for _ in 0..rows {
        b.append_value(value);
    }
    Arc::new(b.finish())
}
