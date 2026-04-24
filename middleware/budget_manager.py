"""
Budget manager: enforces configurable token budgets and computes dynamic
output-token limits based on task type.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional, Tuple

from .token_counter import TokenCounter
from .types import Message, TaskType, TokenBudget

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Dynamic output-token limits per task type
# ---------------------------------------------------------------------------
TASK_OUTPUT_TOKENS: Dict[str, int] = {
    TaskType.CLASSIFICATION.value: 50,
    TaskType.EXTRACTION.value:     150,
    TaskType.SUMMARIZATION.value:  300,
    TaskType.GENERATION.value:     800,
    TaskType.REASONING.value:      1_200,
    TaskType.CODING.value:         1_200,
}

_DEFAULT_OUTPUT_TOKENS = 800


class BudgetManager:
    """
    Enforces token budgets and selects output-token limits.

    Rules:
      - System messages are NEVER removed or truncated.
      - The most recent user message is NEVER removed (may be truncated as
        last resort with a warning).
      - Messages are dropped from the front (oldest first) until the budget
        is satisfied.
      - If even system + last message exceeds the budget, the last message's
        content is truncated with a warning.

    For sensitive content the caller should pass *is_sensitive=True* to
    compress_message; truncation-only mode is used in that case.
    """

    def __init__(self, budget: TokenBudget, token_counter: TokenCounter) -> None:
        self._budget  = budget
        self._counter = token_counter

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def budget(self) -> TokenBudget:
        return self._budget

    def get_output_tokens(self, task_type: Optional[TaskType] = None) -> int:
        """Return the recommended max_tokens for the given task type."""
        if task_type is None:
            limit = _DEFAULT_OUTPUT_TOKENS
        else:
            limit = TASK_OUTPUT_TOKENS.get(task_type.value, _DEFAULT_OUTPUT_TOKENS)
        return min(limit, self._budget.max_output_tokens)

    def check_input(self, token_count: int) -> bool:
        return token_count <= self._budget.max_input_tokens

    def check_output(self, token_count: int) -> bool:
        return token_count <= self._budget.max_output_tokens

    def check_total(self, input_tokens: int, output_tokens: int) -> bool:
        return (input_tokens + output_tokens) <= self._budget.max_total_tokens

    def enforce_input_budget(
        self,
        messages: List[Message],
        provider: str = "openai",
    ) -> Tuple[List[Message], List[str]]:
        """
        Trim *messages* so their total token count fits within
        ``budget.max_input_tokens``.

        Returns ``(trimmed_messages, warnings)``.
        """
        warnings: List[str] = []
        msg_dicts = [m.to_dict() for m in messages]
        current   = self._counter.count_messages(msg_dicts, provider)

        if current <= self._budget.max_input_tokens:
            return messages, warnings

        warnings.append(
            f"Input ({current} tokens) exceeds budget "
            f"({self._budget.max_input_tokens} tokens). Trimming oldest messages."
        )

        system_msgs = [m for m in messages if m.role == "system"]
        conv_msgs   = [m for m in messages if m.role != "system"]

        # Drop from the front of conv_msgs until we fit or only 1 message remains
        while len(conv_msgs) > 1:
            test = system_msgs + conv_msgs
            test_dicts = [m.to_dict() for m in test]
            if self._counter.count_messages(test_dicts, provider) <= self._budget.max_input_tokens:
                return test, warnings
            conv_msgs.pop(0)

        # Still over budget with a single conv message — truncate its content
        result = system_msgs + conv_msgs
        if result:
            # How many tokens are consumed by the system block alone?
            sys_tokens = self._counter.count_messages(
                [m.to_dict() for m in system_msgs], provider
            ) if system_msgs else 3
            available = self._budget.max_input_tokens - sys_tokens - 30  # 30 for overhead
            available = max(available, 100)  # always leave at least 100 tokens of content
            char_limit = self._counter.estimate_char_budget(available)

            last = conv_msgs[-1]
            if len(last.content) > char_limit:
                truncated_content = last.content[:char_limit].rsplit(" ", 1)[0]
                conv_msgs[-1] = Message(
                    role=last.role,
                    content=truncated_content + " …[truncated to fit token budget]",
                )
                warnings.append("Last message was truncated to fit within the token budget.")

        return system_msgs + conv_msgs, warnings

    def compress_message(
        self,
        message: Message,
        max_tokens: int,
        is_sensitive: bool = False,
    ) -> Tuple[Message, bool]:
        """
        Compress a single oversized message to fit within *max_tokens*.

        For sensitive content only safe tail-truncation is applied.
        For regular content an extractive summariser is used first.

        Returns ``(possibly_compressed_message, was_compressed)``.
        """
        current = self._counter.count(message.content)
        if current <= max_tokens:
            return message, False

        char_limit = self._counter.estimate_char_budget(max_tokens)

        if is_sensitive:
            truncated = message.content[:char_limit]
            if len(truncated) < len(message.content):
                truncated += "\n…[content truncated — sensitive domain detected, full compression skipped]"
            return Message(role=message.role, content=truncated), True

        # Non-sensitive: extractive summarisation
        from .history_compressor import ExtractiveSummarizer  # avoid circular at module level
        summary = ExtractiveSummarizer().summarize(
            message.content, max_sentences=12, max_chars=char_limit
        )
        return Message(role=message.role, content=summary), True
