import asyncio
import socket

import httpx
import pytest
from fastapi import HTTPException

from app.api.routers.preview import PublicIPTransport


@pytest.mark.asyncio
async def test_preview_transport_rejects_private_dns_answer(monkeypatch):
    loop = asyncio.get_running_loop()

    async def private_answer(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    monkeypatch.setattr(loop, "getaddrinfo", private_answer)
    transport = PublicIPTransport()
    with pytest.raises(HTTPException) as exc:
        await transport.handle_async_request(httpx.Request("GET", "https://example.com/"))
    assert exc.value.status_code == 400
    await transport.aclose()


@pytest.mark.asyncio
async def test_preview_transport_connects_to_validated_ip(monkeypatch):
    loop = asyncio.get_running_loop()

    async def public_answer(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]

    async def capture_request(self, request):
        assert request.url.host == "93.184.215.14"
        assert request.headers["host"] == "example.com"
        assert request.extensions["sni_hostname"] == "example.com"
        return httpx.Response(200, request=request)

    monkeypatch.setattr(loop, "getaddrinfo", public_answer)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", capture_request)
    transport = PublicIPTransport()
    response = await transport.handle_async_request(httpx.Request("GET", "https://example.com/"))
    assert response.status_code == 200
    await transport.aclose()
