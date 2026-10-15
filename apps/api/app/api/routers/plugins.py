from fastapi import APIRouter, Depends, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from typing import Optional
import json
from app.core.database import get_db
from app.models import Plugin, PluginSetting
from app.services.audit import write_audit, get_client_ip
from app.utils.security import bearer_scheme, decode_token
import uuid

router = APIRouter()

# Plugin IDs are static — registered at app startup, no dynamic registration.
# Validating plugin_id against this set blocks two attack classes:
#   1. Junk-row DoS: writing settings for fake plugin IDs to fill the table
#   2. Typo/misroute: malicious frontend writing to "ai-summary " (trailing
#      space) lets an attacker shadow legitimate config
BUILTIN_PLUGINS = [
    {"id": "ai-summary",   "name": "AI Summary",    "version": "1.0.0", "permissions": ["messages.read", "api.ai"]},
    {"id": "translate",    "name": "Translate",      "version": "1.0.0", "permissions": ["messages.read", "api.ai"]},
    {"id": "quick-reply",  "name": "Quick Reply",    "version": "1.0.0", "permissions": ["messages.send"]},
    {"id": "bot-bridge",   "name": "Bot Bridge",     "version": "1.0.0", "permissions": ["messages.read", "messages.send"]},
    {"id": "reminder",     "name": "Reminder",       "version": "1.0.0", "permissions": ["messages.read"]},
    {"id": "markdown-plus","name": "Markdown Plus",  "version": "1.0.0", "permissions": ["messages.read"]},
]
_VALID_PLUGIN_IDS = {p["id"] for p in BUILTIN_PLUGINS}

# Bound plugin settings JSON to prevent DoS-via-config-bloat.
# 64KB is generous for any legitimate plugin config (API keys, prompts, toggles).
_MAX_CONFIG_BYTES = 64 * 1024
_MAX_CONFIG_DEPTH = 8


def _validate_plugin_id(plugin_id: str) -> None:
    if plugin_id not in _VALID_PLUGIN_IDS:
        # Use 404 so we don't leak which IDs exist via timing
        raise HTTPException(status_code=404, detail="Plugin not found")


def _validate_config(config: dict) -> None:
    """Reject configs that are too large, too deep, or non-JSON-serializable."""
    try:
        encoded = json.dumps(config, ensure_ascii=False)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Config must be JSON-serializable")
    if len(encoded.encode("utf-8")) > _MAX_CONFIG_BYTES:
        raise HTTPException(status_code=413, detail=f"Config exceeds {_MAX_CONFIG_BYTES} bytes")

    def depth(obj, current=0) -> int:
        if current > _MAX_CONFIG_DEPTH:
            return current
        if isinstance(obj, dict):
            return max((depth(v, current + 1) for v in obj.values()), default=current)
        if isinstance(obj, list):
            return max((depth(v, current + 1) for v in obj), default=current)
        return current

    if depth(config) > _MAX_CONFIG_DEPTH:
        raise HTTPException(status_code=400, detail="Config nesting too deep")


def get_plugin_actor(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme),
) -> dict[str, str | None]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    role = payload.get("role")
    if role == "admin":
        return {"role": "admin", "sub": payload["sub"], "account_id": payload.get("account_id")}
    if role == "user" and payload.get("account_id"):
        return {"role": "user", "sub": payload["sub"], "account_id": payload["account_id"]}
    raise HTTPException(status_code=403, detail="Plugin access denied")


def _require_admin(actor: dict[str, str | None]) -> None:
    if actor.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")


def _require_account_owner(account_id: Optional[str], actor: dict[str, str | None]) -> None:
    """For per-account settings: admin can touch anything; users only their own."""
    if actor.get("role") == "admin":
        return
    # Global (account_id=None) settings are admin-only — users must scope to their own account.
    if account_id is None:
        raise HTTPException(status_code=403, detail="Global plugin settings are admin-only")
    if actor.get("account_id") != account_id:
        raise HTTPException(status_code=403, detail="Plugin setting access denied")


async def ensure_plugins(db: AsyncSession):
    for p in BUILTIN_PLUGINS:
        result = await db.execute(select(Plugin).where(Plugin.id == p["id"]))
        if not result.scalar_one_or_none():
            db.add(Plugin(id=p["id"], name=p["name"], version=p["version"],
                          is_enabled=False, permission_json=p["permissions"]))
    await db.commit()


@router.get(
    "/",
    summary="List plugins",
    description="Return installed built-in plugins and current enabled state.",
)
async def list_plugins(
    actor: dict[str, str | None] = Depends(get_plugin_actor),
    db: AsyncSession = Depends(get_db),
):
    await ensure_plugins(db)
    result = await db.execute(select(Plugin))
    return [{"id": p.id, "name": p.name, "version": p.version,
             "is_enabled": p.is_enabled, "permissions": p.permission_json}
            for p in result.scalars().all()]


