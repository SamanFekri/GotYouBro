#!/usr/bin/env python3
"""GotYouBro heartbeat client for Python 3.8+ (standard library only).

    GOTYOUBRO_URL=https://gotyoubro.example.com GOTYOUBRO_TOKEN=gyb_... python3 heartbeat.py
    python3 heartbeat.py --once        # single heartbeat, e.g. at the end of a cron job
    GOTYOUBRO_MONITOR=worker python3 heartbeat.py   # heartbeat for the "worker" monitor

To use it inside your app, import `start_heartbeat` and call it once at startup; it runs in a
daemon thread and never raises.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("GOTYOUBRO_URL", "http://localhost:6969").rstrip("/")
TOKEN = os.environ.get("GOTYOUBRO_TOKEN", "")
INTERVAL_SECONDS = float(os.environ.get("GOTYOUBRO_INTERVAL", "30"))
# Optional monitor key (a service can have several monitors: api, worker, nightly-job...).
MONITOR = os.environ.get("GOTYOUBRO_MONITOR", "")


def send_heartbeat() -> dict:
    """Send one heartbeat. Returns the response data; raises on failure."""
    request = urllib.request.Request(
        f"{BASE_URL}/api/v1/health/heartbeat" + (f"/{urllib.parse.quote(MONITOR)}" if MONITOR else ""),
        method="POST",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)["data"]
    except urllib.error.HTTPError as err:
        try:
            error = json.load(err).get("error", {})
        except ValueError:
            error = {}
        raise RuntimeError(f"{err.code} {error.get('code', '')} {error.get('message', '')}".strip()) from None


def start_heartbeat(interval_seconds: float = INTERVAL_SECONDS) -> threading.Event:
    """Send heartbeats in a background thread. Set the returned event to stop."""
    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            try:
                data = send_heartbeat()
                suffix = " (recovered)" if data.get("recovered") else ""
                print(f"[heartbeat] {time.strftime('%Y-%m-%dT%H:%M:%S')} {data['healthStatus']}{suffix}", flush=True)
            except Exception as exc:  # monitoring must never take your app down
                print(f"[heartbeat] failed: {exc}", file=sys.stderr, flush=True)
            stop.wait(interval_seconds)

    threading.Thread(target=loop, name="gotyoubro-heartbeat", daemon=True).start()
    return stop


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("Set GOTYOUBRO_TOKEN (and GOTYOUBRO_URL).")
    if "--once" in sys.argv:
        try:
            print(f"heartbeat ok: {send_heartbeat()['healthStatus']}")
        except Exception as exc:
            sys.exit(f"heartbeat failed: {exc}")
    else:
        start_heartbeat()
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
