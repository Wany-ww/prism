//! PRISM 수집 에이전트 (별도 LAN 설비용). 실행 파일 하나로 동작하며 Python 등 설치가 필요 없다.
//!
//! 서버가 직접 접근할 수 없는 설비(대표 설비 PC / 작업 PC 뒤 별도 LAN)의 로그를
//! 게이트웨이 PC에서 찾아 서버로 업로드한다. 경로/패턴/주기는 서버 GUI 설정을 그대로 받아 쓴다.
//!
//! 사용 예)
//!   prism-agent.exe --server http://10.0.0.5:8000 --equipment "Blade 조립기 #2" --equipment "Blade 조립기 #3"
//!   prism-agent.exe --server http://10.0.0.5:8000 --equipment "EOL 설비 #1" --once
//! 옵션: --token (서버 PRISM_AGENT_TOKEN 설정 시, 환경변수 PRISM_AGENT_TOKEN 으로도 가능)

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const USAGE: &str = "PRISM log agent

usage: prism-agent --server URL --equipment NAME [--equipment NAME ...] [--token TOKEN] [--once]

  --server     PRISM 서버 주소 (예: http://10.0.0.5:8000)
  --equipment  서버에 등록된 설비명 (여러 번 지정 가능)
  --token      서버의 PRISM_AGENT_TOKEN (환경변수 PRISM_AGENT_TOKEN 으로도 지정 가능)
  --once       한 번만 동기화하고 종료";

struct Args {
    server: String,
    equipment: Vec<String>,
    token: String,
    once: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut server = None;
    let mut equipment = Vec::new();
    let mut token = std::env::var("PRISM_AGENT_TOKEN").unwrap_or_default();
    let mut once = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let (key, inline) = match a.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
            _ => (a.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            inline.clone().or_else(|| it.next()).ok_or_else(|| format!("{name} needs a value"))
        };
        match key.as_str() {
            "--server" => server = Some(value("--server")?),
            "--equipment" => equipment.push(value("--equipment")?),
            "--token" => token = value("--token")?,
            "--once" => once = true,
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("unknown option: {other}")),
        }
    }
    let server = server.ok_or("--server is required")?;
    if equipment.is_empty() {
        return Err("--equipment is required".into());
    }
    Ok(Args { server: server.trim_end_matches('/').to_string(), equipment, token, once })
}

fn log(msg: &str) {
    println!("{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn check(resp: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let status = resp.status();
    let mut resp = resp;
    let body = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("detail").map(|d| d.to_string()))
            .unwrap_or(body);
        return Err(format!("HTTP {}: {}", status.as_u16(), detail));
    }
    serde_json::from_str(&body).map_err(|e| format!("bad JSON from server: {e}"))
}

fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn get_config(http: &ureq::Agent, args: &Args, equipment: &str) -> Result<Value, String> {
    let url = format!("{}/api/agent/config?equipment={}", args.server, encode(equipment));
    let mut req = http.get(&url);
    if !args.token.is_empty() {
        req = req.header("X-Agent-Token", &args.token);
    }
    check(req.call().map_err(|e| e.to_string())?)
}

struct FileInfo {
    size: u64,
    mtime: f64,
}

