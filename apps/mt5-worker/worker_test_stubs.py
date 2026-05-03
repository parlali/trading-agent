from __future__ import annotations

import sys
import types
from typing import Callable


class StubLogger:
    def info(self, *args: object, **kwargs: object) -> None:
        return None

    def warning(self, *args: object, **kwargs: object) -> None:
        return None

    def error(self, *args: object, **kwargs: object) -> None:
        return None

    def critical(self, *args: object, **kwargs: object) -> None:
        return None


class StubBaseSettings:
    def __init__(self, **kwargs: object):
        for key, value in kwargs.items():
            setattr(self, key, value)


class StubBaseModel(StubBaseSettings):
    pass


class StubHTTPException(Exception):
    def __init__(self, status_code: int, detail: object):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class StubFastAPI:
    def __init__(self, *args: object, **kwargs: object):
        return None

    def get(self, *args: object, **kwargs: object) -> Callable[[Callable[..., object]], Callable[..., object]]:
        return lambda fn: fn

    def post(self, *args: object, **kwargs: object) -> Callable[[Callable[..., object]], Callable[..., object]]:
        return lambda fn: fn


def install_dependency_stubs() -> None:
    structlog = types.ModuleType("structlog")
    structlog.get_logger = lambda: StubLogger()
    sys.modules.setdefault("structlog", structlog)

    pydantic_settings = types.ModuleType("pydantic_settings")
    pydantic_settings.BaseSettings = StubBaseSettings
    sys.modules.setdefault("pydantic_settings", pydantic_settings)

    fastapi = types.ModuleType("fastapi")
    fastapi.Depends = lambda value=None: value
    fastapi.FastAPI = StubFastAPI
    fastapi.Header = lambda default="": default
    fastapi.HTTPException = StubHTTPException
    sys.modules.setdefault("fastapi", fastapi)

    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = StubBaseModel
    pydantic.Field = lambda default=None, **kwargs: default
    sys.modules.setdefault("pydantic", pydantic)

    uvicorn = types.ModuleType("uvicorn")
    uvicorn.run = lambda *args, **kwargs: None
    sys.modules.setdefault("uvicorn", uvicorn)
