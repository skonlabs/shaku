// Behavioral Learning Engine (Step 11f).
// Processes explicit and implicit signals to build anti-preference memories.
//
// 4 scenarios per spec:
//   1. 👎 "Not helpful" → mismatch analysis → anti_preference memory
//   2. Direct correction ("That's wrong") → correction memory
//   3. User rephrases question → detect gap → inject lesson
//   4. User clicks Regenerate → escalate model, store lesson after positive response

import { embed } from "@/lib/embeddings";
import type { SupabaseClient } from "@supabase/supabase-js";

export type FeedbackReason =
  | "inaccurate"
  | "not_helpful"
  | "too_long"
  | "too_short"
  | "wrong_format"
  | "other";

export interface MismatchAnalysis {
  mismatchType:
    | "missed_intent"
    | "too_vague"
    | "wrong_scope"
    | "irrelevant_sources"
    | "missing_context";
  whatUserWanted: string;
  whatAiProvided: string;
  lesson: string;
}

// Scenario 1: Process negative feedback
export async function processNegativeFeedback(
  userId: string,
  conversationId: string,
  messageId: string,
  userMessage: string,
  aiResponse: string,
  reason: FeedbackReason,
  freeText: string | null,
  supabase: SupabaseClient,
): Promise<void> {
  const analysis = await analyzeMismatch(userMessage, aiResponse, reason);

  // Store feedback event
  await supabase.from("feedback_events").insert({
    user_id: userId,
    message_id: messageId,
    conversation_id: conversationId,
    feedback_type: "thumbs_down",
    reason,
    free_text: freeText,
    mismatch_analysis: analysis,
    lesson_extracted: analysis?.lesson,
  });

  if (analysis) {
    await createAntiPreferenceMemory(
      userId,
      conversationId,
      `User found response unhelpful when asked about "${userMessage.slice(0, 100)}". Issue: ${analysis.mismatchType}. Lesson: ${analysis.lesson}`,
      supabase,
    );
  }
}

// Scenario 2: Process correction
export async function processCorrection(
  userId: string,
  conversationId: string,
  messageId: string,
  correctionMessage: string,
  originalAiResponse: string,
  supabase: SupabaseClient,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  let lesson = correctionMessage.slice(0, 300);

  if (key) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 150,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: `AI said: "${originalAiResponse.slice(0, 300)}"
User corrected: "${correctionMessage.slice(0, 200)}"
Extract a specific, reusable lesson. Return 1 sentence starting with "When discussing..." or "Don't assume..."`,
            },
          ],
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const json = (await res.json()) as { choices: { message: { content: string } }[] };
        lesson = json.choices[0]?.message?.content?.trim() || lesson;
      }
    } catch {
      // keep original
    }
  }

  await supabase.from("feedback_events").insert({
    user_id: userId,
    message_id: messageId,
    conversation_id: conversationId,
    feedback_type: "correction",
    lesson_extracted: lesson,
  });

  await createCorrectionMemory(userId, conversationId, lesson, supabase);

  // Return acknowledgment message for the AI to include in its response
  return `I see what went wrong — let me try again with that correction in mind.`;
}

async function analyzeMismatch(
  userMessage: string,
  aiResponse: string,
  reason: FeedbackReason,
): Promise<MismatchAnalysis | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

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
            content: `The user asked: "${userMessage.slice(0, 300)}". AI responded: "${aiResponse.slice(0, 300)}". User said "${reason}". Return JSON: {"mismatch_type":"missed_intent"|"too_vague"|"wrong_scope"|"irrelevant_sources"|"missing_context","what_user_wanted":"...","what_ai_provided":"...","lesson":"..."}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(json.choices[0]?.message?.content?.trim() ?? "{}");
    return {
      mismatchType: parsed.mismatch_type,
      whatUserWanted: parsed.what_user_wanted,
      whatAiProvided: parsed.what_ai_provided,
      lesson: parsed.lesson,
    };
  } catch {
    return null;
  }
}

async function createAntiPreferenceMemory(
  userId: string,
  conversationId: string,
  content: string,
  supabase: SupabaseClient,
): Promise<void> {
  let embedding: number[] | undefined;
  try {
    embedding = await embed(content);
  } catch {
    // ok to proceed without
  }

  await supabase.from("memories").insert({
    user_id: userId,
    type: "anti_preference",
    content,
    source_conversation_id: conversationId,
    confidence: 0.8,
    importance: 0.7,
    embedding: embedding ? `[${embedding.join(",")}]` : null,
  });
}

async function createCorrectionMemory(
  userId: string,
  conversationId: string,
  content: string,
  supabase: SupabaseClient,
): Promise<void> {
  let embedding: number[] | undefined;
  try {
    embedding = await embed(content);
  } catch {
    // ok
  }

  await supabase.from("memories").insert({
    user_id: userId,
    type: "correction",
    content,
    source_conversation_id: conversationId,
    confidence: 0.9,
    importance: 0.8,
    embedding: embedding ? `[${embedding.join(",")}]` : null,
  });
}

// Positive feedback: record which response style was liked for routing adjustment
export async function processPositiveFeedback(
  userId: string,
  conversationId: string,
  messageId: string,
  supabase: SupabaseClient,
): Promise<void> {
  await supabase.from("feedback_events").insert({
    user_id: userId,
    message_id: messageId,
    conversation_id: conversationId,
    feedback_type: "thumbs_up",
  });
}
