"""웹훅 알림: 설비 수집 실패/복구, Flow 실행 실패/복구를 Slack 등 incoming-webhook 호환 URL로 보낸다.

PRISM_ALERT_WEBHOOK 이 비어 있으면(기본값) send_alert 는 아무 것도 하지 않는다.
요청은 백그라운드 스레드에서 보내고 실패해도 예외를 올리지 않는다 (수집/Flow 실행을 절대 막지 않음).
"""

import json
import logging
import threading
import time
import urllib.request
from urllib.error import URLError

from .config import ALERT_MIN_INTERVAL_SEC, ALERT_WEBHOOK

log = logging.getLogger("prism.alerts")

_last_sent: dict[str, float] = {}
_lock = threading.Lock()


def _post(url: str, payload: dict):
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=8)
    except (URLError, OSError, ValueError) as e:
        log.warning("alert webhook failed: %s", e)


def send_alert(kind: str, title: str, detail: str = "", key: str | None = None) -> None:
    """비동기로 웹훅에 알림을 보낸다.

    key 를 주면 같은 key 는 PRISM_ALERT_MIN_INTERVAL_SEC(기본 5분) 안에 한 번만 보내서,
    상태가 자주 바뀌는(flapping) 설비/Flow 가 알림을 스팸하지 않게 한다.
    """
    if not ALERT_WEBHOOK:
        return
    dedupe_key = key or kind
    now = time.time()
    with _lock:
        last = _last_sent.get(dedupe_key, 0)
        if now - last < ALERT_MIN_INTERVAL_SEC:
            return
        _last_sent[dedupe_key] = now
    text = f"*[PRISM] {title}*" + (f"\n{detail}" if detail else "")
    # Slack incoming-webhook 과 호환되는 가장 단순한 형태 ({"text": ...}); 다른 수신 서버도 대개 이 필드를 본다.
    threading.Thread(target=_post, args=(ALERT_WEBHOOK, {"text": text[:3900]}), daemon=True).start()
