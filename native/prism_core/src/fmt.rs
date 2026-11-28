//! Python/pandas 와 같은 모양으로 값을 문자열로 만드는 함수들.
//! 키 비교·문자열 변환 결과가 예전(pandas) 구현과 같아야 기존 데이터셋과 매칭/upsert 결과가 바뀌지 않는다.

use chrono::{DateTime, Datelike, Timelike};

/// Python `repr(float)` 과 같은 표기 (예: 1.5, 1e-05, 1e+16, 100.0).
pub fn py_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    // Rust 의 {:e} 는 왕복 가능한 가장 짧은 자릿수 (Python repr 과 같은 자릿수)
    let s = format!("{:e}", v);
    let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let decpt = exp + 1;
    let mut out = String::with_capacity(digits.len() + 8);
    if v < 0.0 {
        out.push('-');
    }
    if decpt <= -4 || decpt > 16 {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let e = decpt - 1;
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", e.abs()));
    } else if decpt <= 0 {
        out.push_str("0.");
        for _ in 0..(-decpt) {
            out.push('0');
        }
        out.push_str(&digits);
    } else if decpt as usize >= digits.len() {
        out.push_str(&digits);
        for _ in 0..(decpt as usize - digits.len()) {
            out.push('0');
        }
        out.push_str(".0");
    } else {
        out.push_str(&digits[..decpt as usize]);
        out.push('.');
        out.push_str(&digits[decpt as usize..]);
    }
    out
}

/// 정수 값인 float 을 Python `str(int(v))` 처럼 (예: 3.0 → "3", -0.0 → "0").
pub fn py_int_of_float(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    format!("{:.0}", v)
}

pub fn is_integral(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0
}

fn parts(us: i64) -> Option<(i32, u32, u32, u32, u32, u32, u32)> {
    let dt = DateTime::from_timestamp_micros(us)?.naive_utc();
    Some((dt.year(), dt.month(), dt.day(), dt.hour(), dt.minute(), dt.second(), dt.nanosecond() / 1000))
}

/// pandas `str(Timestamp)` 표기: 2026-11-24 10:00:00 (마이크로초가 있으면 .123456)
pub fn ts_pandas(us: i64) -> String {
    match parts(us) {
        Some((y, mo, d, h, mi, s, micro)) => {
            if micro == 0 {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
            } else {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, mo, d, h, mi, s, micro)
            }
        }
        None => "NaT".into(),
    }
}

/// 화면 표기와 같은 밀리초 표기: 2026-11-24 10:00:00.000
pub fn ts_millis(us: i64) -> String {
    match parts(us) {
        Some((y, mo, d, h, mi, s, micro)) => {
            format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}", y, mo, d, h, mi, s, micro / 1000)
        }
        None => "NaT".into(),
    }
}

pub fn py_bool(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

/// Python `str.strip()` 과 같은 공백 기준 (Python 은 \x1c-\x1f 도 공백으로 본다)
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_like_python() {
        assert_eq!(py_float(1.5), "1.5");
        assert_eq!(py_float(100.0), "100.0");
        assert_eq!(py_float(1e16), "1e+16");
        assert_eq!(py_float(1e15), "1000000000000000.0");
        assert_eq!(py_float(0.0001), "0.0001");
        assert_eq!(py_float(0.00001), "1e-05");
        assert_eq!(py_float(-1.25e-7), "-1.25e-07");
        assert_eq!(py_float(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(py_float(123456.789), "123456.789");
        assert_eq!(py_int_of_float(-0.0), "0");
        assert_eq!(py_int_of_float(1e20), "100000000000000000000");
    }

    #[test]
    fn timestamps() {
        assert_eq!(ts_pandas(0), "1970-01-01 00:00:00");
        assert_eq!(ts_pandas(1_500_000), "1970-01-01 00:00:01.500000");
        assert_eq!(ts_millis(1_500_000), "1970-01-01 00:00:01.500");
    }
}
