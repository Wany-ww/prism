//! numpy 배열 ↔ Arrow 배열 변환.
//!
//! Python 쪽(app/engine/native.py)이 pandas 컬럼을 종류별 numpy 배열로 넘겨 준다:
//!   f64 (NaN = null) / i64 (+ null 마스크) / bool (+ null 마스크) / ts (int64 마이크로초, i64::MIN = null)
//!   str (object 배열: str 이 아니면 str() 로 변환) / obj_bool / obj_int / obj_float (object 배열) / null

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::builder::{BooleanBuilder, Float64Builder, Int64Builder, StringBuilder};
use arrow_array::cast::AsArray;
use arrow_array::types::*;
use arrow_array::*;
use arrow_buffer::{BooleanBuffer, NullBuffer};
use arrow_schema::{DataType, TimeUnit};
use numpy::{PyArray1, PyArrayMethods, PyReadonlyArray1};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyFloat, PyString};

pub const NAT: i64 = i64::MIN;

fn mask_nulls(mask: Option<&Bound<'_, PyAny>>, len: usize) -> PyResult<Option<NullBuffer>> {
    let Some(m) = mask else { return Ok(None) };
    if m.is_none() {
        return Ok(None);
    }
    let m: PyReadonlyArray1<bool> = m.extract()?;
    let m = m.as_array();
    if m.len() != len {
        return Err(PyValueError::new_err("mask length mismatch"));
    }
    // mask 가 true 인 곳이 null
    let valid: BooleanBuffer = m.iter().map(|v| !*v).collect();
    let nb = NullBuffer::new(valid);
    Ok(if nb.null_count() == 0 { None } else { Some(nb) })
}

pub fn py_str(o: &Bound<'_, PyAny>) -> PyResult<String> {
    if let Ok(s) = o.cast::<PyString>() {
        return Ok(match s.to_str() {
            Ok(v) => v.to_owned(),
            Err(_) => s.to_string_lossy().into_owned(),
        });
    }
    let s = o.str()?;
    Ok(match s.to_str() {
        Ok(v) => v.to_owned(),
        Err(_) => s.to_string_lossy().into_owned(),
    })
}

fn is_nan(o: &Bound<'_, PyAny>) -> bool {
    o.cast::<PyFloat>().map(|f| f.value().is_nan()).unwrap_or(false)
}

pub fn array_from_py(py: Python<'_>, kind: &str, values: &Bound<'_, PyAny>, mask: Option<&Bound<'_, PyAny>>, len: usize) -> PyResult<ArrayRef> {
    Ok(match kind {
        "f64" => {
            let a: PyReadonlyArray1<f64> = values.extract()?;
            let v: Vec<f64> = match a.as_slice() {
                Ok(s) => s.to_vec(),
                Err(_) => a.as_array().iter().copied().collect(),
            };
            let valid: BooleanBuffer = v.iter().map(|x| !x.is_nan()).collect();
            let nb = NullBuffer::new(valid);
            Arc::new(Float64Array::new(v.into(), if nb.null_count() == 0 { None } else { Some(nb) }))
        }
        "i64" => {
            let a: PyReadonlyArray1<i64> = values.extract()?;
            let v: Vec<i64> = a.as_array().iter().copied().collect();
            let n = v.len();
            Arc::new(Int64Array::new(v.into(), mask_nulls(mask, n)?))
        }
        "bool" => {
            let a: PyReadonlyArray1<bool> = values.extract()?;
            let v: BooleanBuffer = a.as_array().iter().copied().collect();
            let n = v.len();
            Arc::new(BooleanArray::new(v, mask_nulls(mask, n)?))
        }
        "ts" => {
            let a: PyReadonlyArray1<i64> = values.extract()?;
            let v: Vec<i64> = a.as_array().iter().copied().collect();
            let valid: BooleanBuffer = v.iter().map(|x| *x != NAT).collect();
            let nb = NullBuffer::new(valid);
            Arc::new(TimestampMicrosecondArray::new(v.into(), if nb.null_count() == 0 { None } else { Some(nb) }))
        }
        "null" => new_null_array(&DataType::Null, len),
        "str" | "obj_bool" | "obj_int" | "obj_float" => {
            let a: PyReadonlyArray1<Py<PyAny>> = values.extract()?;
            let arr = a.as_array();
            match kind {
                "str" => {
                    let mut b = StringBuilder::with_capacity(arr.len(), arr.len() * 8);
                    for o in arr.iter() {
                        let o = o.bind(py);
                        if o.is_none() || is_nan(o) {
                            b.append_null();
                        } else {
                            b.append_value(py_str(o)?);
                        }
                    }
                    Arc::new(b.finish())
                }
                "obj_bool" => {
                    let mut b = BooleanBuilder::with_capacity(arr.len());
                    for o in arr.iter() {
                        let o = o.bind(py);
                        if o.is_none() || is_nan(o) {
                            b.append_null();
                        } else {
                            b.append_value(o.is_truthy()?);
                        }
                    }
                    Arc::new(b.finish())
                }
                "obj_int" => {
                    let mut b = Int64Builder::with_capacity(arr.len());
                    for o in arr.iter() {
                        let o = o.bind(py);
                        if o.is_none() || is_nan(o) {
                            b.append_null();
                        } else {
                            match o.extract::<i64>() {
                                Ok(v) => b.append_value(v),
                                // int64 범위를 넘는 정수가 있으면 컬럼 전체를 문자열로 (pyarrow 저장 실패 시와 같은 처리)
                                Err(_) => return array_from_py(py, "str", values, None, len),
                            }
                        }
                    }
                    Arc::new(b.finish())
                }
                _ => {
                    let mut b = Float64Builder::with_capacity(arr.len());
                    for o in arr.iter() {
                        let o = o.bind(py);
                        if o.is_none() {
                            b.append_null();
                        } else {
                            let v: f64 = o.extract()?;
                            if v.is_nan() {
                                b.append_null()
                            } else {
                                b.append_value(v)
                            }
                        }
                    }
                    Arc::new(b.finish())
                }
            }
        }
        other => return Err(PyValueError::new_err(format!("unknown column kind {other}"))),
    })
}

