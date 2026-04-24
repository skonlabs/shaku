/**
 * PromptNormalizer — replaces verbose phrases with concise equivalents
 * and extracts task-critical entities.
 *
 * Short texts (< 60 chars) are returned unchanged.
 * Sensitive-domain text must NOT be passed here — the caller is responsible
 * for the sensitivity check before calling normalize().
 */
import type { TaskType } from "./types";

// ---------------------------------------------------------------------------
// Verbose → concise phrase map (longest phrases first to avoid partial matches)
// ---------------------------------------------------------------------------
const VERBOSE_PHRASES: Array<[RegExp, string]> = [
  [/\bdue to the fact that\b/gi, "because"],
  [/\bin order to\b/gi, "to"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bwith (?:regard|reference) to\b/gi, "regarding"],
  [/\bwith respect to\b/gi, "regarding"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bin the event (?:that|of)\b/gi, "if"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bnotwithstanding the fact that\b/gi, "although"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bis (?:capable of|able to)\b/gi, "can"],
  [/\bat this (?:point in time|juncture)\b/gi, "now"],
  [/\bin the (?:near|foreseeable) future\b/gi, "soon"],
  [/\ba (?:large|great) number of\b/gi, "many"],
  [/\bthe (?:vast )?majority of\b/gi, "most"],
  [/\ba (?:small|limited) number of\b/gi, "few"],
  [/\bgive (?:consideration|thought) to\b/gi, "consider"],
  [/\bcome to (?:the )?conclusion\b/gi, "conclude"],
  [/\bprovide (?:an )?explanation (?:of|for)\b/gi, "explain"],
  [/\bcarry out (?:a|an|the)\b/gi, "perform"],
  [/\btake into (?:account|consideration)\b/gi, "consider"],
  [/\bwith the exception of\b/gi, "except"],
  [/\bin (?:addition|addition to this)[,.]?\b/gi, "also"],
  [/\bfurthermore[,.]?\b/gi, "also"],
  [/\bmoreover[,.]?\b/gi, "also"],
  [/\bnevertheless[,.]?\b/gi, "still"],
];

// ---------------------------------------------------------------------------
// Entity extraction patterns
// ---------------------------------------------------------------------------
const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b(?:today|tomorrow|yesterday|this week|last week|next week|this month|last month|next month|this year|last year|next year)\b/gi,
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi,
  /\bQ[1-4]\s*\d{4}\b/gi,
];

const NUMBER_PATTERNS: RegExp[] = [
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
  /\b\d+(?:\.\d+)?%/g,
  /\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[KMBkmb])?\b/g,
  /€\s*\d+(?:,\d{3})*(?:\.\d+)?\b/g,
  /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|PB)\b/gi,
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?)\b/gi,
  /\b\d+(?:\.\d+)?\s*(?:tokens?|words?|characters?|lines?|pages?)\b/gi,
];

const CONSTRAINT_KW = [
  "must not", "must", "shall not", "shall", "should not", "should",
  "cannot", "can not", "do not", "don't", "required to", "mandatory",
  "at most", "at least", "no more than", "no less than", "exactly",
  "within", "not before", "not after", "between", "maximum", "minimum",
  "limit to", "restrict to", "exclude", "include only", "only if",
  "unless", "provided that",
];

const FORMAT_KW = [
  "json", "xml", "yaml", "csv", "tsv", "markdown", "html", "plain text",
  "as a table", "in a table", "as a list", "as a bullet", "as numbered",
  "code block", "python", "javascript", "typescript", "bash", "sql",
  "format as", "output as", "return as", "respond with", "structured",
];

// Task-type detection: [taskType, triggerPhrases]
const TASK_HINTS: Array<[TaskType, string[]]> = [
  ["classification", ["classify ", "categorize ", "label this", "which category", "is this a ", "identify the type of", "sort into"]],
  ["extraction",     ["extract ", "identify all ", "find all ", "list all the ", "what are the ", "pull out", "retrieve all"]],
  ["summarization",  ["summarize", "summary", "tl;dr", "tldr", "brief overview", "condense", "shorten this", "give me the gist"]],
  ["coding",         ["debug ", "fix the bug", "implement ", "write code", "write a function", "refactor ", "explain this code", "code review"]],
  ["reasoning",      ["analyze ", "analyse ", "reason about", "why does", "explain why", "what causes", "derive ", "prove ", "evaluate "]],
  ["generation",     ["write ", "create ", "generate ", "draft ", "compose ", "produce ", "design a "]],
];

export interface CriticalDetails {
  dates: string[];
  numbers: string[];
  constraints: string[];
  formatHints: string[];
}

export class PromptNormalizer {
  /** Replace verbose phrases with concise equivalents. Short texts unchanged. */
  normalize(text: string): string {
    if (!text || text.length < 60) return text;

    for (const [pattern, replacement] of VERBOSE_PHRASES) {
      text = text.replace(pattern, replacement);
    }

    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Infer task type from trigger phrases; returns undefined if no match. */
  extractTaskTypeHint(text: string): TaskType | undefined {
    const lower = text.toLowerCase();
    for (const [taskType, phrases] of TASK_HINTS) {
      if (phrases.some((p) => lower.includes(p))) return taskType;
    }
    return undefined;
  }

  /** Extract task-critical entities (dates, numbers, constraints, format hints). */
  extractCriticalDetails(text: string): CriticalDetails {
    return {
      dates:        this.extractMatches(text, DATE_PATTERNS),
      numbers:      this.extractMatches(text, NUMBER_PATTERNS),
      constraints:  CONSTRAINT_KW.filter((kw) => text.toLowerCase().includes(kw)),
      formatHints:  FORMAT_KW.filter((kw) => text.toLowerCase().includes(kw)),
    };
  }

  private extractMatches(text: string, patterns: RegExp[]): string[] {
    const found: string[] = [];
    for (const pattern of patterns) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) found.push(...matches);
    }
    // Deduplicate while preserving order
    return [...new Map(found.map((v) => [v, v])).values()];
  }
}