@router.post(
    "/{plugin_id}/enable",
    summary="Enable plugin (admin only)",
    description="Enable one plugin server-wide. Affects all accounts, "
                "so this requires the admin role.",
)
async def enable_plugin(
    plugin_id: str,
    request: Request,
    actor: dict[str, str | None] = Depends(get_plugin_actor),
    db: AsyncSession = Depends(get_db),
):
    # Plugin enable/disable is a server-wide flag, not per-account.
    # Without this admin gate, any authenticated user could (re)enable
    # plugins for everyone — a hostile user could disable an admin's
    # plugin or reverse a security-motivated disable.
    _require_admin(actor)
    _validate_plugin_id(plugin_id)
    result = await db.execute(select(Plugin).where(Plugin.id == plugin_id))
    plugin = result.scalar_one_or_none()
    if not plugin:
        raise HTTPException(404, "Plugin not found")
    plugin.is_enabled = True
    await db.commit()
    await write_audit(
        db,
        actor=actor.get("sub") or "admin",
        action="plugin_enabled",
        target_type="plugin",
        target_id=plugin_id,
        client_ip=get_client_ip(request),
    )
    return {"ok": True, "plugin_id": plugin_id, "is_enabled": True}


@router.post(
    "/{plugin_id}/disable",
    summary="Disable plugin (admin only)",
    description="Disable one plugin server-wide. Admin-only for the same "
                "reason as enable.",
)
async def disable_plugin(
    plugin_id: str,
    request: Request,
    actor: dict[str, str | None] = Depends(get_plugin_actor),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(actor)
    _validate_plugin_id(plugin_id)
    result = await db.execute(select(Plugin).where(Plugin.id == plugin_id))
    plugin = result.scalar_one_or_none()
    if not plugin:
        raise HTTPException(404, "Plugin not found")
    plugin.is_enabled = False
    await db.commit()
    await write_audit(
        db,
        actor=actor.get("sub") or "admin",
        action="plugin_disabled",
        target_type="plugin",
        target_id=plugin_id,
        client_ip=get_client_ip(request),
    )
    return {"ok": True, "plugin_id": plugin_id, "is_enabled": False}


@router.get(
    "/{plugin_id}/settings",
    summary="Get plugin settings",
    description="Return plugin configuration for optional account scope. "
                "Users may only read their own account's settings; "
                "admin may read any.",
)
async def get_plugin_settings(
    plugin_id: str,
    account_id: Optional[str] = None,
    actor: dict[str, str | None] = Depends(get_plugin_actor),
    db: AsyncSession = Depends(get_db),
):
    _validate_plugin_id(plugin_id)
    _require_account_owner(account_id, actor)

    # Strict scoping: never fall back to "any row matching plugin_id" — that
    # used to leak one user's config to anyone making an unscoped query.
    stmt = select(PluginSetting).where(
        PluginSetting.plugin_id == plugin_id,
        PluginSetting.account_id == account_id,
    )
    result = await db.execute(stmt)
    setting = result.scalar_one_or_none()
    return {"config": setting.config_json if setting else {}}


@router.put(
    "/{plugin_id}/settings",
    summary="Update plugin settings",
    description="Write plugin configuration. Users may only write their own "
                "account's settings. Global (account_id=None) settings "
                "require admin role. Config bounded to 64KB / depth 8.",
)
async def update_plugin_settings(
    plugin_id: str,
    config: dict,
    account_id: Optional[str] = None,
    actor: dict[str, str | None] = Depends(get_plugin_actor),
    db: AsyncSession = Depends(get_db),
):
    _validate_plugin_id(plugin_id)
    _require_account_owner(account_id, actor)
    _validate_config(config)

    stmt = select(PluginSetting).where(
        PluginSetting.plugin_id == plugin_id,
        PluginSetting.account_id == account_id,
    )
    result = await db.execute(stmt)
    setting = result.scalar_one_or_none()
    if setting:
        setting.config_json = config
        await db.commit()
        return {"ok": True}
    db.add(PluginSetting(
        id=str(uuid.uuid4()),
        plugin_id=plugin_id,
        account_id=account_id,
        config_json=config,
    ))
    try:
        await db.commit()
        return {"ok": True}
    except IntegrityError:
        # Concurrent settings PUT lost the race. The partial-unique index
        # added in migration 0008 ensures only one per (plugin, account).
        # Roll back and overwrite the winner's row with our config — last
        # write wins, which matches the existing semantics of the update branch.
        await db.rollback()
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if not existing:
            raise HTTPException(status_code=409, detail="Conflict writing plugin settings")
        existing.config_json = config
        await db.commit()
        return {"ok": True}
