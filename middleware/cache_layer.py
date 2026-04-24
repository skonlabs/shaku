"""
In-process LRU cache with TTL for cleaned inputs, summaries, embeddings,
and final model responses.

Thread-safety note: uses a plain dict — suitable for single-threaded or
cooperative async code.  Add threading.Lock wrapping if needed in
multi-threaded environments.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


class CacheLayer:
    """
    Namespaced, TTL-aware LRU cache.

    Namespaces used by the middleware:
      - ``clean``     : cleaned input text
      - ``summary``   : extractive summaries of conversation turns
      - ``embedding`` : text embeddings (list[float])
      - ``response``  : final model responses

    LRU eviction removes the oldest 25 % of entries when the cache is full.
    """

    def __init__(
        self,
        max_size: int = 1_000,
        ttl_seconds: float = 3_600.0,
    ) -> None:
        self._max_size = max_size
        self._ttl      = ttl_seconds
        # key → {"val": Any, "ts": float}
        self._store: dict = {}
        self._hits   = 0
        self._misses = 0

    # ------------------------------------------------------------------
    # Typed accessors (kept thin to remain testable)
    # ------------------------------------------------------------------

    def get_cleaned(self, raw_text: str) -> Optional[str]:
        return self._get("clean", raw_text)

    def set_cleaned(self, raw_text: str, cleaned: str) -> None:
        self._set("clean", raw_text, cleaned)

    def get_summary(self, text: str) -> Optional[str]:
        return self._get("summary", text)

    def set_summary(self, text: str, summary: str) -> None:
        self._set("summary", text, summary)

    def get_embedding(self, text: str) -> Optional[list]:
        return self._get("embedding", text)

    def set_embedding(self, text: str, embedding: list) -> None:
        self._set("embedding", text, embedding)

    def get_response(self, request_key: str) -> Optional[Any]:
        return self._get("response", request_key)

    def set_response(self, request_key: str, response: Any) -> None:
        self._set("response", request_key, response)

    # ------------------------------------------------------------------
    # Generic get / set
    # ------------------------------------------------------------------

    def get(self, namespace: str, content: str) -> Optional[Any]:
        return self._get(namespace, content)

    def set(self, namespace: str, content: str, value: Any) -> None:
        self._set(namespace, content, value)

    # ------------------------------------------------------------------
    # Stats & maintenance
    # ------------------------------------------------------------------

    @property
    def hits(self) -> int:
        return self._hits

    @property
    def misses(self) -> int:
        return self._misses

    @property
    def hit_rate(self) -> float:
        total = self._hits + self._misses
        return round(self._hits / total, 4) if total else 0.0

    @property
    def size(self) -> int:
        return len(self._store)

    def stats(self) -> dict:
        return {
            "hits":      self._hits,
            "misses":    self._misses,
            "hit_rate":  self.hit_rate,
            "size":      len(self._store),
            "max_size":  self._max_size,
            "ttl":       self._ttl,
        }

    def clear(self) -> None:
        self._store.clear()
        self._hits   = 0
        self._misses = 0

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _cache_key(self, namespace: str, content: str) -> str:
        digest = hashlib.sha256(
            content.encode("utf-8", errors="replace")
        ).hexdigest()
        return f"{namespace}:{digest}"

    def _get(self, namespace: str, content: str) -> Optional[Any]:
        key   = self._cache_key(namespace, content)
        entry = self._store.get(key)

        if entry is None:
            self._misses += 1
            return None

        if time.monotonic() - entry["ts"] > self._ttl:
            del self._store[key]
            self._misses += 1
            return None

        # Refresh access time (LRU)
        entry["ts"] = time.monotonic()
        self._hits += 1
        return entry["val"]

    def _set(self, namespace: str, content: str, value: Any) -> None:
        key = self._cache_key(namespace, content)
        if len(self._store) >= self._max_size and key not in self._store:
            self._evict()
        self._store[key] = {"val": value, "ts": time.monotonic()}

    def _evict(self) -> None:
        """Remove the oldest 25 % of entries."""
        sorted_keys = sorted(self._store, key=lambda k: self._store[k]["ts"])
        n_evict = max(1, len(sorted_keys) // 4)
        for k in sorted_keys[:n_evict]:
            del self._store[k]
        logger.debug("CacheLayer: evicted %d entries (size now %d)", n_evict, len(self._store))
