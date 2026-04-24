"""Prompt normalisation: compact phrasing + task-type detection + entity extraction."""
from __future__ import annotations

import re
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Entity extraction patterns
# ---------------------------------------------------------------------------
_DATE_PATTERNS: List[re.Pattern] = [
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),                                              # ISO 8601
    re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b"),                                        # US/EU numeric
    re.compile(r"\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b", re.I),
    re.compile(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b", re.I),
    re.compile(r"\b(?:today|tomorrow|yesterday|this week|last week|next week|"
               r"this month|last month|next month|this year|last year|next year)\b", re.I),
    re.compile(r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b", re.I),
    re.compile(r"\bQ[1-4]\s*\d{4}\b", re.I),
    re.compile(r"\b\d{4}\b"),                                                           # bare year (4 digits)
]

_NUMBER_PATTERNS: List[re.Pattern] = [
    re.compile(r"\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b"),           # comma-grouped numbers
    re.compile(r"\b\d+(?:\.\d+)?%"),                             # percentages
    re.compile(r"\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[KMBkmb])?\b"),  # dollar amounts
    re.compile(r"€\s*\d+(?:,\d{3})*(?:\.\d+)?\b"),             # euro amounts
    re.compile(r"\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|PB)\b", re.I),
    re.compile(r"\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?)\b", re.I),
    re.compile(r"\b\d+(?:\.\d+)?\s*(?:tokens?|words?|characters?|lines?|pages?)\b", re.I),
]

_CONSTRAINT_KW = [
    "must not", "must", "shall not", "shall", "should not", "should",
    "cannot", "can not", "do not", "don't", "required to", "mandatory",
    "at most", "at least", "no more than", "no less than", "exactly",
    "within", "not before", "not after", "between", "maximum", "minimum",
    "limit to", "restrict to", "exclude", "include only", "only if",
    "unless", "provided that", "on the condition",
]

_FORMAT_KW = [
    "json", "xml", "yaml", "csv", "tsv", "markdown", "html", "plain text",
    "as a table", "in a table", "as a list", "as a bullet", "as numbered",
    "code block", "python", "javascript", "typescript", "bash", "sql",
    "format as", "output as", "return as", "respond with", "structured",
]

# ---------------------------------------------------------------------------
# Verbose → concise phrase replacements (order matters — longest first)
# ---------------------------------------------------------------------------
_VERBOSE_PHRASES: List[tuple] = [
    (re.compile(r"\bdue to the fact that\b", re.I), "because"),
    (re.compile(r"\bin order to\b", re.I), "to"),
    (re.compile(r"\bfor the purpose of\b", re.I), "to"),
    (re.compile(r"\bwith (regard|reference) to\b", re.I), "regarding"),
    (re.compile(r"\bwith respect to\b", re.I), "regarding"),
    (re.compile(r"\bprior to\b", re.I), "before"),
    (re.compile(r"\bsubsequent to\b", re.I), "after"),
    (re.compile(r"\bin the event (that|of)\b", re.I), "if"),
    (re.compile(r"\bin spite of the fact that\b", re.I), "although"),
    (re.compile(r"\bnotwithstanding the fact that\b", re.I), "although"),
    (re.compile(r"\bhas the ability to\b", re.I), "can"),
    (re.compile(r"\bis (capable of|able to)\b", re.I), "can"),
    (re.compile(r"\bat this (point in time|juncture)\b", re.I), "now"),
    (re.compile(r"\bin the (near|foreseeable) future\b", re.I), "soon"),
    (re.compile(r"\ba (large|great) number of\b", re.I), "many"),
    (re.compile(r"\bthe (vast )?majority of\b", re.I), "most"),
    (re.compile(r"\ba (small|limited) number of\b", re.I), "few"),
    (re.compile(r"\bmake (a|an) (decision|attempt|effort)\b", re.I), lambda m: {"decision": "decide", "attempt": "try", "effort": "try"}[m.group(2).lower()]),
    (re.compile(r"\bgive (consideration|thought) to\b", re.I), "consider"),
    (re.compile(r"\bcome to (the )?conclusion\b", re.I), "conclude"),
    (re.compile(r"\bprovide (an )?explanation (of|for)\b", re.I), "explain"),
    (re.compile(r"\bcarry out (a|an|the)\b", re.I), "perform"),
    (re.compile(r"\btake into (account|consideration)\b", re.I), "consider"),
    (re.compile(r"\bwith the exception of\b", re.I), "except"),
    (re.compile(r"\bin (addition|addition to this)[,.]?\b", re.I), "also"),
    (re.compile(r"\bfurthermore[,.]?\b", re.I), "also"),
    (re.compile(r"\bmoreover[,.]?\b", re.I), "also"),
    (re.compile(r"\bhowever[,.]?\b", re.I), "but"),
    (re.compile(r"\bnevertheless[,.]?\b", re.I), "still"),
]

# Task-type keyword maps: (task_type_string, [trigger_phrases])
_TASK_HINTS = [
    ("classification", ["classify ", "categorize ", "label this", "which category", "is this a ", "identify the type of", "sort into"]),
    ("extraction",     ["extract ", "identify all ", "find all ", "list all the ", "what are the ", "pull out", "retrieve all"]),
    ("summarization",  ["summarize", "summary", "tl;dr", "tldr", "brief overview", "condense", "shorten this", "give me the gist"]),
    ("coding",         ["debug ", "fix the bug", "implement ", "write code", "write a function", "refactor ", "explain this code", "code review"]),
    ("reasoning",      ["analyze ", "analyse ", "reason about", "why does", "explain why", "what causes", "derive ", "prove ", "evaluate "]),
    ("generation",     ["write ", "create ", "generate ", "draft ", "compose ", "produce ", "design a "]),
]


class PromptNormalizer:
    """
    Normalises prompts into a compact structured form.

    - Replaces verbose multi-word phrases with concise equivalents.
    - Preserves all entities: numbers, dates, constraints, format requirements.
    - Never modifies sensitive domain text (caller must check sensitivity first).
    - Short texts (< 60 chars) are returned unchanged.
    """

    def normalize(self, text: str) -> str:
        """Return normalised text with verbose phrases replaced by concise equivalents."""
        if not text or len(text) < 60:
            return text
        text = self._replace_verbose(text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def extract_task_type_hint(self, text: str) -> Optional[str]:
        """
        Return a TaskType string inferred from trigger phrases in *text*,
        or None if no confident match is found.

        Checked in priority order: more specific task types first.
        """
        lower = text.lower()
        for task_type, phrases in _TASK_HINTS:
            if any(p in lower for p in phrases):
                return task_type
        return None

    def extract_critical_details(self, text: str) -> Dict[str, List[str]]:
        """
        Extract and return all task-critical entities found in *text*.

        Keys: dates, numbers, constraints, format_hints
        """
        return {
            "dates": self._extract_dates(text),
            "numbers": self._extract_numbers(text),
            "constraints": self._extract_constraints(text),
            "format_hints": self._extract_format_hints(text),
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _replace_verbose(self, text: str) -> str:
        for pattern, replacement in _VERBOSE_PHRASES:
            if callable(replacement):
                text = pattern.sub(replacement, text)
            else:
                text = pattern.sub(replacement, text)
        return text

    def _extract_dates(self, text: str) -> List[str]:
        found: List[str] = []
        for pat in _DATE_PATTERNS:
            found.extend(pat.findall(text))
        # Deduplicate while preserving order
        return list(dict.fromkeys(found))

    def _extract_numbers(self, text: str) -> List[str]:
        found: List[str] = []
        for pat in _NUMBER_PATTERNS:
            found.extend(pat.findall(text))
        return list(dict.fromkeys(found))

    def _extract_constraints(self, text: str) -> List[str]:
        lower = text.lower()
        return [kw for kw in _CONSTRAINT_KW if kw in lower]

    def _extract_format_hints(self, text: str) -> List[str]:
        lower = text.lower()
        return [kw for kw in _FORMAT_KW if kw in lower]
