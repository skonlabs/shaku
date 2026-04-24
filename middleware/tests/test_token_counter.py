"""Tests for TokenCounter."""
import pytest
from middleware.token_counter import TokenCounter


@pytest.fixture
def counter():
    return TokenCounter(model="gpt-4o")


class TestCount:
    def test_empty_string_returns_zero(self, counter):
        assert counter.count("") == 0

    def test_none_like_empty(self, counter):
        assert counter.count("") == 0

    def test_single_word_at_least_one(self, counter):
        assert counter.count("hello") >= 1

    def test_longer_text_more_tokens(self, counter):
        short = counter.count("hi")
        long  = counter.count("The quick brown fox jumps over the lazy dog")
        assert long > short

    def test_returns_int(self, counter):
        result = counter.count("some text here")
        assert isinstance(result, int)

    def test_whitespace_only_positive(self, counter):
        # Even a single space is > 0 tokens
        result = counter.count("   ")
        assert result >= 1

    def test_repeated_text_consistent(self, counter):
        t = "This is a test sentence for token counting."
        assert counter.count(t) == counter.count(t)  # deterministic


class TestCountMessages:
    def test_empty_list_returns_base_overhead(self, counter):
        # Base overhead is 3 (reply priming)
        assert counter.count_messages([]) == 3

    def test_single_message_adds_overhead(self, counter):
        msgs = [{"role": "user", "content": "hello"}]
        result = counter.count_messages(msgs)
        # Must be > just counting the word "hello"
        assert result > counter.count("hello")

    def test_more_messages_more_tokens(self, counter):
        one = counter.count_messages([{"role": "user", "content": "hello"}])
        two = counter.count_messages([
            {"role": "user",      "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ])
        assert two > one

    def test_system_plus_user(self, counter):
        msgs = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user",   "content": "What is 2 + 2?"},
        ]
        result = counter.count_messages(msgs)
        assert result > 10

    def test_provider_openai_vs_anthropic(self, counter):
        msgs = [{"role": "user", "content": "Test message."}]
        openai_count    = counter.count_messages(msgs, provider="openai")
        anthropic_count = counter.count_messages(msgs, provider="anthropic")
        # Anthropic overhead is slightly higher
        assert anthropic_count >= openai_count

    def test_empty_content_messages(self, counter):
        msgs = [{"role": "user", "content": ""}]
        result = counter.count_messages(msgs)
        assert result >= 3  # at least base overhead

    def test_name_field_adds_token(self, counter):
        without_name = counter.count_messages([{"role": "user", "content": "hi"}])
        with_name    = counter.count_messages([{"role": "user", "content": "hi", "name": "Alice"}])
        assert with_name > without_name


class TestEstimateCharBudget:
    def test_positive_budget(self, counter):
        result = counter.estimate_char_budget(1_000)
        assert result > 0

    def test_zero_budget(self, counter):
        assert counter.estimate_char_budget(0) == 0

    def test_scales_with_budget(self, counter):
        small = counter.estimate_char_budget(100)
        large = counter.estimate_char_budget(1_000)
        assert large > small

    def test_returns_int(self, counter):
        assert isinstance(counter.estimate_char_budget(500), int)
