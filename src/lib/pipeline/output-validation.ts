// Step 9: Output validation — PII in response, confidence scoring,
// citation verification, content safety.

import { detectStructuredPii, redactText } from "@/lib/utils/pii";

export interface ValidationResult {
  text: string;
  piiRedacted: boolean;
  confidence: number;
  citationsVerified: boolean;
}

// Re-inject original PII values into AI response for the "Redact & Send" flow.
// Called per-chunk during streaming when piiMapping is non-empty.
export function reInjectPiiChunk(
  chunk: string,
  accumulated: string,
  piiMapping: Record<string, string>,
): string {
  if (Object.keys(piiMapping).length === 0) return chunk;
  let result = chunk;
  for (const [placeholder, original] of Object.entries(piiMapping)) {
    result = result.replaceAll(placeholder, original);
  }
  return result;
}

// 9a. Auto-redact PII in output that was NOT from user input or retrieved context.
// Covers SSN, credit cards, phone numbers, and email addresses.
// Names and structured business data still require explicit user consent.
const OUTPUT_PII_TYPES = new Set(["ssn", "credit_card", "phone", "email"]);

export function redactOutputPii(
  text: string,
  allowedPiiValues: Set<string>,
): { text: string; redacted: boolean } {
  const tags = detectStructuredPii(text).filter(
    (t) => OUTPUT_PII_TYPES.has(t.type) && !allowedPiiValues.has(t.value),
  );
  if (tags.length === 0) return { text, redacted: false };
  const { redacted } = redactText(text, tags);
  return { text: redacted, redacted: true };
}

// 9d. Confidence scoring based on retrieval quality, claims verified, query ambiguity.
export function scoreConfidence(opts: {
  retrievalQualityAvg: number;
  claimsVerifiedRatio: number;
  queryAmbiguity: number; // 0=clear, 1=very ambiguous
  modelCapability: number; // 0.0–1.0 from model registry
}): number {
  return (
    0.4 * opts.retrievalQualityAvg +
    0.3 * opts.claimsVerifiedRatio +
    0.2 * (1 - opts.queryAmbiguity) +
    0.1 * opts.modelCapability
  );
}

// 9b. Verify citations are grounded in the retrieved context.
// A citation [Foo] is "verified" only when:
//   1. The bracket label contains a known source name as a substring, AND
//   2. The 80 chars of text immediately preceding the bracket share ≥3
//      non-stopword tokens with the cited source's content.
// Caller passes an array of {name, content} so we can do the overlap check;
// the legacy string[] form is kept for backward compatibility (loose match only).
const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","at","for","with","by","is",
  "are","was","were","be","been","this","that","it","its","as","from","but",
  "if","then","so","not","no",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
}

export function verifyCitations(
  responseText: string,
  retrievedSources: string[] | { name: string; content: string }[],
): number {
  const sources =
    retrievedSources.length > 0 && typeof retrievedSources[0] === "string"
      ? (retrievedSources as string[]).map((s) => ({ name: s, content: "" }))
      : (retrievedSources as { name: string; content: string }[]);

  const sourceNamesLower = sources.map((s) => s.name.toLowerCase());
  const sourceTokens = sources.map((s) => new Set(tokenize(s.content ?? "")));

  const citationRe = /\[([^\]]+)\]/g;
  const matches = [...responseText.matchAll(citationRe)];
  if (matches.length === 0) return 0; // no citations in a sourced response = 0 verified

  let verified = 0;
  for (const m of matches) {
    const label = m[1].toLowerCase();
    const sourceIdx = sourceNamesLower.findIndex((s) => label.includes(s));
    if (sourceIdx === -1) continue;

    const ctx = responseText.slice(Math.max(0, m.index! - 80), m.index!);
    const ctxTokens = new Set(tokenize(ctx));
    const target = sourceTokens[sourceIdx];

    // If we don't have source content (legacy callers), accept name-only match.
    if (target.size === 0) {
      verified++;
      continue;
    }
    let overlap = 0;
    for (const t of ctxTokens) if (target.has(t)) overlap++;
    if (overlap >= 3) verified++;
  }
  return verified / matches.length;
}

// 9e. Basic content safety check (pattern-based for Phase 1)
export function isSafeContent(text: string): boolean {
  const unsafePatterns = [
    /(?:how to|instructions? for) (?:make|build|create) (?:a )?(bomb|weapon|explosive)/i,
    /(?:synthesiz|manufactur|produc)e? (?:methamphetamine|fentanyl|heroin|cocaine)/i,
  ];
  return !unsafePatterns.some((p) => p.test(text));
}

// Estimate query ambiguity (0=clear, 1=very ambiguous)
export function scoreAmbiguity(query: string): number {
  let score = 0;
  const lower = query.toLowerCase();
  if (/\b(it|this|that|they|them|those)\b/.test(lower)) score += 0.2; // unresolved pronouns
  if (/\bor\b/.test(lower)) score += 0.15; // alternatives
  if (query.split(" ").length < 4) score += 0.15; // very short
  if (/\bsomething|anything|whatever\b/.test(lower)) score += 0.2;
  return Math.min(1, score);
}
