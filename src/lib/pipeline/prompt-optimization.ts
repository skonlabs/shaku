// Step 7: Prompt optimization — query rewriting, instruction injection,
// format guidance, safety framing, chart and follow-up instructions.

import type { Intent, IntentResult } from "@/lib/llm/types";

export interface PromptOptimizationResult {
  rewrittenQuery: string;
  systemAdditions: string;
}

// 7a. Query rewriting for clarity
export async function rewriteQuery(
  originalQuery: string,
  intent: IntentResult,
  followUpContext?: string,
): Promise<string> {
  if (intent.intent === "acknowledgment" || intent.intent === "casual_chat") {
    return originalQuery;
  }
  if (originalQuery.length < 20) return originalQuery;

  const key = process.env.OPENAI_API_KEY;
  if (!key) return originalQuery;

  try {
    const contextHint = followUpContext
      ? `\nConversation context: ${followUpContext.slice(0, 200)}`
      : "";

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Rewrite this query to be more specific and searchable. Do NOT change what is being asked — only add specificity. Return ONLY the rewritten query, nothing else.${contextHint}
Original: ${originalQuery}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) return originalQuery;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const rewritten = json.choices[0]?.message?.content?.trim();
    return rewritten || originalQuery;
  } catch {
    return originalQuery;
  }
}

// 7b–7f. Build system prompt additions based on intent
export function buildSystemAdditions(
  intent: Intent,
  styleProfile: Record<string, string>,
  conversationTone: string,
  isFollowUp: boolean,
  followUpReference?: string,
  hasSources = false,
): string {
  const parts: string[] = [];

  // Citation instruction — only when sources are actually present in context
  if (hasSources && (intent === "question" || intent === "search" || intent === "analysis")) {
    parts.push(
      "Cite relevant sources inline using [Source Name] where <source name> matches the name attribute in the <source> tags.",
    );
  }

  // Follow-up handling
  if (isFollowUp && followUpReference) {
    parts.push(
      `This is a follow-up to: "${followUpReference.slice(0, 100)}". Go deeper on this specific aspect.`,
    );
  }

  // Style profile injection
  if (styleProfile.verbosity) parts.push(`Verbosity: ${styleProfile.verbosity}.`);
  if (styleProfile.format_preference) parts.push(`Format: ${styleProfile.format_preference}.`);

  // Tone adaptation
  const toneInstructions = TONE_INSTRUCTIONS[conversationTone];
  if (toneInstructions) parts.push(toneInstructions);

  // Follow-up questions — only for substantive information intents, kept brief.
  // IMPORTANT: <followups> must only appear AFTER you have written your actual
  // answer. Never emit <followups> as a substitute for an answer, and never
  // emit it without preceding content. Omit entirely for short replies.
  if (intent === "question" || intent === "search" || intent === "analysis") {
    parts.push(
      'After writing your answer, you may append 2-3 short follow-up questions inside <followups>["q1","q2"]</followups>. The <followups> block must always come after your answer, never before it and never instead of it.',
    );
  }

  return parts.join("\n");
}

const INTENT_INSTRUCTIONS: Partial<Record<Intent, string>> = {};

const TONE_INSTRUCTIONS: Record<string, string> = {
  casual: "Be warm and conversational. Small talk is fine.",
  focused: "Be direct. Lead with the answer. No filler phrases.",
  frustrated:
    "Acknowledge any difficulty. Be extra precise. Offer to try a different approach if needed.",
  urgent: "Lead with the key information immediately. Skip all preamble.",
  exploratory: "Provide extra detail and context. Suggest related topics.",
};

// XML wrappers for structured context injection — used by context-assembly.ts
export function wrapUserMessage(content: string): string {
  return `<user_message>${content}</user_message>`;
}

export function wrapSource(name: string, type: string, content: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<source name="${esc(name)}" type="${esc(type)}">${content}</source>`;
}

export function wrapMemory(type: string, content: string): string {
  return `<memory type="${type}">${content}</memory>`;
}

// 7c. Output format guidance based on query patterns
export function detectFormatHint(query: string): string | null {
  const q = query.toLowerCase();
  if (/^list\b/.test(q) || /\blist (the|all|every)\b/.test(q)) return "Present as a bulleted list.";
  if (/\bcompare\b/.test(q)) return "Present as a comparison table.";
  if (/\bhow (much|many)\b/.test(q)) return "Lead with the number, then provide context.";
  if (/\bsummariz(e|ation)\b/.test(q)) return "Use structured sections with headers.";
  if (/\bstep.?by.?step\b/.test(q)) return "Use numbered steps.";
  return null;
}
