"""
Context pruning: split long documents into chunks, rank by relevance to the
query using BM25, return the top-K chunks that fit within a token budget.
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter
from typing import List, NamedTuple, Optional

from .token_counter import TokenCounter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Stop-words for BM25 tokenisation
# ---------------------------------------------------------------------------
_STOP_WORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "have",
    "do", "it", "its", "this", "that", "these", "those", "as", "up", "if",
    "so", "we", "you", "he", "she", "they", "not", "no", "all", "more",
    "also", "than", "then", "i", "my", "me", "our", "us", "your", "his",
    "her", "their", "can", "will", "just", "been", "has", "had",
})


class ScoredChunk(NamedTuple):
    text: str
    score: float
    source_index: int
    chunk_index: int


class ContextPruner:
    """
    Splits documents into overlapping chunks, ranks them by BM25 relevance
    against a query, and returns the top-K chunks that fit within a token
    budget — in original document order.

    No API calls are made; all scoring is deterministic.
    """

    # BM25 hyper-parameters (literature defaults)
    _K1 = 1.5
    _B  = 0.75

    def __init__(
        self,
        token_counter: TokenCounter,
        chunk_size_tokens: int = 512,
        overlap_tokens: int = 64,
        top_k: int = 5,
    ) -> None:
        self._counter        = token_counter
        self._chunk_size     = chunk_size_tokens
        self._overlap        = overlap_tokens
        self._top_k          = top_k

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def prune(
        self,
        documents: List[str],
        query: str,
        token_budget: Optional[int] = None,
    ) -> List[str]:
        """
        Return a list of the most relevant chunks, in original document order,
        that collectively fit within *token_budget*.

        If *token_budget* is None only the top-K limit is applied.
        """
        if not documents:
            return []
        if not query.strip():
            # No query — return the first document's chunks up to budget
            query = "the"

        all_chunks: List[ScoredChunk] = []
        for doc_idx, doc in enumerate(documents):
            chunks = self._chunk_document(doc, doc_idx)
            all_chunks.extend(chunks)

        if not all_chunks:
            return []

        ranked = self._rank_bm25(all_chunks, query)

        # Apply top-K limit
        selected = ranked[: self._top_k]

        # Apply token budget
        if token_budget is not None:
            selected = self._apply_budget(selected, token_budget)

        # Restore original document order
        selected.sort(key=lambda c: (c.source_index, c.chunk_index))
        return [c.text for c in selected]

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------

    def _chunk_document(self, text: str, doc_idx: int) -> List[ScoredChunk]:
        """
        Split *text* into chunks of ≤ chunk_size_tokens with paragraph-aware
        boundaries.  Oversized paragraphs are split by sentence.
        """
        if not text.strip():
            return []

        paragraphs = re.split(r"\n\n+", text.strip())
        chunks: List[ScoredChunk] = []
        current_paras: List[str] = []
        current_tokens = 0
        chunk_idx = 0

        def _flush() -> None:
            nonlocal current_paras, current_tokens, chunk_idx
            if current_paras:
                chunks.append(ScoredChunk(
                    text="\n\n".join(current_paras),
                    score=0.0,
                    source_index=doc_idx,
                    chunk_index=chunk_idx,
                ))
                chunk_idx += 1
                # Overlap: keep the last paragraph as the start of the next chunk
                if self._overlap > 0 and current_paras:
                    last = current_paras[-1]
                    current_paras = [last]
                    current_tokens = self._counter.count(last)
                else:
                    current_paras = []
                    current_tokens = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            para_tokens = self._counter.count(para)

            if para_tokens > self._chunk_size:
                # Paragraph is itself too large — flush current and split by sentence
                _flush()
                for chunk_text in self._split_by_sentences(para, doc_idx, chunk_idx):
                    chunks.append(ScoredChunk(
                        text=chunk_text,
                        score=0.0,
                        source_index=doc_idx,
                        chunk_index=chunk_idx,
                    ))
                    chunk_idx += 1
                # Reset (no overlap across sentence-split chunks for simplicity)
                current_paras = []
                current_tokens = 0
            elif current_tokens + para_tokens > self._chunk_size and current_paras:
                _flush()
                current_paras.append(para)
                current_tokens += para_tokens
            else:
                current_paras.append(para)
                current_tokens += para_tokens

        # Final flush
        if current_paras:
            chunks.append(ScoredChunk(
                text="\n\n".join(current_paras),
                score=0.0,
                source_index=doc_idx,
                chunk_index=chunk_idx,
            ))

        return chunks

    def _split_by_sentences(self, text: str, doc_idx: int, start_idx: int) -> List[str]:
        """
        Split an oversized paragraph by sentences.
        When a single sentence is itself too long (e.g. no punctuation),
        fall back to word-level splitting.
        """
        sentences = re.split(r"(?<=[.!?])\s+", text)
        current: List[str] = []
        current_tokens = 0
        result_texts: List[str] = []

        for sent in sentences:
            s_tokens = self._counter.count(sent)

            if s_tokens > self._chunk_size:
                # Single sentence is too long — split by words
                if current:
                    result_texts.append(" ".join(current))
                    current = []
                    current_tokens = 0
                result_texts.extend(self._split_by_words(sent))
                continue

            if current_tokens + s_tokens > self._chunk_size and current:
                result_texts.append(" ".join(current))
                # Overlap: keep last sentence
                current = current[-1:] if self._overlap > 0 else []
                current_tokens = self._counter.count(" ".join(current)) if current else 0
            current.append(sent)
            current_tokens += s_tokens

        if current:
            result_texts.append(" ".join(current))

        return result_texts if result_texts else [text]

    def _split_by_words(self, text: str) -> List[str]:
        """Split a very long token-less span by word count."""
        words = text.split()
        result_texts: List[str] = []
        current: List[str] = []
        current_tokens = 0

        for word in words:
            w_tok = self._counter.count(word)
            if current_tokens + w_tok > self._chunk_size and current:
                result_texts.append(" ".join(current))
                current = current[-1:] if self._overlap > 0 else []
                current_tokens = self._counter.count(" ".join(current)) if current else 0
            current.append(word)
            current_tokens += w_tok

        if current:
            result_texts.append(" ".join(current))

        return result_texts if result_texts else [text]

    # ------------------------------------------------------------------
    # BM25 ranking
    # ------------------------------------------------------------------

    def _rank_bm25(
        self, chunks: List[ScoredChunk], query: str
    ) -> List[ScoredChunk]:
        """Score chunks with BM25 and return sorted list (highest score first)."""
        query_terms = self._tokenize(query)
        if not query_terms:
            return list(chunks)

        # Build per-document term lists
        tokenized = [self._tokenize(c.text) for c in chunks]
        n = len(tokenized)

        # Document frequency per term
        df: Counter = Counter()
        for terms in tokenized:
            df.update(set(terms))

        # IDF (with smoothing to handle single-document corpora)
        idf: dict = {
            term: math.log((n - count + 0.5) / (count + 0.5) + 1.0)
            for term, count in df.items()
        }

        avg_len = sum(len(t) for t in tokenized) / max(n, 1)

        scored: List[ScoredChunk] = []
        for chunk, terms in zip(chunks, tokenized):
            tf = Counter(terms)
            doc_len = len(terms)
            score = 0.0
            for qt in query_terms:
                if qt not in tf:
                    continue
                tf_val   = tf[qt]
                idf_val  = idf.get(qt, 0.0)
                tf_norm  = tf_val * (self._K1 + 1) / (
                    tf_val + self._K1 * (1 - self._B + self._B * doc_len / max(avg_len, 1))
                )
                score += idf_val * tf_norm
            scored.append(ScoredChunk(
                text=chunk.text,
                score=score,
                source_index=chunk.source_index,
                chunk_index=chunk.chunk_index,
            ))

        scored.sort(key=lambda c: c.score, reverse=True)
        return scored

    # ------------------------------------------------------------------
    # Budget enforcement
    # ------------------------------------------------------------------

    def _apply_budget(
        self, chunks: List[ScoredChunk], budget: int
    ) -> List[ScoredChunk]:
        """Greedily include chunks from the ranked list until budget is exhausted."""
        selected: List[ScoredChunk] = []
        used = 0
        for chunk in chunks:
            tokens = self._counter.count(chunk.text)
            if used + tokens > budget:
                if not selected:
                    # Always include at least one chunk (truncated if necessary)
                    char_limit = self._counter.estimate_char_budget(budget)
                    selected.append(ScoredChunk(
                        text=chunk.text[:char_limit],
                        score=chunk.score,
                        source_index=chunk.source_index,
                        chunk_index=chunk.chunk_index,
                    ))
                break
            selected.append(chunk)
            used += tokens
        return selected

    # ------------------------------------------------------------------
    # Tokenisation helper
    # ------------------------------------------------------------------

    def _tokenize(self, text: str) -> List[str]:
        """Lowercase word tokens filtered of stop-words."""
        return [
            w for w in re.findall(r"\b[a-z]{2,}\b", text.lower())
            if w not in _STOP_WORDS
        ]
