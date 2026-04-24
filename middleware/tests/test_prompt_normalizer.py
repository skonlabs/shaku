"""Tests for PromptNormalizer."""
import pytest
from middleware.prompt_normalizer import PromptNormalizer


@pytest.fixture
def norm():
    return PromptNormalizer()


class TestNormalize:
    def test_short_text_unchanged(self, norm):
        short = "Hello world"  # < 60 chars
        assert norm.normalize(short) == short

    def test_empty_string_unchanged(self, norm):
        assert norm.normalize("") == ""

    def test_verbose_phrase_replaced(self, norm):
        text = "We need to act in order to solve this problem before the deadline."
        result = norm.normalize(text)
        assert "in order to" not in result
        assert "to" in result

    def test_due_to_fact_that(self, norm):
        text = "This failed due to the fact that the server was unavailable for requests."
        result = norm.normalize(text)
        assert "due to the fact that" not in result
        assert "because" in result

    def test_prior_to(self, norm):
        text = "Please complete the form prior to the meeting scheduled for tomorrow morning."
        result = norm.normalize(text)
        assert "prior to" not in result
        assert "before" in result

    def test_with_regard_to(self, norm):
        text = "With regard to the latest report, please review the key findings carefully."
        result = norm.normalize(text)
        assert "with regard to" not in result.lower()
        assert "regarding" in result.lower()

    def test_preserves_dates(self, norm):
        text = "Please submit the report by 2024-12-31 in order to meet the deadline."
        result = norm.normalize(text)
        assert "2024-12-31" in result

    def test_preserves_numbers(self, norm):
        text = "The budget is $1,500,000 and the team has the ability to meet targets."
        result = norm.normalize(text)
        assert "$1,500,000" in result

    def test_normalizes_whitespace(self, norm):
        text = "This    is   a    verbose    phrase  due to the fact that  spaces   exist here now."
        result = norm.normalize(text)
        assert "  " not in result

    def test_output_stripped(self, norm):
        # Use text > 60 chars so normalize() does not short-circuit
        text = "  We need in order to do this important thing properly with great care.  "
        result = norm.normalize(text)
        assert result == result.strip()


class TestExtractTaskTypeHint:
    def test_classification_hint(self, norm):
        assert norm.extract_task_type_hint("Can you classify this text into categories?") == "classification"

    def test_extraction_hint(self, norm):
        assert norm.extract_task_type_hint("Extract all the email addresses from this document.") == "extraction"

    def test_summarization_hint(self, norm):
        assert norm.extract_task_type_hint("Summarize this article in 3 bullet points.") == "summarization"

    def test_summarization_tldr(self, norm):
        assert norm.extract_task_type_hint("TLDR of the following text please.") == "summarization"

    def test_coding_hint_debug(self, norm):
        assert norm.extract_task_type_hint("Debug this Python function for me.") == "coding"

    def test_coding_hint_implement(self, norm):
        assert norm.extract_task_type_hint("Implement a binary search function.") == "coding"

    def test_reasoning_hint(self, norm):
        assert norm.extract_task_type_hint("Analyze the root cause of this failure.") == "reasoning"

    def test_generation_hint(self, norm):
        assert norm.extract_task_type_hint("Write a blog post about machine learning trends.") == "generation"

    def test_unknown_returns_none(self, norm):
        assert norm.extract_task_type_hint("Hello, how are you?") is None

    def test_empty_returns_none(self, norm):
        assert norm.extract_task_type_hint("") is None


class TestExtractCriticalDetails:
    def test_extracts_iso_date(self, norm):
        details = norm.extract_critical_details("The deadline is 2024-12-31.")
        assert "2024-12-31" in details["dates"]

    def test_extracts_written_date(self, norm):
        details = norm.extract_critical_details("Submit by January 15, 2025.")
        assert any("January" in d for d in details["dates"])

    def test_extracts_percentage(self, norm):
        details = norm.extract_critical_details("Revenue increased by 15.5% this quarter.")
        assert any("15.5%" in n for n in details["numbers"])

    def test_extracts_dollar_amount(self, norm):
        details = norm.extract_critical_details("The budget is $50,000 for the project.")
        assert any("50,000" in n for n in details["numbers"])

    def test_extracts_must_constraint(self, norm):
        details = norm.extract_critical_details("The response must include a summary.")
        assert "must" in details["constraints"]

    def test_extracts_at_most_constraint(self, norm):
        details = norm.extract_critical_details("Use at most 500 words.")
        assert "at most" in details["constraints"]

    def test_extracts_json_format(self, norm):
        details = norm.extract_critical_details("Return the result as json please.")
        assert "json" in details["format_hints"]

    def test_extracts_table_format(self, norm):
        details = norm.extract_critical_details("Present the data as a table.")
        assert "as a table" in details["format_hints"]

    def test_no_entities_empty_lists(self, norm):
        details = norm.extract_critical_details("Hello, how are you doing today?")
        assert details["constraints"] == []

    def test_deduplicates_dates(self, norm):
        text = "The date 2024-01-01 and also 2024-01-01 again."
        details = norm.extract_critical_details(text)
        assert details["dates"].count("2024-01-01") == 1
