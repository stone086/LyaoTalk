from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from urllib.parse import urlparse
import logging
import time

from app.core.rate_limit import limiter
from app.core.config import settings
from app.core.observability import metrics_registry

router = APIRouter()
logger = logging.getLogger("lyaotalk.csp")


@router.get(
    "/metrics",
    include_in_schema=False,
    response_class=PlainTextResponse,
)
async def prometheus_metrics():
    """Prometheus-compatible scrape endpoint.

    Nginx should restrict `/api/metrics` to trusted Prometheus hosts. The
    app-level toggle is a second guard for single-host deployments.
    """
    if not settings.METRICS_ENABLED:
        raise HTTPException(status_code=404, detail="metrics disabled")
    return PlainTextResponse(
        metrics_registry.render_prometheus(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


# CSP directives are attacker-controlled strings. Feeding them straight into
# a metric label lets anyone create unbounded series (one per unique value)
# and exhaust memory. Map to a fixed vocabulary instead.
_CSP_KNOWN_DIRECTIVES = {
    "base-uri", "child-src", "connect-src", "default-src", "font-src",
    "form-action", "frame-ancestors", "frame-src", "img-src", "manifest-src",
    "media-src", "object-src", "prefetch-src", "report-to", "report-uri",
    "sandbox", "script-src", "script-src-attr", "script-src-elem",
    "style-src", "style-src-attr", "style-src-elem", "worker-src",
}


def _csp_label(directive: str) -> str:
    head = (directive or "").strip().lower().split(" ", 1)[0]
    return head if head in _CSP_KNOWN_DIRECTIVES else "other"


WEB_VITAL_NAMES = {"LCP", "FID", "CLS", "INP", "TTFB"}
WEB_VITAL_RATINGS = {"good", "needs-improvement", "poor"}
_WEB_VITALS_MAX = 5000
_BATCH_MAX_REPORTS = 50  # one page submitting more than this is suspicious
_web_vitals_buffer: list[dict] = []


class WebVitalReport(BaseModel):
    name: str = Field(..., max_length=8)
    value: float = Field(..., ge=0, le=1_000_000)  # ms or ratio; cap at sane upper bound
    rating: str = Field(..., max_length=32)
    url: str = Field(..., max_length=2048)
    timestamp: int = Field(..., ge=0)


class WebVitalsBatch(BaseModel):
    reports: list[WebVitalReport] = Field(..., max_length=_BATCH_MAX_REPORTS)


@router.post(
    "/metrics/web-vitals",
    include_in_schema=False,
)
@limiter.limit("30/minute")
async def collect_web_vitals(request: Request, batch: WebVitalsBatch):
    """
    Browser performance telemetry sink.

    Public-by-design: any browser session may post web-vitals. Hardened to
    prevent the endpoint from being weaponized as a memory-DoS or stored-XSS
    vector for the admin panel that consumes the buffer:
      - Batch size capped at 50 reports
      - Per-field length / numeric range validated by Pydantic
      - URL scheme restricted to http(s) so admin panel can't be poisoned
        with javascript:/data: URLs
      - Timestamps rejected if they're outside ±1 day of now (replay/junk)
    """
    now_ms = int(time.time() * 1000)
    one_day_ms = 24 * 60 * 60 * 1000
    accepted = 0
    for report in batch.reports:
        if report.name not in WEB_VITAL_NAMES:
            continue
        if report.rating not in WEB_VITAL_RATINGS:
            continue
        # Reject URLs with non-http(s) schemes so the admin panel doesn't end up
        # rendering javascript:/data: URLs from user-submitted reports.
        try:
            parsed = urlparse(report.url)
            if parsed.scheme not in ("http", "https"):
                continue
        except Exception:
            continue
        # Skip reports with implausible timestamps to keep the buffer tidy
        if abs(report.timestamp - now_ms) > one_day_ms:
            continue
        metrics_registry.inc("lyaotalk_events_total", event="web_vital", name=report.name, rating=report.rating)
        _web_vitals_buffer.append(
            {
                "name": report.name,
                "value": report.value,
                "rating": report.rating,
                "url": report.url[:2048],
                "timestamp": report.timestamp,
            }
        )
        accepted += 1
    if len(_web_vitals_buffer) > _WEB_VITALS_MAX:
        del _web_vitals_buffer[: len(_web_vitals_buffer) - _WEB_VITALS_MAX]
    return {"received": accepted}


def web_vitals_summary() -> dict[str, dict]:
    summary: dict[str, dict] = {}
    for metric in WEB_VITAL_NAMES:
        values = sorted(r["value"] for r in _web_vitals_buffer if r["name"] == metric)
        if not values:
            continue
        summary[metric] = {
            "count": len(values),
            "p50": round(_percentile(values, 0.50), 2),
            "p75": round(_percentile(values, 0.75), 2),
            "p95": round(_percentile(values, 0.95), 2),
        }
    return summary


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0
    index = min(round((len(values) - 1) * percentile), len(values) - 1)
    return values[index]


# ===== CSP violation reports =====
# Browser POSTs here when an inline script, blocked image, or other policy
# violation occurs. Two competing report formats exist and both arrive here:
#   - Legacy `report-uri` (Content-Type: application/csp-report)
#       → wraps a single report under "csp-report" key
#   - Modern Reporting API (Content-Type: application/reports+json)
#       → array of reports under top-level list
#
# We accept either as opaque JSON, extract the most useful fields, and log
# them at WARNING level. CSP reports are public-by-design (browser sends
# without auth), so we apply tight rate limiting to prevent log-flood DoS
# and bound the body size to 8KB.
_CSP_BUFFER_MAX = 500
_csp_buffer: list[dict] = []


@router.post(
    "/csp-report",
    include_in_schema=False,
)
@limiter.limit("120/minute")
async def receive_csp_report(request: Request):
    raw = await request.body()
    if len(raw) > 8192:
        # Browsers don't send 8KB+ reports; this is an attempt to flood logs.
        return {"received": 0}
    try:
        import json as _json
        data = _json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return {"received": 0}

    # Normalize across the two formats into a common shape
    reports: list[dict] = []
    if isinstance(data, dict) and "csp-report" in data:
        # Legacy format
        cr = data["csp-report"] or {}
        reports.append({
            "directive": str(cr.get("violated-directive") or cr.get("effective-directive") or "")[:128],
            "blocked": str(cr.get("blocked-uri") or "")[:512],
            "source": str(cr.get("source-file") or "")[:512],
            "document": str(cr.get("document-uri") or "")[:512],
            "line": cr.get("line-number"),
        })
    elif isinstance(data, list):
        # Reporting API format
        for entry in data[:5]:  # cap at 5 reports per request
            if not isinstance(entry, dict):
                continue
            body = entry.get("body") or {}
            if not isinstance(body, dict):
                continue
            reports.append({
                "directive": str(body.get("effectiveDirective") or body.get("violatedDirective") or "")[:128],
                "blocked": str(body.get("blockedURL") or "")[:512],
                "source": str(body.get("sourceFile") or "")[:512],
                "document": str(body.get("documentURL") or entry.get("url") or "")[:512],
                "line": body.get("lineNumber"),
            })
    else:
        return {"received": 0}

    # Log + buffer for admin panel inspection. Use WARNING because CSP
    # violations either indicate XSS attempts or legitimate-but-blocked
    # resources that an operator needs to add to the policy.
    client_ip = (request.client.host if request.client else "?")
    for r in reports:
        metrics_registry.inc("lyaotalk_events_total", event="csp_violation", directive=_csp_label(r["directive"]))
        logger.warning(
            "csp_violation",
            extra={
                "directive": r["directive"],
                "blocked": r["blocked"],
                "document": r["document"],
                "client_ip": client_ip,
            },
        )
        _csp_buffer.append({**r, "ip": client_ip, "ts": int(time.time() * 1000)})

    if len(_csp_buffer) > _CSP_BUFFER_MAX:
        del _csp_buffer[: len(_csp_buffer) - _CSP_BUFFER_MAX]
    return {"received": len(reports)}


def csp_report_summary() -> list[dict]:
    """Return the most recent CSP violations for admin panel."""
    return list(_csp_buffer[-100:])
