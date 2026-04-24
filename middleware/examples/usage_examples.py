"""
Usage examples for the token-optimization middleware.

No real API calls are made — the examples show exactly how to wire the
middleware into OpenAI and Anthropic call sites.  Replace the
``# ── call API here ──`` comments with your actual SDK calls.
"""
from __future__ import annotations

import logging

from middleware import (
    Message,
    OptimizationConfig,
    Provider,
    TaskType,
    TokenBudget,
    TokenOptimizationMiddleware,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


# ===========================================================================
# 1. Basic OpenAI usage
# ===========================================================================

def example_openai_basic() -> None:
    """Minimal setup — drop-in before any openai.chat.completions.create call."""
    middleware = TokenOptimizationMiddleware(
        OptimizationConfig(
            budget=TokenBudget(max_input_tokens=4_000, max_output_tokens=800),
            provider=Provider.OPENAI,
        )
    )

    raw_messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {
            "role": "user",
            "content": (
                "  Hello!!    Can   you   help me?  \n\n\n\n"
                "  Hello!!    Can   you   help me?  \n\n"   # duplicate paragraph
                "I hope this email finds you well. "        # boilerplate
                "Please note that I need help with Python sorting."
            ),
        },
    ]

    payload = middleware.for_openai(raw_messages, task_type="generation")
    meta    = payload.pop("_optimization")   # remove before forwarding to SDK

    print("── OpenAI basic example ──────────────────────────────")
    print(f"  messages  : {len(payload['messages'])} message(s)")
    print(f"  max_tokens: {payload['max_tokens']}")
    print(f"  saved     : {meta['savings_tokens']} tokens ({meta['savings_pct']}%)")
    print(f"  warnings  : {meta['warnings']}")

    # ── call API here ──
    # response = openai_client.chat.completions.create(
    #     model="gpt-4o",
    #     **payload,
    # )


# ===========================================================================
# 2. Anthropic usage
# ===========================================================================

def example_anthropic_basic() -> None:
    """Anthropic-style: system prompt passed separately, messages list only has user/assistant."""
    middleware = TokenOptimizationMiddleware(
        OptimizationConfig(
            budget=TokenBudget(max_input_tokens=4_000, max_output_tokens=300),
            provider=Provider.ANTHROPIC,
        )
    )

    messages = [
        {"role": "user",      "content": "Summarize the key points of the following article: [article text]"},
        {"role": "assistant", "content": "The article covers three main topics..."},
        {"role": "user",      "content": "Can you expand on the second point?"},
    ]

    payload = middleware.for_anthropic(
        messages,
        system="You are a precise summarisation assistant. Keep answers under 300 words.",
        task_type="summarization",
    )
    meta = payload.pop("_optimization")

    print("\n── Anthropic basic example ───────────────────────────")
    print(f"  system    : {payload.get('system', 'N/A')[:60]}…")
    print(f"  messages  : {len(payload['messages'])} message(s)")
    print(f"  max_tokens: {payload['max_tokens']}")
    print(f"  saved     : {meta['savings_pct']}%")

    # ── call API here ──
    # response = anthropic_client.messages.create(
    #     model="claude-sonnet-4-6",
    #     **payload,
    # )


# ===========================================================================
# 3. Long conversation — history compression
# ===========================================================================

def example_history_compression() -> None:
    """Demonstrate automatic history trimming for a long conversation."""
    middleware = TokenOptimizationMiddleware(
        OptimizationConfig(
            budget=TokenBudget(max_input_tokens=2_000),
            history_keep_turns=3,   # keep only the last 3 turns verbatim
        )
    )

    # Simulate a 20-turn conversation
    typed_msgs: list[Message] = [
        Message(role="system", content="You are a code assistant.")
    ]
    for i in range(20):
        typed_msgs.append(Message(
            role="user",
            content=f"Question {i}: How do I implement feature {i} in Python?",
        ))
        typed_msgs.append(Message(
            role="assistant",
            content=f"Answer {i}: Feature {i} requires steps X, Y, Z…",
        ))
    typed_msgs.append(Message(role="user", content="Now help me debug the integration test."))

    result = middleware.process(typed_msgs)

    print("\n── History compression example ───────────────────────")
    print(f"  input messages : {len(typed_msgs)}")
    print(f"  output messages: {len(result.messages) + (1 if result.system_prompt else 0)}")
    print(f"  tokens before  : {result.input_tokens_before}")
    print(f"  tokens after   : {result.input_tokens_after}")
    print(f"  savings        : {result.savings_pct}%")
    print(f"  last user msg  : {result.messages[-1].content[:60]}…")


