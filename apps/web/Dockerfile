# =====================================================
# Build stage
# =====================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy lockfile + manifest first for better caching
COPY package.json package-lock.json* ./

# Use ci for deterministic builds when lockfile exists, fall back to install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build


# =====================================================
# Runtime stage — nginx serving static assets, non-root
# =====================================================
FROM nginx:1.27-alpine

# Use the non-root user that nginx-unprivileged ships with
# Or set up our own — here we patch the default config to bind > 1024
RUN apk add --no-cache curl && \
    sed -i 's,listen       80;,listen       8080;,' /etc/nginx/conf.d/default.conf && \
    sed -i 's,/var/run/nginx.pid,/tmp/nginx.pid,' /etc/nginx/nginx.conf && \
    chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /usr/share/nginx/html && \
    chmod -R g=u /var/cache/nginx /var/log/nginx /etc/nginx/conf.d

COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/nginx/html
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/ > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
