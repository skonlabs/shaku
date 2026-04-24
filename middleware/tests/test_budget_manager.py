"""Tests for BudgetManager."""
import pytest
from middleware.budget_manager import BudgetManager, TASK_OUTPUT_TOKENS
from middleware.token_counter import TokenCounter
from middleware.types import Message, TaskType, TokenBudget


@pytest.fixture
def counter():
    return TokenCounter()


@pytest.fixture
def budget():
    return TokenBudget(max_input_tokens=500, max_output_tokens=300, max_total_tokens=800)


@pytest.fixture
def mgr(budget, counter):
    return BudgetManager(budget, counter)


class TestGetOutputTokens:
    def test_classification_limit(self, mgr):
        assert mgr.get_output_tokens(TaskType.CLASSIFICATION) == 50

    def test_extraction_limit(self, mgr):
        assert mgr.get_output_tokens(TaskType.EXTRACTION) == 150

    def test_summarization_limit(self, mgr):
        assert mgr.get_output_tokens(TaskType.SUMMARIZATION) == 300

    def test_generation_limit_capped_by_budget(self, mgr):
        # budget.max_output_tokens=300 < generation(800)
        assert mgr.get_output_tokens(TaskType.GENERATION) == 300

    def test_reasoning_capped_by_budget(self, mgr):
        assert mgr.get_output_tokens(TaskType.REASONING) == 300

    def test_none_returns_default(self, mgr):
        result = mgr.get_output_tokens(None)
        assert result <= 300  # capped by budget

    def test_task_output_tokens_all_defined(self):
        for task in TaskType:
            assert task.value in TASK_OUTPUT_TOKENS

    def test_coding_matches_reasoning(self):
        assert TASK_OUTPUT_TOKENS[TaskType.CODING.value] == TASK_OUTPUT_TOKENS[TaskType.REASONING.value]


class TestCheckMethods:
    def test_check_input_within(self, mgr):
        assert mgr.check_input(499) is True

    def test_check_input_exact(self, mgr):
        assert mgr.check_input(500) is True

    def test_check_input_over(self, mgr):
        assert mgr.check_input(501) is False

    def test_check_output_within(self, mgr):
        assert mgr.check_output(300) is True

    def test_check_output_over(self, mgr):
        assert mgr.check_output(301) is False

    def test_check_total_within(self, mgr):
        assert mgr.check_total(400, 300) is True

    def test_check_total_exact(self, mgr):
        assert mgr.check_total(500, 300) is True

    def test_check_total_over(self, mgr):
        assert mgr.check_total(501, 300) is False


class TestEnforceInputBudget:
    def test_under_budget_unchanged(self, mgr):
        msgs = [
            Message(role="system", content="System."),
            Message(role="user",   content="Short user message."),
        ]
        result, warnings = mgr.enforce_input_budget(msgs)
        assert len(result) == len(msgs)
        assert warnings == []

    def test_over_budget_trims_from_front(self, counter):
        # Tight budget — total messages exceed it so trimming must occur
        b   = TokenBudget(max_input_tokens=35, max_output_tokens=100, max_total_tokens=135)
        mgr = BudgetManager(b, counter)

        msgs = [
            Message(role="system",    content="System prompt."),
            Message(role="user",      content="Old user question that takes up many tokens here."),
            Message(role="assistant", content="Old assistant reply with many tokens here too."),
            Message(role="user",      content="New short question."),
        ]
        result, warnings = mgr.enforce_input_budget(msgs)
        assert len(warnings) > 0
        # System message always preserved
        assert result[0].role == "system"
        # Last user message preserved
        last_user = [m for m in result if m.role == "user"][-1]
        assert "New short question" in last_user.content

    def test_system_never_removed(self, counter):
        b   = TokenBudget(max_input_tokens=30, max_output_tokens=50, max_total_tokens=80)
        mgr = BudgetManager(b, counter)
        msgs = [
            Message(role="system", content="Important system."),
            Message(role="user",   content="Hi"),
        ]
        result, _ = mgr.enforce_input_budget(msgs)
        systems = [m for m in result if m.role == "system"]
        assert len(systems) == 1
        assert systems[0].content == "Important system."

    def test_truncation_warning_on_extreme_budget(self, counter):
        b   = TokenBudget(max_input_tokens=20, max_output_tokens=50, max_total_tokens=70)
        mgr = BudgetManager(b, counter)
        msgs = [
            Message(role="user", content="A" * 500),
        ]
        _, warnings = mgr.enforce_input_budget(msgs)
        # Should warn about truncation
        assert any("truncat" in w.lower() for w in warnings)

    def test_empty_messages(self, mgr):
        result, warnings = mgr.enforce_input_budget([])
        assert result == []
        assert warnings == []


class TestCompressMessage:
    def test_under_limit_unchanged(self, mgr):
        msg  = Message(role="user", content="Short message.")
        out, was_compressed = mgr.compress_message(msg, max_tokens=1_000)
        assert out.content == msg.content
        assert was_compressed is False

    def test_over_limit_compressed(self, mgr):
        long_content = " ".join(f"Sentence number {i} with extra padding words." for i in range(50))
        msg  = Message(role="user", content=long_content)
        out, was_compressed = mgr.compress_message(msg, max_tokens=30)
        assert was_compressed is True
        assert len(out.content) < len(long_content)

    def test_sensitive_uses_truncation(self, mgr):
        long = "A" * 2000
        msg  = Message(role="user", content=long)
        out, was_compressed = mgr.compress_message(msg, max_tokens=50, is_sensitive=True)
        assert was_compressed is True
        assert "sensitive domain" in out.content.lower() or len(out.content) < len(long)

    def test_preserves_role(self, mgr):
        msg = Message(role="assistant", content="A" * 500)
        out, _ = mgr.compress_message(msg, max_tokens=30)
        assert out.role == "assistant"
