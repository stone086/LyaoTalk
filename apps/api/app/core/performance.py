"""Performance diagnostics for staging and release baselines.

The helpers in this module are intentionally lightweight and avoid adding new
runtime dependencies. They count SQL statements per request with SQLAlchemy
engine events and use contextvars so async requests do not share state.

The goal is not to replace an APM. It is to make N+1 query regressions visible
in staging and to give release engineers concrete numbers for the performance
baseline document.
"""

from __future__ import annotations

import contextvars
import logging
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings

logger = logging.getLogger("lyaotalk.performance")


@dataclass
class RequestQueryState:
    request_id: str
    method: str
    path: str
    count: int = 0
    slow_count: int = 0
    total_sql_ms: float = 0.0
    max_sql_ms: float = 0.0


_query_state: contextvars.ContextVar[RequestQueryState | None] = contextvars.ContextVar(
    "lyaotalk_query_state",
    default=None,
)


def start_query_counting(*, request_id: str, method: str, path: str):
    """Start counting SQL statements for one request and return a reset token."""
    if not settings.PERF_QUERY_COUNT_ENABLED:
        return None
    return _query_state.set(RequestQueryState(request_id=request_id, method=method, path=path))


def finish_query_counting(token: Any) -> RequestQueryState | None:
    """Return the final state and reset the contextvar."""
    if token is None:
        return None
    state = _query_state.get()
    _query_state.reset(token)
    return state


def attach_sqlalchemy_performance_listeners(engine: AsyncEngine) -> None:
    """Attach query-count and slow-query listeners to the SQLAlchemy engine."""
    sync_engine = engine.sync_engine
    if getattr(sync_engine, "_lyaotalk_perf_listeners_attached", False):
        return

    @event.listens_for(sync_engine, "before_cursor_execute")
    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        context._lyaotalk_query_start = time.perf_counter()
        state = _query_state.get()
        if state is not None:
            state.count += 1

    @event.listens_for(sync_engine, "after_cursor_execute")
    def after_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        started = getattr(context, "_lyaotalk_query_start", None)
        if started is None:
            return
        elapsed_ms = (time.perf_counter() - started) * 1000
        state = _query_state.get()
        if state is not None:
            state.total_sql_ms += elapsed_ms
            state.max_sql_ms = max(state.max_sql_ms, elapsed_ms)
            if elapsed_ms >= settings.PERF_SLOW_SQL_MS:
                state.slow_count += 1
                logger.warning(
                    "slow_sql",
                    extra={
                        "request_id": state.request_id,
                        "method": state.method,
                        "path": state.path,
                        "elapsed_ms": round(elapsed_ms, 1),
                        "statement_preview": _preview_sql(statement),
                    },
                )

    setattr(sync_engine, "_lyaotalk_perf_listeners_attached", True)


def _preview_sql(statement: str) -> str:
    """Return a short SQL preview without values/parameters."""
    return " ".join(str(statement).split())[:240]
