//! Match 노드의 짝 찾기. 결과는 (왼쪽 행 번호, 오른쪽 행 번호) 쌍이고 짝이 없으면 -1.
//! 행 순서는 예전 pandas merge / merge_asof 구현과 같다:
//!   inner/left: 왼쪽 행 순서 (같은 키의 오른쪽 행들은 원래 순서), right: 오른쪽 행 순서,
//!   outer: 키를 사전순으로 정렬. asof: 왼쪽 시각순 → (left/outer) 시각 없는 왼쪽 행 → (outer) 안 쓰인 오른쪽 행.

use rustc_hash::FxHashMap;

pub struct Keys {
    pub keys: Vec<String>,
}

/// 컬럼별 키(null 은 None) → 행별 키 문자열. null 은 서로 매칭되지 않도록 고유 값으로 (예전 구현과 같은 값).
pub fn compose(cols: Vec<Vec<Option<String>>>, rows: usize, side: char) -> Keys {
    let mut counters = vec![0usize; cols.len()];
    let mut keys = Vec::with_capacity(rows);
    for i in 0..rows {
        let mut k = String::new();
        for (j, col) in cols.iter().enumerate() {
            if j > 0 {
                k.push('\u{1}');
            }
            match &col[i] {
                Some(s) => k.push_str(s),
                None => {
                    k.push_str(&format!("\u{0}null{}{}", side, counters[j]));
                    counters[j] += 1;
                }
            }
        }
        keys.push(k);
    }
    Keys { keys }
}

fn groups(keys: &[String], rows: &[usize]) -> FxHashMap<String, Vec<usize>> {
    let mut m: FxHashMap<String, Vec<usize>> = FxHashMap::default();
    for &r in rows {
        m.entry(keys[r].clone()).or_default().push(r);
    }
    m
}

pub fn exact(left: &Keys, right: &Keys, how: &str, duplicates: &str) -> (Vec<i64>, Vec<i64>) {
    let nl = left.keys.len();
    let nr = right.keys.len();
    // duplicates=first/last: 같은 키의 오른쪽 행은 하나만 (나머지는 아예 없는 것으로)
    let right_rows: Vec<usize> = match duplicates {
        "first" | "last" => {
            let mut pick: FxHashMap<&str, usize> = FxHashMap::default();
            for r in 0..nr {
                let e = pick.entry(right.keys[r].as_str()).or_insert(r);
                if duplicates == "last" {
                    *e = r;
                }
            }
            let mut v: Vec<usize> = pick.into_values().collect();
            v.sort_unstable();
            v
        }
        _ => (0..nr).collect(),
    };
    let mut li = Vec::new();
    let mut ri = Vec::new();
    match how {
        "inner" | "left" => {
            let rmap = groups(&right.keys, &right_rows);
            for l in 0..nl {
                match rmap.get(&left.keys[l]) {
                    Some(rs) => {
                        for &r in rs {
                            li.push(l as i64);
                            ri.push(r as i64);
                        }
                    }
                    None if how == "left" => {
                        li.push(l as i64);
                        ri.push(-1);
                    }
                    None => {}
                }
            }
        }
        "right" => {
            let all_left: Vec<usize> = (0..nl).collect();
            let lmap = groups(&left.keys, &all_left);
            for &r in &right_rows {
                match lmap.get(&right.keys[r]) {
                    Some(ls) => {
                        for &l in ls {
                            li.push(l as i64);
                            ri.push(r as i64);
                        }
                    }
                    None => {
                        li.push(-1);
                        ri.push(r as i64);
                    }
                }
            }
        }
        _ => {
            // outer: 키 합집합을 사전순으로
            let all_left: Vec<usize> = (0..nl).collect();
            let lmap = groups(&left.keys, &all_left);
            let rmap = groups(&right.keys, &right_rows);
            let mut all: Vec<&String> = lmap.keys().chain(rmap.keys().filter(|k| !lmap.contains_key(*k))).collect();
            // 키가 여러 개면 컬럼별로 비교 (pandas 의 튜플 정렬과 같게: ("", x) 가 ("\0null..", y) 보다 앞)
            all.sort_unstable_by(|a, b| a.split('\u{1}').cmp(b.split('\u{1}')));
            for k in all {
                match (lmap.get(k), rmap.get(k)) {
                    (Some(ls), Some(rs)) => {
                        for &l in ls {
                            for &r in rs {
                                li.push(l as i64);
                                ri.push(r as i64);
                            }
                        }
                    }
                    (Some(ls), None) => {
                        for &l in ls {
                            li.push(l as i64);
                            ri.push(-1);
                        }
                    }
                    (None, Some(rs)) => {
                        for &r in rs {
                            li.push(-1);
                            ri.push(r as i64);
                        }
                    }
                    (None, None) => {}
                }
            }
        }
    }
    (li, ri)
}

