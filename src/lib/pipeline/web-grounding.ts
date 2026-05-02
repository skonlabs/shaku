// Web grounding heuristic: decides whether the model should be given a
// web-search tool for the current turn. We err on the side of enabling it
// for any question that smells like it references a real-world entity,
// recent event, or factual lookup — matching ChatGPT/Claude consumer apps.
//
// Native provider tools (Anthropic web_search_20250305, OpenAI web_search_preview)
// are smart enough to skip the search if they don't need it, so a permissive
// heuristic costs little and dramatically improves answer quality for
// non-famous people, niche companies, and recent events.

import type { Intent } from "@/lib/llm/types";

const RECENCY_WORDS = [
  "today", "yesterday", "tonight", "this week", "this month", "this year",
  "latest", "recent", "recently", "current", "currently", "now", "right now",
  "news", "update", "updated", "breaking", "just announced", "just released",
  "2024", "2025", "2026",
];

const ENTITY_TRIGGERS = [
  "who is", "who's", "who was", "who are",
  "what is", "what's", "what was", "what are",
  "where is", "where's",
  "when did", "when was", "when is",
  "tell me about", "info on", "information on", "background on",
  "look up", "search for", "find out", "find me",
  "linkedin", "twitter", "instagram", "tiktok", "youtube", "github",
  "ceo of", "founder of", "founded by", "owner of",
  "stock price", "market cap", "valuation",
  "weather", "score", "results", "winner",
];

// Heuristic: a contiguous run of capitalized words anywhere except sentence
// start is a strong proper-noun signal (people, companies, products).
function hasProperNoun(text: string): boolean {
  // Skip the first word (often capitalized just because it starts a sentence).
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^\p{L}'-]/gu, "");
    if (w.length >= 2 && /^[A-Z]/.test(w) && !/^(I|I'm|I've|I'd|I'll)$/.test(w)) {
      return true;
    }
  }
  return false;
}

const SKIP_INTENTS: Intent[] = ["acknowledgment", "casual_chat", "creative", "action"];

export interface GroundingDecision {
  enabled: boolean;
  reason: string;
}

export function shouldGroundWithWeb(query: string, intent: Intent): GroundingDecision {
  if (SKIP_INTENTS.includes(intent)) {
    return { enabled: false, reason: `intent=${intent}` };
  }
  if (!query || query.trim().length < 3) {
    return { enabled: false, reason: "query too short" };
  }

  const lower = query.toLowerCase();

  for (const word of RECENCY_WORDS) {
    if (lower.includes(word)) return { enabled: true, reason: `recency:${word}` };
  }
  for (const trigger of ENTITY_TRIGGERS) {
    if (lower.includes(trigger)) return { enabled: true, reason: `entity:${trigger}` };
  }
  if (hasProperNoun(query)) {
    return { enabled: true, reason: "proper-noun" };
  }
  // Question-shaped queries default to grounded — cheap insurance against
  // hallucination. Provider tool will skip the search if it isn't needed.
  if (/\?\s*$/.test(query.trim()) && (intent === "question" || intent === "search" || intent === "analysis")) {
    return { enabled: true, reason: "question-mark" };
  }
  return { enabled: false, reason: "no-trigger" };
}

// Sanitize query before it leaves to a search provider. Strip obvious PII
// patterns (emails, phone numbers, long digit runs that look like IDs) so
// private identifiers never reach Bing/Brave/etc. The model still has full
// access to the original query — only the tool call payload is sanitized.
export function sanitizeForSearch(query: string): string {
  return query
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/\b\d{9,}\b/g, "[id]")
    .trim();
}