/// pandas 블록 단위 변환: 같은 종류 컬럼들을 (컬럼 수, 행 수) 2D 배열 하나로 모아 넘긴다
/// (pandas 가 컬럼 수천 개를 다시 한 블록으로 합치며 복사하는 일을 없앰).
/// 반환: [(종류, 배열, 컬럼 위치들)] — 종류: f64 / i64 / bool / ts (2D) · str (1D object, 컬럼마다) · obj (2D object)
pub fn blocks_to_py<'py>(py: Python<'py>, cols: &[ArrayRef], rows: usize) -> PyResult<Vec<(&'static str, Bound<'py, PyAny>, Vec<i64>)>> {
    use rayon::prelude::*;
    let mut groups: HashMap<&'static str, Vec<usize>> = HashMap::new();
    let mut strs = Vec::new();
    for (i, c) in cols.iter().enumerate() {
        let kind = match c.data_type() {
            DataType::Float64 => "f64",
            DataType::Int64 if c.null_count() > 0 => "f64",
            DataType::Int64 => "i64",
            DataType::Boolean if c.null_count() == 0 => "bool",
            DataType::Timestamp(TimeUnit::Microsecond, _) => "ts",
            DataType::Utf8 => {
                strs.push(i);
                continue;
            }
            _ => "obj",
        };
        groups.entry(kind).or_default().push(i);
    }
    let mut out = Vec::new();
    for kind in ["f64", "i64", "bool", "ts"] {
        let Some(idx) = groups.get(kind) else { continue };
        let k = idx.len();
        let arr: Bound<'py, PyAny> = match kind {
            "f64" => {
                let mut buf = vec![0f64; k * rows];
                if rows > 0 {
                    buf.par_chunks_mut(rows).zip(idx.par_iter()).for_each(|(dst, &i)| {
                        let c = &cols[i];
                        if let Some(a) = c.as_primitive_opt::<Float64Type>() {
                            dst.copy_from_slice(a.values());
                            if a.null_count() > 0 {
                                for (j, d) in dst.iter_mut().enumerate() {
                                    if a.is_null(j) {
                                        *d = f64::NAN;
                                    }
                                }
                            }
                        } else {
                            let a = c.as_primitive::<Int64Type>();
                            for (j, d) in dst.iter_mut().enumerate() {
                                *d = if a.is_null(j) { f64::NAN } else { a.value(j) as f64 };
                            }
                        }
                    });
                }
                PyArray1::from_vec(py, buf).reshape([k, rows])?.into_any()
            }
            "i64" | "ts" => {
                let mut buf = vec![0i64; k * rows];
                if rows > 0 {
                    buf.par_chunks_mut(rows).zip(idx.par_iter()).for_each(|(dst, &i)| {
                        let c = &cols[i];
                        let (vals, nulls) = if kind == "i64" {
                            let a = c.as_primitive::<Int64Type>();
                            (a.values().as_ref(), a.nulls())
                        } else {
                            let a = c.as_primitive::<TimestampMicrosecondType>();
                            (a.values().as_ref(), a.nulls())
                        };
                        dst.copy_from_slice(vals);
                        if let Some(n) = nulls {
                            for (j, d) in dst.iter_mut().enumerate() {
                                if n.is_null(j) {
                                    *d = NAT;
                                }
                            }
                        }
                    });
                }
                PyArray1::from_vec(py, buf).reshape([k, rows])?.into_any()
            }
            _ => {
                let mut buf = vec![false; k * rows];
                if rows > 0 {
                    buf.par_chunks_mut(rows).zip(idx.par_iter()).for_each(|(dst, &i)| {
                        let a = cols[i].as_boolean();
                        for (j, d) in dst.iter_mut().enumerate() {
                            *d = a.value(j);
                        }
                    });
                }
                PyArray1::from_vec(py, buf).reshape([k, rows])?.into_any()
            }
        };
        out.push((kind, arr, idx.iter().map(|i| *i as i64).collect()));
    }
    for i in strs {
        let (_, arr) = array_to_py(py, &cols[i])?;
        out.push(("str", arr, vec![i as i64]));
    }
    if let Some(idx) = groups.get("obj") {
        let mut buf: Vec<Py<PyAny>> = Vec::with_capacity(idx.len() * rows);
        for &i in idx {
            let (_, arr) = array_to_py(py, &cols[i])?;
            let a: PyReadonlyArray1<Py<PyAny>> = arr.extract()?;
            buf.extend(a.as_array().iter().map(|o| o.clone_ref(py)));
        }
        out.push(("obj", PyArray1::from_vec(py, buf).reshape([idx.len(), rows])?.into_any(), idx.iter().map(|i| *i as i64).collect()));
    }
    Ok(out)
}

