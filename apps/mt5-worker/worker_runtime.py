from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import sys
import tempfile
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

PRE_SUBMIT_MUTATION_OPERATIONS = {
    "order_submit",
    "order_modify",
    "order_cancel",
    "order_cancel_all",
    "position_close",
    "position_close_all",
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
        self._session_lock: asyncio.Lock | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._singleton_lock_handle: Any | None = None
        self._singleton_lock_path: str | None = None
        self._state_file_path = self.resolve_state_file_path()

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
        self.acquire_singleton_guard()
        self.persist_state()
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

    def acquire_singleton_guard(self) -> None:
        if os.name != "nt":
            return

        import msvcrt

        portable_dir = os.path.abspath(os.path.expanduser(self.settings.mt5_portable_dir))
        terminal_path = os.path.abspath(os.path.expanduser(self.settings.mt5_terminal_path))
        lock_key = hashlib.sha256(f"{portable_dir}|{terminal_path}".encode("utf-8")).hexdigest()[:16]
        lock_path = os.path.join(tempfile.gettempdir(), f"valiq-mt5-worker-{lock_key}.lock")
        handle = open(lock_path, "a+b")

        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            handle.close()
            self.terminate_for_restart(
                "mt5_worker_singleton_lock_held",
                {
                    "portableDir": portable_dir,
                    "terminalPath": terminal_path,
                    "lockPath": lock_path,
                },
            )

        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} portableDir={portable_dir} terminalPath={terminal_path}\n".encode("utf-8"))
        handle.flush()
        self._singleton_lock_handle = handle
        self._singleton_lock_path = lock_path
        log.info(
            "mt5_worker_singleton_lock_acquired",
            portableDir=portable_dir,
            terminalPath=terminal_path,
            lockPath=lock_path,
        )

    def release_singleton_guard(self) -> None:
        handle = self._singleton_lock_handle
        if handle is None:
            return

        if os.name == "nt":
            import msvcrt

            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError as exc:
                log.warning("mt5_worker_singleton_lock_release_failed", error=str(exc))

        try:
            handle.close()
        finally:
            self._singleton_lock_handle = None
            self._singleton_lock_path = None

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
        self.update_state({
            "status": "disconnected",
            "activeOperation": None,
            "lastError": None,
            "lastStartedAt": None,
            "lastFinishedAt": None,
        })

    def resolve_state_file_path(self) -> str:
        configured = str(getattr(self.settings, "worker_state_path", "")).strip()
        if configured:
            return os.path.abspath(os.path.expanduser(configured))

        return os.path.join(tempfile.gettempdir(), f"valiq-mt5-worker-state-{self.settings.worker_port}.json")

    def update_state(self, values: dict[str, Any]) -> None:
        self.state.update(values)
        self.persist_state()

    def persist_state(self) -> None:
        payload = {
            **self.state,
            "pid": os.getpid(),
            "terminalBlocked": self.terminal_blocked,
            "updatedAt": time.time(),
        }
        path = self._state_file_path
        tmp_path = f"{path}.tmp"

        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, sort_keys=True)
            os.replace(tmp_path, path)
        except Exception as exc:
            log.warning("mt5_worker_state_persist_failed", path=path, error=str(exc))

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

    def require_client(self, operation: str | None = None) -> MT5Client:
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
                operation in RECOVERABLE_READ_OPERATIONS,
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

    def _session_lock_instance(self) -> asyncio.Lock:
        if self._session_lock is None:
            self._session_lock = asyncio.Lock()
        return self._session_lock

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
        queue_started_at = time.time()
        queue_timeout = self.settings.mt5_operation_queue_timeout_seconds
        try:
            await asyncio.wait_for(lock.acquire(), timeout=queue_timeout)
        except (TimeoutError, asyncio.TimeoutError) as exc:
            queued_for = time.time() - queue_started_at
            message = f"MT5 operation queue timed out waiting for {self.state.get('activeOperation')}"
            self.update_state({
                "status": self._operation_status(),
                "lastError": message,
                "lastFinishedAt": time.time(),
            })
            log.warning(
                "mt5_operation_queue_timeout",
                operation=operation,
                activeOperation=self.state.get("activeOperation"),
                timeout_seconds=queue_timeout,
                queued_seconds=queued_for,
            )
            try:
                raise_worker_http_error(
                    message,
                    "operation_queue_timeout",
                    operation not in PRE_SUBMIT_MUTATION_OPERATIONS,
                    details={
                        "activeOperation": self.state.get("activeOperation"),
                        "queuedSeconds": queued_for,
                        "timeoutSeconds": queue_timeout,
                    },
                )
            except Exception as http_exc:
                raise http_exc from exc

        timeout = timeout_seconds if timeout_seconds is not None else self.settings.mt5_operation_timeout_seconds
        try:
            started_at = time.time()
            self.update_state({
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
                self.update_state({
                    "status": self._operation_status(),
                    "activeOperation": None,
                    "lastFinishedAt": time.time(),
                })
                return result
            except (TimeoutError, asyncio.TimeoutError) as exc:
                self.terminal_blocked = True
                self.update_state({
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
                self.update_state({
                    "status": self._operation_status(),
                    "activeOperation": None,
                    "lastError": str(exc),
                    "lastFinishedAt": time.time(),
                })
                raise
        finally:
            lock.release()

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

    async def run_client_http_operation(
        self,
        operation: str,
        func: Callable[[MT5Client], Any],
        timeout_seconds: float | None = None,
    ) -> Any:
        client = self.require_client(operation)
        return await self.run_http_operation(
            operation,
            lambda: func(client),
            timeout_seconds,
        )

    async def run_account_operation(
        self,
        operation: str,
        credentials: Any,
        func: Callable[[MT5Client], Any],
        timeout_seconds: float | None = None,
    ) -> Any:
        login = int(credentials.login)
        session_lock = self._session_lock_instance()
        queue_timeout = self.settings.mt5_operation_queue_timeout_seconds
        try:
            await asyncio.wait_for(session_lock.acquire(), timeout=queue_timeout)
        except (TimeoutError, asyncio.TimeoutError):
            raise_worker_http_error(
                f"MT5 account session queue timed out before serving login {login}",
                "session_queue_timeout",
                operation not in PRE_SUBMIT_MUTATION_OPERATIONS,
                details={
                    "login": login,
                    "activeOperation": self.state.get("activeOperation"),
                    "timeoutSeconds": queue_timeout,
                },
            )

        try:
            await self.ensure_session_login(
                operation,
                login,
                credentials.password,
                credentials.server,
            )

            def verified(client: MT5Client) -> Any:
                client.assert_session_login(login)
                return func(client)

            return await self.run_client_http_operation(operation, verified, timeout_seconds)
        finally:
            session_lock.release()

    async def ensure_session_login(
        self,
        operation: str,
        login: int,
        password: str,
        server: str,
    ) -> None:
        client = self.client
        if (
            client is not None
            and client._connected
            and not self.terminal_blocked
            and int(client.login) == login
            and client.server == server
        ):
            return

        log.info(
            "mt5_session_switch",
            operation=operation,
            fromLogin=client.login if client else None,
            toLogin=login,
        )
        result = await self.connect(login, password, server)
        if not result.get("success"):
            raise_worker_http_error(
                f"MT5 session switch to login {login} failed: {result.get('error')}",
                str(result.get("errorType") or "session_switch_failed"),
                bool(result.get("retryable", False)),
                details={"login": login},
            )

        account_info = result.get("accountInfo") or {}
        active_login = account_info.get("login")
        active = self.client
        if (
            active is None
            or not active._connected
            or int(active.login) != login
            or int(active_login or 0) != login
        ):
            raise_worker_http_error(
                f"MT5 session login mismatch after reconnect: expected {login}, active {active_login}",
                "session_login_mismatch",
                False,
                details={"login": login, "activeLogin": active_login},
            )

    def should_recover_connection(self, operation: str, exc: MT5ConnectionError) -> bool:
        recoverable_operation = operation in RECOVERABLE_READ_OPERATIONS or operation in PRE_SUBMIT_MUTATION_OPERATIONS
        if not recoverable_operation:
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
            self.update_state({"status": "connected"})
            log.info("mt5_reconnected", operation=operation, login=client.login)
            return True

    async def connect(self, login: int, password: str, server: str) -> dict[str, Any]:
        connect_lock = self._connect_lock_instance()
        try:
            await asyncio.wait_for(
                connect_lock.acquire(),
                timeout=self.settings.mt5_operation_queue_timeout_seconds,
            )
        except (TimeoutError, asyncio.TimeoutError):
            return {
                "success": False,
                "error": "MT5 connect queue timed out waiting for another connect operation",
                "errorType": "connect_queue_timeout",
                "retryable": True,
            }

        try:
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
                self.update_state({"status": "connected"})
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
        finally:
            connect_lock.release()

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
        self.update_state({
            "status": "disconnected",
            "activeOperation": None,
            "lastFinishedAt": time.time(),
        })
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        self.release_singleton_guard()
        log.info("mt5_worker_stopped")
