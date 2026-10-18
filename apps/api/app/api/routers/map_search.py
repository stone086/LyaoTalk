"""Small, explicitly submitted place searches for the in-app location picker."""

import hashlib
import json

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from app.core.rate_limit import limiter
from app.utils.cache import get_redis

router = APIRouter()
_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "LyaoTalk/2.3.6 (+https://lyaot.2-yc.com)"


@router.get("/map/search")
@limiter.limit("10/minute")
async def search_places(request: Request, q: str = Query(min_length=2, max_length=160)):
    query = " ".join(q.split())
    if len(query) < 2:
        raise HTTPException(422, "Search text is too short")
    cache_key = "map:search:v1:" + hashlib.sha256(query.casefold().encode()).hexdigest()
    try:
        redis = await get_redis()
        cached = await redis.get(cache_key)
        if cached is not None:
            return json.loads(cached)
        # The public Nominatim service permits at most one request per second
        # for the entire application. Fail closed if Redis cannot enforce it.
        allowed = await redis.set("map:search:upstream-slot", "1", nx=True, px=1100)
    except Exception:
        raise HTTPException(503, "Place search is temporarily unavailable") from None
    if not allowed:
        raise HTTPException(429, "Please wait a moment before searching again")

    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=False, trust_env=False) as client:
            response = await client.get(
                _SEARCH_URL,
                params={"q": query, "format": "jsonv2", "limit": 5, "addressdetails": 0},
                headers={"User-Agent": _USER_AGENT, "Accept-Language": "zh-CN,zh,en"},
            )
            response.raise_for_status()
            results = []
            for place in response.json()[:5]:
                latitude, longitude = float(place["lat"]), float(place["lon"])
                if -90 <= latitude <= 90 and -180 <= longitude <= 180:
                    results.append({
                        "name": str(place["display_name"])[:300],
                        "latitude": latitude,
                        "longitude": longitude,
                    })
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Place search failed") from None

    try:
        await redis.setex(cache_key, 24 * 60 * 60, json.dumps(results, ensure_ascii=False))
    except Exception:
        pass
    return results
