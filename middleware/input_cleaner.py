"""Input cleaning: removes noise while preserving every task-critical detail."""
from __future__ import annotations

import hashlib
import logging
import re
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Boilerplate patterns
# Each entry: (compiled regex, replacement string).
# Replacements are minimal — we shrink noise, not meaning.
# ---------------------------------------------------------------------------
_BOILERPLATE: List[Tuple[re.Pattern, str]] = [
    # Email / letter openers
    (re.compile(r"I hope this (email|message|note|letter) finds you well\.?", re.I), ""),
    (re.compile(r"I (am writing|wanted to (reach out|contact) (you )?)(today |)(to |)", re.I), ""),
    (re.compile(r"Please (do not hesitate|feel free) to (contact|reach out|get in touch)[^.]*\.", re.I), ""),
    # Redundant discourse markers
    (re.compile(r"\bIt is (worth|important to) (noting|mentioning|highlight(ing)?|remember) that\b", re.I), ""),
    (re.compile(r"\bPlease note that\b", re.I), ""),
    (re.compile(r"\bIt should be noted that\b", re.I), ""),
    (re.compile(r"\bAs (you |we )?(may |)(know|be aware)[,.]?\b", re.I), ""),
    (re.compile(r"\bAt the end of the day[,.]?\b", re.I), ""),
    (re.compile(r"\bFor (all intents and purposes|the (purpose|avoidance) of doubt)[,.]?\b", re.I), ""),
    (re.compile(r"\bFirst and foremost[,.]?\b", re.I), ""),
    (re.compile(r"\bLast but (certainly )?not least[,.]?\b", re.I), "Finally,"),
    (re.compile(r"\bIn (summary|conclusion|closing)[,.]?\b", re.I), ""),
    (re.compile(r"\bTo (summarize|sum up|recap)[,.]?\b", re.I), ""),
    (re.compile(r"\bAs (mentioned|stated|discussed|noted) (above|previously|earlier|before)[,.]?\b", re.I), ""),
    (re.compile(r"\bNeedless to say[,.]?\b", re.I), ""),
    (re.compile(r"\bObviously[,.]?\b", re.I), ""),
    (re.compile(r"\bOf course[,.]?\b", re.I), ""),
    # Excessive hedging chains
    (re.compile(r"\bit might possibly be the case that\b", re.I), "possibly"),
    (re.compile(r"\bperhaps it could (be argued|be said) that\b", re.I), "arguably"),
    (re.compile(r"\bsome (people|experts|analysts) (might |may |would |)(argue|say|suggest|think) that\b", re.I), ""),
]

# ---------------------------------------------------------------------------
# Metadata patterns to strip
# ---------------------------------------------------------------------------
_METADATA: List[Tuple[re.Pattern, str]] = [
    # Full HTML documents / head / script / style blocks
    (re.compile(r"<!DOCTYPE[^>]*>", re.I), ""),
    (re.compile(r"<head[^>]*>.*?</head>", re.S | re.I), ""),
    (re.compile(r"<script[^>]*>.*?</script>", re.S | re.I), ""),
    (re.compile(r"<style[^>]*>.*?</style>", re.S | re.I), ""),
    (re.compile(r"<!--.*?-->", re.S), ""),
    # Inline HTML tags — preserve text content
    (re.compile(r"<[^>]{1,200}>"), " "),
    # Markdown images — keep alt text, strip URL
    (re.compile(r"!\[([^\]]*)\]\([^)]+\)"), r"\1"),
    # Bare URLs (not part of markdown link syntax)
    (re.compile(r"(?<!\()\bhttps?://\S{10,}(?!\))"), "[url]"),
    # Base64 data URIs
    (re.compile(r"data:[a-z/]+;base64,[A-Za-z0-9+/=]{20,}"), "[base64]"),
    # Email-style headers (From:, Date:, Subject:, etc.)
    (re.compile(r"^(Date|From|To|CC|BCC|Subject|Sent|Received|Message-ID)\s*:[^\n]*\n?", re.M | re.I), ""),
]

