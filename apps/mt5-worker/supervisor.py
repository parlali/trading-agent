from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any


def read_float_env(name: str, default: float) -> float:
    value = os.environ.get(name, "").strip()
    if not value:
        return default

    try:
        return float(value)
    except ValueError:
        return default


def read_int_env(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default

    try:
        return int(value)
    except ValueError:
        return default


def log(event: str, **fields: Any) -> None:
    payload = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [supervisor] {event} {payload}".rstrip(), flush=True)


def load_env_file(path: str) -> None:
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", "\""}:
                value = value[1:-1]

            os.environ.setdefault(key, value)


class WorkerSupervisor:
    def __init__(self) -> None:
        self.worker_dir = os.path.dirname(os.path.abspath(__file__))
        load_env_file(os.path.join(self.worker_dir, ".env"))
        self.worker_port = read_int_env("WORKER_PORT", 8090)
        self.worker_access_key = os.environ.get("WORKER_ACCESS_KEY", "").strip()
        self.startup_grace_seconds = read_float_env("WORKER_SUPERVISOR_STARTUP_GRACE_SECONDS", 20.0)
        self.interval_seconds = read_float_env("WORKER_SUPERVISOR_INTERVAL_SECONDS", 5.0)
        self.timeout_seconds = read_float_env("WORKER_SUPERVISOR_TIMEOUT_SECONDS", 3.0)
        self.failure_threshold = max(1, read_int_env("WORKER_SUPERVISOR_FAILURE_THRESHOLD", 2))
        self.restart_delay_seconds = read_float_env("WORKER_SUPERVISOR_RESTART_DELAY_SECONDS", 2.0)
        self.active_operation_grace_seconds = read_float_env("WORKER_SUPERVISOR_ACTIVE_OPERATION_GRACE_SECONDS", 90.0)
        self.state_path = os.environ.get("WORKER_STATE_PATH", "").strip() or os.path.join(
            tempfile.gettempdir(),
            f"valiq-mt5-worker-state-{self.worker_port}.json",
        )
        self.child: subprocess.Popen[bytes] | None = None
        self.stopping = False

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self.handle_stop)
        signal.signal(signal.SIGINT, self.handle_stop)
        log(
            "starting",
            port=self.worker_port,
            intervalSeconds=self.interval_seconds,
            timeoutSeconds=self.timeout_seconds,
            failureThreshold=self.failure_threshold,
            activeOperationGraceSeconds=self.active_operation_grace_seconds,
        )

        while not self.stopping:
            self.child = self.start_child()
            self.monitor_child()

            if self.stopping:
                break

            time.sleep(self.restart_delay_seconds)

        self.stop_child()
        log("stopped")
        return 0

    def handle_stop(self, _signum: int, _frame: Any) -> None:
        self.stopping = True
        self.stop_child()

    def start_child(self) -> subprocess.Popen[bytes]:
        command = [sys.executable, "main.py"]
        child = subprocess.Popen(
            command,
            cwd=self.worker_dir,
            env=os.environ.copy(),
        )
        log("child_started", pid=child.pid)
        return child

    def monitor_child(self) -> None:
        if self.child is None:
            return

        failures = 0
        started_at = time.monotonic()

        while not self.stopping:
            exit_code = self.child.poll()
            if exit_code is not None:
                log("child_exited", pid=self.child.pid, exitCode=exit_code)
                return

            if time.monotonic() - started_at < self.startup_grace_seconds:
                time.sleep(self.interval_seconds)
                continue

            result = self.health_check()
            if result["ok"]:
                if result.get("activeOperation"):
                    log(
                        "health_probe_tolerated_active_operation",
                        operation=result["activeOperation"],
                        ageSeconds=result.get("activeOperationAgeSeconds"),
                    )
                if failures > 0:
                    log("health_recovered", failures=failures)
                failures = 0
            else:
                failures += 1
                log(
                    "health_failed",
                    failures=failures,
                    threshold=self.failure_threshold,
                    error=result["error"],
                )

            if failures >= self.failure_threshold:
                log("child_restart_required", pid=self.child.pid, reason="health_probe_failed")
                self.stop_child()
                return

            time.sleep(self.interval_seconds)

    def health_check(self) -> dict[str, Any]:
        if not self.worker_access_key:
            return {"ok": False, "error": "WORKER_ACCESS_KEY is missing"}

        request = urllib.request.Request(
            f"http://127.0.0.1:{self.worker_port}/health",
            headers={"x-worker-key": self.worker_access_key},
            method="GET",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
                if response.status != 200:
                    return {"ok": False, "error": f"HTTP {response.status}"}
                if body.get("status") != "ok":
                    return {"ok": False, "error": f"worker status {body.get('status')}"}
                return {"ok": True, "error": ""}
        except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError) as exc:
            tolerated = self.active_operation_health()
            if tolerated["ok"]:
                return tolerated
            return {"ok": False, "error": str(exc)}

    def active_operation_health(self) -> dict[str, Any]:
        child = self.child
        if child is None:
            return {"ok": False, "error": "no child process"}

        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            return {"ok": False, "error": f"state unavailable: {exc}"}

        if int(state.get("pid") or 0) != child.pid:
            return {"ok": False, "error": "state belongs to another process"}

        active_operation = state.get("activeOperation")
        started_at = state.get("lastStartedAt")
        if not active_operation or not isinstance(started_at, (int, float)):
            return {"ok": False, "error": "no active operation"}

        age_seconds = max(0.0, time.time() - float(started_at))
        if age_seconds > self.active_operation_grace_seconds:
            return {
                "ok": False,
                "error": f"active operation {active_operation} exceeded supervisor grace",
            }

        return {
            "ok": True,
            "error": "",
            "activeOperation": active_operation,
            "activeOperationAgeSeconds": round(age_seconds, 3),
        }

    def stop_child(self) -> None:
        child = self.child
        self.child = None

        if child is None or child.poll() is not None:
            return

        log("child_stopping", pid=child.pid)
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            child.terminate()

        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


if __name__ == "__main__":
    raise SystemExit(WorkerSupervisor().run())
