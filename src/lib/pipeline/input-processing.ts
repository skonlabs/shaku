// Step 3: Input processing — runs all sub-steps in parallel.
//
// Fixes spec ordering issue: PII detection must happen BEFORE saving the message.
// Pipeline callers should:
//   1. Run processInput()
//   2. If piiResult.needsConfirm.length > 0 → pause, show confirmation UI
//   3. Get user decision → call applyPiiDecision()
//   4. Save the decided content to DB
//   5. Continue pipeline with processed content

import { detectStructuredPii, detectNames, applyPreferences } from "@/lib/utils/pii";
import type { PiiTag, PiiPreferences } from "@/lib/utils/pii";
import type { Intent, IntentResult } from "@/lib/llm/types";

export interface InputProcessingResult {
  intent: IntentResult;
  piiTags: PiiTag[];
  piiNeedsConfirm: PiiTag[];
  piiAutoRedact: PiiTag[];
  piiAutoSend: PiiTag[];
  adversarialScore: number;
  urlsDetected: string[];
  isAcknowledgment: boolean;
}

// Jailbreak / prompt injection patterns
const ADVERSARIAL_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:DAN|jailbroken|unrestricted)/i,
  /pretend\s+you\s+(?:have\s+no\s+)?(?:restrictions|guidelines|rules)/i,
  /act\s+as\s+if\s+you\s+(?:were\s+)?trained\s+(?:differently|without)/i,
  /system\s*:\s*(?:you\s+are|ignore|override)/i,
  /<\s*(?:system|instructions?)\s*>/i,
];

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

export async function processInput(
  text: string,
  piiPreferences: Partial<PiiPreferences>,
): Promise<InputProcessingResult> {
  // Run all sub-steps in parallel
  const [structuredPii, names, intentResult] = await Promise.all([
    Promise.resolve(detectStructuredPii(text)),
    detectNames(text),
    classifyIntent(text),
  ]);

  const allPiiTags = deduplicateTags([...structuredPii, ...names]);
  const { autoRedact, autoSend, needsConfirm } = applyPreferences(allPiiTags, piiPreferences);

  const adversarialScore = scoreAdversarial(text);
  const urlsDetected = [...text.matchAll(URL_REGEX)].map((m) => m[0]);

  return {
    intent: intentResult,
    piiTags: allPiiTags,
    piiNeedsConfirm: needsConfirm,
    piiAutoRedact: autoRedact,
    piiAutoSend: autoSend,
    adversarialScore,
    urlsDetected,
    isAcknowledgment: intentResult.intent === "acknowledgment" && intentResult.confidence > 0.9,
  };
}

async function classifyIntent(text: string): Promise<IntentResult> {
  const complexity = scoreComplexity(text);
  const isAck = isAcknowledgment(text);

  if (isAck) {
    return {
      intent: "acknowledgment",
      confidence: 0.95,
      isFollowUp: false,
      followUpReference: null,
      complexity: 0.0,
      domain: "general",
    };
  }

  // Use GPT-4o-mini for intent classification
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return fallbackClassify(text, complexity);
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 128,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Classify this message. Return JSON only: {"intent":"question"|"creative"|"action"|"search"|"analysis"|"casual_chat"|"multi_part"|"follow_up"|"acknowledgment","confidence":0.0-1.0,"is_follow_up":true|false,"follow_up_reference":string|null,"domain":"general"|"code"|"analysis"|"creative"|"reasoning"}
Message: ${JSON.stringify(text.slice(0, 500))}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) throw new Error("classify failed");
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(json.choices[0].message.content.trim());

    return {
      intent: (parsed.intent as Intent) ?? "question",
      confidence: parsed.confidence ?? 0.7,
      isFollowUp: parsed.is_follow_up ?? false,
      followUpReference: parsed.follow_up_reference ?? null,
      complexity,
      domain: parsed.domain ?? "general",
    };
  } catch {
    return fallbackClassify(text, complexity);
  }
}

function fallbackClassify(text: string, complexity: number): IntentResult {
  const lower = text.toLowerCase();
  let intent: Intent = "question";
  if (/\b(create|send|schedule|add|post|set|book|remind)\b/.test(lower)) intent = "action";
  else if (/\b(write|draft|generate|compose|create)\b/.test(lower)) intent = "creative";
  else if (/\b(analyze|compare|contrast|explain|why|how)\b/.test(lower)) intent = "analysis";
  else if (/\b(find|search|look up|show me)\b/.test(lower)) intent = "search";
  else if (lower.length < 20 && !/\?/.test(lower)) intent = "casual_chat";

  return {
    intent,
    confidence: 0.6,
    isFollowUp: /^(also|and|but|what about|how about|follow.?up|continuing)/i.test(text),
    followUpReference: null,
    complexity,
    domain: "general",
  };
}

function scoreComplexity(text: string): number {
  let score = 0;
  const words = text.split(/\s+/).length;

  score += Math.min(0.3, words / 100);
  score += (text.match(/\?/g)?.length ?? 0) * 0.05;
  score += /\b(compare|analyze|contrast|synthesize|evaluate)\b/i.test(text) ? 0.2 : 0;
  score += /\b(why|explain|reason|impact|implication)\b/i.test(text) ? 0.15 : 0;
  score += (text.match(/\band\b/gi)?.length ?? 0) > 3 ? 0.1 : 0; // multiple sub-questions

  return Math.min(1.0, score);
}

function scoreAdversarial(text: string): number {
  let score = 0;
  for (const pattern of ADVERSARIAL_PATTERNS) {
    if (pattern.test(text)) score += 0.3;
  }
  // Prompt injection heuristic: XML-like system tags
  if (/<\s*(system|assistant|user)\s*>/i.test(text)) score += 0.4;
  return Math.min(1.0, score);
}

const ACK_PATTERNS = new Set([
  "thanks", "thank you", "ty", "thx", "ok", "okay", "got it", "perfect",
  "great", "cool", "nice", "awesome", "sounds good", "👍", "👌",
  "ok thanks", "got it thanks", "appreciate it", "understood", "noted",
]);

function isAcknowledgment(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[!.?,]+$/g, "");
  if (normalized.length > 30) return false;
  return ACK_PATTERNS.has(normalized);
}

function deduplicateTags(tags: PiiTag[]): PiiTag[] {
  // Remove overlapping tags (keep the first/longer match)
  const sorted = tags.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PiiTag[] = [];
  let lastEnd = -1;
  for (const tag of sorted) {
    if (tag.start >= lastEnd) {
      result.push(tag);
      lastEnd = tag.end;
    }
  }
  return result;
}
