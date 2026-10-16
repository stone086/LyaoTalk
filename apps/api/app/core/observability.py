"""Lightweight observability helpers for LyaoTalk.

This module intentionally avoids new runtime dependencies so the 1.8.x
hash-pinned Python install remains stable. It exposes Prometheus-compatible
text metrics and in-process counters/histograms suitable for a single API
process. If the API is scaled horizontally, scrape each instance separately.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


def _escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")[:160]


def _labelset(**labels: str) -> str:
    if not labels:
        return ""
    parts = [f'{key}="{_escape_label(str(value))}"' for key, value in sorted(labels.items())]
    return "{" + ",".join(parts) + "}"


@dataclass
class _HistogramState:
    buckets: dict[float, int]
    count: int = 0
    total: float = 0.0


class MetricsRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(float)
        self._http_latency: dict[tuple[tuple[str, str], ...], _HistogramState] = {}

    def inc(self, name: str, amount: float = 1.0, **labels: str) -> None:
        key = (name, tuple(sorted((str(k), str(v)) for k, v in labels.items())))
        with self._lock:
            self._counters[key] += amount

    def observe_http(self, *, method: str, path: str, status_code: int, elapsed_seconds: float) -> None:
        status_class = f"{int(status_code / 100)}xx" if status_code else "unknown"
        route = normalize_route(path)
        labels = tuple(sorted({"method": method, "route": route, "status_class": status_class}.items()))
        with self._lock:
            self._counters[("lyaotalk_http_requests_total", labels)] += 1
            state = self._http_latency.get(labels)
            if state is None:
                state = _HistogramState(buckets={bucket: 0 for bucket in _BUCKETS})
                self._http_latency[labels] = state
            state.count += 1
            state.total += max(elapsed_seconds, 0.0)
            for bucket in _BUCKETS:
                if elapsed_seconds <= bucket:
                    state.buckets[bucket] += 1

    def render_prometheus(self) -> str:
        now = time.time()
        lines: list[str] = []
        lines.extend([
            "# HELP lyaotalk_build_info Build and runtime information for this API process.",
            "# TYPE lyaotalk_build_info gauge",
        ])
        try:
            from app.core.version import get_app_version
            version = get_app_version()
        except Exception:
            version = "unknown"
        lines.append(f'lyaotalk_build_info{{version="{_escape_label(version)}"}} 1')
        lines.extend([
            "# HELP lyaotalk_process_uptime_seconds Seconds since the API process started.",
            "# TYPE lyaotalk_process_uptime_seconds gauge",
            f"lyaotalk_process_uptime_seconds {now - self._started_at:.3f}",
            "# HELP lyaotalk_http_requests_total Total HTTP requests observed by the API middleware.",
            "# TYPE lyaotalk_http_requests_total counter",
        ])
        with self._lock:
            for (name, label_items), value in sorted(self._counters.items()):
                if name != "lyaotalk_http_requests_total":
                    continue
                lines.append(f"{name}{_labelset(**dict(label_items))} {value:.0f}")
            lines.extend([
                "# HELP lyaotalk_http_request_duration_seconds HTTP request latency histogram.",
                "# TYPE lyaotalk_http_request_duration_seconds histogram",
            ])
            for label_items, state in sorted(self._http_latency.items()):
                base_labels = dict(label_items)
                cumulative = 0
                for bucket in _BUCKETS:
                    cumulative = state.buckets[bucket]
                    lines.append(
                        "lyaotalk_http_request_duration_seconds_bucket"
                        f"{_labelset(**base_labels, le=str(bucket))} {cumulative}"
                    )
                lines.append(
                    "lyaotalk_http_request_duration_seconds_bucket"
                    f"{_labelset(**base_labels, le='+Inf')} {state.count}"
                )
                lines.append(f"lyaotalk_http_request_duration_seconds_count{_labelset(**base_labels)} {state.count}")
                lines.append(f"lyaotalk_http_request_duration_seconds_sum{_labelset(**base_labels)} {state.total:.6f}")
            lines.extend([
                "# HELP lyaotalk_events_total Security and operational events emitted by the application.",
                "# TYPE lyaotalk_events_total counter",
            ])
            for (name, label_items), value in sorted(self._counters.items()):
                if name == "lyaotalk_http_requests_total":
                    continue
                lines.append(f"{name}{_labelset(**dict(label_items))} {value:.0f}")
        return "\n".join(lines) + "\n"


def normalize_route(path: str) -> str:
    """Reduce label cardinality for Prometheus route labels."""
    if not path:
        return "/"
    safe = path.split("?", 1)[0]
    parts: list[str] = []
    for item in safe.strip("/").split("/"):
        if not item:
            continue
        if len(item) >= 24 and all(c.isalnum() or c in "-_" for c in item):
            parts.append(":id")
        elif item.isdigit():
            parts.append(":id")
        else:
            parts.append(item[:64])
    return "/" + "/".join(parts)


metrics_registry = MetricsRegistry()
