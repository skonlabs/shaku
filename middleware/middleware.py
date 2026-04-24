"""
TokenOptimizationMiddleware — the top-level orchestrator.

Pipeline (per request):
  1.  Merge system_prompt into messages (if provided separately).
  2.  Count tokens BEFORE optimisation.
  3.  Detect sensitive-domain content → limit compression.
  4.  Auto-detect task type from the last user message (if not provided).
  5.  Clean each message (whitespace, duplicates, boilerplate).
  6.  Compress history (keep last N turns, summarise older ones).
  7.  Prune context documents (BM25 ranking, top-K chunks, budget).
  8.  Normalise prompts (verbose phrase replacement).
  9.  Enforce input token budget (drop oldest messages, truncate last resort).
  10. Determine dynamic max_output_tokens for the task type.
  11. Count tokens AFTER optimisation and log savings.
  12. Return OptimizationResult.

Public entry points:
  - process()        — provider-agnostic, returns OptimizationResult
  - for_openai()     — wraps process(), returns dict ready for OpenAI API
  - for_anthropic()  — wraps process(), returns dict ready for Anthropic API
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .budget_manager import BudgetManager
from .cache_layer import CacheLayer
from .context_pruner import ContextPruner
from .history_compressor import HistoryCompressor
from .input_cleaner import InputCleaner
from .prompt_normalizer import PromptNormalizer
from .token_counter import TokenCounter
from .types import (
    Message,
    OptimizationConfig,
    OptimizationResult,
    Provider,
    TaskType,
    TokenBudget,
)

logger = logging.getLogger(__name__)


class TokenOptimizationMiddleware:
    """
    Provider-agnostic token-optimisation middleware.

    Instantiate once and reuse across many requests; all state is in the
    CacheLayer and the injected components (all thread-safe for read access).

    Example (OpenAI)::

        middleware = TokenOptimizationMiddleware()
        payload = middleware.for_openai(messages, task_type="summarization")
        # payload["messages"] and payload["max_tokens"] are ready to use
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            **{k: v for k, v in payload.items() if not k.startswith("_")},
        )

    Example (Anthropic)::

        middleware = TokenOptimizationMiddleware(
            OptimizationConfig(provider=Provider.ANTHROPIC)
        )
        payload = middleware.for_anthropic(messages, system="You are helpful.")
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-6",
            **{k: v for k, v in payload.items() if not k.startswith("_")},
        )
    """

    def __init__(self, config: Optional[OptimizationConfig] = None) -> None:
        self.config = config or OptimizationConfig()

        self._counter  = TokenCounter(model=self.config.model)
        self._cleaner  = InputCleaner()
        self._normalizer = PromptNormalizer()
        self._history  = HistoryCompressor(
            self._counter,
            keep_turns=self.config.history_keep_turns,
        )
        self._pruner   = ContextPruner(
            self._counter,
            chunk_size_tokens=self.config.chunk_size_tokens,
            overlap_tokens=self.config.chunk_overlap_tokens,
            top_k=self.config.context_top_k_chunks,
        )
        self._budget   = BudgetManager(self.config.budget, self._counter)
        self._cache: Optional[CacheLayer] = (
            CacheLayer() if self.config.enable_caching else None
        )

    # ------------------------------------------------------------------
    # Primary entry point
    # ------------------------------------------------------------------

    def process(
        self,
        messages: List[Message],
        documents: Optional[List[str]] = None,
        task_type: Optional[TaskType] = None,
        system_prompt: Optional[str] = None,
    ) -> OptimizationResult:
        """
        Run the full optimisation pipeline and return an OptimizationResult.

        Parameters
        ----------
        messages:
            Conversation messages (may include a ``role="system"`` entry).
        documents:
            Optional list of context documents to prune before injection.
        task_type:
            Override the task type for dynamic output-token selection.
            If None the middleware tries to infer it from the last user message.
        system_prompt:
            Optional system prompt provided separately (Anthropic-style).
            If *messages* already starts with a system message this is
            prepended as a second system block.
        """
        warnings: List[str] = []
        cache_hits = 0

        # Step 1 — merge explicit system_prompt
        messages = list(messages)  # don't mutate the caller's list
        if system_prompt:
            if not messages or messages[0].role != "system":
                messages.insert(0, Message(role="system", content=system_prompt))

        # Step 2 — token count BEFORE
        tokens_before = self._count(messages)

        # Step 3 — sensitive-domain detection
        full_text = " ".join(m.content for m in messages)
        is_sensitive, sensitive_domains = self._cleaner.is_sensitive(
            full_text, self.config.sensitive_domains
        )
        if is_sensitive:
            warnings.append(
                f"Sensitive content detected (domains: {', '.join(sensitive_domains)}). "
                "Aggressive compression skipped; only safe cleaning applied."
            )

        # Step 4 — auto-detect task type
        effective_task = task_type or self.config.task_type
        if effective_task is None:
            hint = self._task_type_hint(messages)
            if hint:
                try:
                    effective_task = TaskType(hint)
                except ValueError:
                    pass

        # Step 5 — clean inputs
        if self.config.enable_cleaning:
            messages, n_hits = self._clean_messages(messages, is_sensitive)
            cache_hits += n_hits

        # Step 6 — compress history
        if self.config.enable_history_trimming:
            messages = self._history.compress(
                messages,
                token_budget=self.config.budget.max_input_tokens,
            )

        # Step 7 — prune and inject context documents
        if documents and self.config.enable_context_pruning:
            query  = self._last_user_content(messages)
            budget = max(200, self.config.budget.max_input_tokens // 3)
            pruned = self._pruner.prune(documents, query, token_budget=budget)
            if pruned:
                context_block = "\n\n---\n\n".join(pruned)
                messages = self._inject_context(messages, context_block)

        # Step 8 — normalise prompts (skip for sensitive content)
        if self.config.enable_normalization and not is_sensitive:
            messages = self._normalize_messages(messages)

        # Step 9 — enforce input budget
        messages, budget_warnings = self._budget.enforce_input_budget(
            messages, provider=self.config.provider.value
        )
        warnings.extend(budget_warnings)

        # Step 10 — separate system prompt for output
        final_system: Optional[str] = None
        final_messages: List[Message] = []
        for m in messages:
            if m.role == "system":
                final_system = (
                    final_system + "\n" + m.content if final_system else m.content
                )
            else:
                final_messages.append(m)

        # Step 11 — dynamic output tokens
        max_output = self._budget.get_output_tokens(effective_task)

        # Step 12 — token count AFTER (for logging / result)
        tokens_after = self._count(messages)

        savings     = max(0, tokens_before - tokens_after)
        savings_pct = round(savings / max(1, tokens_before) * 100, 1)

        logger.info(
            "TokenOptimizationMiddleware | %d → %d tokens "
            "(saved %d, %.1f%%) | task=%s | sensitive=%s | cache_hits=%d",
            tokens_before, tokens_after, savings, savings_pct,
            effective_task.value if effective_task else "auto",
            is_sensitive,
            cache_hits,
        )

        return OptimizationResult(
            messages=final_messages,
            system_prompt=final_system,
            max_output_tokens=max_output,
            input_tokens_before=tokens_before,
            input_tokens_after=tokens_after,
            warnings=warnings,
            cache_hits=cache_hits,
        )

    # ------------------------------------------------------------------
    # Provider-specific convenience wrappers
    # ------------------------------------------------------------------

    def for_openai(
        self,
        messages: List[Dict[str, Any]],
        documents: Optional[List[str]] = None,
        task_type: Optional[str] = None,
        system_prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Optimise and return a dict suitable for
        ``openai.chat.completions.create(**payload)``.

        The ``_optimization`` key carries audit metadata and is not a valid
        OpenAI parameter — strip it before forwarding if preferred.
        """
        typed = [Message.from_dict(m) for m in messages]
        tt    = TaskType(task_type) if task_type else None
        result = self.process(typed, documents=documents, task_type=tt, system_prompt=system_prompt)

        out_messages: List[Dict[str, str]] = []
        if result.system_prompt:
            out_messages.append({"role": "system", "content": result.system_prompt})
        out_messages.extend(m.to_dict() for m in result.messages)

        return {
            "messages":   out_messages,
            "max_tokens": result.max_output_tokens,
            "_optimization": self._audit(result),
        }

    def for_anthropic(
        self,
        messages: List[Dict[str, Any]],
        system: Optional[str] = None,
        documents: Optional[List[str]] = None,
        task_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Optimise and return a dict suitable for
        ``anthropic.messages.create(**payload)``.

        The system prompt (if any) is placed in the top-level ``system`` key
        as required by the Anthropic API.
        """
        typed  = [Message.from_dict(m) for m in messages]
        tt     = TaskType(task_type) if task_type else None
        result = self.process(typed, documents=documents, task_type=tt, system_prompt=system)

        out_messages = [m.to_dict() for m in result.messages]

        payload: Dict[str, Any] = {
            "messages":   out_messages,
            "max_tokens": result.max_output_tokens,
            "_optimization": self._audit(result),
        }
        if result.system_prompt:
            payload["system"] = result.system_prompt
        return payload

    # ------------------------------------------------------------------
    # Cache stats helper
    # ------------------------------------------------------------------

    def cache_stats(self) -> dict:
        if self._cache is None:
            return {"enabled": False}
        return {"enabled": True, **self._cache.stats()}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _count(self, messages: List[Message]) -> int:
        return self._counter.count_messages(
            [m.to_dict() for m in messages],
            provider=self.config.provider.value,
        )

    def _clean_messages(
        self, messages: List[Message], is_sensitive: bool
    ) -> tuple:  # (List[Message], int cache_hits)
        cleaned: List[Message] = []
        hits = 0
        for msg in messages:
            if msg.role == "system":
                # Apply only safe whitespace normalisation to system prompts
                content = self._cleaner._normalise_whitespace(msg.content)  # noqa: SLF001
                cleaned.append(Message(role=msg.role, content=content))
                continue

            raw = msg.content
            if self._cache:
                cached = self._cache.get_cleaned(raw)
                if cached is not None:
                    cleaned.append(Message(role=msg.role, content=cached))
                    hits += 1
                    continue

            result = self._cleaner.clean(raw, is_sensitive=is_sensitive)

            if self._cache:
                self._cache.set_cleaned(raw, result)

            cleaned.append(Message(role=msg.role, content=result))

        return cleaned, hits

    def _normalize_messages(self, messages: List[Message]) -> List[Message]:
        out: List[Message] = []
        for msg in messages:
            if msg.role == "system":
                out.append(msg)
                continue
            out.append(Message(role=msg.role, content=self._normalizer.normalize(msg.content)))
        return out

    def _task_type_hint(self, messages: List[Message]) -> Optional[str]:
        last_user = self._last_user_content(messages)
        return self._normalizer.extract_task_type_hint(last_user)

    def _last_user_content(self, messages: List[Message]) -> str:
        for m in reversed(messages):
            if m.role == "user":
                return m.content[:500]
        return ""

    def _inject_context(
        self, messages: List[Message], context_block: str
    ) -> List[Message]:
        """Append pruned context to the last user message."""
        result = list(messages)
        for i in range(len(result) - 1, -1, -1):
            if result[i].role == "user":
                updated_content = (
                    result[i].content + f"\n\n[Relevant context]\n{context_block}"
                )
                result[i] = Message(role="user", content=updated_content)
                return result
        return result

    @staticmethod
    def _audit(result: OptimizationResult) -> dict:
        return {
            "tokens_before":  result.input_tokens_before,
            "tokens_after":   result.input_tokens_after,
            "savings_tokens": result.savings_tokens,
            "savings_pct":    result.savings_pct,
            "warnings":       result.warnings,
            "cache_hits":     result.cache_hits,
        }