# ===========================================================================
# 4. Document / context pruning
# ===========================================================================

def example_document_pruning() -> None:
    """Rank and inject only the most relevant document chunks."""
    middleware = TokenOptimizationMiddleware(
        OptimizationConfig(
            budget=TokenBudget(max_input_tokens=3_000),
            context_top_k_chunks=2,
        )
    )

    documents = [
        "Python is a programming language used for data science, web development, and automation. "
        "It has a simple syntax and a large ecosystem of libraries like NumPy and Pandas.",

        "JavaScript is primarily used for web development. React and Vue are popular frameworks. "
        "Node.js enables JavaScript to run on the server side.",

        "Machine learning is a branch of AI that enables systems to learn from data. "
        "Common algorithms include decision trees, neural networks, and support vector machines.",

        "SQL is the standard language for relational databases. "
        "It supports SELECT, INSERT, UPDATE, and DELETE operations.",

        "Docker packages applications into containers ensuring consistent deployment "
        "across development, staging, and production environments.",
    ]

    msgs = [Message(role="user", content="How can Python be used for machine learning?")]

    result = middleware.process(msgs, documents=documents)

    combined = " ".join(m.content for m in result.messages)
    has_context = "[Relevant context]" in combined

    print("\n── Document pruning example ──────────────────────────")
    print(f"  source documents : {len(documents)}")
    print(f"  context injected : {has_context}")
    print(f"  tokens after     : {result.input_tokens_after}")
    if has_context:
        ctx_start = combined.index("[Relevant context]")
        print(f"  context preview  : {combined[ctx_start:ctx_start+100]}…")


# ===========================================================================
# 5. Sensitive content — conservative handling
# ===========================================================================

def example_sensitive_content() -> None:
    """Shows that sensitive-domain content is handled conservatively."""
    middleware = TokenOptimizationMiddleware()

    msgs = [Message(
        role="user",
        content=(
            "Pursuant to the liability clause in our agreement, the plaintiff must comply with "
            "the jurisdiction requirements.  The GDPR audit trail must be maintained for "
            "at least 5 years per regulatory compliance standards."
        ),
    )]

    result = middleware.process(msgs)

    print("\n── Sensitive content example ─────────────────────────")
    print(f"  warnings: {result.warnings}")
    # Verify key legal/compliance terms were preserved
    preserved_text = " ".join(m.content for m in result.messages)
    for term in ["liability", "GDPR", "audit trail"]:
        print(f"  '{term}' preserved: {term.lower() in preserved_text.lower()}")


# ===========================================================================
# 6. Dynamic task-type selection
# ===========================================================================

def example_task_types() -> None:
    """Shows how output-token limits vary by task type."""
    cfg = OptimizationConfig(budget=TokenBudget(max_output_tokens=10_000))
    mw  = TokenOptimizationMiddleware(cfg)

    cases = [
        ("Classify this customer review as positive, negative, or neutral.", TaskType.CLASSIFICATION),
        ("Extract all dates and monetary amounts from the contract.", TaskType.EXTRACTION),
        ("Summarize this 10-page research paper.",                           TaskType.SUMMARIZATION),
        ("Write a detailed blog post about serverless computing.",           TaskType.GENERATION),
        ("Analyze the time complexity of this sorting algorithm.",           TaskType.REASONING),
        ("Debug and fix the broken authentication middleware.",              TaskType.CODING),
    ]

    print("\n── Dynamic output-token limits ───────────────────────")
    for prompt, task in cases:
        msgs   = [Message(role="user", content=prompt)]
        result = mw.process(msgs, task_type=task)
        print(f"  {task.value:15s} → max_output_tokens = {result.max_output_tokens}")


# ===========================================================================
# 7. Cache reuse
# ===========================================================================

def example_caching() -> None:
    """Demonstrates that repeated identical inputs are served from cache."""
    mw = TokenOptimizationMiddleware()

    msgs = [Message(
        role="user",
        content="  Hello!!    Can   you   help  me   with Python?  ",
    )]

    r1 = mw.process(msgs)
    r2 = mw.process(msgs)   # same input → cache hit

    print("\n── Cache reuse example ───────────────────────────────")
    print(f"  First call  cache_hits : {r1.cache_hits}")
    print(f"  Second call cache_hits : {r2.cache_hits}")
    print(f"  Cache stats: {mw.cache_stats()}")


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    example_openai_basic()
    example_anthropic_basic()
    example_history_compression()
    example_document_pruning()
    example_sensitive_content()
    example_task_types()
    example_caching()