# ---------------------------------------------------------------------------
# Sensitive-domain keyword sets
# When any keyword is found, compression is skipped with a warning.
# ---------------------------------------------------------------------------
_SENSITIVE_KW: Dict[str, List[str]] = {
    "legal": [
        "pursuant to", "whereas ", "hereinafter", "indemnif", "liability",
        "breach of contract", "arbitration", "jurisdiction", "statute",
        "regulatory compliance", "attorney", "counsel", "plaintiff", "defendant",
        "court order", "tribunal", "force majeure", "intellectual property",
    ],
    "medical": [
        "diagnosis", "treatment plan", "medication", "dosage", "symptom",
        "clinical trial", "patient record", "prescription", "contraindication",
        "adverse effect", "prognosis", "therapy", "medical history",
        "ehr", "phi", "hipaa",
    ],
    "financial": [
        "investment advice", "securities", "portfolio", "dividend",
        "fiduciary duty", "prospectus", "material disclosure", "interest rate risk",
        "yield curve", "collateral", "derivatives", "audit report",
        "financial statement", "balance sheet", "insider trading",
    ],
    "compliance": [
        "gdpr", "hipaa", "sox ", "pci-dss", "iso 27001", "regulatory requirement",
        "audit trail", "data protection officer", "privacy policy",
        "consent form", "data retention", "right to erasure",
    ],
}


class InputCleaner:
    """
    Cleans text inputs by removing noise while preserving task-critical content.

    Conservative by default — sensitive domain content is NOT aggressively
    compressed; only whitespace normalization and deduplication are applied.
    """

    def clean(self, text: str, is_sensitive: bool = False) -> str:
        """
        Return cleaned text.  Steps (in order):
          1. Strip irrelevant metadata / markup
          2. Normalise whitespace
          3. Remove duplicate paragraphs
          4. Remove boilerplate filler (skipped for sensitive content)
          5. Final whitespace pass
        """
        if not text:
            return text

        text = self._strip_metadata(text)
        text = self._normalise_whitespace(text)
        text = self._deduplicate_paragraphs(text)

        if not is_sensitive:
            text = self._remove_boilerplate(text)
            text = self._normalise_whitespace(text)  # re-run after removals

        return text.strip()

    def is_sensitive(
        self,
        text: str,
        domains: Optional[List[str]] = None,
    ) -> Tuple[bool, List[str]]:
        """
        Return (is_sensitive, matched_domain_names).

        Checks the text for domain-sensitive keywords.  When *domains* is
        provided only those domains are checked; otherwise all are checked.
        """
        text_lower = text.lower()
        check = domains if domains is not None else list(_SENSITIVE_KW.keys())
        matched: List[str] = []
        for domain in check:
            keywords = _SENSITIVE_KW.get(domain, [])
            if any(kw in text_lower for kw in keywords):
                matched.append(domain)
        return bool(matched), matched

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _strip_metadata(self, text: str) -> str:
        for pattern, replacement in _METADATA:
            text = pattern.sub(replacement, text)
        return text

    def _normalise_whitespace(self, text: str) -> str:
        text = re.sub(r"[ \t]+", " ", text)           # collapse inline whitespace
        text = re.sub(r"[ \t]+\n", "\n", text)        # trailing spaces on lines
        text = re.sub(r"\n{3,}", "\n\n", text)         # cap paragraph gaps at 2
        return text

    def _deduplicate_paragraphs(self, text: str) -> str:
        """Remove exact-duplicate paragraphs (case-insensitive, whitespace-normalised)."""
        paragraphs = re.split(r"\n\n+", text)
        seen: Set[str] = set()
        unique: List[str] = []
        for para in paragraphs:
            stripped = para.strip()
            if not stripped:
                continue
            fingerprint = hashlib.md5(
                re.sub(r"\s+", " ", stripped.lower()).encode()
            ).hexdigest()
            if fingerprint not in seen:
                seen.add(fingerprint)
                unique.append(stripped)
        return "\n\n".join(unique)

    def _remove_boilerplate(self, text: str) -> str:
        for pattern, replacement in _BOILERPLATE:
            text = pattern.sub(replacement, text)
        # Collapse any double spaces introduced by blank substitutions
        text = re.sub(r"  +", " ", text)
        # Remove lines that are now empty
        text = re.sub(r"^\s*\n", "", text, flags=re.M)
        return text
