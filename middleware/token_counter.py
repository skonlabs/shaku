"""Token counting with tiktoken (if available) or char-based fallback."""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_CHARS_PER_TOKEN = 4  # conservative English approximation

try:
    import tiktoken as _tiktoken

    _TIKTOKEN_AVAILABLE = True
except ImportError:
    _tiktoken = None  # type: ignore[assignment]
    _TIKTOKEN_AVAILABLE = False

# Per-provider framing overhead (tokens per message)
_MSG_OVERHEAD: Dict[str, int] = {
    "openai": 4,     # per OpenAI's token-counting cookbook
    "anthropic": 5,  # slightly higher for Anthropic's XML-style framing
}


class TokenCounter:
    """
    Counts tokens accurately with tiktoken when available, otherwise uses a
    deterministic character-based approximation (1 token ≈ 4 chars).

    All methods are pure functions of their inputs — no side effects, no API calls.
    """

    def __init__(self, model: str = "gpt-4o") -> None:
        self._model = model
        self._enc: Optional[object] = None

        if _TIKTOKEN_AVAILABLE:
            try:
                self._enc = _tiktoken.encoding_for_model(model)
            except KeyError:
                self._enc = _tiktoken.get_encoding("cl100k_base")
                logger.debug(
                    "TokenCounter: unknown model %r, falling back to cl100k_base", model
                )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def count(self, text: str) -> int:
        """Return token count for a single text string."""
        if not text:
            return 0
        if self._enc is not None:
            return len(self._enc.encode(text, disallowed_special=()))
        return max(1, len(text) // _CHARS_PER_TOKEN)

    def count_messages(
        self,
        messages: List[Dict[str, str]],
        provider: str = "openai",
    ) -> int:
        """
        Return total token count for a list of chat messages including
        role-framing overhead.

        Overhead model (OpenAI):
          3 tokens for reply-priming
          +4 per message for role/name framing
        """
        overhead = _MSG_OVERHEAD.get(provider, 4)
        total = 3  # reply-priming tokens
        for msg in messages:
            total += overhead
            content = msg.get("content") or ""
            total += self.count(content)
            if msg.get("name"):
                total += 1  # name field costs 1 extra token
        return total

    def estimate_char_budget(self, token_budget: int) -> int:
        """
        Convert a token budget into a safe character limit.

        With tiktoken we use a slightly conservative 3.8 chars/token ratio;
        without tiktoken we use the 4 chars/token fallback.
        """
        if self._enc is not None:
            return int(token_budget * 3.8)
        return token_budget * _CHARS_PER_TOKEN

    @property
    def uses_tiktoken(self) -> bool:
        """True when tiktoken is installed and active."""
        return self._enc is not None