fn upload(http: &ureq::Agent, args: &Args, equipment: &str, path: &str, st: &FileInfo) -> Result<Value, String> {
    let content = fs::read(path).map_err(|e| e.to_string())?;
    let boundary = format!("prism{:032x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut body: Vec<u8> = Vec::with_capacity(content.len() + 1024);
    for (k, v) in [
        ("equipment", equipment.to_string()),
        ("path", path.to_string()),
        ("size", st.size.to_string()),
        ("mtime", format!("{}", st.mtime)),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
    }
    let fname = Path::new(path).file_name().map(|n| n.to_string_lossy().replace('"', "_")).unwrap_or_default();
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{fname}\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(&content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut req = http
        .post(&format!("{}/api/agent/upload", args.server))
        .header("Content-Type", &format!("multipart/form-data; boundary={boundary}"));
    if !args.token.is_empty() {
        req = req.header("X-Agent-Token", &args.token);
    }
    check(req.send(&body[..]).map_err(|e| e.to_string())?)
}

/// Python os.path.normpath 와 같은 모양 (서버가 기억하는 경로와 비교하기 위해)
fn normpath(p: &str) -> String {
    let s = p.replace('/', "\\");
    let unc = s.starts_with("\\\\");
    let (prefix, rest) = if unc {
        ("\\\\", &s[2..])
    } else if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = &s[..2];
        let rest = &s[2..];
        return format!("{}{}", drive, normpath_rest(rest, rest.starts_with('\\')));
    } else {
        ("", &s[..])
    };
    format!("{}{}", prefix, normpath_rest(rest, !unc && rest.starts_with('\\')))
}

fn normpath_rest(rest: &str, rooted: bool) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for comp in rest.split('\\') {
        match comp {
            "" | "." => {}
            ".." => {
                if matches!(parts.last(), Some(p) if *p != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            c => parts.push(c),
        }
    }
    let joined = parts.join("\\");
    if rooted {
        format!("\\{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

fn digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// 서버와 같은 규칙: 상위 폴더 아래 경로 숫자를 이어 붙인 값이 날짜(YYYYMMDD/YYMMDD)인 폴더.
fn date_folder_locations(spec: &Value) -> Vec<(String, String)> {
    let keys: BTreeMap<String, String> = spec
        .get("keys")
        .and_then(|k| k.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("*").to_string())).collect())
        .unwrap_or_default();
    let depth = spec.get("depth").and_then(|d| d.as_u64()).unwrap_or(3) as usize;
    let base = spec.get("base").and_then(|b| b.as_str()).unwrap_or("").to_string();
    let mut out = Vec::new();
    fn walk(path: &Path, acc: &str, level: usize, depth: usize, keys: &BTreeMap<String, String>, out: &mut Vec<(String, String)>) {
        if level >= depth {
            return;
        }
        let Ok(rd) = fs::read_dir(path) else { return };
        let mut names: Vec<String> =
            rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let d = format!("{}{}", acc, digits(&name));
            if d == acc {
                continue;
            }
            let child = path.join(&name);
            if let Some(pattern) = keys.get(&d) {
                out.push((child.to_string_lossy().into_owned(), pattern.clone()));
            } else if keys.keys().any(|k| k.starts_with(&d)) {
                walk(&child, &d, level + 1, depth, keys, out);
            }
        }
    }
    walk(Path::new(&base), "", 0, depth, &keys, &mut out);
    out
}

fn find_files(dir: &str, pattern: &str) -> Vec<(String, FileInfo)> {
    let full = format!("{}\\{}", glob::Pattern::escape(dir.trim_end_matches(['\\', '/'])), pattern);
    let mut out = Vec::new();
    let Ok(paths) = glob::glob(&full) else { return out };
    for p in paths.flatten() {
        let Ok(meta) = fs::metadata(&p) else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        out.push((normpath(&PathBuf::from(&p).to_string_lossy()), FileInfo { size: meta.len(), mtime }));
    }
    out
}

fn sync(http: &ureq::Agent, args: &Args, equipment: &str) -> Result<u64, String> {
    let cfg = get_config(http, args, equipment)?;
    let interval = cfg.get("interval_sec").and_then(|v| v.as_u64()).unwrap_or(300);
    if !cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) {
        log(&format!("[{equipment}] 서버에서 수집이 꺼져 있어 건너뜀 (설비 설정에서 Enabled 를 켜세요)"));
        return Ok(interval);
    }
    let parser_hash = cfg.get("parser_hash").cloned().unwrap_or(Value::Null);
    let known = cfg.get("known").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut locations: Vec<(String, String)> = cfg
        .get("locations")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|l| {
                    (
                        l.get("dir").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                        l.get("pattern").and_then(|p| p.as_str()).unwrap_or("*").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(spec) = cfg.get("date_folders").filter(|v| !v.is_null()) {
        locations.extend(date_folder_locations(spec));
    }
    let mut files: BTreeMap<String, FileInfo> = BTreeMap::new();
    for (dir, pattern) in &locations {
        for (p, st) in find_files(dir, pattern) {
            files.insert(p, st);
        }
    }
    let mut order: Vec<(&String, &FileInfo)> = files.iter().collect();
    order.sort_by(|a, b| a.1.mtime.partial_cmp(&b.1.mtime).unwrap_or(std::cmp::Ordering::Equal));
    let mut sent = 0;
    for (path, st) in order {
        if let Some(k) = known.get(path.as_str()).and_then(|v| v.as_array()) {
            let size = k.first().and_then(|v| v.as_u64());
            let mtime = k.get(1).and_then(|v| v.as_f64());
            let phash = k.get(2).cloned().unwrap_or(Value::Null);
            if size == Some(st.size) && mtime.map(|m| (m - st.mtime).abs() < 1e-3).unwrap_or(false) && phash == parser_hash {
                continue;
            }
        }
        match upload(http, args, equipment, path, st) {
            Ok(r) => {
                sent += 1;
                let status = r.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let detail = r.get("rows").map(|v| v.to_string()).or_else(|| r.get("message").and_then(|v| v.as_str()).map(String::from)).unwrap_or_default();
                log(&format!("[{equipment}] {path} -> {status} {detail}"));
            }
            Err(e) => log(&format!("[{equipment}] {path} 업로드 실패: {e}")), // 다음 주기에 재시도
        }
    }
    log(&format!("[{equipment}] 파일 {}개 확인, {}개 전송", files.len(), sent));
    Ok(interval)
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("error: {e}\n");
            }
            eprintln!("{USAGE}");
            std::process::exit(if e.is_empty() { 0 } else { 2 });
        }
    };
    let http = agent();
    loop {
        let mut wait = 300u64;
        for eq in &args.equipment {
            match sync(&http, &args, eq) {
                Ok(w) => wait = wait.min(w),
                Err(e) => {
                    log(&format!("[{eq}] 서버 통신 실패: {e}"));
                    wait = wait.min(60);
                }
            }
        }
        if args.once {
            return;
        }
        std::thread::sleep(Duration::from_secs(wait.max(10)));
    }
}
