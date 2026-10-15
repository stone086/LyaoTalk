"""
config.py - Public runtime configuration endpoint.

Returns non-sensitive feature flags so the frontend can adapt its UI
without hard-coding backend capabilities.
"""
from fastapi import APIRouter

from app.core.config import settings

router = APIRouter()


@router.get(
    "/config/runtime",
    summary="Public runtime configuration",
    description="Return non-sensitive feature flags and client runtime settings.",
)
async def runtime_config():
    sfu_url = settings.SFU_URL.strip()
    return {
        "sfu_url": sfu_url or None,
        "features": {
            "sfu": bool(sfu_url),
            "passkey": False,
            "ai": bool(settings.AI_API_KEY),
            "discovery": True,
            "oidc": settings.OIDC_ENABLED,
            "ldap": settings.LDAP_ENABLED,
        },
    }
