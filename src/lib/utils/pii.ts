// PII detection and handling for Cortex.
//
// Detection: regex for structured PII (SSN, CC, phone, email, zip) +
// LLM-based name detection (GPT-4o-mini, <200ms, <$0.001/call).
//
// Key rule from spec: PII is NEVER silently redacted on INPUT.
// The ONLY auto-redaction is on OUTPUT (hallucinated/leaked PII from model).

export type PiiType =
  | "ssn"
  | "credit_card"
  | "email"
  | "phone"
  | "name"
  | "address"
  | "zip";

export type PiiPreference = "always_ask" | "always_redact" | "always_send";

export type PiiPreferences = Record<PiiType, PiiPreference>;

export const DEFAULT_PII_PREFERENCES: PiiPreferences = {
  name: "always_ask",
  email: "always_ask",
  phone: "always_ask",
  address: "always_ask",
  zip: "always_ask",
  ssn: "always_redact",
  credit_card: "always_redact",
};

export interface PiiTag {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  placeholder: string; // e.g. [EMAIL_1]
}

// Structured PII patterns (regex-based)
const PATTERNS: { type: PiiType; regex: RegExp }[] = [
  { type: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    type: "credit_card",
    regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  },
  {
    type: "email",
    regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
  },
  {
    type: "phone",
    regex: /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g,
  },
  {
    type: "zip",
    regex: /\b\d{5}(?:-\d{4})?\b/g,
  },
];

export function detectStructuredPii(text: string): PiiTag[] {
  const tags: PiiTag[] = [];
  const counters: Partial<Record<PiiType, number>> = {};

  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const n = (counters[type] = (counters[type] ?? 0) + 1);
      tags.push({
        type,
        value: match[0],
        start: match.index!,
        end: match.index! + match[0].length,
        placeholder: `[${type.toUpperCase()}_${n}]`,
      });
    }
  }

  return tags;
}

// LLM-based name detection (GPT-4o-mini)
export async function detectNames(text: string): Promise<PiiTag[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || text.length < 3) return [];

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 256,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Extract all person names from the following text. Return a JSON array of {"name": string, "start": number, "end": number}. Use character offsets. If none, return [].
Text: ${JSON.stringify(text)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const raw = json.choices[0]?.message?.content?.trim() ?? "[]";
    const parsed = JSON.parse(raw) as { name: string; start: number; end: number }[];

    let counter = 0;
    return parsed.map((p) => ({
      type: "name" as PiiType,
      value: p.name,
      start: p.start,
      end: p.end,
      placeholder: `[NAME_${++counter}]`,
    }));
  } catch {
    return [];
  }
}

// Apply preferences: split tags into auto-redact, auto-send, and needs-confirm groups
export function applyPreferences(
  tags: PiiTag[],
  prefs: Partial<PiiPreferences>,
): {
  autoRedact: PiiTag[];
  autoSend: PiiTag[];
  needsConfirm: PiiTag[];
} {
  const merged = { ...DEFAULT_PII_PREFERENCES, ...prefs };
  const autoRedact: PiiTag[] = [];
  const autoSend: PiiTag[] = [];
  const needsConfirm: PiiTag[] = [];

  for (const tag of tags) {
    const pref = merged[tag.type] ?? "always_ask";
    if (pref === "always_redact") autoRedact.push(tag);
    else if (pref === "always_send") autoSend.push(tag);
    else needsConfirm.push(tag);
  }

  return { autoRedact, autoSend, needsConfirm };
}

// Apply redactions: replace PII values with placeholders, return mapping for re-injection
export function redactText(
  text: string,
  tagsToRedact: PiiTag[],
): { redacted: string; mapping: Record<string, string> } {
  // Sort by start position descending so we replace from end to preserve offsets
  const sorted = [...tagsToRedact].sort((a, b) => b.start - a.start);
  let result = text;
  const mapping: Record<string, string> = {};

  for (const tag of sorted) {
    result = result.slice(0, tag.start) + tag.placeholder + result.slice(tag.end);
    mapping[tag.placeholder] = tag.value;
  }

  return { redacted: result, mapping };
}

// Re-inject original values into AI response (for "Redact & Send" flow)
export function reInjectPii(text: string, mapping: Record<string, string>): string {
  let result = text;
  for (const [placeholder, value] of Object.entries(mapping)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

// Detect PII in output that was not from user input or retrieved context (hallucinated).
// Returns redacted text and a flag indicating if anything was removed.
export function redactOutputPii(
  text: string,
  allowedValues: Set<string>,
): { text: string; redacted: boolean } {
  const structuredTags = detectStructuredPii(text);
  const toRedact = structuredTags.filter(
    (t) => !allowedValues.has(t.value) && (t.type === "ssn" || t.type === "credit_card"),
  );

  if (toRedact.length === 0) return { text, redacted: false };

  const { redacted } = redactText(text, toRedact);
  return { text: redacted, redacted: true };
}
