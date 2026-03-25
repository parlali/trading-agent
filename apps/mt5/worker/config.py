from pydantic_settings import BaseSettings


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
    mt5_initialize_timeout_ms: int = 60_000

    # Connection management
    reconnect_max_retries: int = 3
    reconnect_delay_seconds: float = 5.0

    # Auth -- shared secret between TS orchestrator and this worker
    worker_access_key: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
