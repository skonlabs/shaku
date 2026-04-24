"""
History compression: keep the last N turns verbatim; summarise older turns
into a compact memory block using extractive summarisation (no API calls).
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import List, Optional, Tuple

from .token_counter import TokenCounter
from .types import Message

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Stop-words for frequency-based sentence scoring
# ---------------------------------------------------------------------------
_STOP_WORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "must", "that",
    "this", "these", "those", "it", "its", "they", "them", "their", "we",
    "our", "you", "your", "i", "my", "he", "she", "his", "her", "not",
    "no", "so", "if", "as", "up", "out", "what", "which", "who", "how",
    "when", "where", "why", "all", "more", "also", "than", "then", "about",
    "into", "through", "over", "after", "before", "just", "only", "very",
})


# ---------------------------------------------------------------------------
# Extractive summariser (pure Python, no API calls, deterministic)
# ---------------------------------------------------------------------------

class ExtractiveSummarizer:
    """
    Selects the most informative sentences from a text block.

    Scoring = normalised word-frequency score + position bonus.
    First and last sentences receive a small bonus (often contain key points).
    """

    def summarize(
        self,
        text: str,
        max_sentences: int = 5,
        max_chars: Optional[int] = None,
    ) -> str:
        """
        Return an extractive summary of *text*.

        If *text* has ≤ *max_sentences* sentences it is returned as-is
        (possibly truncated to *max_chars*).
        """
        if not text:
            return text
        sentences = self._split_sentences(text)
        if not sentences:
            return text

        if len(sentences) <= max_sentences:
            result = text
            return self._maybe_truncate(result, max_chars)

        scores = self._score_sentences(sentences)

        # Pick top-N by score, restore original order
        ranked_indices = sorted(
            range(len(scores)), key=lambda i: scores[i], reverse=True
        )[:max_sentences]
        kept_indices = sorted(ranked_indices)

        summary = " ".join(sentences[i] for i in kept_indices)
        return self._maybe_truncate(summary, max_chars)

    # ------------------------------------------------------------------

    def _split_sentences(self, text: str) -> List[str]:
        """Split on terminal punctuation followed by whitespace."""
        raw = re.split(r"(?<=[.!?])\s+", text.strip())
        return [s.strip() for s in raw if s.strip()]

    def _score_sentences(self, sentences: List[str]) -> List[float]:
        all_words = []
        for s in sentences:
            all_words.extend(re.findall(r"\b[a-z]{3,}\b", s.lower()))

        word_freq = Counter(w for w in all_words if w not in _STOP_WORDS)
        max_freq = max(word_freq.values(), default=1)
        n = len(sentences)

        scores: List[float] = []
        for i, sent in enumerate(sentences):
            words = [w for w in re.findall(r"\b[a-z]{3,}\b", sent.lower()) if w not in _STOP_WORDS]
            if not words:
                scores.append(0.0)
                continue

            freq_score = sum(word_freq.get(w, 0) for w in words) / max_freq / len(words)

            # First sentence gets +0.20, last gets +0.15 (often contain key points)
            if i == 0:
                pos_bonus = 0.20
            elif i == n - 1:
                pos_bonus = 0.15
            else:
                pos_bonus = 0.0

            # Mild length bonus: prefer medium-length sentences (10-25 words)
            length_score = min(1.0, len(words) / 20.0) * 0.05

            scores.append(freq_score + pos_bonus + length_score)

        return scores

    @staticmethod
    def _maybe_truncate(text: str, max_chars: Optional[int]) -> str:
        if max_chars and len(text) > max_chars:
            truncated = text[:max_chars].rsplit(" ", 1)[0]
            return truncated + "…"
        return text


# ---------------------------------------------------------------------------
# History compressor
# ---------------------------------------------------------------------------

class HistoryCompressor:
    """
    Trims conversation history so it fits within a token budget.

    Strategy:
      1. System messages are always preserved verbatim.
      2. The most recent *keep_turns* user/assistant turns are preserved verbatim.
      3. All older turns are collapsed into a single compact memory block using
         extractive summarisation (no API calls required).
      4. If the result still exceeds *token_budget* the oldest non-system
         messages are removed from the front.
    """

    def __init__(
        self,
        token_counter: TokenCounter,
        keep_turns: int = 10,
    ) -> None:
        self._counter = token_counter
        self._keep_turns = keep_turns
        self._summarizer = ExtractiveSummarizer()

    def compress(
        self,
        messages: List[Message],
        token_budget: Optional[int] = None,
    ) -> List[Message]:
        """
        Return a compressed copy of *messages*.

        The returned list always starts with any original system messages,
        optionally followed by a generated summary block for older turns,
        then the most recent *keep_turns* turns.
        """
        if not messages:
            return messages

        system_msgs = [m for m in messages if m.role == "system"]
        conv_msgs   = [m for m in messages if m.role != "system"]

        turns = self._pair_turns(conv_msgs)

        if len(turns) <= self._keep_turns:
            # Nothing old enough to summarise — still enforce budget if given
            if token_budget:
                return self._trim_to_budget(messages, token_budget, system_msgs)
            return messages

        old_turns    = turns[: -self._keep_turns]
        recent_turns = turns[-self._keep_turns :]

        summary_text = self._summarize_turns(old_turns)
        memory_msg = Message(
            role="user",
            content=f"[Earlier conversation summary]\n{summary_text}",
        )

        recent_msgs: List[Message] = []
        for user_msg, asst_msg in recent_turns:
            recent_msgs.append(user_msg)
            if asst_msg is not None:
                recent_msgs.append(asst_msg)

        result = system_msgs + [memory_msg] + recent_msgs

        if token_budget:
            result = self._trim_to_budget(result, token_budget, system_msgs)

        logger.info(
            "HistoryCompressor: %d turns → summary + %d recent turns",
            len(turns),
            len(recent_turns),
        )
        return result

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _pair_turns(
        self, messages: List[Message]
    ) -> List[Tuple[Message, Optional[Message]]]:
        """Pair consecutive user/assistant messages into (user, assistant?) turns."""
        turns: List[Tuple[Message, Optional[Message]]] = []
        i = 0
        while i < len(messages):
            msg = messages[i]
            if msg.role == "user":
                if i + 1 < len(messages) and messages[i + 1].role == "assistant":
                    turns.append((msg, messages[i + 1]))
                    i += 2
                else:
                    turns.append((msg, None))
                    i += 1
            else:
                # Lone assistant message — treat as its own "turn"
                turns.append((msg, None))
                i += 1
        return turns

    def _summarize_turns(
        self, turns: List[Tuple[Message, Optional[Message]]]
    ) -> str:
        """Produce a compact extractive summary of old conversation turns."""
        lines: List[str] = []
        for user_msg, asst_msg in turns:
            lines.append(f"User: {user_msg.content[:400]}")
            if asst_msg is not None:
                lines.append(f"Assistant: {asst_msg.content[:400]}")
        combined = "\n".join(lines)
        return self._summarizer.summarize(combined, max_sentences=10, max_chars=900)

    def _trim_to_budget(
        self,
        messages: List[Message],
        budget: int,
        system_msgs: List[Message],
    ) -> List[Message]:
        """Drop the oldest non-system messages until the list fits in *budget*."""
        result = list(messages)
        msg_dicts = [m.to_dict() for m in result]

        while (
            self._counter.count_messages(msg_dicts) > budget
            and len(result) > len(system_msgs) + 1  # always keep last message
        ):
            # Remove the first non-system message
            for idx, m in enumerate(result):
                if m.role != "system":
                    result.pop(idx)
                    msg_dicts = [m.to_dict() for m in result]
                    break

        return result
