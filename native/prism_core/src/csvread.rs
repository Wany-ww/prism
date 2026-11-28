//! 설비 로그 CSV 파서 (Parser 코드에서 prism.read_csv 로 사용).
//! pandas.read_csv 기본 동작과 같게: 헤더 1줄, 컬럼별 정수 → 실수 → 참/거짓 → 문자열 순으로 타입 추론,
//! pandas 기본 결측 표기(NA, NaN, null, 빈 칸 등)는 null, 같은 이름 컬럼은 a, a.1, a.2.
//!
//! 텍스트를 줄 경계에서 스레드 수만큼 나누고, 각 스레드가 자기 줄들을 나누는 즉시 컬럼별로 숫자/참거짓으로 해석한다
//! (원문 조각은 문자열 컬럼만 보관). 조각마다 정해진 타입은 마지막에 컬럼 전체 기준으로 맞춘다.
//! 따옴표가 있으면(필드 안 쉼표·줄바꿈 가능) csv 표준 해석기로 레코드를 나눈 뒤 같은 방식으로 해석한다.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow_array::builder::StringBuilder;
use arrow_array::*;
use arrow_buffer::{BooleanBuffer, NullBuffer};
use encoding_rs::Encoding;
use rayon::prelude::*;

use crate::frame::Frame;

pub struct Options {
    pub encoding: String,
    pub errors_replace: bool,
    pub sep: u8,
    pub skip_rows: usize,
    pub header: bool,
    pub meta_prefix: Option<String>,
    pub comment: Option<u8>,
}

fn encoding_for(label: &str) -> Option<&'static Encoding> {
    let l = label.trim().to_ascii_lowercase().replace('_', "-");
    // Python 코덱 이름 → WHATWG 이름
    let mapped = match l.as_str() {
        "cp949" | "ms949" | "uhc" | "euc-kr" | "euckr" | "ks-c-5601-1987" => "euc-kr",
        "utf8" | "utf-8-sig" | "u8" => "utf-8",
        "cp932" | "ms932" | "sjis" | "shift-jis" => "shift_jis",
        "cp936" | "ms936" => "gbk",
        "latin-1" | "latin1" | "iso-8859-1" | "cp1252" => "windows-1252",
        "utf-16" | "utf16" => "utf-16le",
        other => other,
    };
    Encoding::for_label(mapped.as_bytes())
}

/// 파일 바이트 → 문자열. UTF-8 은 복사 없이 검사만 한다. BOM 이 있으면 BOM 기준 (pandas 도 UTF-8 BOM 은 뗀다).
pub fn decode(bytes: Vec<u8>, encoding: &str, replace: bool) -> Result<String, String> {
    let enc = encoding_for(encoding).ok_or_else(|| format!("Unsupported encoding: {encoding}"))?;
    let (enc, bom) = match Encoding::for_bom(&bytes) {
        Some((e, n)) => (e, n),
        None => (enc, 0),
    };
    let bad = || format!("'{}' codec can't decode the file (check the equipment encoding setting, e.g. cp949)", encoding);
    if enc == encoding_rs::UTF_8 {
        let mut bytes = bytes;
        if bom > 0 {
            bytes.drain(..bom);
        }
        return match String::from_utf8(bytes) {
            Ok(s) => Ok(s),
            Err(e) if replace => Ok(String::from_utf8_lossy(e.as_bytes()).into_owned()),
            Err(_) => Err(bad()),
        };
    }
    let body = &bytes[bom..];
    if replace {
        Ok(enc.decode_without_bom_handling(body).0.into_owned())
    } else {
        enc.decode_without_bom_handling_and_without_replacement(body).map(|c| c.into_owned()).ok_or_else(bad)
    }
}

pub struct Parsed {
    pub frame: Frame,
    pub meta: Vec<(String, String)>,
}

/// pandas 기본 결측 표기
fn is_na(s: &str) -> bool {
    if s.len() > 8 {
        return false;
    }
    matches!(
        s,
        "" | "#N/A" | "#N/A N/A" | "#NA" | "-1.#IND" | "-1.#QNAN" | "-NaN" | "-nan" | "1.#IND" | "1.#QNAN" | "<NA>" | "N/A" | "NA"
            | "NULL" | "NaN" | "None" | "n/a" | "nan" | "null"
    )
}

fn parse_bool(s: &str) -> Option<bool> {
    match s {
        "True" | "TRUE" | "true" => Some(true),
        "False" | "FALSE" | "false" => Some(false),
        _ => None,
    }
}

// ---------------- 줄(행) 묶음 ----------------

