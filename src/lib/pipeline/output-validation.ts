// Step 9: Output validation — PII in response, confidence scoring,
// citation verification, content safety.

import { detectStructuredPii, redactText } from "@/lib/utils/pii";

export interface ValidationResult {
  text: string;
  piiRedacted: boolean;
  confidence: number;
  citationsVerified: boolean;
}

// 9a. Re-inject original PII values into AI response for "Redact & Send" flow.
// Called DURING streaming, per-chunk — checks accumulated text for placeholders.
// TODO: wire to UI — currently unused; PII confirmation UI doesn't exist yet.
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
// Only SSN and credit cards are auto-redacted — everything else needs user consent.
export function redactOutputPii(
  text: string,
  allowedPiiValues: Set<string>,
): { text: string; redacted: boolean } {
  const tags = detectStructuredPii(text).filter(
    (t) =>
      (t.type === "ssn" || t.type === "credit_card") && !allowedPiiValues.has(t.value),
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

// 9b. Verify citations exist in retrieved context.
// Returns ratio of verified claims (simplified: check if source names appear in chunks).
export function verifyCitations(
  responseText: string,
  retrievedSourceNames: string[],
): number {
  const citationPattern = /\[([^\]]+)\]/g;
  const cited: string[] = [];
  for (const match of responseText.matchAll(citationPattern)) {
    cited.push(match[1].toLowerCase());
  }

  if (cited.length === 0) return 1; // no citations = no unverified claims
  const sourceNamesLower = retrievedSourceNames.map((s) => s.toLowerCase());
  const verified = cited.filter((c) => sourceNamesLower.some((s) => c.includes(s)));
  return verified.length / cited.length;
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
