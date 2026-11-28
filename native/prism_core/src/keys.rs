//! 매칭/upsert 키 문자열 만들기.

use arrow_array::cast::AsArray;
use arrow_array::types::*;
use arrow_array::*;
use arrow_schema::{DataType, TimeUnit};
use numpy::PyReadonlyArray1;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyFloat, PyInt, PyString};

use crate::convert::{py_str, NAT};
use crate::fmt;

/// Match 노드 키 입력: (종류, 값 배열, null 마스크)
///   f64 / i64(+mask) / bool(+mask) / ts(int64 us) / raw(object 배열 — 원래 Python 값 그대로)
pub struct KeyInput<'py> {
    pub kind: String,
    pub values: Bound<'py, PyAny>,
    pub mask: Option<Bound<'py, PyAny>>,
}

fn mask_vec(mask: &Option<Bound<'_, PyAny>>) -> PyResult<Option<Vec<bool>>> {
    match mask {
        Some(m) if !m.is_none() => {
            let a: PyReadonlyArray1<bool> = m.extract()?;
            Ok(Some(a.as_array().iter().copied().collect()))
        }
        _ => Ok(None),
    }
}

/// 예전 builtin._norm_value 와 같은 규칙 (normalize=True):
///   None/NaN → null, 정수 값 float → 정수 표기, str() 후 앞뒤 공백 제거, 빈 문자열 → null, (upper 면 대문자)
/// normalize=False: null 이 아니면 str(v) 그대로.
pub fn key_strings(py: Python<'_>, input: &KeyInput<'_>, normalize: bool, upper: bool) -> PyResult<Vec<Option<String>>> {
    let finish = |s: String| -> Option<String> {
        if !normalize {
            return Some(s);
        }
        let t = fmt::py_strip(&s);
        if t.is_empty() {
            None
        } else if upper {
            Some(t.to_uppercase())
        } else {
            Some(t.to_string())
        }
    };
    let float_str = |v: f64| -> Option<String> {
        if v.is_nan() {
            None
        } else if normalize && fmt::is_integral(v) {
            Some(fmt::py_int_of_float(v))
        } else {
            Some(fmt::py_float(v))
        }
    };
    let mask = mask_vec(&input.mask)?;
    let null_at = |i: usize| mask.as_ref().map(|m| m[i]).unwrap_or(false);
    let out: Vec<Option<String>> = match input.kind.as_str() {
        "f64" => {
            let a: PyReadonlyArray1<f64> = input.values.extract()?;
            a.as_array().iter().map(|v| float_str(*v).and_then(&finish)).collect()
        }
        "i64" => {
            let a: PyReadonlyArray1<i64> = input.values.extract()?;
            a.as_array().iter().enumerate().map(|(i, v)| if null_at(i) { None } else { finish(v.to_string()) }).collect()
        }
        "bool" => {
            let a: PyReadonlyArray1<bool> = input.values.extract()?;
            a.as_array()
                .iter()
                .enumerate()
                .map(|(i, v)| if null_at(i) { None } else { finish(fmt::py_bool(*v).to_string()) })
                .collect()
        }
        "ts" => {
            let a: PyReadonlyArray1<i64> = input.values.extract()?;
            a.as_array().iter().map(|v| if *v == NAT { None } else { finish(fmt::ts_pandas(*v)) }).collect()
        }
        _ => {
            let a: PyReadonlyArray1<Py<PyAny>> = input.values.extract()?;
            let isna = py.import("pandas")?.getattr("isna")?;
            let mut out = Vec::with_capacity(a.len()?);
            for o in a.as_array().iter() {
                let o = o.bind(py);
                let s: Option<String> = if o.is_none() {
                    None
                } else if let Ok(s) = o.cast::<PyString>() {
                    Some(s.to_string_lossy().into_owned())
                } else if o.is_instance_of::<PyBool>() {
                    Some(fmt::py_bool(o.is_truthy()?).to_string())
                } else if let Ok(f) = o.cast::<PyFloat>() {
                    float_str(f.value())
                } else if o.is_instance_of::<PyInt>() {
                    match o.extract::<i64>() {
                        Ok(v) => Some(v.to_string()),
                        Err(_) => Some(py_str(o)?),
                    }
                } else if !normalize && isna.call1((o,))?.is_truthy().unwrap_or(false) {
                    // normalize=False 는 pandas isna (NaT, pd.NA 등) 를 null 로 봤다
                    None
                } else {
                    Some(py_str(o)?)
                };
                out.push(s.and_then(&finish));
            }
            out
        }
    };
    Ok(out)
}

/// upsert 키 (예전 frames.norm_keys 와 같은 표기): 공백 제거, 1.0 → 1, 시각은 밀리초 표기. null 끼리는 같은 키.
pub fn upsert_key(arr: &ArrayRef, i: usize) -> String {
    if arr.is_null(i) {
        return "\u{0}null".into();
    }
    let s = match arr.data_type() {
        DataType::Utf8 => fmt::py_strip(arr.as_string::<i32>().value(i)).to_string(),
        DataType::Int64 => arr.as_primitive::<Int64Type>().value(i).to_string(),
        DataType::Float64 => fmt::py_float(arr.as_primitive::<Float64Type>().value(i)),
        DataType::Boolean => fmt::py_bool(arr.as_boolean().value(i)).to_string(),
        DataType::Timestamp(TimeUnit::Microsecond, _) => fmt::ts_millis(arr.as_primitive::<TimestampMicrosecondType>().value(i)),
        _ => crate::types::value_string(arr, i).unwrap_or_default(),
    };
    strip_zero_fraction(s)
}

/// ^(-?\d+)\.0+$ → \1
fn strip_zero_fraction(s: String) -> String {
    let b = s.as_bytes();
    let Some(dot) = s.find('.') else { return s };
    let (int, frac) = (&b[..dot], &b[dot + 1..]);
    let digits = if int.first() == Some(&b'-') { &int[1..] } else { int };
    if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) && !frac.is_empty() && frac.iter().all(|c| *c == b'0') {
        s[..dot].to_string()
    } else {
        s
    }
}

pub fn row_keys(cols: &[ArrayRef], rows: usize) -> Vec<String> {
    (0..rows)
        .map(|i| {
            let mut k = String::new();
            for (j, c) in cols.iter().enumerate() {
                if j > 0 {
                    k.push('\u{1f}');
                }
                k.push_str(&upsert_key(c, i));
            }
            k
        })
        .collect()
}