/// 한 스레드가 맡는 행들. 문자열 컬럼으로 바뀔 때 앞쪽 행의 원문을 다시 꺼내기 위해 행 원문을 기억한다.
enum Rows<'a> {
    Lines(Vec<&'a str>, char),
    Records(&'a [csv::StringRecord]),
}

impl<'a> Rows<'a> {
    fn len(&self) -> usize {
        match self {
            Rows::Lines(l, _) => l.len(),
            Rows::Records(r) => r.len(),
        }
    }

    fn field(&self, r: usize, j: usize) -> &'a str {
        match self {
            Rows::Lines(l, sep) => l[r].split(*sep).nth(j).unwrap_or(""),
            Rows::Records(recs) => recs[r].get(j).unwrap_or(""),
        }
    }
}

// ---------------- 컬럼 조각 ----------------

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Null,
    Bool,
    Int,
    Float,
    Str,
}

/// 한 행 묶음 안 한 컬럼의 값. 숫자/참거짓은 해석한 값만, 문자열이면 원문 조각.
enum Piece<'a> {
    Null(usize),
    Int(Vec<i64>, Vec<bool>),
    Float(Vec<f64>, Vec<bool>),
    Bool(Vec<bool>, Vec<bool>),
    Str(Vec<&'a str>),
}

impl<'a> Piece<'a> {
    fn kind(&self) -> Kind {
        match self {
            Piece::Null(_) => Kind::Null,
            Piece::Int(..) => Kind::Int,
            Piece::Float(..) => Kind::Float,
            Piece::Bool(..) => Kind::Bool,
            Piece::Str(_) => Kind::Str,
        }
    }

    fn push_null(&mut self) {
        match self {
            Piece::Null(n) => *n += 1,
            Piece::Int(v, ok) => {
                v.push(0);
                ok.push(false)
            }
            Piece::Float(v, ok) => {
                v.push(f64::NAN);
                ok.push(false)
            }
            Piece::Bool(v, ok) => {
                v.push(false);
                ok.push(false)
            }
            Piece::Str(v) => v.push(""),
        }
    }

    /// row: 이 묶음 안 행 번호 (문자열로 바뀔 때 0..row 원문을 다시 꺼냄)
    fn push(&mut self, f: &'a str, j: usize, row: usize, rows: &Rows<'a>) {
        if is_na(f) {
            self.push_null();
            return;
        }
        match self {
            Piece::Str(v) => v.push(f),
            Piece::Null(n) => {
                let n = *n;
                let t = f.trim();
                *self = if let Ok(x) = t.parse::<i64>() {
                    let mut v = vec![0; n];
                    let mut ok = vec![false; n];
                    v.push(x);
                    ok.push(true);
                    Piece::Int(v, ok)
                } else if let Ok(x) = t.parse::<f64>() {
                    let mut v = vec![f64::NAN; n];
                    let mut ok = vec![false; n];
                    v.push(x);
                    ok.push(true);
                    Piece::Float(v, ok)
                } else if let Some(b) = parse_bool(f) {
                    let mut v = vec![false; n];
                    let mut ok = vec![false; n];
                    v.push(b);
                    ok.push(true);
                    Piece::Bool(v, ok)
                } else {
                    let mut v = vec![""; n];
                    v.push(f);
                    Piece::Str(v)
                };
            }
            Piece::Int(v, ok) => {
                let t = f.trim();
                if let Ok(x) = t.parse::<i64>() {
                    v.push(x);
                    ok.push(true);
                } else if let Ok(x) = t.parse::<f64>() {
                    let mut fv: Vec<f64> = v.iter().map(|i| *i as f64).collect();
                    let mut fok = std::mem::take(ok);
                    fv.push(x);
                    fok.push(true);
                    *self = Piece::Float(fv, fok);
                } else {
                    self.to_str(j, row, rows);
                    self.push(f, j, row, rows);
                }
            }
            Piece::Float(v, ok) => {
                if let Ok(x) = f.trim().parse::<f64>() {
                    v.push(x);
                    ok.push(true);
                } else {
                    self.to_str(j, row, rows);
                    self.push(f, j, row, rows);
                }
            }
            Piece::Bool(v, ok) => {
                if let Some(b) = parse_bool(f) {
                    v.push(b);
                    ok.push(true);
                } else {
                    self.to_str(j, row, rows);
                    self.push(f, j, row, rows);
                }
            }
        }
    }

    /// 지금까지(0..upto 행)의 원문으로 문자열 조각이 됨
    fn to_str(&mut self, j: usize, upto: usize, rows: &Rows<'a>) {
        *self = Piece::Str((0..upto).map(|r| rows.field(r, j)).collect());
    }

