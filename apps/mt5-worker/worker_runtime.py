from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

import structlog

from mt5_client import MT5Client
from mt5_errors import MT5ConnectionError
from worker_contracts import (
    BlockingOperationTimeout,
    raise_blocking_operation_http_error,
    raise_mt5_connection_http_error,
    raise_worker_http_error,
)

log = structlog.get_logger()


RECOVERABLE_READ_OPERATIONS = {
    "account",
    "positions",
    "orders",
    "position_closures",
    "symbol_info",
    "order_status",
}

RECOVERABLE_CONNECTION_ERRORS = {
    "not_connected",
    "session_lost",
    "query_failed",
}


class MT5WorkerRuntime:
    def __init__(self, settings: Any):
        self.settings = settings
        self.client: MT5Client | None = None
        self.terminal_blocked = False
        self.state: dict[str, Any] = {
            "status": "disconnected",
            "activeOperation": None,
            "lastError": None,
            "lastStartedAt": None,
            "lastFinishedAt": None,
        }
        self._watchdog_stop: threading.Event | None = None
        self._watchdog_thread: threading.Thread | None = None
        self._operation_lock: asyncio.Lock | None = None
        self._connect_lock: asyncio.Lock | None = None
        self._executor: ThreadPoolExecutor | None = None

    def assert_expected_repo_path(self) -> None:
        if os.name != "nt":
            return

        expected_suffix = self.settings.worker_expected_repo_suffix.strip()
        if not expected_suffix:
            return

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        expected_parts = tuple(part.lower() for part in expected_suffix.replace("/", "\\").split("\\") if part)
        root_parts = tuple(part.lower() for part in repo_root.replace("/", "\\").split("\\") if part)

        if expected_parts and root_parts[-len(expected_parts):] != expected_parts:
            self.terminate_for_restart(
                "worker_repo_path_mismatch",
                {
                    "repoRoot": repo_root,
                    "expectedSuffix": expected_suffix,
                },
            )

    def startup(self) -> None:
        self.assert_expected_repo_path()
        log.info("mt5_worker_starting", port=self.settings.worker_port)
        self.install_loop_exception_handler()
        self.start_listener_watchdog()

    def terminate_for_restart(self, reason: str, details: dict[str, Any] | None = None) -> None:
        log.critical(
            "mt5_worker_restart_required",
            reason=reason,
            **(details or {}),
        )
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(70)

    def install_loop_exception_handler(self) -> None:
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()

        def handle_exception(
            active_loop: asyncio.AbstractEventLoop,
            context: dict[str, Any],
        ) -> None:
            if self.is_worker_accept_socket_failure(context):
                exception = context.get("exception")
                self.terminate_for_restart(
                    "worker_accept_socket_failed",
                    {
                        "message": str(context.get("message", "")),
                        "exceptionType": type(exception).__name__ if exception else None,
                        "exception": str(exception) if exception else None,
                        "port": self.settings.worker_port,
                    },
                )

            if previous_handler:
                previous_handler(active_loop, context)
            else:
                active_loop.default_exception_handler(context)

        loop.set_exception_handler(handle_exception)

    def is_worker_accept_socket_failure(self, context: dict[str, Any]) -> bool:
        message = str(context.get("message", ""))
        if "Accept failed on a socket" not in message:
            return False

        socket_obj = context.get("socket")
        if socket_obj is None:
            return True

        try:
            local_address = socket_obj.getsockname()
        except OSError:
            return True

        if not isinstance(local_address, tuple) or len(local_address) < 2:
            return True

        return int(local_address[1]) == self.settings.worker_port

    def start_listener_watchdog(self) -> None:
        if not self.settings.worker_listener_watchdog_enabled:
            log.info("mt5_listener_watchdog_disabled")
            return

        if self._watchdog_thread is not None:
            return

        stop_event = threading.Event()
        thread = threading.Thread(
            target=self.run_listener_watchdog,
            args=(stop_event,),
            name="mt5-listener-watchdog",
            daemon=True,
        )
        self._watchdog_stop = stop_event
        self._watchdog_thread = thread
        thread.start()

    def stop_listener_watchdog(self) -> None:
        if self._watchdog_stop is not None:
            self._watchdog_stop.set()

        if self._watchdog_thread is not None:
            self._watchdog_thread.join(timeout=2.0)

        self._watchdog_stop = None
        self._watchdog_thread = None

    def run_listener_watchdog(self, stop_event: threading.Event) -> None:
        if stop_event.wait(self.settings.worker_listener_watchdog_startup_grace_seconds):
            return

        failures = 0
        threshold = max(1, self.settings.worker_listener_watchdog_failure_threshold)

        while not stop_event.is_set():
            if self.can_connect_worker_listener():
                if failures > 0:
                    log.info("mt5_listener_watchdog_recovered", failures=failures)
                failures = 0
            else:
                failures += 1
                log.error(
                    "mt5_listener_watchdog_failed",
                    failures=failures,
                    threshold=threshold,
                    host=self.resolve_listener_probe_host(),
                    port=self.settings.worker_port,
                )
                if failures >= threshold:
                    self.terminate_for_restart(
                        "worker_listener_not_accepting",
                        {
                            "failures": failures,
                            "threshold": threshold,
                            "host": self.resolve_listener_probe_host(),
                            "port": self.settings.worker_port,
                        },
                    )

            stop_event.wait(self.settings.worker_listener_watchdog_interval_seconds)

    def can_connect_worker_listener(self) -> bool:
        try:
            with socket.create_connection(
                (self.resolve_listener_probe_host(), self.settings.worker_port),
                timeout=self.settings.worker_listener_watchdog_timeout_seconds,
            ):
                return True
        except OSError:
            return False

    def resolve_listener_probe_host(self) -> str:
        host = self.settings.worker_host.strip()
        if host in {"", "0.0.0.0", "::", "[::]"}:
            return "127.0.0.1"
        return host

    def reset_state(self) -> None:
        self.terminal_blocked = False
        self.state.update({
            "status": "disconnected",
            "activeOperation": None,
            "lastError": None,
            "lastStartedAt": None,
            "lastFinishedAt": None,
        })

    def health(self) -> dict[str, Any]:
        connected = self.client is not None and self.client._connected and not self.terminal_blocked
        return {
            "status": "degraded" if self.terminal_blocked else "ok",
            "connected": connected,
            "login": self.client.login if self.client else None,
            "workerState": {
                **self.state,
                "terminalBlocked": self.terminal_blocked,
            },
        }

    def require_client(self) -> MT5Client:
        if self.terminal_blocked:
            raise_worker_http_error(
                "MT5 terminal IPC is blocked after a timed-out SDK operation. Restart the worker before trading.",
                "terminal_blocked",
                False,
            )
        if self.client is None:
            raise_worker_http_error(
                "MT5 not connected. Call POST /connect first.",
                "not_connected",
                False,
            )
        return self.client

    def _operation_status(self) -> str:
        return "connected" if self.client is not None and self.client._connected else "disconnected"

    def _operation_lock_instance(self) -> asyncio.Lock:
        if self._operation_lock is None:
            self._operation_lock = asyncio.Lock()
        return self._operation_lock

    def _connect_lock_instance(self) -> asyncio.Lock:
        if self._connect_lock is None:
            self._connect_lock = asyncio.Lock()
        return self._connect_lock

    def _executor_instance(self) -> ThreadPoolExecutor:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mt5-sdk")
        return self._executor

    async def run_operation(
        self,
        operation: str,
        func: Callable[[], Any],
        timeout_seconds: float | None = None,
    ) -> Any:
        if self.terminal_blocked:
            raise_worker_http_error(
                "MT5 terminal IPC is blocked after a timed-out SDK operation. Restart the worker before trading.",
                "terminal_blocked",
                False,
            )

        lock = self._operation_lock_instance()
        if lock.locked():
            raise_worker_http_error(
                f"MT5 operation already in progress: {self.state.get('activeOperation')}",
                "operation_in_progress",
                True,
                details={
                    "activeOperation": self.state.get("activeOperation"),
                },
            )

        timeout = timeout_seconds if timeout_seconds is not None else self.settings.mt5_operation_timeout_seconds
        async with lock:
            started_at = time.time()
            self.state.update({
                "status": "busy",
                "activeOperation": operation,
                "lastError": None,
                "lastStartedAt": started_at,
                "lastFinishedAt": None,
            })
            try:
                loop = asyncio.get_running_loop()
                result = await asyncio.wait_for(
                    loop.run_in_executor(self._executor_instance(), func),
                    timeout=timeout,
                )
                self.state.update({
                    "status": self._operation_status(),
                    "activeOperation": None,
                    "lastFinishedAt": time.time(),
                })
                return result
            except (TimeoutError, asyncio.TimeoutError) as exc:
                self.terminal_blocked = True
                self.state.update({
                    "status": "degraded",
                    "activeOperation": None,
                    "lastError": f"{operation} timed out after {timeout:.1f}s",
                    "lastFinishedAt": time.time(),
                })
                elapsed = time.time() - started_at
                log.error(
                    "mt5_blocking_operation_timeout",
                    operation=operation,
                    timeout_seconds=timeout,
                    elapsed_seconds=elapsed,
                )
                self.terminate_for_restart(
                    "mt5_sdk_operation_timeout",
                    {
                        "operation": operation,
                        "timeoutSeconds": timeout,
                        "elapsedSeconds": elapsed,
                    },
                )
                raise BlockingOperationTimeout(operation, timeout) from exc
            except Exception as exc:
                self.state.update({
                    "status": self._operation_status(),
                    "activeOperation": None,
                    "lastError": str(exc),
                    "lastFinishedAt": time.time(),
                })
                raise

    async def run_http_operation(
        self, operation: str, func: Callable[[], Any], timeout_seconds: float | None = None
    ) -> Any:
        try:
            return await self.run_operation(operation, func, timeout_seconds)
        except MT5ConnectionError as exc:
            if self.should_recover_connection(operation, exc):
                try:
                    if await self.recover_client_connection(operation, exc):
                        return await self.run_operation(operation, func, timeout_seconds)
                except MT5ConnectionError as recovery_exc:
                    raise_mt5_connection_http_error(recovery_exc)
                except BlockingOperationTimeout as recovery_timeout:
                    raise_blocking_operation_http_error(recovery_timeout)

            raise_mt5_connection_http_error(exc)
        except BlockingOperationTimeout as exc:
            raise_blocking_operation_http_error(exc)

    def should_recover_connection(self, operation: str, exc: MT5ConnectionError) -> bool:
        if operation not in RECOVERABLE_READ_OPERATIONS:
            return False
        if exc.error_type not in RECOVERABLE_CONNECTION_ERRORS:
            return False
        return exc.retryable

    async def recover_client_connection(self, operation: str, exc: MT5ConnectionError) -> bool:
        client = self.client
        if client is None:
            return False

        connect_lock = self._connect_lock_instance()
        async with connect_lock:
            if self.client is not client:
                return self.client is not None and self.client._connected
            if client._connected:
                return True

            log.warning(
                "mt5_reconnect_after_session_loss",
                operation=operation,
                login=client.login,
                errorType=exc.error_type,
                error=str(exc),
            )

            def reconnect_blocking() -> dict[str, Any]:
                client.connect()
                return client.get_account_info()

            await self.run_operation(
                "reconnect",
                reconnect_blocking,
                self.settings.mt5_connect_timeout_seconds,
            )
            self.state["status"] = "connected"
            log.info("mt5_reconnected", operation=operation, login=client.login)
            return True

    async def connect(self, login: int, password: str, server: str) -> dict[str, Any]:
        connect_lock = self._connect_lock_instance()
        if connect_lock.locked():
            return {
                "success": False,
                "error": "MT5 connect already in progress",
                "errorType": "connect_in_progress",
                "retryable": True,
            }

        async with connect_lock:
            previous_client = self.client

            def connect_blocking() -> tuple[MT5Client, dict[str, Any]]:
                if previous_client is not None:
                    previous_client.disconnect()
                client = MT5Client(login=login, password=password, server=server)
                try:
                    client.connect()
                    account_info = client.get_account_info()
                except Exception:
                    client.disconnect()
                    raise

                return client, account_info

            try:
                client, account_info = await self.run_operation(
                    "connect",
                    connect_blocking,
                    self.settings.mt5_connect_timeout_seconds,
                )
                self.client = client
                self.state["status"] = "connected"
            except MT5ConnectionError as exc:
                return {
                    "success": False,
                    "error": str(exc),
                    "errorType": exc.error_type,
                    "retryable": exc.retryable,
                }
            except BlockingOperationTimeout as exc:
                return {
                    "success": False,
                    "error": str(exc),
                    "errorType": "timeout",
                    "retryable": False,
                }

            return {
                "success": True,
                "accountInfo": account_info,
            }

    async def disconnect(self) -> dict[str, Any]:
        client = self.client

        def disconnect_blocking() -> None:
            if client is not None:
                client.disconnect()

        await self.run_http_operation("disconnect", disconnect_blocking)
        if self.client is client:
            self.client = None
        return {"success": True}

    def shutdown(self) -> None:
        self.stop_listener_watchdog()
        if self.client is not None:
            self.client.disconnect()
            self.client = None
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        log.info("mt5_worker_stopped")
