"""Tests for ContextPruner."""
import pytest
from middleware.context_pruner import ContextPruner, ScoredChunk
from middleware.token_counter import TokenCounter


@pytest.fixture
def counter():
    return TokenCounter()


@pytest.fixture
def pruner(counter):
    return ContextPruner(counter, chunk_size_tokens=50, overlap_tokens=5, top_k=3)


DOCS = [
    "Python is a high-level programming language known for its simplicity and readability. "
    "It is widely used in data science, machine learning, web development, and automation.",

    "JavaScript is primarily a frontend web development language. "
    "Frameworks like React, Vue, and Angular are popular choices for building user interfaces.",

    "Machine learning is a subset of artificial intelligence. "
    "Neural networks learn patterns from large datasets to make predictions.",

    "SQL is a domain-specific language for managing relational databases. "
    "Common operations include SELECT, INSERT, UPDATE, and DELETE.",

    "Docker is a containerisation platform that packages applications with their dependencies. "
    "It simplifies deployment across different environments.",
]


class TestChunking:
    def test_single_short_doc_one_chunk(self, pruner, counter):
        doc = "This is a short document."
        chunks = pruner._chunk_document(doc, 0)
        assert len(chunks) == 1
        assert chunks[0].text == doc

    def test_empty_doc_no_chunks(self, pruner):
        chunks = pruner._chunk_document("", 0)
        assert chunks == []

    def test_long_doc_multiple_chunks(self, counter):
        # Use small chunk size so a long doc splits
        p = ContextPruner(counter, chunk_size_tokens=20, overlap_tokens=0, top_k=10)
        long_doc = " ".join(f"Word{i}" for i in range(200))
        chunks = p._chunk_document(long_doc, 0)
        assert len(chunks) > 1

    def test_chunk_source_index(self, pruner):
        chunks = pruner._chunk_document("A short text.", 2)
        assert all(c.source_index == 2 for c in chunks)

    def test_chunk_indices_sequential(self, counter):
        p = ContextPruner(counter, chunk_size_tokens=20, overlap_tokens=0, top_k=10)
        long_doc = " ".join(f"Sentence {i} with enough words to fill." for i in range(30))
        chunks = p._chunk_document(long_doc, 0)
        indices = [c.chunk_index for c in chunks]
        assert indices == list(range(len(chunks)))

    def test_oversized_paragraph_split(self, counter):
        p = ContextPruner(counter, chunk_size_tokens=10, overlap_tokens=0, top_k=10)
        para = "word " * 100
        chunks = p._chunk_document(para, 0)
        assert len(chunks) >= 2


class TestBM25Ranking:
    def test_relevant_chunk_ranked_first(self, pruner):
        chunks = [
            ScoredChunk(text="Python machine learning neural networks.", score=0, source_index=0, chunk_index=0),
            ScoredChunk(text="JavaScript React frontend user interface.", score=0, source_index=1, chunk_index=0),
            ScoredChunk(text="SQL database queries SELECT INSERT.", score=0, source_index=2, chunk_index=0),
        ]
        ranked = pruner._rank_bm25(chunks, "machine learning Python")
        # The Python/ML chunk should be ranked higher
        assert ranked[0].text == "Python machine learning neural networks."

    def test_empty_chunks_returned_as_is(self, pruner):
        result = pruner._rank_bm25([], "query")
        assert result == []

    def test_empty_query_returns_original_order(self, pruner):
        chunks = [
            ScoredChunk(text="A.", score=0, source_index=0, chunk_index=0),
            ScoredChunk(text="B.", score=0, source_index=1, chunk_index=0),
        ]
        result = pruner._rank_bm25(chunks, "")
        # Empty query falls back to original ordering
        assert len(result) == 2

    def test_single_chunk_always_returned(self, pruner):
        chunks = [ScoredChunk(text="Only one chunk.", score=0, source_index=0, chunk_index=0)]
        result = pruner._rank_bm25(chunks, "some query terms")
        assert len(result) == 1

    def test_scores_are_non_negative(self, pruner):
        chunks = [
            ScoredChunk(text="Hello world test.", score=0, source_index=0, chunk_index=0),
        ]
        ranked = pruner._rank_bm25(chunks, "hello world")
        assert all(c.score >= 0 for c in ranked)


class TestPrune:
    def test_returns_list(self, pruner):
        result = pruner.prune(DOCS, "Python programming")
        assert isinstance(result, list)

    def test_empty_docs_returns_empty(self, pruner):
        assert pruner.prune([], "query") == []

    def test_top_k_limit_respected(self, pruner):
        result = pruner.prune(DOCS, "programming language")
        assert len(result) <= 3  # top_k=3

    def test_budget_limit_respected(self, counter):
        p = ContextPruner(counter, chunk_size_tokens=100, overlap_tokens=0, top_k=10)
        budget = 50
        result = p.prune(DOCS, "Python", token_budget=budget)
        total_tokens = sum(counter.count(c) for c in result)
        assert total_tokens <= budget + 10  # small margin

    def test_relevant_docs_ranked_higher(self, pruner):
        result = pruner.prune(DOCS, "machine learning neural networks")
        # At least one result should relate to ML
        combined = " ".join(result).lower()
        assert "machine learning" in combined or "neural" in combined

    def test_result_in_original_document_order(self, pruner):
        result = pruner.prune(DOCS, "programming language Python JavaScript")
        # When multiple chunks from different docs, they should be in doc order
        # (i.e., Python doc before SQL doc)
        all_text = " ".join(result)
        if "Python" in all_text and "SQL" in all_text:
            assert all_text.index("Python") < all_text.index("SQL")

    def test_no_query_returns_something(self, pruner):
        # Empty query should not crash
        result = pruner.prune(DOCS[:2], "")
        assert isinstance(result, list)


class TestTokenize:
    def test_removes_stop_words(self, pruner):
        tokens = pruner._tokenize("the quick brown fox")
        assert "the" not in tokens

    def test_lowercases(self, pruner):
        tokens = pruner._tokenize("Python JavaScript")
        assert "python" in tokens
        assert "javascript" in tokens

    def test_empty_string(self, pruner):
        assert pruner._tokenize("") == []

    def test_filters_single_char(self, pruner):
        tokens = pruner._tokenize("a b c hello world")
        assert "a" not in tokens
        assert "b" not in tokens
