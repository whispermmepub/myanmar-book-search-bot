"""Book data loading, caching and search."""

import csv
import io
import logging
import os
import re
import unicodedata
from datetime import datetime

import httpx
from PIL import Image

log = logging.getLogger(__name__)

DEFAULT_SHEET_CSV_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "18gpNdDNHztbkQE9rRvw6Y0rPqtKjrROJdy4HnZXqTQw/export?format=csv"
)

# CSV column order (as exported from the Google Form responses sheet)
COL_TIMESTAMP = 0
COL_PUBLISHER = 1
COL_MONTH = 2
COL_IMAGE = 3
COL_AUTHOR = 4
COL_TITLE = 5
COL_EDITION = 6
COL_GENRE = 7
COL_PRICE = 8
COL_DESC = 9

_PUNCT_RE = re.compile(r"[.,!?()\[\]{}<>\"'`~@#$%^&*_\-+=/\\|:;，。！？（）“”‘’]", re.UNICODE)
_SPACE_RE = re.compile(r"\s+", re.UNICODE)


def normalize(text: str) -> str:
    """Lowercase, unify unicode, drop spaces and punctuation."""
    text = unicodedata.normalize("NFKC", text or "")
    text = _PUNCT_RE.sub("", text)
    text = _SPACE_RE.sub("", text)
    return text.casefold()


def _extract_image_id(url: str) -> str | None:
    if not url:
        return None
    m = re.search(r"[?&]id=([\w-]+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/d/([\w-]+)", url)
    if m:
        return m.group(1)
    return None


class BookStore:
    """Loads book rows from the Google Sheets CSV export and searches them."""

    def __init__(self, csv_url: str | None = None, client: httpx.AsyncClient | None = None):
        self.csv_url = csv_url or os.environ.get("SHEET_CSV_URL", DEFAULT_SHEET_CSV_URL)
        self._client = client or httpx.AsyncClient(
            timeout=30, follow_redirects=True, headers={"User-Agent": "book-search-bot/1.0"}
        )
        self.books: list[dict] = []
        self.loaded_at: datetime | None = None

    async def close(self):
        await self._client.aclose()

    async def fetch_csv(self) -> str:
        resp = await self._client.get(self.csv_url)
        resp.raise_for_status()
        return resp.text

    def parse_csv(self, text: str) -> None:
        rows = list(csv.reader(io.StringIO(text)))
        books: list[dict] = []
        seen: set[tuple] = set()
        for row in rows[2:]:  # skip header row and empty spacer row
            if len(row) <= COL_PRICE:
                continue
            title = (row[COL_TITLE] or "").strip()
            author = (row[COL_AUTHOR] or "").strip()
            publisher = (row[COL_PUBLISHER] or "").strip()
            price = (row[COL_PRICE] or "").strip()
            edition = (row[COL_EDITION] or "").strip()
            image_url = (row[COL_IMAGE] or "").strip()
            image_id = _extract_image_id(image_url)
            if not (title and author and publisher and price and edition and image_id):
                continue  # only keep entries with complete information
            key = (normalize(title), normalize(author))
            if key in seen:
                continue  # dedupe identical entries
            seen.add(key)
            books.append(
                {
                    "id": len(books),
                    "timestamp": (row[COL_TIMESTAMP] or "").strip(),
                    "publisher": publisher,
                    "month": (row[COL_MONTH] or "").strip(),
                    "author": author,
                    "title": title,
                    "edition": edition,
                    "genre": (row[COL_GENRE] or "").strip(),
                    "price": price,
                    "description": (row[COL_DESC] or "").strip(),
                    "image_url": image_url,
                    "image_id": image_id,
                    "title_n": normalize(title),
                    "author_n": normalize(author),
                    "publisher_n": normalize(publisher),
                }
            )
        books.sort(key=lambda b: b["timestamp"], reverse=True)
        for i, b in enumerate(books):
            b["id"] = i
        self.books = books
        self.loaded_at = datetime.utcnow()
        log.info("Loaded %d books", len(self.books))

    async def load(self) -> None:
        text = await self.fetch_csv()
        self.parse_csv(text)

    def _tokenize(self, q: str) -> list[str]:
        return [normalize(t) for t in q.split() if normalize(t)]

    def by_id(self, book_id: int) -> dict | None:
        if 0 <= book_id < len(self.books) and self.books[book_id]["id"] == book_id:
            return self.books[book_id]
        return None

    def search(self, query: str, limit: int = 100) -> list[dict]:
        q = normalize(query)
        if not q:
            return []
        q_tokens = self._tokenize(query)
        scored: list[tuple[int, dict]] = []
        for b in self.books:
            title_n, author_n, pub_n = b["title_n"], b["author_n"], b["publisher_n"]
            score = 0
            if q == title_n:
                score = 100
            elif title_n.startswith(q):
                score = 85
            elif q in title_n:
                score = 70
            elif q == author_n:
                score = 90
            elif author_n.startswith(q):
                score = 75
            elif q in author_n:
                score = 60
            elif q == pub_n or q in pub_n:
                score = 30
            elif len(q_tokens) > 1 and all(t in title_n or t in author_n for t in q_tokens):
                score = 50
            if score:
                scored.append((score, b))
        scored.sort(key=lambda x: (-x[0], x[1]["timestamp"]), reverse=False)
        return [b for _, b in scored[:limit]]


class ImageCache:
    """Downloads Google Drive cover images and caches them locally as JPEG."""

    def __init__(self, root: str | None = None):
        self.root = root or os.environ.get("IMAGE_CACHE_DIR", "/tmp/book_covers")
        os.makedirs(self.root, exist_ok=True)
        self._client = httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 book-search-bot"},
        )

    async def close(self):
        await self._client.aclose()

    def _path(self, image_id: str) -> str:
        return os.path.join(self.root, f"{image_id}.jpg")

    async def get(self, image_id: str) -> str | None:
        path = self._path(image_id)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return path
        # Try the small thumbnail first (much faster than the full file),
        # then fall back to the full-size export URL.
        candidates = [
            f"https://drive.google.com/thumbnail?id={image_id}&sz=w800",
            f"https://drive.google.com/uc?export=view&id={image_id}",
        ]
        for url in candidates:
            for attempt in (1, 2):
                try:
                    resp = await self._client.get(url)
                    resp.raise_for_status()
                    data = resp.content
                    if not data:
                        continue
                    # Normalize every image to JPEG so Telegram can always display it.
                    img = Image.open(io.BytesIO(data))  # raises if the response is not an image
                    img.thumbnail((1280, 1280))
                    if img.mode in ("RGBA", "P", "LA"):
                        img = img.convert("RGB")
                    img.save(path, "JPEG", quality=88)
                    log.info("Cached cover %s via %s (%d bytes)", image_id, url, len(data))
                    return path
                except Exception as exc:  # noqa: BLE001
                    log.warning("Image fetch attempt %d failed for %s via %s: %s", attempt, image_id, url, exc)
                    if attempt == 2:
                        break
        return None
