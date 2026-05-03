from pathlib import Path

from pydantic_settings import BaseSettings


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MT5_SERVERS_DAT_PATH = REPO_ROOT / "private" / "mt5-worker" / "servers.dat"


class Settings(BaseSettings):
    """MT5 worker configuration.

    All values can be overridden via environment variables or a .env file.
    """

    # Required
    worker_host: str = "0.0.0.0"
    worker_port: int = 8090

    # MT5 terminal settings (Windows paths)
    mt5_portable_dir: str = "C:\\mt5"
    mt5_terminal_path: str = "C:\\Program Files\\MetaTrader 5\\terminal64.exe"
    mt5_servers_dat_path: str = str(DEFAULT_MT5_SERVERS_DAT_PATH)
    mt5_initialize_timeout_ms: int = 60_000

    # Connection management
    reconnect_max_retries: int = 3
    reconnect_delay_seconds: float = 5.0
    mt5_connect_timeout_seconds: float = 75.0
    mt5_operation_timeout_seconds: float = 30.0

    # Auth -- shared secret between TS orchestrator and this worker
    worker_access_key: str = ""

    worker_listener_watchdog_enabled: bool = True
    worker_listener_watchdog_startup_grace_seconds: float = 15.0
    worker_listener_watchdog_interval_seconds: float = 5.0
    worker_listener_watchdog_timeout_seconds: float = 2.0
    worker_listener_watchdog_failure_threshold: int = 3
    worker_expected_repo_suffix: str = "Desktop\\trading"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
