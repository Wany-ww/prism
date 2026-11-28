//! 표준 컬럼 타입과 타입 맞추기.
//!
//! PRISM 은 컬럼을 다섯 가지 타입으로만 다룬다: bool / int64 / float64 / string / timestamp(us).
//! 다른 프로그램이 쓴 parquet(int32, 시간대가 있는 timestamp, dictionary 문자열 등)도 읽을 때 이 타입으로 바꾼다.

use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::*;
use arrow_array::*;
use arrow_buffer::NullBuffer;
use arrow_cast::display::{ArrayFormatter, FormatOptions};
use arrow_schema::{ArrowError, DataType, TimeUnit};

use crate::fmt;

pub fn ts_type() -> DataType {
    DataType::Timestamp(TimeUnit::Microsecond, None)
}

pub fn type_name(t: &DataType) -> &'static str {
    match t {
        DataType::Null => "null",
        DataType::Boolean => "bool",
        DataType::Int64 => "int64",
        DataType::Float64 => "float64",
        DataType::Timestamp(_, _) => "timestamp",
        _ => "string",
    }
}

pub fn type_from_name(s: &str) -> DataType {
    match s {
        "null" => DataType::Null,
        "bool" => DataType::Boolean,
        "int64" => DataType::Int64,
        "float64" => DataType::Float64,
        "timestamp" => ts_type(),
        _ => DataType::Utf8,
    }
}

fn cast(arr: &ArrayRef, to: &DataType) -> Result<ArrayRef, ArrowError> {
    arrow_cast::cast(arr.as_ref(), to)
}

fn ts_to_micros(arr: &ArrayRef, unit: &TimeUnit) -> ArrayRef {
    // 시간대가 있으면 UTC 기준 값 그대로 시간대만 뗀다 (pandas tz_convert(None) 과 같음)
    let (vals, nulls): (Vec<i64>, Option<NullBuffer>) = match unit {
        TimeUnit::Second => {
            let a = arr.as_primitive::<TimestampSecondType>();
            (a.values().iter().map(|v| v.saturating_mul(1_000_000)).collect(), a.nulls().cloned())
        }
        TimeUnit::Millisecond => {
            let a = arr.as_primitive::<TimestampMillisecondType>();
            (a.values().iter().map(|v| v.saturating_mul(1_000)).collect(), a.nulls().cloned())
        }
        TimeUnit::Microsecond => {
            let a = arr.as_primitive::<TimestampMicrosecondType>();
            (a.values().to_vec(), a.nulls().cloned())
        }
        TimeUnit::Nanosecond => {
            let a = arr.as_primitive::<TimestampNanosecondType>();
            (a.values().iter().map(|v| v.div_euclid(1_000)).collect(), a.nulls().cloned())
        }
    };
    Arc::new(TimestampMicrosecondArray::new(vals.into(), nulls))
}

/// 읽어 온 배열을 표준 타입으로.
pub fn normalize(arr: &ArrayRef) -> ArrayRef {
    use DataType::*;
    match arr.data_type() {
        Null | Boolean | Int64 | Float64 | Utf8 => arr.clone(),
        Timestamp(unit, _) => ts_to_micros(arr, unit),
        Int8 | Int16 | Int32 | UInt8 | UInt16 | UInt32 | UInt64 => cast(arr, &Int64).unwrap_or_else(|_| to_utf8(arr)),
        Float16 | Float32 | Decimal32(..) | Decimal64(..) | Decimal128(..) | Decimal256(..) => {
            cast(arr, &Float64).unwrap_or_else(|_| to_utf8(arr))
        }
        LargeUtf8 | Utf8View => cast(arr, &Utf8).unwrap_or_else(|_| to_utf8(arr)),
        Dictionary(_, value) => match cast(arr, value) {
            Ok(a) => normalize(&a),
            Err(_) => to_utf8(arr),
        },
        Date32 => {
            let a = arr.as_primitive::<Date32Type>();
            let vals: Vec<i64> = a.values().iter().map(|d| *d as i64 * 86_400_000_000).collect();
            Arc::new(TimestampMicrosecondArray::new(vals.into(), a.nulls().cloned()))
        }
        Date64 => {
            let a = arr.as_primitive::<Date64Type>();
            let vals: Vec<i64> = a.values().iter().map(|d| d * 1_000).collect();
            Arc::new(TimestampMicrosecondArray::new(vals.into(), a.nulls().cloned()))
        }
        _ => to_utf8(arr),
    }
}

/// 값 하나를 문자열로 (Python str() 과 같은 표기)
pub fn value_string(arr: &ArrayRef, i: usize) -> Option<String> {
    if arr.is_null(i) {
        return None;
    }
    Some(match arr.data_type() {
        DataType::Utf8 => arr.as_string::<i32>().value(i).to_string(),
        DataType::Int64 => arr.as_primitive::<Int64Type>().value(i).to_string(),
        DataType::Float64 => fmt::py_float(arr.as_primitive::<Float64Type>().value(i)),
        DataType::Boolean => fmt::py_bool(arr.as_boolean().value(i)).to_string(),
        DataType::Timestamp(TimeUnit::Microsecond, _) => fmt::ts_pandas(arr.as_primitive::<TimestampMicrosecondType>().value(i)),
        _ => {
            let opts = FormatOptions::default();
            match ArrayFormatter::try_new(arr.as_ref(), &opts) {
                Ok(f) => f.value(i).to_string(),
                Err(_) => String::new(),
            }
        }
    })
}

pub fn to_utf8(arr: &ArrayRef) -> ArrayRef {
    if arr.data_type() == &DataType::Utf8 {
        return arr.clone();
    }
    if arr.data_type() == &DataType::Null {
        return new_null_array(&DataType::Utf8, arr.len());
    }
    let mut b = arrow_array::builder::StringBuilder::with_capacity(arr.len(), arr.len() * 8);
    match arr.data_type() {
        DataType::Int64 | DataType::Float64 | DataType::Boolean | DataType::Timestamp(TimeUnit::Microsecond, _) => {
            for i in 0..arr.len() {
                b.append_option(value_string(arr, i));
            }
        }
        _ => {
            let opts = FormatOptions::default();
            let f = ArrayFormatter::try_new(arr.as_ref(), &opts).ok();
            for i in 0..arr.len() {
                if arr.is_null(i) {
                    b.append_null();
                } else if let Some(f) = &f {
                    b.append_value(f.value(i).to_string());
                } else {
                    b.append_null();
                }
            }
        }
    }
    Arc::new(b.finish())
}

/// 두 타입을 함께 담을 수 있는 타입 (pyarrow permissive 와 비슷하게, 안 되면 문자열)
pub fn unify(a: &DataType, b: &DataType) -> DataType {
    use DataType::*;
    match (a, b) {
        (x, y) if x == y => x.clone(),
        (Null, y) => y.clone(),
        (x, Null) => x.clone(),
        (Int64, Float64) | (Float64, Int64) => Float64,
        _ => Utf8,
    }
}

/// 표준 타입 배열을 target 타입으로
pub fn cast_to(arr: &ArrayRef, target: &DataType) -> ArrayRef {
    if arr.data_type() == target {
        return arr.clone();
    }
    if arr.data_type() == &DataType::Null || target == &DataType::Null {
        return new_null_array(target, arr.len());
    }
    if target == &DataType::Utf8 {
        return to_utf8(arr);
    }
    cast(arr, target).unwrap_or_else(|_| new_null_array(target, arr.len()))
}
