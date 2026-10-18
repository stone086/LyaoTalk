from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routers import map_search


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.slots = 0

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, *, nx, px):
        assert nx and px >= 1000
        self.slots += 1
        return self.slots == 1

    async def setex(self, key, ttl, value):
        assert ttl >= 86400
        self.values[key] = value


@pytest.mark.asyncio
async def test_place_search_returns_locations_and_reuses_cache(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(map_search, "get_redis", lambda: _async_value(redis))
    calls = []

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def get(self, url, *, params, headers):
            calls.append((url, params, headers))
            return SimpleNamespace(
                raise_for_status=lambda: None,
                json=lambda: [{"display_name": "宁波市", "lat": "29.87", "lon": "121.55"}],
            )

    monkeypatch.setattr(map_search.httpx, "AsyncClient", lambda **_: FakeClient())
    first = await map_search.search_places.__wrapped__(SimpleNamespace(), q="  宁波市  ")
    second = await map_search.search_places.__wrapped__(SimpleNamespace(), q="宁波市")
    assert first == second == [{"name": "宁波市", "latitude": 29.87, "longitude": 121.55}]
    assert len(calls) == 1
    assert calls[0][1]["q"] == "宁波市"
    assert "LyaoTalk" in calls[0][2]["User-Agent"]


@pytest.mark.asyncio
async def test_place_search_throttles_uncached_queries(monkeypatch):
    redis = FakeRedis()
    redis.slots = 1
    monkeypatch.setattr(map_search, "get_redis", lambda: _async_value(redis))
    with pytest.raises(HTTPException) as error:
        await map_search.search_places.__wrapped__(SimpleNamespace(), q="北京")
    assert error.value.status_code == 429


async def _async_value(value):
    return value
