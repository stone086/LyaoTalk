import secrets
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://localhost:5432/lyaotalk"
    REDIS_URL: str = "redis://localhost:6379/0"

    MINIO_ENDPOINT: str = "localhost:9000"
    MINIO_ACCESS_KEY: str = ""
    MINIO_SECRET_KEY: str = ""
    MINIO_BUCKET: str = "lyaotalk-files"
    MINIO_SECURE: bool = False

    SECRET_KEY: str = secrets.token_urlsafe(48)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    CORS_ORIGINS: List[str] = ["http://localhost:5173"]
    XMPP_DOMAIN: str = "localhost"
    XMPP_REGISTRATION_ENABLED: bool = True
    PUBLIC_DOMAIN: str = "localhost"
    FILES_PUBLIC_DOMAIN: str = ""
    FRONTEND_URL: str = ""
    AI_API_KEY: str = ""
    AI_BASE_URL: str = ""
    AI_MODEL: str = ""
    ALERT_EMAIL: str = ""
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_TIMEOUT: int = 30
    DB_POOL_RECYCLE: int = 1800


    # Observability
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "json"  # json or text
    METRICS_ENABLED: bool = True

    # Performance diagnostics. These are safe to leave enabled in staging;
    # production can disable query counting if the extra event hook overhead is
    # not desired. No SQL parameters are logged.
    PERF_QUERY_COUNT_ENABLED: bool = True
    PERF_QUERY_WARN_THRESHOLD: int = 10
    PERF_SLOW_SQL_MS: int = 250

    # SSO / OIDC
    OIDC_ENABLED: bool = False
    OIDC_ISSUER: str = ""
    OIDC_CLIENT_ID: str = ""
    OIDC_CLIENT_SECRET: str = ""
    OIDC_REDIRECT_URI: str = ""
    OIDC_LABEL: str = "Single Sign-On"
    # Refuse logins where the IdP hasn't verified the user's email.
    # Most production IdPs (Auth0, Okta, Keycloak with email-verify flow,
    # Azure AD) set email_verified=true. If yours doesn't, set this to
    # false explicitly — but understand the impact: a user who registered
    # with someone else's email at the IdP can log in as that email.
    OIDC_REQUIRE_EMAIL_VERIFIED: bool = True
    AUTO_PROVISION_OIDC: bool = False

    # SSO / LDAP
    LDAP_ENABLED: bool = False
    LDAP_SERVER: str = ""
    LDAP_BIND_DN_TEMPLATE: str = "uid={username},ou=People,dc=example,dc=com"
    LDAP_LABEL: str = "Corporate Login"
    AUTO_PROVISION_LDAP: bool = False

    # Web Push (VAPID)
    VAPID_PRIVATE_KEY: str = ""
    VAPID_PUBLIC_KEY: str = ""
    VAPID_EMAIL: str = "admin@lyaotalk.local"

    # TURN/STUN credentials for Prosody/coturn integration. The API does not
    # expose TURN_SECRET publicly; accepting it here keeps install-generated
    # runtime env files compatible with strict Pydantic settings.
    TURN_SECRET: str = ""
    TURN_HOST: str = ""
    TURN_PORT: int = 3478

    # SFU (Selective Forwarding Unit for group calls)
    SFU_URL: str = ""

    # Admin credentials.
    # Either ADMIN_PASS (plaintext, legacy) OR ADMIN_PASS_HASH (preferred).
    # ADMIN_PASS_HASH is an argon2 or bcrypt encoded hash. When both are set,
    # ADMIN_PASS_HASH wins.
    # Generate with: python -c "from argon2 import PasswordHasher; print(PasswordHasher().hash('your-password'))"
    ADMIN_USER: str = "admin"
    ADMIN_PASS: str = ""
    ADMIN_PASS_HASH: str = ""

    # JWT lifetime overrides for the new short-lived access + refresh-token model.
    # Shorter access token reduces the window for stolen-token replay; refresh
    # tokens can be revoked centrally via Redis (see app/utils/security.py).
    ACCESS_TOKEN_EXPIRE_MINUTES_ACCESS: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14

    # Push shared secret (for server-to-server push triggers)
    PUSH_SHARED_SECRET: str = ""

    # Prometheus scrape token. Empty keeps the previous behaviour (nginx
    # already restricts /api/metrics to loopback and RFC1918 ranges); setting
    # it adds an application-level guard for multi-tenant or exposed setups.
    METRICS_TOKEN: str = ""

    # Inbound webhooks. When the sender supplies X-LyaoTalk-Timestamp and
    # X-LyaoTalk-Signature we verify them and refuse replays. Setting this to
    # true rejects unsigned calls outright, which requires every integration
    # to be updated before flipping it.
    WEBHOOK_SIGNATURES_REQUIRED: bool = False

    model_config = SettingsConfigDict(env_file=".env")

    @model_validator(mode="after")
    def reject_public_default_secret(self):
        public_host = self.PUBLIC_DOMAIN.strip().lower()
        if public_host not in ("", "localhost", "127.0.0.1", "::1"):
            if len(self.SECRET_KEY) < 32:
                raise ValueError("A unique SECRET_KEY of at least 32 characters is required")
        return self


settings = Settings()