/// Arrow → numpy. (종류, 배열) — 종류: f64 / i64 / bool / ts(int64 마이크로초) / obj
pub fn array_to_py<'py>(py: Python<'py>, arr: &ArrayRef) -> PyResult<(&'static str, Bound<'py, PyAny>)> {
    let n = arr.len();
    Ok(match arr.data_type() {
        DataType::Float64 => {
            let a = arr.as_primitive::<Float64Type>();
            let v: Vec<f64> = if a.null_count() == 0 {
                a.values().to_vec()
            } else {
                (0..n).map(|i| if a.is_null(i) { f64::NAN } else { a.value(i) }).collect()
            };
            ("f64", PyArray1::from_vec(py, v).into_any())
        }
        DataType::Int64 => {
            let a = arr.as_primitive::<Int64Type>();
            if a.null_count() == 0 {
                ("i64", PyArray1::from_vec(py, a.values().to_vec()).into_any())
            } else {
                // pandas 와 같이 null 이 있는 정수는 float(NaN)
                let v: Vec<f64> = (0..n).map(|i| if a.is_null(i) { f64::NAN } else { a.value(i) as f64 }).collect();
                ("f64", PyArray1::from_vec(py, v).into_any())
            }
        }
        DataType::Boolean => {
            let a = arr.as_boolean();
            if a.null_count() == 0 {
                let v: Vec<bool> = a.values().iter().collect();
                ("bool", PyArray1::from_vec(py, v).into_any())
            } else {
                let t = PyBool::new(py, true).to_owned().into_any().unbind();
                let f = PyBool::new(py, false).to_owned().into_any().unbind();
                let v: Vec<Py<PyAny>> = (0..n)
                    .map(|i| if a.is_null(i) { py.None() } else if a.value(i) { t.clone_ref(py) } else { f.clone_ref(py) })
                    .collect();
                ("obj", PyArray1::from_vec(py, v).into_any())
            }
        }
        DataType::Timestamp(TimeUnit::Microsecond, _) => {
            let a = arr.as_primitive::<TimestampMicrosecondType>();
            let v: Vec<i64> = if a.null_count() == 0 {
                a.values().to_vec()
            } else {
                (0..n).map(|i| if a.is_null(i) { NAT } else { a.value(i) }).collect()
            };
            ("ts", PyArray1::from_vec(py, v).into_any())
        }
        DataType::Utf8 => {
            let a = arr.as_string::<i32>();
            // 같은 값이 많은 컬럼(설비명, 판정 등)은 Python 문자열 객체를 공유해 메모리와 시간을 줄임
            let mut cache: HashMap<&str, Py<PyAny>> = HashMap::new();
            let mut caching = true;
            let mut v: Vec<Py<PyAny>> = Vec::with_capacity(n);
            for i in 0..n {
                if a.is_null(i) {
                    v.push(py.None());
                    continue;
                }
                let s = a.value(i);
                if caching {
                    if let Some(o) = cache.get(s) {
                        v.push(o.clone_ref(py));
                        continue;
                    }
                    let o = PyString::new(py, s).into_any().unbind();
                    cache.insert(s, o.clone_ref(py));
                    v.push(o);
                    if cache.len() > 4096 && cache.len() * 2 > i {
                        caching = false;
                        cache.clear();
                    }
                } else {
                    v.push(PyString::new(py, s).into_any().unbind());
                }
            }
            ("str", PyArray1::from_vec(py, v).into_any())
        }
        _ => {
            let v: Vec<Py<PyAny>> = (0..n).map(|_| py.None()).collect();
            ("obj", PyArray1::from_vec(py, v).into_any())
        }
    })
}