    fn len(&self) -> usize {
        match self {
            Piece::Null(n) => *n,
            Piece::Int(v, _) => v.len(),
            Piece::Float(v, _) => v.len(),
            Piece::Bool(v, _) => v.len(),
            Piece::Str(v) => v.len(),
        }
    }
}

/// 한 행 묶음을 컬럼 조각들로. width 를 넘는 줄은 (줄 번호, 필드 수) 로 알림 (header 가 없으면 컬럼을 늘림).
struct Chunk<'a> {
    rows: Rows<'a>,
    pieces: Vec<Piece<'a>>,
    too_wide: Option<(usize, usize)>,
    lines_seen: usize,
}

fn fill_chunk<'a>(rows: Rows<'a>, width: usize, grow: bool, line_of: impl Fn(usize) -> usize) -> Chunk<'a> {
    let mut pieces: Vec<Piece<'a>> = (0..width).map(|_| Piece::Null(0)).collect();
    let mut too_wide = None;
    let n = rows.len();
    for r in 0..n {
        let mut k = 0usize;
        let mut handle = |f: &'a str, k: usize, pieces: &mut Vec<Piece<'a>>| {
            if k < pieces.len() {
                pieces[k].push(f, k, r, &rows);
            } else if grow {
                let mut p = Piece::Null(r);
                p.push(f, k, r, &rows);
                pieces.push(p);
            } else if too_wide.is_none() {
                too_wide = Some(r);
            }
        };
        match &rows {
            Rows::Lines(lines, sep) => {
                // 구분자(ASCII) 위치에서만 자르므로 UTF-8 경계가 깨지지 않는다
                let line: &'a str = lines[r];
                let bytes = line.as_bytes();
                let sb = *sep as u8;
                let mut s = 0usize;
                for (i, &c) in bytes.iter().enumerate() {
                    if c == sb {
                        handle(unsafe { line.get_unchecked(s..i) }, k, &mut pieces);
                        k += 1;
                        s = i + 1;
                    }
                }
                handle(unsafe { line.get_unchecked(s..) }, k, &mut pieces);
                k += 1;
            }
            Rows::Records(recs) => {
                for f in recs[r].iter() {
                    handle(f, k, &mut pieces);
                    k += 1;
                }
            }
        }
        for p in pieces.iter_mut().skip(k) {
            p.push_null();
        }
    }
    let too_wide = too_wide.map(|r| {
        let saw = match &rows {
            Rows::Lines(l, sep) => l[r].split(*sep).count(),
            Rows::Records(recs) => recs[r].len(),
        };
        (line_of(r), saw)
    });
    Chunk { rows, pieces, too_wide, lines_seen: 0 }
}