pub const NAT: i64 = i64::MIN;

/// direction: backward(이전 중 가장 가까운) / forward(이후 중 가장 가까운) / nearest. tolerance 는 마이크로초.
pub fn asof(
    left: &Keys,
    right: &Keys,
    lt: &[i64],
    rt: &[i64],
    how: &str,
    direction: &str,
    tolerance: Option<i64>,
) -> (Vec<i64>, Vec<i64>) {
    let nl = left.keys.len();
    let nr = right.keys.len();
    // 시각이 있는 오른쪽 행만, 키별로 시각순 (같은 시각은 원래 순서)
    let r_valid: Vec<usize> = (0..nr).filter(|&r| rt[r] != NAT).collect();
    let mut rgroups: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    for &r in &r_valid {
        rgroups.entry(right.keys[r].as_str()).or_default().push(r);
    }
    for g in rgroups.values_mut() {
        g.sort_by_key(|&r| rt[r]);
    }
    let mut l_ok: Vec<usize> = (0..nl).filter(|&l| lt[l] != NAT).collect();
    l_ok.sort_by_key(|&l| lt[l]);
    let within = |d: i64| tolerance.map(|t| d <= t).unwrap_or(true);

    let find = |l: usize| -> Option<usize> {
        let g = rgroups.get(left.keys[l].as_str())?;
        let t = lt[l];
        let back = {
            let pos = g.partition_point(|&r| rt[r] <= t);
            if pos > 0 {
                let r = g[pos - 1];
                within(t - rt[r]).then_some(r)
            } else {
                None
            }
        };
        let fwd = {
            let pos = g.partition_point(|&r| rt[r] < t);
            if pos < g.len() {
                let r = g[pos];
                within(rt[r] - t).then_some(r)
            } else {
                None
            }
        };
        match direction {
            "backward" => back,
            "forward" => fwd,
            _ => match (back, fwd) {
                (Some(b), Some(f)) => {
                    // 거리가 같으면 이전 쪽 (pandas 와 같음)
                    if t - rt[b] <= rt[f] - t {
                        Some(b)
                    } else {
                        Some(f)
                    }
                }
                (b, f) => b.or(f),
            },
        }
    };

    let mut li = Vec::with_capacity(l_ok.len());
    let mut ri = Vec::with_capacity(l_ok.len());
    let mut used = vec![false; nr];
    for &l in &l_ok {
        match find(l) {
            Some(r) => {
                li.push(l as i64);
                ri.push(r as i64);
                used[r] = true;
            }
            None if how != "inner" => {
                li.push(l as i64);
                ri.push(-1);
            }
            None => {}
        }
    }
    if how != "inner" {
        for l in (0..nl).filter(|&l| lt[l] == NAT) {
            li.push(l as i64);
            ri.push(-1);
        }
        if how == "outer" {
            for &r in &r_valid {
                if !used[r] {
                    li.push(-1);
                    ri.push(r as i64);
                }
            }
        }
    }
    (li, ri)
}
