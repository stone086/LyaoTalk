"""
websocket.py - Real-time push endpoint.
The frontend connects here to receive server-pushed events
(new message notifications, presence changes, etc.).
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict, Set
from app.utils.security import decode_token
import json
import asyncio

router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self.connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, ws: WebSocket, account_id: str, subprotocol: str | None = None):
        await ws.accept(subprotocol=subprotocol)
        if account_id not in self.connections:
            self.connections[account_id] = set()
        self.connections[account_id].add(ws)

    def disconnect(self, ws: WebSocket, account_id: str):
        if account_id in self.connections:
            self.connections[account_id].discard(ws)
            if not self.connections[account_id]:
                del self.connections[account_id]

    async def send_to_account(self, account_id: str, data: dict):
        if account_id not in self.connections:
            return
        dead = set()
        for ws in self.connections[account_id]:
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.connections[account_id].discard(ws)

    async def broadcast(self, data: dict):
        for account_id in list(self.connections.keys()):
            await self.send_to_account(account_id, data)


manager = ConnectionManager()


@router.websocket("/ws/{account_id}")
async def websocket_endpoint(ws: WebSocket, account_id: str):
    # Authenticate through the Sec-WebSocket-Protocol header, not the URL.
    # A token in the query string is copied into nginx/APM access logs and the
    # browser history on every connect; headers are not logged by default.
    # The client offers ["liaot.v1", "bearer.<jwt>"] and we echo "liaot.v1".
    subprotocol = None
    token = None
    offered = (ws.headers.get("sec-websocket-protocol") or "").split(",")
    for part in offered:
        candidate = part.strip()
        if candidate.startswith("bearer."):
            token = candidate[len("bearer."):]
            subprotocol = "liaot.v1"
            break
    if not token:
        # Legacy clients still pass ?token=; accepted for now so a stale PWA
        # keeps working, and nginx no longer logs this path.
        token = ws.query_params.get("token")
    if not token:
        await ws.close(code=4001, reason="Missing token")
        return
    try:
        payload = decode_token(token)
        role = payload.get("role")
        token_account_id = payload.get("account_id")
        # Accept user token only for the matching account; admin token for any account
        if role == "user" and token_account_id != account_id:
            await ws.close(code=4003, reason="Token account mismatch")
            return
        if role not in ("user", "admin"):
            await ws.close(code=4003, reason="Invalid token role")
            return
    except Exception:
        await ws.close(code=4001, reason="Invalid or expired token")
        return

    # Limit concurrent connections per account (prevent resource exhaustion)
    MAX_CONNECTIONS_PER_ACCOUNT = 10
    existing = manager.connections.get(account_id, set())
    if len(existing) >= MAX_CONNECTIONS_PER_ACCOUNT:
        await ws.close(code=4008, reason="Too many connections")
        return

    await manager.connect(ws, account_id, subprotocol)
    consecutive_timeouts = 0
    MAX_IDLE_TIMEOUTS = 6  # 6 * 30s = 3 minutes idle → disconnect
    MAX_MESSAGE_BYTES = 8 * 1024  # 8KB — clients only send pings + ack frames
    try:
        await ws.send_json({"type": "connected", "account_id": account_id})
        while True:
            try:
                decode_token(token)
            except Exception:
                await ws.close(code=4003, reason="Session revoked")
                break
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=30)
                consecutive_timeouts = 0
                # Reject oversized messages — without this, an attacker could
                # send a 100MB payload and force the server to allocate it,
                # then ws.receive_text gives it to us all at once.
                if len(data) > MAX_MESSAGE_BYTES:
                    await ws.close(code=1009, reason="Message too large")
                    break
                try:
                    msg = json.loads(data)
                except (ValueError, TypeError):
                    # Malformed JSON — close rather than try to recover, since
                    # a well-behaved client should never send non-JSON here.
                    await ws.close(code=1003, reason="Invalid frame")
                    break
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
            except asyncio.TimeoutError:
                consecutive_timeouts += 1
                if consecutive_timeouts >= MAX_IDLE_TIMEOUTS:
                    await ws.close(code=4009, reason="Idle timeout")
                    break
                await ws.send_json({"type": "ping"})
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws, account_id)


async def push_event(account_id: str, event_type: str, payload: dict):
    await manager.send_to_account(account_id, {"type": event_type, **payload})