/// 조각들을 컬럼 전체 타입으로 맞춰 Arrow 배열 하나로
fn merge_column(chunks: &[Chunk<'_>], j: usize, total: usize) -> ArrayRef {
    let piece = |c: &Chunk<'_>| -> Option<Kind> { c.pieces.get(j).map(|p| p.kind()) };
    let mut kind = Kind::Null;
    for c in chunks {
        let k = piece(c).unwrap_or(Kind::Null);
        kind = match (kind, k) {
            (a, b) if a == b => a,
            (Kind::Null, b) => b,
            (a, Kind::Null) => a,
            (Kind::Int, Kind::Float) | (Kind::Float, Kind::Int) => Kind::Float,
            _ => Kind::Str,
        };
    }
    let rows_of = |c: &Chunk<'_>| c.rows.len();
    match kind {
        // 값이 전혀 없는 컬럼은 pandas 처럼 float(NaN)
        Kind::Null => Arc::new(Float64Array::new_null(total)),
        Kind::Int => {
            let mut v = Vec::with_capacity(total);
            let mut ok = Vec::with_capacity(total);
            for c in chunks {
                match c.pieces.get(j) {
                    Some(Piece::Int(a, o)) => {
                        v.extend_from_slice(a);
                        ok.extend_from_slice(o);
                    }
                    _ => {
                        v.extend(std::iter::repeat_n(0, rows_of(c)));
                        ok.extend(std::iter::repeat_n(false, rows_of(c)));
                    }
                }
            }
            Arc::new(Int64Array::new(v.into(), nulls(ok)))
        }
        Kind::Float => {
            let mut v = Vec::with_capacity(total);
            let mut ok = Vec::with_capacity(total);
            for c in chunks {
                match c.pieces.get(j) {
                    Some(Piece::Float(a, o)) => {
                        v.extend_from_slice(a);
                        ok.extend_from_slice(o);
                    }
                    Some(Piece::Int(a, o)) => {
                        v.extend(a.iter().map(|x| *x as f64));
                        ok.extend_from_slice(o);
                    }
                    _ => {
                        v.extend(std::iter::repeat_n(f64::NAN, rows_of(c)));
                        ok.extend(std::iter::repeat_n(false, rows_of(c)));
                    }
                }
            }
            Arc::new(Float64Array::new(v.into(), nulls(ok)))
        }
        Kind::Bool => {
            let mut v = Vec::with_capacity(total);
            let mut ok = Vec::with_capacity(total);
            for c in chunks {
                match c.pieces.get(j) {
                    Some(Piece::Bool(a, o)) => {
                        v.extend_from_slice(a);
                        ok.extend_from_slice(o);
                    }
                    _ => {
                        v.extend(std::iter::repeat_n(false, rows_of(c)));
                        ok.extend(std::iter::repeat_n(false, rows_of(c)));
                    }
                }
            }
            Arc::new(BooleanArray::new(BooleanBuffer::from(v), nulls(ok)))
        }
        Kind::Str => {
            let mut b = StringBuilder::with_capacity(total, total * 8);
            for c in chunks {
                match c.pieces.get(j) {
                    Some(Piece::Str(a)) => {
                        for s in a {
                            b.append_option(if is_na(s) { None } else { Some(*s) });
                        }
                    }
                    Some(Piece::Null(_)) | None => {
                        for _ in 0..rows_of(c) {
                            b.append_null();
                        }
                    }
                    Some(_) => {
                        // 이 조각은 숫자였지만 다른 조각에 문자열이 있음 → 원문 그대로
                        for r in 0..rows_of(c) {
                            let s = c.rows.field(r, j);
                            b.append_option(if is_na(s) { None } else { Some(s) });
                        }
                    }
                }
            }
            Arc::new(b.finish())
        }
    }
}

fn nulls(ok: Vec<bool>) -> Option<NullBuffer> {
    let nb = NullBuffer::new(BooleanBuffer::from(ok));
    if nb.null_count() == 0 {
        None
    } else {
        Some(nb)
    }
}

fn header_names(h: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (i, raw) in h.enumerate() {
        let base = if raw.is_empty() { format!("Unnamed: {i}") } else { raw };
        let mut name = base.clone();
        if used.contains(&name) {
            let n = seen.entry(base.clone()).or_insert(0);
            loop {
                *n += 1;
                name = format!("{base}.{n}");
                if !used.contains(&name) {
                    break;
                }
            }
        }
        used.insert(name.clone());
        out.push(name);
    }
    out
}

fn trim_eol(line: &str) -> &str {
    let l = line.strip_suffix('\n').unwrap_or(line);
    l.strip_suffix('\r').unwrap_or(l)
}

// ---------------- 진입점 ----------------

pub fn parse(text: &str, opts: &Options) -> Result<Parsed, String> {
    let mut meta = Vec::new();
    // skip_rows / meta 줄은 CSV 해석 전에 걸러냄
    let owned: String;
    let body: &str = if opts.skip_rows > 0 || opts.meta_prefix.is_some() {
        let mut out = String::with_capacity(text.len());
        for (i, line) in text.split_inclusive('\n').enumerate() {
            if i < opts.skip_rows {
                continue;
            }
            if let Some(p) = &opts.meta_prefix {
                if line.starts_with(p.as_str()) {
                    let l = line[p.len()..].trim();
                    let (k, v) = l.split_once('=').unwrap_or((l, ""));
                    meta.push((k.trim().to_string(), v.trim().to_string()));
                    continue;
                }
            }
            out.push_str(line);
        }
        owned = out;
        &owned
    } else {
        text
    };
    let trace = std::env::var_os("PRISM_TRACE").is_some();
    let t0 = std::time::Instant::now();
    let records: Vec<csv::StringRecord>;
    let (names, chunks) = if body.contains('"') {
        records = quoted_records(body, opts)?;
        split_quoted(&records, opts)?
    } else {
        split_plain(body, opts)?
    };
    if trace {
        eprintln!("csv: split+parse {:?} ({} chunks)", t0.elapsed(), chunks.len());
    }
    let width = if opts.header { names.len() } else { chunks.iter().map(|c| c.pieces.len()).max().unwrap_or(0) };
    let names = if opts.header { names } else { (0..width).map(|i| i.to_string()).collect() };
    let total: usize = chunks.iter().map(|c| c.rows.len()).sum();
    let t1 = std::time::Instant::now();
    let cols: Vec<ArrayRef> = (0..width).into_par_iter().map(|j| merge_column(&chunks, j, total)).collect();
    if trace {
        eprintln!("csv: merge {:?}", t1.elapsed());
    }
    debug_assert!(chunks.iter().all(|c| c.pieces.iter().all(|p| p.len() == c.rows.len())));
    Ok(Parsed { frame: Frame::new(names, cols, total), meta })
}

fn is_comment(line: &str, opts: &Options) -> bool {
    opts.comment.map(|c| line.as_bytes().first() == Some(&c)).unwrap_or(false)
}

/// 따옴표 없는 텍스트
fn split_plain<'a>(body: &'a str, opts: &Options) -> Result<(Vec<String>, Vec<Chunk<'a>>), String> {
    let sep = opts.sep as char;
    let mut header_end = 0usize;
    let mut names = Vec::new();
    if opts.header {
        let mut found = false;
        for line in body.split_inclusive('\n') {
            header_end += line.len();
            let l = trim_eol(line);
            if l.is_empty() || is_comment(l, opts) {
                continue;
            }
            names = header_names(l.split(sep).map(String::from));
            found = true;
            break;
        }
        if !found {
            return Ok((vec![], vec![]));
        }
    }
    let data = &body[header_end..];
    let header_lines = body[..header_end].matches('\n').count();
    // 줄 경계에서 스레드 수만큼 자르기 (1MB 미만이면 하나)
    let n = if data.len() < (1 << 20) { 1 } else { rayon::current_num_threads() };
    let bytes = data.as_bytes();
    let step = (data.len() / n.max(1)).max(1);
    let mut pieces: Vec<&str> = Vec::new();
    let mut start = 0usize;
    while start < data.len() {
        let mut end = (start + step).min(data.len());
        while end < data.len() && bytes[end - 1] != b'\n' {
            end += 1;
        }
        pieces.push(&data[start..end]);
        start = end;
    }
    let width = names.len();
    let mut chunks: Vec<Chunk<'a>> = pieces
        .par_iter()
        .map(|piece| {
            // 데이터 줄과 각 줄의 (조각 안) 줄 번호
            let mut lines = Vec::new();
            let mut line_no = Vec::new();
            let mut count = 0usize;
            for line in piece.split_inclusive('\n') {
                count += 1;
                let l = trim_eol(line);
                if l.is_empty() || is_comment(l, opts) {
                    continue;
                }
                lines.push(l);
                line_no.push(count);
            }
            let mut c = fill_chunk(Rows::Lines(lines, sep), width, !opts.header, |r| line_no[r]);
            c.lines_seen = count;
            c
        })
        .collect();
    // 줄 번호를 파일 기준으로 (오류 메시지용)
    let mut before = header_lines + opts.skip_rows;
    for c in chunks.iter_mut() {
        if let Some((l, saw)) = c.too_wide {
            return Err(format!("Error tokenizing data. Expected {} fields in line {}, saw {}", width, before + l, saw));
        }
        before += c.lines_seen;
    }
    Ok((names, chunks))
}

