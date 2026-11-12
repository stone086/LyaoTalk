"""Daily world-news ranking for the members-only news page.

The page is intentionally server-driven: headlines are fetched from public
RSS feeds by the API, normalised, de-duplicated, and ranked once per Beijing
calendar day.  Keeping the aggregation here avoids CORS problems in the
browser and means only authenticated members can trigger upstream fetches.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from email.utils import parsedate_to_datetime
from typing import Iterable
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx

logger = logging.getLogger("lyaotalk.news")

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
_MAX_FEED_BYTES = 4 * 1024 * 1024
_ITEMS_PER_FEED = 24
_WINDOW_HOURS = 48
_FALLBACK_WINDOW_HOURS = 7 * 24
_MAX_ITEMS_TOTAL = 180

@dataclass(frozen=True)
class NewsFeed:
    source_id: str
    name: str
    url: str
    weight: float
    domains: tuple[str, ...]


def _feed(source_id: str, name: str, url: str, weight: float, *domains: str) -> NewsFeed:
    return NewsFeed(source_id=source_id, name=name, url=url, weight=weight, domains=domains)


# Trusted, editorially maintained world-news feeds.  Weights express how
# strongly a single-source story competes against a story carried by several
# outlets; cross-source coverage remains the dominant signal.
_FEEDS = (
    _feed("bbc", "BBC News", "https://feeds.bbci.co.uk/news/world/rss.xml", 9.5, "bbc.co.uk", "bbc.com"),
    _feed("guardian", "The Guardian", "https://www.theguardian.com/world/rss", 9.0, "theguardian.com"),
    _feed("aljazeera", "Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", 8.8, "aljazeera.com"),
    _feed("npr", "NPR", "https://feeds.npr.org/1004/rss.xml", 8.2, "npr.org"),
    _feed("dw", "DW", "https://rss.dw.com/rdf/rss-en-world", 8.0, "dw.com"),
    _feed("france24", "France 24", "https://www.france24.com/en/rss", 7.8, "france24.com"),
    _feed("un", "UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml", 7.8, "un.org"),
    _feed("sky", "Sky News", "https://feeds.skynews.com/feeds/rss/world.xml", 7.7, "news.sky.com", "skynews.com"),
    _feed(
        "google",
        "Google News",
        "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
        7.0,
        "news.google.com",
    ),
)

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
_EXCLUDED_SECTION_RE = re.compile(
    r"^/(?:sport|sports|football|soccer|cricket|tennis|golf|formula-?1|f1|"
    r"entertainment|celebrity|celebrities|culture|lifestyle|travel|fashion|"
    r"music|film|movies|tv|television)(?:/|$)",
    re.IGNORECASE,
)
_NON_NEWS_CATEGORIES = frozenset(
    {
        "sport", "sports", "football", "soccer", "cricket", "tennis", "golf",
        "formula 1", "f1", "entertainment", "celebrity", "celebrities",
        "lifestyle", "travel", "fashion", "music", "film", "movies",
        "television", "tv shows",
    }
)

# Generic words do not distinguish one story from another.  Keeping this list
# small is deliberate: over-filtering makes unrelated headlines look alike.
_STOPWORDS = frozenset(
    {
        "a", "about", "after", "again", "against", "all", "also", "amid", "an",
        "and", "are", "as", "at", "be", "been", "before", "being", "between",
        "by", "can", "could", "did", "do", "does", "during", "for", "from",
        "had", "has", "have", "he", "her", "here", "his", "how", "in", "into",
        "is", "it", "its", "just", "more", "most", "new", "news", "not", "now",
        "of", "on", "one", "or", "our", "out", "over", "says", "she", "should",
        "since", "so", "some", "than", "that", "the", "their", "them", "then",
        "there", "these", "they", "this", "those", "to", "today", "under",
        "up", "update", "updates", "was", "we", "were", "what", "when", "where",
        "which", "while", "who", "why", "will", "with", "world", "would",
        "you", "your", "live", "latest", "breaking", "video", "watch",
    }
)


class NewsUnavailable(RuntimeError):
    """Raised when no usable headlines can be obtained."""


@dataclass
class NewsItem:
    feed: NewsFeed
    publisher: str
    title: str
    summary: str
    url: str
    published_at: datetime
    image: str | None = None


@dataclass
class StoryCluster:
    items: list[NewsItem] = field(default_factory=list)

    @property
    def publishers(self) -> set[str]:
        return {item.publisher for item in self.items if item.publisher}

    @property
    def feeds(self) -> set[str]:
        return {item.feed.source_id for item in self.items}

    @property
    def latest(self) -> datetime:
        return max(item.published_at for item in self.items)

    @property
    def lead(self) -> NewsItem:
        # Prefer a version with an image, then a stronger feed, then a fuller
        # summary, and finally the freshest publication time.
        return max(
            self.items,
            key=lambda item: (
                bool(item.image),
                item.feed.weight,
                len(item.summary),
                item.published_at,
            ),
        )

    @property
    def score(self) -> float:
        latest = self.latest
        age_hours = max(0.0, (datetime.now(UTC) - latest).total_seconds() / 3600)
        freshness = max(0.0, min(1.0, 1.0 - age_hours / 36.0))
        coverage = max(1, len(self.publishers))
        return max(item.feed.weight for item in self.items) + 1.7 * (coverage - 1) + freshness

    def add(self, item: NewsItem) -> None:
        self.items.append(item)


_cache_lock: asyncio.Lock | None = None
_cache_key: str | None = None
_cache_payload: dict | None = None


def _get_cache_lock() -> asyncio.Lock:
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _element_text(element: ET.Element) -> str:
    return "".join(element.itertext()).strip()


def _direct_text(element: ET.Element, *names: str) -> str:
    wanted = {name.lower() for name in names}
    for child in element:
        if _local_name(child.tag) in wanted:
            text = _element_text(child)
            if text:
                return text
    return ""


def _plain_text(raw: str, limit: int = 380) -> str:
    value = html.unescape(raw or "")
    value = _HTML_TAG_RE.sub(" ", value)
    value = _WHITESPACE_RE.sub(" ", value).strip()
    if len(value) > limit:
        value = value[: limit - 1].rstrip() + "…"
    return value


def _valid_http_url(value: str) -> str | None:
    if not value:
        return None
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return value.strip()


def _item_link(element: ET.Element) -> str | None:
    fallback: str | None = None
    for child in element:
        if _local_name(child.tag) != "link":
            continue
        href = child.attrib.get("href")
        rel = (child.attrib.get("rel") or "alternate").lower()
        if href and rel in {"alternate", ""}:
            return _valid_http_url(href)
        if not href:
            text = _element_text(child)
            if text:
                fallback = _valid_http_url(text)
    if fallback:
        return fallback
    guid = _direct_text(element, "guid", "id")
    return _valid_http_url(guid)


def _item_image(element: ET.Element) -> str | None:
    for child in element.iter():
        name = _local_name(child.tag)
        if name not in {"content", "thumbnail", "enclosure", "image"}:
            continue
        url = child.attrib.get("url") or child.attrib.get("href") or ""
        kind = (child.attrib.get("type") or child.attrib.get("medium") or "").lower()
        if not url:
            continue
        if kind.startswith("image") or name in {"thumbnail", "image"} or re.search(
            r"\.(?:jpg|jpeg|png|webp|avif)(?:\?|$)", url, re.IGNORECASE
        ):
            valid = _valid_http_url(url)
            if valid and valid.lower().startswith("https://"):
                return valid
    return None


def _parse_date(raw: str) -> datetime | None:
    value = (raw or "").strip()
    if not value:
        return None
    parsed: datetime | None = None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        parsed = None
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    now = datetime.now(UTC)
    if parsed.year < 2000 or parsed > now + timedelta(hours=2):
        return None
    return parsed


def _item_date(element: ET.Element) -> datetime | None:
    for name in ("pubdate", "published", "updated", "date", "created", "issued"):
        raw = _direct_text(element, name)
        parsed = _parse_date(raw)
        if parsed:
            return parsed
    return None


def _publisher(element: ET.Element, feed: NewsFeed) -> str:
    source = _plain_text(_direct_text(element, "source", "creator", "author"), 80)
    if feed.source_id == "google" and source:
        # Google News appends the original publisher in <source>.
        return source
    return feed.name


def _is_non_news_item(element: ET.Element, url: str, feed: NewsFeed) -> bool:
    categories = {
        _plain_text(child.text or "", 40).casefold()
        for child in element
        if _local_name(child.tag) == "category"
    }
    if categories & _NON_NEWS_CATEGORIES:
        return True
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").casefold()
        path = parsed.path
    except ValueError:
        return True
    if feed.domains and not any(host == domain or host.endswith(f".{domain}") for domain in feed.domains):
        return True
    return bool(path and _EXCLUDED_SECTION_RE.search(path))


def _strip_source_suffix(title: str, publisher: str) -> str:
    for separator in (" - ", " | ", " — "):
        suffix = f"{separator}{publisher}"
        if title.lower().endswith(suffix.lower()):
            return title[: -len(suffix)].strip()
    return title


def _parse_feed(feed: NewsFeed, payload: bytes, fetched_at: datetime) -> list[NewsItem]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        logger.warning("news_feed_xml_invalid feed=%s error=%s", feed.source_id, type(exc).__name__)
        return []

    entries: list[ET.Element] = []
    for child in root.iter():
        if _local_name(child.tag) in {"item", "entry"}:
            entries.append(child)
    if not entries and _local_name(root.tag) in {"item", "entry"}:
        entries.append(root)

    items: list[NewsItem] = []
    for entry in entries[:_ITEMS_PER_FEED]:
        raw_title = _direct_text(entry, "title")
        title = _plain_text(raw_title, 220)
        link = _item_link(entry)
        if not title or not link or _is_non_news_item(entry, link, feed):
            continue
        publisher = _publisher(entry, feed)
        title = _strip_source_suffix(title, publisher)
        summary = _plain_text(
            _direct_text(entry, "description", "summary", "content", "encoded"),
            320,
        )
        published = _item_date(entry) or fetched_at
        items.append(
            NewsItem(
                feed=feed,
                publisher=publisher,
                title=title,
                summary=summary,
                url=link,
                published_at=published,
                image=_item_image(entry),
            )
        )
    return items


async def _fetch_feed(client: httpx.AsyncClient, feed: NewsFeed, fetched_at: datetime) -> list[NewsItem]:
    try:
        response = await client.get(feed.url)
        response.raise_for_status()
        if len(response.content) > _MAX_FEED_BYTES:
            logger.warning("news_feed_too_large feed=%s bytes=%s", feed.source_id, len(response.content))
            return []
        return await asyncio.to_thread(_parse_feed, feed, response.content, fetched_at)
    except Exception as exc:  # one bad publisher must not empty the page
        logger.warning("news_feed_failed feed=%s error=%s", feed.source_id, type(exc).__name__)
        return []


def _title_tokens(title: str) -> set[str]:
    normalized = title.casefold().replace("’", "'").replace("‘", "'")
    return {
        word
        for word in _WORD_RE.findall(normalized)
        if len(word) > 2 and word not in _STOPWORDS
    }


def _similar_titles(left: str, right: str) -> bool:
    left_norm = _WHITESPACE_RE.sub(" ", left.casefold()).strip()
    right_norm = _WHITESPACE_RE.sub(" ", right.casefold()).strip()
    if not left_norm or not right_norm:
        return False
    if left_norm == right_norm:
        return True

    left_tokens = _title_tokens(left)
    right_tokens = _title_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    overlap = len(left_tokens & right_tokens)
    smaller = min(len(left_tokens), len(right_tokens))
    if overlap >= 3 and overlap / smaller >= 0.55:
        return True
    return False


def _cluster(items: Iterable[NewsItem]) -> list[StoryCluster]:
    clusters: list[StoryCluster] = []
    ordered = sorted(items, key=lambda item: item.published_at, reverse=True)
    for item in ordered:
        for cluster in clusters:
            if any(_similar_titles(item.title, other.title) for other in cluster.items):
                cluster.add(item)
                break
        else:
            clusters.append(StoryCluster(items=[item]))
    return clusters


def _select_top_clusters(clusters: list[StoryCluster], now: datetime, count: int = 10) -> list[StoryCluster]:
    for window_hours in (_WINDOW_HOURS, _FALLBACK_WINDOW_HOURS):
        cutoff = now - timedelta(hours=window_hours)
        eligible = [cluster for cluster in clusters if cluster.latest >= cutoff]
        eligible.sort(key=lambda cluster: (cluster.score, cluster.latest), reverse=True)
        if len(eligible) >= count:
            break
    else:
        eligible = sorted(clusters, key=lambda cluster: (cluster.score, cluster.latest), reverse=True)

    # Keep the list visibly global: no single publisher may take more than two
    # slots while enough alternatives exist.  We then backfill if necessary.
    picked: list[StoryCluster] = []
    publisher_counts: dict[str, int] = {}
    for cluster in eligible:
        publisher = cluster.lead.publisher
        if publisher_counts.get(publisher, 0) >= 2:
            continue
        picked.append(cluster)
        publisher_counts[publisher] = publisher_counts.get(publisher, 0) + 1
        if len(picked) == count:
            break

    if len(picked) < count:
        ids = {id(cluster) for cluster in picked}
        for cluster in eligible:
            if id(cluster) not in ids:
                picked.append(cluster)
                if len(picked) == count:
                    break
    return picked


def _build_payload(items: list[NewsItem], local_date: date, now: datetime) -> dict:
    clusters = _cluster(items)
    selected = _select_top_clusters(clusters, now)

    output: list[dict] = []
    for rank, cluster in enumerate(selected, start=1):
        lead = cluster.lead
        publishers = sorted(cluster.publishers)
        other_publishers = [publisher for publisher in publishers if publisher != lead.publisher]
        output.append(
            {
                "rank": rank,
                "title": lead.title,
                "summary": lead.summary,
                "source": lead.publisher,
                "url": lead.url,
                "image": lead.image,
                "published_at": cluster.latest.isoformat(),
                "coverage": len(publishers),
                "also_reported_by": other_publishers[:3],
            }
        )

    next_update = datetime.combine(local_date + timedelta(days=1), time.min, tzinfo=LOCAL_TZ)
    return {
        "date": local_date.isoformat(),
        "timezone": "Asia/Shanghai",
        "generated_at": now.isoformat(),
        "next_update": next_update.isoformat(),
        "stale": False,
        "items": output,
        "sources": [{"name": feed.name, "url": feed.url} for feed in _FEEDS],
        "candidate_count": len(items),
    }


async def _fetch_all() -> list[NewsItem]:
    now = datetime.now(UTC)
    timeout = httpx.Timeout(15.0, connect=7.0)
    headers = {
        "User-Agent": "LyaoTalk-News/1.0 (+https://2-yc.com)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
        batches = await asyncio.gather(*(_fetch_feed(client, feed, now) for feed in _FEEDS))
    items = [item for batch in batches for item in batch]
    # Cap the working set so the O(n²) de-duplication stays comfortably fast
    # even if a publisher unexpectedly returns a very large feed.
    items.sort(key=lambda item: item.published_at, reverse=True)
    return items[:_MAX_ITEMS_TOTAL]


async def get_daily_top10() -> dict:
    """Return the cached top-10 for the current Beijing calendar day.

    A same-day cache is shared inside each worker process.  If all upstream
    feeds fail after a successful earlier build, the previous payload is
    returned with ``stale: true`` rather than showing an empty members page.
    """
    global _cache_key, _cache_payload

    now = datetime.now(UTC)
    local_date = now.astimezone(LOCAL_TZ).date()
    cache_key = local_date.isoformat()

    if _cache_key == cache_key and _cache_payload is not None:
        return _cache_payload

    async with _get_cache_lock():
        if _cache_key == cache_key and _cache_payload is not None:
            return _cache_payload

        try:
            items = await _fetch_all()
            if len(items) < 5:
                raise NewsUnavailable("No usable headlines from upstream feeds")
            payload = _build_payload(items, local_date, now)
            if len(payload["items"]) < 5:
                raise NewsUnavailable("Could not rank enough distinct stories")
        except Exception as exc:
            logger.warning("news_build_failed error=%s", type(exc).__name__)
            if _cache_payload is not None:
                return {**_cache_payload, "stale": True}
            raise

        _cache_key = cache_key
        _cache_payload = payload
        return payload
