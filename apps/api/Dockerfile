# =====================================================
# Build stage — install deps with build toolchain
# =====================================================
FROM python:3.12-slim AS builder

WORKDIR /build

# Build dependencies (only present in this stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libldap2-dev \
        libsasl2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps into a virtualenv we'll copy over
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt


# =====================================================
# Runtime stage — minimal image, no compilers, non-root
# =====================================================
FROM python:3.12-slim

# Runtime libraries only (no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        libldap-2.5-0 \
        libmagic1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 lyaotalk && \
    useradd --system --uid 1001 --gid lyaotalk --no-create-home --shell /usr/sbin/nologin lyaotalk

WORKDIR /app

# Copy virtualenv from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Copy app code with proper ownership
COPY --chown=lyaotalk:lyaotalk . .

USER lyaotalk

EXPOSE 8000

# Liveness probe — gives orchestrator a signal when API is unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "3", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]

# ============================================================================
# Recommended runtime flags (for whoever orchestrates this image — Compose,
# Kubernetes, plain `docker run`):
#
#   docker run \
#     --read-only \                       # rootfs immutable; only writable
#                                         # paths are explicit volumes/tmpfs
#     --tmpfs /tmp:size=64M,noexec,nosuid \
#     --cap-drop=ALL \                    # CAP_NET_BIND_SERVICE not needed
#                                         # (we listen on 8000, unprivileged)
#     --security-opt=no-new-privileges:true \
#     --security-opt=seccomp=default \    # Docker's default seccomp profile
#                                         # blocks ~44 syscalls (ptrace,
#                                         # init_module, mount, reboot, etc.)
#     --pids-limit=512 \                  # backstop fork-bomb / runaway
#     --memory=1g --memory-swap=1g \      # bound RAM
#     --user 1001:1001 \                  # already enforced via USER above
#                                         # but explicit at run-time is safer
#     --network lyaotalk-internal \       # isolated network — only DB, Redis,
#                                         # MinIO, and reverse proxy reachable
#     lyaotalk-api:1.6.0
#
# For Kubernetes, equivalent securityContext:
#   readOnlyRootFilesystem: true
#   runAsNonRoot: true
#   runAsUser: 1001
#   allowPrivilegeEscalation: false
#   capabilities: { drop: [ALL] }
#   seccompProfile: { type: RuntimeDefault }
# ============================================================================