fn quoted_records(body: &str, opts: &Options) -> Result<Vec<csv::StringRecord>, String> {
    let mut rb = csv::ReaderBuilder::new();
    rb.delimiter(opts.sep).has_headers(false).flexible(true).comment(opts.comment);
    let mut rdr = rb.from_reader(body.as_bytes());
    let mut out = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("CSV parse error: {e}"))?;
        if rec.is_empty() || (rec.len() == 1 && rec[0].is_empty()) {
            continue; // 빈 줄
        }
        out.push(rec);
    }
    Ok(out)
}

fn split_quoted<'a>(records: &'a [csv::StringRecord], opts: &Options) -> Result<(Vec<String>, Vec<Chunk<'a>>), String> {
    let (names, data): (Vec<String>, &[csv::StringRecord]) = if opts.header {
        match records.first() {
            None => return Ok((vec![], vec![])),
            Some(h) => (header_names(h.iter().map(String::from)), &records[1..]),
        }
    } else {
        (vec![], records)
    };
    let width = names.len();
    // 레코드 묶음 단위로 동시에 해석
    let step = data.len().div_ceil(rayon::current_num_threads()).max(4096);
    let mut chunks: Vec<Chunk<'a>> = data
        .par_chunks(step.max(1))
        .map(|part| fill_chunk(Rows::Records(part), width, !opts.header, |r| part[r].position().map(|p| p.line() as usize).unwrap_or(0)))
        .collect();
    for c in chunks.iter_mut() {
        if let Some((l, saw)) = c.too_wide {
            return Err(format!("Error tokenizing data. Expected {} fields in line {}, saw {}", width, l + opts.skip_rows, saw));
        }
    }
    Ok((names, chunks))
}
