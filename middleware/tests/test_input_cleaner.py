"""Tests for InputCleaner."""
import pytest
from middleware.input_cleaner import InputCleaner


@pytest.fixture
def cleaner():
    return InputCleaner()


class TestWhitespaceNormalisation:
    def test_collapses_multiple_spaces(self, cleaner):
        result = cleaner.clean("hello   world   test")
        assert "  " not in result

    def test_collapses_tabs(self, cleaner):
        result = cleaner.clean("hello\t\tworld")
        assert "\t" not in result

    def test_caps_blank_lines_at_two(self, cleaner):
        result = cleaner.clean("paragraph one\n\n\n\n\nparagraph two")
        assert "\n\n\n" not in result

    def test_strips_trailing_spaces_on_lines(self, cleaner):
        result = cleaner.clean("line one   \nline two   ")
        assert "   \n" not in result

    def test_strips_leading_and_trailing(self, cleaner):
        result = cleaner.clean("  \n\n  hello world  \n\n  ")
        assert result == result.strip()


class TestDuplicateParagraphRemoval:
    def test_removes_exact_duplicate(self, cleaner):
        text = "Hello world.\n\nHello world."
        result = cleaner.clean(text)
        assert result.count("Hello world.") == 1

    def test_removes_case_insensitive_duplicate(self, cleaner):
        text = "Hello World.\n\nHELLO WORLD."
        result = cleaner.clean(text)
        # One of them should be gone (case-normalised fingerprint)
        assert result.count("\n\n") < text.count("\n\n")

    def test_keeps_different_paragraphs(self, cleaner):
        text = "First paragraph.\n\nSecond paragraph."
        result = cleaner.clean(text)
        assert "First" in result and "Second" in result

    def test_three_duplicates_keeps_one(self, cleaner):
        para = "Repeated content here."
        text = f"{para}\n\n{para}\n\n{para}"
        result = cleaner.clean(text)
        assert result.count("Repeated content here.") == 1


class TestMetadataStripping:
    def test_strips_html_tags(self, cleaner):
        result = cleaner.clean("<p>Hello <b>world</b></p>")
        assert "<p>" not in result
        assert "<b>" not in result
        assert "Hello" in result
        assert "world" in result

    def test_strips_script_tag(self, cleaner):
        result = cleaner.clean("<script>alert('xss')</script>Clean text")
        assert "<script>" not in result
        assert "Clean text" in result

    def test_strips_style_tag(self, cleaner):
        result = cleaner.clean("<style>body { color: red; }</style>Content")
        assert "<style>" not in result
        assert "Content" in result

    def test_strips_bare_url(self, cleaner):
        result = cleaner.clean("Visit https://example.com/very/long/path?query=1 for details")
        assert "https://" not in result

    def test_preserves_markdown_alt_text(self, cleaner):
        result = cleaner.clean("See ![diagram of system](https://example.com/img.png)")
        assert "diagram of system" in result

    def test_strips_base64(self, cleaner):
        b64 = "data:image/png;base64," + "A" * 50
        result = cleaner.clean(f"Image: {b64} end")
        assert "data:image/png;base64," not in result

    def test_strips_email_headers(self, cleaner):
        text = "From: alice@example.com\nSubject: Test\nDate: 2024-01-01\n\nBody text"
        result = cleaner.clean(text)
        assert "From:" not in result
        assert "Body text" in result


class TestBoilerplateRemoval:
    def test_removes_email_opener(self, cleaner):
        result = cleaner.clean("I hope this email finds you well. Please review the attached report.")
        assert "I hope this email" not in result
        assert "Please review" in result

    def test_removes_please_note_that(self, cleaner):
        result = cleaner.clean("Please note that the deadline is Friday.")
        assert "Please note that" not in result
        assert "deadline" in result

    def test_removes_needless_to_say(self, cleaner):
        result = cleaner.clean("Needless to say, quality matters.")
        assert "Needless to say" not in result
        assert "quality" in result

    def test_removes_as_mentioned_earlier(self, cleaner):
        result = cleaner.clean("As mentioned earlier, we need to act fast.")
        assert "As mentioned earlier" not in result
        assert "we need to act fast" in result

    def test_not_applied_to_sensitive_content(self, cleaner):
        text = "I hope this email finds you well. Pursuant to GDPR regulations..."
        result = cleaner.clean(text, is_sensitive=True)
        # Boilerplate NOT removed for sensitive content
        assert "I hope this email" in result


class TestSensitivityDetection:
    def test_detects_legal_content(self, cleaner):
        text = "Pursuant to the agreement, the indemnification clause shall apply."
        is_sensitive, domains = cleaner.is_sensitive(text)
        assert is_sensitive is True
        assert "legal" in domains

    def test_detects_medical_content(self, cleaner):
        text = "The patient diagnosis indicates medication dosage adjustment is needed."
        is_sensitive, domains = cleaner.is_sensitive(text)
        assert is_sensitive is True
        assert "medical" in domains

    def test_detects_financial_content(self, cleaner):
        text = "The audit report revealed discrepancies in the balance sheet."
        is_sensitive, domains = cleaner.is_sensitive(text)
        assert is_sensitive is True
        assert "financial" in domains

    def test_detects_compliance_content(self, cleaner):
        text = "GDPR requires a data protection officer to maintain the audit trail."
        is_sensitive, domains = cleaner.is_sensitive(text)
        assert is_sensitive is True
        assert "compliance" in domains

    def test_normal_text_not_sensitive(self, cleaner):
        text = "Can you help me write a Python script to sort a list?"
        is_sensitive, domains = cleaner.is_sensitive(text)
        assert is_sensitive is False
        assert domains == []

    def test_domain_filter(self, cleaner):
        text = "The audit report revealed balance sheet issues per GDPR."
        _, domains = cleaner.is_sensitive(text, domains=["legal"])
        assert "financial" not in domains
        assert "compliance" not in domains

    def test_empty_text_not_sensitive(self, cleaner):
        is_sensitive, _ = cleaner.is_sensitive("")
        assert is_sensitive is False


class TestEdgeCases:
    def test_empty_string_returns_empty(self, cleaner):
        assert cleaner.clean("") == ""

    def test_single_word_unchanged(self, cleaner):
        assert cleaner.clean("hello") == "hello"

    def test_idempotent(self, cleaner):
        text = "Some normal text with a couple of sentences.\n\nAnother paragraph here."
        first  = cleaner.clean(text)
        second = cleaner.clean(first)
        assert first == second
