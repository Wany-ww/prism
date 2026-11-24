"""데모용 설비 로그 생성기.

공정 흐름: Blade 조립기(#1,#2) → 구동 검사기(#1~#3) → EOL(#1)
- Blade 조립기: 날짜 폴더 + 시간별 파일   logs/blade_0N/YYYYMMDD/Blade_YYYYMMDD_HH.csv
- 구동 검사기: 날짜 포함 파일명 + 메타 헤더 logs/drive_0N/DriveTest_YYYYMMDD.csv
- EOL        : 날짜 포함 파일명, cp949      logs/eol_01/EOL_YYYY-MM-DD.csv
트레이(40개 x 20포지션)는 재사용되므로 Tray No/Position 만으로는 중복 매칭된다 → 시간 기준 매칭 필요.
핀 위치 편차가 F14 Area / F1440 Area 에 선형 영향을 주도록 생성.
"""

import csv
import random
import shutil
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

TRAYS, POSITIONS = 40, 20


def generate(out_dir: Path, days: int = 3, cycle_sec: float = 150, seed: int = 7, now: datetime | None = None) -> Path:
    rnd = random.Random(seed)
    now = (now or datetime.now()).replace(microsecond=0)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0)
    if out_dir.exists():
        shutil.rmtree(out_dir)

    blade_rows = defaultdict(list)  # (machine, date, hour) -> rows
    drive_rows = defaultdict(list)  # (machine, date) -> rows
    eol_rows = defaultdict(list)  # date -> rows
    seq_by_day = defaultdict(int)

    t = start
    slot = 0
    while t < now:
        tray = slot // POSITIONS % TRAYS + 1
        pos = slot % POSITIONS + 1
        slot += 1
        blade_m = 1 if tray % 2 else 2
        bx = rnd.gauss(0, 0.012) + (0.004 if blade_m == 2 else 0)
        by = rnd.gauss(0, 0.012)
        rx = rnd.gauss(0, 0.010)
        ry = rnd.gauss(0, 0.010) - (0.003 if blade_m == 2 else 0)
        tray_no = f"TR{tray:04d}"
        blade_rows[(blade_m, t.strftime("%Y%m%d"), t.hour)].append(
            {
                "DateTime": t.strftime("%Y-%m-%d %H:%M:%S"),
                "Model": "CM-A12",
                "Tray No": tray_no,
                "Tray Position": pos,
                "base_pin_x": round(12.500 + bx, 4),
                "base_pin_y": round(8.200 + by, 4),
                "rotate_pin_x": round(5.750 + rx, 4),
                "rotate_pin_y": round(3.100 + ry, 4),
                "Press_N": round(rnd.gauss(42, 1.5), 2),
                "Result": "OK" if abs(bx) < 0.04 and abs(rx) < 0.035 else "NG",
            }
        )

        t_drive = t + timedelta(minutes=rnd.uniform(25, 80))
        if t_drive < now:
            day = t_drive.strftime("%y%m%d")
            seq_by_day[day] += 1
            vaid = f"VA{day}{seq_by_day[day]:05d}"
            f14 = 96.0 - 420 * bx + 260 * ry - 90 * abs(rx) + rnd.gauss(0, 1.1)
            judge = "PASS" if f14 > 88 else "FAIL"
            drive_m = rnd.choice([1, 2, 3])
            drive_rows[(drive_m, t_drive.strftime("%Y%m%d"))].append(
                {
                    "Date": t_drive.strftime("%Y/%m/%d"),
                    "Time": t_drive.strftime("%H:%M:%S"),
                    "QRCODE": tray_no,
                    "Position No": pos,
                    "VAID": vaid,
                    "F14 Area": round(f14, 3),
                    "F14 Peak": round(f14 * 0.42 + rnd.gauss(0, 0.6), 3),
                    "Current_mA": round(rnd.gauss(118, 4) + (3 if drive_m == 3 else 0), 2),
                    "Judge": judge,
                }
            )
            t_eol = t_drive + timedelta(minutes=rnd.uniform(40, 200))
            if judge == "PASS" and t_eol < now and rnd.random() > 0.02:
                f1440 = 0.82 * f14 + 14.0 - 300 * rx + rnd.gauss(0, 0.9)
                eol_rows[t_eol.strftime("%Y-%m-%d")].append(
                    {
                        "검사시간": t_eol.strftime("%Y-%m-%d %H:%M:%S"),
                        "VAID": vaid,
                        "F1440 Area": round(f1440, 3),
                        "MTF_C": round(rnd.gauss(0.62, 0.02) + 0.002 * (f1440 - 93), 4),
                        "MTF_E": round(rnd.gauss(0.48, 0.025), 4),
                        "판정": "OK" if f1440 > 86 else "NG",
                    }
                )
        t += timedelta(seconds=rnd.uniform(0.6, 1.4) * cycle_sec)

    for (m, d, h), rows in blade_rows.items():
        _write(out_dir / f"blade_{m:02d}" / d / f"Blade_{d}_{h:02d}.csv", rows, "utf-8")
    for (m, d), rows in drive_rows.items():
        p = out_dir / f"drive_{m:02d}" / f"DriveTest_{d}.csv"
        meta = [f"#Machine=DRV-{m:02d}", "#Recipe=CM-A12_DRV_v3", f"#Created={d}"]
        _write(p, sorted(rows, key=lambda r: r["Time"]), "utf-8", meta)
    for d, rows in eol_rows.items():
        _write(out_dir / "eol_01" / f"EOL_{d}.csv", sorted(rows, key=lambda r: r["검사시간"]), "cp949")
    return out_dir


def _write(path: Path, rows: list[dict], encoding: str, meta: list[str] | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding=encoding) as f:
        for line in meta or []:
            f.write(line + "\n")
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "demo" / "logs"
    print(generate(target))
