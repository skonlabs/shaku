"""Integration tests for TokenOptimizationMiddleware."""
import pytest
from middleware import (
    CacheLayer,
    Message,
    OptimizationConfig,
    Provider,
    TaskType,
    TokenBudget,
    TokenOptimizationMiddleware,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_msgs(n_turns=3, include_system=True):
    msgs = []
    if include_system:
        msgs.append({"role": "system", "content": "You are a helpful assistant."})
    for i in range(n_turns):
        msgs.append({"role": "user",      "content": f"User question {i}: explain topic {i} in detail please."})
        msgs.append({"role": "assistant", "content": f"Assistant answer {i}: topic {i} involves A, B, and C."})
    msgs.append({"role": "user", "content": "Final question: summarize everything."})
    return msgs


def make_typed_msgs(n_turns=3, include_system=True):
    return [Message.from_dict(m) for m in make_msgs(n_turns, include_system)]


DOCS = [
    "Python is a popular programming language for data science and machine learning.",
    "JavaScript powers most web browsers and Node.js for server-side development.",
    "Machine learning algorithms include regression, classification, and clustering.",
    "Databases like PostgreSQL and MySQL store structured relational data efficiently.",
    "Docker containers package applications for consistent deployment environments.",
]


# ---------------------------------------------------------------------------
# Basic pipeline
# ---------------------------------------------------------------------------

class TestProcessBasic:
    def test_returns_optimization_result(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        assert result is not None

    def test_result_has_messages(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        assert isinstance(result.messages, list)
        assert len(result.messages) > 0

    def test_result_has_max_output_tokens(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        assert result.max_output_tokens > 0

    def test_result_has_token_counts(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        assert result.input_tokens_before > 0
        assert result.input_tokens_after > 0

    def test_savings_pct_non_negative(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        assert result.savings_pct >= 0.0

    def test_system_prompt_separated(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process(make_typed_msgs())
        # System message should be separated into system_prompt field
        assert result.system_prompt is not None
        for m in result.messages:
            assert m.role != "system"

    def test_empty_messages(self):
        mw = TokenOptimizationMiddleware()
        result = mw.process([])
        assert result.messages == []
        assert result.input_tokens_before >= 0


# ---------------------------------------------------------------------------
# System prompt merging
# ---------------------------------------------------------------------------

class TestSystemPromptMerging:
    def test_separate_system_prompt(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="Hello")]
        result = mw.process(msgs, system_prompt="Be concise.")
        assert result.system_prompt == "Be concise."

    def test_system_in_messages_preserved(self):
        mw = TokenOptimizationMiddleware()
        msgs = [
            Message(role="system", content="You are helpful."),
            Message(role="user",   content="Hi"),
        ]
        result = mw.process(msgs)
        assert result.system_prompt == "You are helpful."

    def test_separate_system_not_doubled(self):
        mw = TokenOptimizationMiddleware()
        msgs = [
            Message(role="system", content="Existing system."),
            Message(role="user",   content="Hello"),
        ]
        result = mw.process(msgs, system_prompt="Passed separately.")
        # The existing system message should win
        assert result.system_prompt is not None


# ---------------------------------------------------------------------------
# Task type
# ---------------------------------------------------------------------------

class TestTaskType:
    @pytest.mark.parametrize("task_type,expected_max", [
        (TaskType.CLASSIFICATION, 50),
        (TaskType.EXTRACTION,     150),
        (TaskType.SUMMARIZATION,  300),
    ])
    def test_explicit_task_type_output_limit(self, task_type, expected_max):
        cfg = OptimizationConfig(
            budget=TokenBudget(max_output_tokens=10_000),
        )
        mw = TokenOptimizationMiddleware(cfg)
        msgs = [Message(role="user", content="Test")]
        result = mw.process(msgs, task_type=task_type)
        assert result.max_output_tokens == expected_max

    def test_auto_detect_summarization(self):
        cfg = OptimizationConfig(budget=TokenBudget(max_output_tokens=10_000))
        mw  = TokenOptimizationMiddleware(cfg)
        msgs = [Message(role="user", content="Summarize this article for me please.")]
        result = mw.process(msgs)
        assert result.max_output_tokens == 300

    def test_auto_detect_classification(self):
        cfg = OptimizationConfig(budget=TokenBudget(max_output_tokens=10_000))
        mw  = TokenOptimizationMiddleware(cfg)
        msgs = [Message(role="user", content="Classify this text into categories.")]
        result = mw.process(msgs)
        assert result.max_output_tokens == 50

    def test_no_task_type_returns_default(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="Hello!")]
        result = mw.process(msgs)
        assert result.max_output_tokens > 0


# ---------------------------------------------------------------------------
# Sensitive content
# ---------------------------------------------------------------------------

class TestSensitiveContent:
    def test_sensitive_content_warns(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(
            role="user",
            content="Pursuant to the GDPR regulation, the data processor must maintain an audit trail."
        )]
        result = mw.process(msgs)
        assert any("sensitive" in w.lower() for w in result.warnings)

    def test_sensitive_content_preserved(self):
        mw = TokenOptimizationMiddleware()
        content = "Pursuant to the liability clause, the plaintiff must comply with the jurisdiction."
        msgs = [Message(role="user", content=content)]
        result = mw.process(msgs)
        # Content should not be drastically shortened
        combined = " ".join(m.content for m in result.messages)
        assert "liability" in combined or "jurisdiction" in combined

    def test_non_sensitive_no_warning(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="How do I sort a list in Python?")]
        result = mw.process(msgs)
        sensitive_warnings = [w for w in result.warnings if "sensitive" in w.lower()]
        assert sensitive_warnings == []


# ---------------------------------------------------------------------------
# Document pruning
# ---------------------------------------------------------------------------

class TestDocumentPruning:
    def test_documents_injected(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="How does machine learning work?")]
        result = mw.process(msgs, documents=DOCS)
        combined = " ".join(m.content for m in result.messages)
        assert "Relevant context" in combined

    def test_no_documents_no_context_block(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="Hello")]
        result = mw.process(msgs, documents=None)
        combined = " ".join(m.content for m in result.messages)
        assert "Relevant context" not in combined

    def test_relevant_doc_ranked_first(self):
        mw = TokenOptimizationMiddleware(
            OptimizationConfig(context_top_k_chunks=1)
        )
        msgs = [Message(role="user", content="Explain machine learning algorithms.")]
        result = mw.process(msgs, documents=DOCS)
        combined = " ".join(m.content for m in result.messages)
        assert "machine learning" in combined.lower()


# ---------------------------------------------------------------------------
# History compression
# ---------------------------------------------------------------------------

class TestHistoryCompression:
    def test_long_history_compressed(self):
        cfg = OptimizationConfig(history_keep_turns=2)
        mw  = TokenOptimizationMiddleware(cfg)
        msgs = make_typed_msgs(n_turns=20)
        result = mw.process(msgs)
        # Should have fewer messages than input
        input_conv  = [m for m in msgs if m.role != "system"]
        output_conv = result.messages
        assert len(output_conv) < len(input_conv)

    def test_last_user_message_always_present(self):
        cfg = OptimizationConfig(history_keep_turns=2)
        mw  = TokenOptimizationMiddleware(cfg)
        msgs = make_typed_msgs(n_turns=15)
        last_user = [m for m in msgs if m.role == "user"][-1]
        result = mw.process(msgs)
        result_users = [m for m in result.messages if m.role == "user"]
        assert result_users[-1].content == last_user.content


# ---------------------------------------------------------------------------
# Budget enforcement
# ---------------------------------------------------------------------------

class TestBudgetEnforcement:
    def test_result_within_budget(self):
        budget = 200
        cfg    = OptimizationConfig(budget=TokenBudget(max_input_tokens=budget))
        mw     = TokenOptimizationMiddleware(cfg)
        msgs   = make_typed_msgs(n_turns=10)
        result = mw.process(msgs)
        assert result.input_tokens_after <= budget + 20  # small margin for overhead

    def test_over_budget_triggers_warning(self):
        # Budget so tight (20 tokens) that even system + 1 message will require truncation
        budget = 20
        cfg    = OptimizationConfig(budget=TokenBudget(max_input_tokens=budget))
        mw     = TokenOptimizationMiddleware(cfg)
        msgs   = make_typed_msgs(n_turns=3)
        result = mw.process(msgs)
        assert any("exceeds" in w.lower() or "truncat" in w.lower() for w in result.warnings)


# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------

class TestCaching:
    def test_cache_hit_on_repeat(self):
        mw = TokenOptimizationMiddleware()
        msgs = [Message(role="user", content="Hello   world    test.")]
        mw.process(msgs)
        result2 = mw.process(msgs)
        assert result2.cache_hits >= 1

    def test_no_cache_when_disabled(self):
        cfg = OptimizationConfig(enable_caching=False)
        mw  = TokenOptimizationMiddleware(cfg)
        msgs = [Message(role="user", content="Hello world")]
        result = mw.process(msgs)
        assert result.cache_hits == 0

    def test_cache_stats_available(self):
        mw = TokenOptimizationMiddleware()
        stats = mw.cache_stats()
        assert stats["enabled"] is True
        assert "hit_rate" in stats


# ---------------------------------------------------------------------------
# for_openai
# ---------------------------------------------------------------------------

class TestForOpenAI:
    def test_returns_dict(self):
        mw  = TokenOptimizationMiddleware()
        out = mw.for_openai(make_msgs())
        assert isinstance(out, dict)

    def test_messages_key_present(self):
        mw  = TokenOptimizationMiddleware()
        out = mw.for_openai(make_msgs())
        assert "messages" in out

    def test_max_tokens_key_present(self):
        mw  = TokenOptimizationMiddleware()
        out = mw.for_openai(make_msgs())
        assert "max_tokens" in out
        assert out["max_tokens"] > 0

    def test_optimization_metadata(self):
        mw  = TokenOptimizationMiddleware()
        out = mw.for_openai(make_msgs())
        assert "_optimization" in out
        meta = out["_optimization"]
        assert "tokens_before" in meta
        assert "tokens_after" in meta
        assert "savings_pct" in meta

    def test_system_prompt_in_messages(self):
        mw  = TokenOptimizationMiddleware()
        out = mw.for_openai(make_msgs())
        roles = [m["role"] for m in out["messages"]]
        assert "system" in roles

    def test_explicit_task_type(self):
        cfg = OptimizationConfig(budget=TokenBudget(max_output_tokens=10_000))
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_openai([{"role": "user", "content": "Test"}], task_type="extraction")
        assert out["max_tokens"] == 150


# ---------------------------------------------------------------------------
# for_anthropic
# ---------------------------------------------------------------------------

class TestForAnthropic:
    def test_returns_dict(self):
        cfg = OptimizationConfig(provider=Provider.ANTHROPIC)
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_anthropic(make_msgs())
        assert isinstance(out, dict)

    def test_system_at_top_level(self):
        cfg = OptimizationConfig(provider=Provider.ANTHROPIC)
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_anthropic(make_msgs(), system="You are a helpful assistant.")
        assert "system" in out

    def test_messages_no_system_role(self):
        cfg = OptimizationConfig(provider=Provider.ANTHROPIC)
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_anthropic(make_msgs())
        for m in out["messages"]:
            assert m["role"] != "system"

    def test_max_tokens_present(self):
        cfg = OptimizationConfig(provider=Provider.ANTHROPIC)
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_anthropic(make_msgs())
        assert "max_tokens" in out

    def test_explicit_task_type(self):
        cfg = OptimizationConfig(
            provider=Provider.ANTHROPIC,
            budget=TokenBudget(max_output_tokens=10_000),
        )
        mw  = TokenOptimizationMiddleware(cfg)
        out = mw.for_anthropic([{"role": "user", "content": "Test"}], task_type="coding")
        assert out["max_tokens"] == 1_200


# ---------------------------------------------------------------------------
# Message.from_dict edge cases
# ---------------------------------------------------------------------------

class TestMessageFromDict:
    def test_plain_string_content(self):
        m = Message.from_dict({"role": "user", "content": "hello"})
        assert m.content == "hello"
        assert m.role == "user"

    def test_list_content_flattened(self):
        m = Message.from_dict({
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "World"},
            ],
        })
        assert "Hello" in m.content
        assert "World" in m.content

    def test_missing_content_defaults_empty(self):
        m = Message.from_dict({"role": "assistant"})
        assert m.content == ""
