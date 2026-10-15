import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.routers import (
    accounts,
    admin,
    ai,
    attachments,
    auth,
    calls,
    contacts,
    config,
    discovery,
    conversations,
    messages,
    metrics,
    plugins,
    preview,
    push,
    sso,
    webhooks,
)
from app.core.config import settings
from app.core.database import Base, engine
from app.core.rate_limit import limiter
from app.core.logging import configure_logging
from app.core.observability import metrics_registry, normalize_route
from app.core.performance import finish_query_counting, start_query_counting
from app.core.version import get_app_version
from app.utils.security import get_current_admin


# ---------------------------------------------------------------------------
# Logging setup — JSON logs by default for journal/Loki/ELK ingestion.
# ---------------------------------------------------------------------------
configure_logging(
    level=settings.LOG_LEVEL,
    json_logs=(settings.LOG_FORMAT.lower() != "text"),
)
logger = logging.getLogger("liaot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("api_starting", extra={"version": get_app_version()})
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    logger.info("api_shutting_down")
    await engine.dispose()


APP_VERSION = get_app_version()

app = FastAPI(
    title="LiaoT API",
    version=APP_VERSION,
    description="Backend API for the LiaoT web XMPP client platform.",
    openapi_tags=[
        {"name": "auth", "description": "Authentication endpoints. Public."},
        {"name": "accounts", "description": "XMPP account management. Users can access their own account; admins can access all."},
        {"name": "conversations", "description": "Conversation metadata APIs. Users can access their own conversations; admins can access all."},
        {"name": "contacts", "description": "Roster and contact APIs. Users can access their own contacts; admins can access all."},
        {"name": "attachments", "description": "Secure attachment upload APIs. User token required."},
        {"name": "calls", "description": "Call history APIs. User token required."},
        {"name": "messages", "description": "Message search and indexing APIs. Admin token required."},
        {"name": "plugins", "description": "Plugin lifecycle APIs. Admin token required."},
        {"name": "ai", "description": "AI utility APIs. Admin token required."},
        {"name": "admin", "description": "System status and audit APIs. Admin token required."},
        {"name": "realtime", "description": "WebSocket realtime bridge endpoints."},
    ],
    lifespan=lifespan,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """Attach a request ID, log timing, and catch unhandled exceptions."""
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.perf_counter()
    query_token = start_query_counting(
        request_id=request_id,
        method=request.method,
        path=request.url.path,
    )
    try:
        response = await call_next(request)
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000
        query_state = finish_query_counting(query_token)
        if query_state is not None:
            metrics_registry.inc(
                "liaot_events_total",
                event="db_queries",
                route=normalize_route(request.url.path),
                amount=float(query_state.count),
            )
        metrics_registry.observe_http(
            method=request.method,
            path=request.url.path,
            status_code=500,
            elapsed_seconds=elapsed_ms / 1000,
        )
        logger.error(
            "request_failed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "error_type": type(exc).__name__,
                "elapsed_ms": round(elapsed_ms, 1),
            },
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "request_id": request_id},
            headers={"X-Request-ID": request_id},
        )
    elapsed_ms = (time.perf_counter() - start) * 1000
    query_state = finish_query_counting(query_token)
    if query_state is not None:
        route = normalize_route(request.url.path)
        metrics_registry.inc(
            "liaot_events_total",
            event="db_queries",
            route=route,
            amount=float(query_state.count),
        )
        if query_state.count > settings.PERF_QUERY_WARN_THRESHOLD:
            metrics_registry.inc("liaot_events_total", event="n_plus_one_suspected", route=route)
            logger.warning(
                "n_plus_one_suspected",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "route": route,
                    "query_count": query_state.count,
                    "slow_query_count": query_state.slow_count,
                    "total_sql_ms": round(query_state.total_sql_ms, 1),
                    "max_sql_ms": round(query_state.max_sql_ms, 1),
                    "threshold": settings.PERF_QUERY_WARN_THRESHOLD,
                },
            )
    response.headers["X-Request-ID"] = request_id
    metrics_registry.observe_http(
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        elapsed_seconds=elapsed_ms / 1000,
    )
    # Only log slow requests or errors at INFO; debug for normal traffic
    if response.status_code >= 500 or elapsed_ms > 1000:
        logger.warning(
            "slow_or_error",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "elapsed_ms": round(elapsed_ms, 1),
            },
        )
    elif response.status_code >= 400:
        logger.info(
            "request_4xx",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "elapsed_ms": round(elapsed_ms, 1),
            },
        )
    return response

admin_dep = [Depends(get_current_admin)]

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(accounts.router, prefix="/accounts", tags=["accounts"])
app.include_router(conversations.router, prefix="/conversations", tags=["conversations"])
app.include_router(contacts.router, prefix="/contacts", tags=["contacts"])
app.include_router(attachments.router, prefix="/attachments", tags=["attachments"])
app.include_router(calls.router, tags=["calls"])
app.include_router(messages.router, prefix="/messages", tags=["messages"])
app.include_router(plugins.router, prefix="/plugins", tags=["plugins"])
app.include_router(ai.router, prefix="/ai", tags=["ai"])
app.include_router(admin.router, prefix="/admin", tags=["admin"], dependencies=admin_dep)
app.include_router(push.router, tags=["push"])
app.include_router(webhooks.router, tags=["webhooks"])
app.include_router(preview.router, tags=["preview"])
app.include_router(sso.router, tags=["sso"])
app.include_router(discovery.router, tags=["discovery"])
app.include_router(config.router, tags=["config"])
app.include_router(metrics.router, tags=["metrics"])


@app.get(
    "/health",
    summary="Public liveness probe",
    description="Returns API liveness and current version.",
)
async def health_check():
    return {"status": "ok", "version": APP_VERSION}


@app.get(
    "/api/health",
    summary="Public API health probe",
    description="Nginx-routed API health endpoint.",
)
async def api_health_check():
    return {"status": "ok", "version": APP_VERSION}


# WebSocket
from app.api.routers import websocket as ws_router

app.include_router(ws_router.router, tags=["realtime"])
