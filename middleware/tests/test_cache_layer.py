"""Tests for CacheLayer."""
import time
import pytest
from middleware.cache_layer import CacheLayer


@pytest.fixture
def cache():
    return CacheLayer(max_size=10, ttl_seconds=60.0)


class TestGetSet:
    def test_get_missing_returns_none(self, cache):
        assert cache.get_cleaned("missing key") is None

    def test_set_then_get(self, cache):
        cache.set_cleaned("hello world", "hello world")
        assert cache.get_cleaned("hello world") == "hello world"

    def test_summary_namespace(self, cache):
        cache.set_summary("input", "summary text")
        assert cache.get_summary("input") == "summary text"

    def test_embedding_namespace(self, cache):
        cache.set_embedding("text", [0.1, 0.2, 0.3])
        assert cache.get_embedding("text") == [0.1, 0.2, 0.3]

    def test_response_namespace(self, cache):
        cache.set_response("key", {"content": "response"})
        assert cache.get_response("key") == {"content": "response"}

    def test_different_namespaces_isolated(self, cache):
        # Same key, different namespace
        cache.set_cleaned("hello", "cleaned")
        cache.set_summary("hello", "summary")
        assert cache.get_cleaned("hello") == "cleaned"
        assert cache.get_summary("hello") == "summary"

    def test_generic_get_set(self, cache):
        cache.set("custom", "key", "value")
        assert cache.get("custom", "key") == "value"

    def test_overwrite_value(self, cache):
        cache.set_cleaned("key", "old")
        cache.set_cleaned("key", "new")
        assert cache.get_cleaned("key") == "new"


class TestTTL:
    def test_expired_entry_returns_none(self):
        cache = CacheLayer(max_size=10, ttl_seconds=0.01)
        cache.set_cleaned("key", "value")
        time.sleep(0.02)
        assert cache.get_cleaned("key") is None

    def test_non_expired_entry_returned(self):
        cache = CacheLayer(max_size=10, ttl_seconds=60.0)
        cache.set_cleaned("key", "value")
        assert cache.get_cleaned("key") == "value"


class TestHitsMisses:
    def test_miss_counted(self, cache):
        cache.get_cleaned("nonexistent")
        assert cache.misses == 1

    def test_hit_counted(self, cache):
        cache.set_cleaned("key", "val")
        cache.get_cleaned("key")
        assert cache.hits == 1

    def test_hit_rate_zero_when_no_calls(self, cache):
        assert cache.hit_rate == 0.0

    def test_hit_rate_calculation(self, cache):
        cache.set_cleaned("k1", "v1")
        cache.get_cleaned("k1")    # hit
        cache.get_cleaned("k2")    # miss
        assert cache.hit_rate == 0.5

    def test_expired_counts_as_miss(self):
        cache = CacheLayer(max_size=10, ttl_seconds=0.01)
        cache.set_cleaned("key", "value")
        time.sleep(0.02)
        cache.get_cleaned("key")
        assert cache.misses == 1
        assert cache.hits == 0


class TestEviction:
    def test_size_does_not_exceed_max(self):
        cache = CacheLayer(max_size=8, ttl_seconds=3600)
        for i in range(20):
            cache.set_cleaned(f"key_{i}", f"value_{i}")
        assert cache.size <= 8

    def test_after_eviction_new_entries_accepted(self):
        cache = CacheLayer(max_size=4, ttl_seconds=3600)
        for i in range(10):
            cache.set_cleaned(f"key_{i}", f"val_{i}")
        # Should not raise and size should be within bounds
        assert cache.size <= 4


class TestClear:
    def test_clear_resets_store(self, cache):
        cache.set_cleaned("key", "val")
        cache.clear()
        assert cache.get_cleaned("key") is None
        assert cache.size == 0

    def test_clear_resets_stats(self, cache):
        cache.set_cleaned("key", "val")
        cache.get_cleaned("key")
        cache.clear()
        assert cache.hits == 0
        assert cache.misses == 0


class TestStats:
    def test_stats_shape(self, cache):
        s = cache.stats()
        assert "hits" in s
        assert "misses" in s
        assert "hit_rate" in s
        assert "size" in s
        assert "max_size" in s
        assert "ttl" in s

    def test_max_size_in_stats(self, cache):
        assert cache.stats()["max_size"] == 10
