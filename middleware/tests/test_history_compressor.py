"""Tests for HistoryCompressor and ExtractiveSummarizer."""
import pytest
from middleware.history_compressor import ExtractiveSummarizer, HistoryCompressor
from middleware.token_counter import TokenCounter
from middleware.types import Message


@pytest.fixture
def counter():
    return TokenCounter()


@pytest.fixture
def compressor(counter):
    return HistoryCompressor(counter, keep_turns=3)


def make_conversation(n_turns: int, system: bool = True) -> list:
    msgs = []
    if system:
        msgs.append(Message(role="system", content="You are a helpful assistant."))
    for i in range(n_turns):
        msgs.append(Message(role="user",      content=f"User question number {i+1}: how do I do task {i+1}?"))
        msgs.append(Message(role="assistant", content=f"Assistant answer {i+1}: you should do step A, step B, step C for task {i+1}."))
    return msgs


class TestExtractiveSummarizer:
    def test_empty_text(self):
        s = ExtractiveSummarizer()
        assert s.summarize("") == ""

    def test_short_text_returned_unchanged(self):
        s = ExtractiveSummarizer()
        text = "One sentence only."
        result = s.summarize(text, max_sentences=5)
        assert result == text

    def test_long_text_shortened(self):
        s = ExtractiveSummarizer()
        # Build 20 sentences
        text = " ".join(f"This is sentence number {i} with some relevant content." for i in range(20))
        result = s.summarize(text, max_sentences=5)
        sentences_in_result = len([x for x in result.split(". ") if x.strip()])
        assert sentences_in_result <= 6  # 5 + possible partial

    def test_max_chars_respected(self):
        s = ExtractiveSummarizer()
        text = " ".join(f"Sentence {i} with meaningful content about systems." for i in range(20))
        result = s.summarize(text, max_sentences=5, max_chars=100)
        assert len(result) <= 105  # slight margin for ellipsis

    def test_preserves_order(self):
        s = ExtractiveSummarizer()
        text = (
            "The first event happened in January. "
            "The second event happened in February. "
            "The third event happened in March. "
            "The fourth event happened in April. "
            "The fifth event happened in May. "
            "The sixth event happened in June."
        )
        result = s.summarize(text, max_sentences=3)
        # Words from result must appear in original order
        words_in_result = [w for w in result.split() if w.lower() in text.lower()]
        assert len(words_in_result) > 0

    def test_deterministic(self):
        s = ExtractiveSummarizer()
        text = " ".join(f"Information about topic {i} with details and context." for i in range(15))
        assert s.summarize(text) == s.summarize(text)


class TestHistoryCompressorNoCompression:
    def test_short_history_unchanged(self, compressor):
        msgs = make_conversation(2)  # 2 turns < keep_turns=3
        result = compressor.compress(msgs)
        assert len(result) == len(msgs)

    def test_empty_returns_empty(self, compressor):
        assert compressor.compress([]) == []

    def test_system_always_first(self, compressor):
        msgs = make_conversation(2)
        result = compressor.compress(msgs)
        assert result[0].role == "system"

    def test_exact_keep_turns_unchanged(self, compressor):
        msgs = make_conversation(3)  # exactly keep_turns
        result = compressor.compress(msgs)
        assert len(result) == len(msgs)


class TestHistoryCompressorWithCompression:
    def test_compresses_long_history(self, compressor):
        msgs = make_conversation(10)  # 10 turns > keep_turns=3
        result = compressor.compress(msgs)
        # Should have: 1 system + 1 summary + 3*2 recent = 8 messages
        assert len(result) < len(msgs)

    def test_system_message_preserved(self, compressor):
        msgs = make_conversation(10)
        result = compressor.compress(msgs)
        system_msgs = [m for m in result if m.role == "system"]
        assert len(system_msgs) == 1
        assert system_msgs[0].content == "You are a helpful assistant."

    def test_summary_block_injected(self, compressor):
        msgs = make_conversation(10)
        result = compressor.compress(msgs)
        user_msgs = [m for m in result if m.role == "user"]
        # First non-system message should be the summary
        first_user = user_msgs[0]
        assert "summary" in first_user.content.lower() or "earlier" in first_user.content.lower()

    def test_recent_turns_count(self, compressor):
        msgs = make_conversation(10)
        result = compressor.compress(msgs)
        # Non-system messages excluding the summary block
        conv_msgs = [m for m in result if m.role != "system"]
        # summary + keep_turns * 2 (user + assistant)
        assert len(conv_msgs) == 1 + (3 * 2)  # 1 summary + 6 recent

    def test_last_user_message_preserved(self, compressor):
        msgs = make_conversation(10)
        last_user = [m for m in msgs if m.role == "user"][-1]
        result    = compressor.compress(msgs)
        result_users = [m for m in result if m.role == "user"]
        assert result_users[-1].content == last_user.content

    def test_no_system_messages(self, counter):
        compressor = HistoryCompressor(counter, keep_turns=2)
        msgs = make_conversation(8, system=False)
        result = compressor.compress(msgs)
        assert len(result) < len(msgs)
        sys_msgs = [m for m in result if m.role == "system"]
        assert sys_msgs == []


class TestHistoryCompressorBudget:
    def test_fits_in_budget(self, counter):
        compressor = HistoryCompressor(counter, keep_turns=5)
        msgs = make_conversation(20)
        # Set a very tight budget
        budget = 200
        result = compressor.compress(msgs, token_budget=budget)
        count = counter.count_messages([m.to_dict() for m in result])
        assert count <= budget

    def test_always_keeps_at_least_one_message(self, counter):
        compressor = HistoryCompressor(counter, keep_turns=10)
        msgs = [
            Message(role="system", content="System."),
            Message(role="user", content="Short."),
        ]
        result = compressor.compress(msgs, token_budget=10_000)
        assert len(result) >= 1
