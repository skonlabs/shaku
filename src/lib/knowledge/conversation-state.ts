// Conversation state management — summary generation, fact extraction,
// tone tracking. Runs async after each exchange.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ToneState {
  current: "casual" | "focused" | "frustrated" | "urgent" | "exploratory";
  confidence: number;
  signals: string[];
}

// Extract new facts from the AI response (called post-exchange)
export async function extractConversationFacts(
  userMessage: string,
  assistantReply: string,
  existingFacts?: string[],
): Promise<string[]> {
  const existingHint =
    existingFacts?.length
      ? `\nAlready known facts (do NOT repeat these): ${existingFacts.slice(-10).join("; ")}`
      : "";
  const prompt = `Extract NEW factual statements about the user from this exchange that are not already known.${existingHint}
User: ${userMessage.slice(0, 800)}
Assistant: ${assistantReply.slice(0, 800)}
Return a JSON array of strings. Return [] if nothing new.`;

  // Try Anthropic first
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = (await res.json()) as { content: { type: string; text: string }[] };
        const text = json.content.find((b) => b.type === "text")?.text?.trim() ?? "[]";
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[];
          return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback to OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return [];

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const raw = json.choices[0]?.message?.content?.trim() ?? "[]";
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as string[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

// Detect conversation tone from user messages.
// To avoid spuriously flipping tone on a single matched word, require:
//   - "frustrated"/"urgent" classifications need ≥2 distinct signal hits OR a
//     long enough message (>200 chars) where one strong signal is reliable.
//   - Otherwise tone falls through to previous/casual.
export function detectTone(
  messages: { role: string; content: string }[],
  previousTone: ToneState,
): ToneState {
  const recentUserMsgs = messages.filter((m) => m.role === "user").slice(-5);
  const recentUser = recentUserMsgs.map((m) => m.content).join(" ");
  const longEnough = recentUser.length > 200;

  // Count distinct signal hits per tone
  const signalsFor = (patterns: RegExp[]): number =>
    patterns.reduce((n, re) => n + (re.test(recentUser) ? 1 : 0), 0);

  const urgentPatterns = [
    /\burgent\b/i, /\basap\b/i, /\bimmediately\b/i, /\bright now\b/i,
    /\bemergency\b/i, /\bdeadline\b/i,
  ];
  const frustratedPatterns = [
    /\bdoesn't make sense\b/i, /\bthis is useless\b/i, /\btry again\b/i,
    /\bwrong\b/i, /\bfrustrated\b/i, /\bnot what i (asked|wanted)\b/i,
    /\bstop (doing|saying)\b/i,
  ];
  const exploratoryPatterns = [
    /\bexplore\b/i, /\bwhat else\b/i, /\btell me more\b/i,
    /\bcurious\b/i, /\binteresting\b/i,
  ];

  const urgentHits = signalsFor(urgentPatterns);
  const frustratedHits = signalsFor(frustratedPatterns);
  const exploratoryHits = signalsFor(exploratoryPatterns);

  let current: ToneState["current"] = "casual";
  let confidence = 0.5;
  const signals: string[] = [];

  if (urgentHits >= 2 || (urgentHits >= 1 && longEnough)) {
    current = "urgent";
    confidence = 0.9;
    signals.push(`urgency keywords (${urgentHits})`);
  } else if (frustratedHits >= 2 || (frustratedHits >= 1 && longEnough)) {
    current = "frustrated";
    confidence = 0.8;
    signals.push(`frustration language (${frustratedHits})`);
  } else if (
    recentUserMsgs.slice(-3).length >= 2 &&
    recentUserMsgs.slice(-3).every((m) => m.content.length < 50)
  ) {
    current = "focused";
    confidence = 0.7;
    signals.push("short messages", "rapid pace");
  } else if (exploratoryHits >= 1) {
    current = "exploratory";
    confidence = 0.7;
    signals.push("exploratory language");
  }

  // Blend with previous tone if confidence is low
  if (confidence < 0.7 && previousTone.current !== "casual") {
    return {
      current: previousTone.current,
      confidence: previousTone.confidence * 0.8,
      signals: previousTone.signals,
    };
  }

  return { current, confidence, signals };
}

// Generate conversation summary when needed (>15 turns or >8 new messages since last)
// NOTE: messageCount is passed as history.length + 2 from chat.stream.ts, which
// includes soft-deleted messages in the count (they're in history[] before the
// is_active filter). This makes the threshold slightly imprecise but is harmless —
// it may trigger summary regeneration one exchange earlier than strictly needed.
export async function maybeRegenerateSummary(
  conversationId: string,
  messageCount: number,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: state } = await supabase
    .from("conversation_states")
    .select("summary_covers_until")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  const covered = state?.summary_covers_until ?? 0;
  if (messageCount - covered < 8) return; // not enough new messages

  const { data: messages } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(messageCount);

  if (!messages || messages.length < 8) return;

  const summarizePrompt = `Summarize this conversation in 3-5 sentences, focusing on decisions made and context needed to continue. Be concise.\n\n${messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
    .join("\n")}`;

  let summary: string | undefined;

  // Try Anthropic first
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          messages: [{ role: "user", content: summarizePrompt }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as { content: { type: string; text: string }[] };
        summary = json.content.find((b) => b.type === "text")?.text?.trim();
      }
    } catch { /* fall through */ }
  }

  // Fallback to OpenAI
  if (!summary) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 300,
          temperature: 0,
          messages: [{ role: "user", content: summarizePrompt }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      summary = json.choices[0]?.message?.content?.trim();
    } catch {
      return;
    }
  }

  if (!summary) return;

  try {
    await supabase.from("conversation_states").upsert({
      conversation_id: conversationId,
      summary,
      summary_covers_until: messageCount,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // Non-critical
  }
}
