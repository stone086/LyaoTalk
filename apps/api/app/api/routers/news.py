"""Members-only daily world-news API."""

from fastapi import APIRouter, Depends, HTTPException, Response

from app.services.news import NewsUnavailable, get_daily_top10
from app.utils.security import get_current_user

router = APIRouter()


@router.get(
    "/top10",
    summary="Daily global news Top 10",
    description=(
        "Return the members-only daily Top 10 world-news ranking. Headlines "
        "are aggregated server-side from public RSS feeds and cached for the "
        "current Beijing calendar day."
    ),
)
async def daily_top10(
    response: Response,
    _member: dict[str, str] = Depends(get_current_user),
):
    try:
        payload = await get_daily_top10()
    except NewsUnavailable:
        raise HTTPException(
            status_code=503,
            detail="News sources are temporarily unavailable. Please try again shortly.",
        )

    # The page is for signed-in members only; do not let shared caches retain
    # a personalised response.
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return payload
