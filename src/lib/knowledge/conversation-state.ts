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
  aiResponse: string,
): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

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
            content: `Extract factual statements established in this exchange that are relevant to continue the conversation (NOT general knowledge). Return JSON string array. Max 5 items. Return [] if nothing.
User: ${userMessage.slice(0, 400)}
Assistant: ${aiResponse.slice(0, 400)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(json.choices[0]?.message?.content?.trim() ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

// Detect conversation tone from user messages
export function detectTone(
  messages: { role: string; content: string }[],
  previousTone: ToneState,
): ToneState {
  const recentUser = messages
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => m.content)
    .join(" ");

  const signals: string[] = [];
  let current: ToneState["current"] = "casual";
  let confidence = 0.5;

  if (
    /\b(urgent|asap|immediately|right now|emergency|deadline)\b/i.test(recentUser)
  ) {
    current = "urgent";
    confidence = 0.9;
    signals.push("urgency keywords");
  } else if (
    /\b(doesn't make sense|this is useless|try again|wrong|frustrated)\b/i.test(recentUser)
  ) {
    current = "frustrated";
    confidence = 0.8;
    signals.push("frustration language");
  } else if (
    messages.filter((m) => m.role === "user").slice(-3).length >= 2 &&
    messages.filter((m) => m.role === "user").slice(-3).every((m) => m.content.length < 50)
  ) {
    current = "focused";
    confidence = 0.7;
    signals.push("short messages", "rapid pace");
  } else if (/\b(explore|what else|tell me more|curious|interesting)\b/i.test(recentUser)) {
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

  const key = process.env.OPENAI_API_KEY;
  if (!key) return;

  try {
    const transcript = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 300,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Summarize this conversation in 3-5 sentences, focusing on decisions made and context needed to continue. Be concise.\n\n${transcript}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const summary = json.choices[0]?.message?.content?.trim();
    if (!summary) return;

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
