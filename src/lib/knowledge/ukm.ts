// User Knowledge Model (UKM) — structured profile built from memories + observations.
// Updated incrementally after each conversation and rebuilt weekly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { HAIKU_MODEL_ID } from "@/lib/llm/registry";

export interface UserKnowledgeModel {
  identity: {
    name?: string;
    role?: string;
    company?: string;
    team?: string;
  };
  activeProjects: string[];
  relationships: { name: string; role: string }[];
  communicationStyle: {
    verbosity?: "concise" | "detailed" | "mixed";
    format?: "bullets" | "prose" | "tables" | "mixed";
    tone?: "formal" | "casual" | "technical";
  };
  preferences: {
    responseFormat?: string;
    avoidTopics?: string[];
    preferredSources?: string[];
  };
  antiPreferences: string[];
  corrections: string[];
  responseStyleDislikes: string[];
  expertise: string[];
  correctionCount: number;
}

export async function loadUkm(
  userId: string,
  supabase: SupabaseClient,
): Promise<UserKnowledgeModel> {
  const { data } = await supabase
    .from("user_knowledge_models")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return emptyUkm();

  // DB stores snake_case columns; map to camelCase TypeScript interface
  return {
    identity: (data.identity as UserKnowledgeModel["identity"]) ?? {},
    activeProjects: (data.active_projects as string[]) ?? [],
    relationships: (data.relationships as UserKnowledgeModel["relationships"]) ?? [],
    communicationStyle: (data.communication_style as UserKnowledgeModel["communicationStyle"]) ?? {},
    preferences: (data.preferences as UserKnowledgeModel["preferences"]) ?? {},
    antiPreferences: (data.anti_preferences as string[]) ?? [],
    corrections: (data.corrections as string[]) ?? [],
    responseStyleDislikes: (data.response_style_dislikes as string[]) ?? [],
    expertise: (data.expertise as string[]) ?? [],
    correctionCount: (data.correction_count as number) ?? 0,
  };
}

/**
 * Update the UKM from a new memory observation.
 *
 * @param opts.minConfidence  Minimum confidence (0-1) the LLM diff must report
 *                            for any field to be applied. Default 0.7.
 * @param opts.allowIdentityChange  If false, identity fields (name/role/company/team)
 *                                  are dropped from the diff unless already-set
 *                                  values are being corroborated. Default false.
 */
export async function updateUkmFromMemory(
  userId: string,
  memoryContent: string,
  memoryType: string,
  supabase: SupabaseClient,
  opts: { minConfidence?: number; allowIdentityChange?: boolean } = {},
): Promise<void> {
  const minConfidence = opts.minConfidence ?? 0.7;
  const allowIdentityChange = opts.allowIdentityChange ?? false;

  const ukm = await loadUkm(userId, supabase);
  const diff = await inferUkmDiff(memoryContent, memoryType, ukm);
  if (!diff) return;

  // Confidence gate: drop the whole diff if the LLM reported low confidence.
  const reportedConf = (diff as { confidence?: number }).confidence;
  if (typeof reportedConf === "number" && reportedConf < minConfidence) return;

  // Identity fields require explicit allowance OR corroboration of existing values.
  if (!allowIdentityChange && diff.identity) {
    const filtered: typeof diff.identity = {};
    for (const k of Object.keys(diff.identity) as Array<keyof typeof diff.identity>) {
      const incoming = diff.identity[k];
      const existing = ukm.identity[k];
      // Allow set-from-empty, or corroboration (same value); reject overwrites.
      if (!existing || existing === incoming) filtered[k] = incoming;
    }
    diff.identity = filtered;
  }

  const updated = applyDiff(ukm, diff);
  try {
    await supabase.from("user_knowledge_models").upsert(
      {
        user_id: userId,
        identity: updated.identity,
        active_projects: updated.activeProjects,
        relationships: updated.relationships,
        communication_style: updated.communicationStyle,
        preferences: updated.preferences,
        anti_preferences: updated.antiPreferences,
        corrections: updated.corrections,
        response_style_dislikes: updated.responseStyleDislikes,
        expertise: updated.expertise,
        correction_count: updated.correctionCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  } catch (e) {
    console.error("[ukm] upsert failed", e);
  }
}

async function inferUkmDiff(
  memoryContent: string,
  memoryType: string,
  currentUkm: UserKnowledgeModel,
): Promise<Partial<UserKnowledgeModel> | null> {
  const prompt = `New observation (type: ${memoryType}):
"${memoryContent.slice(0, 800)}"

Current user profile:
${JSON.stringify({
  identity: currentUkm.identity,
  expertise: currentUkm.expertise.slice(0, 5),
  preferences: currentUkm.preferences,
  communicationStyle: currentUkm.communicationStyle,
  activeProjects: currentUkm.activeProjects.slice(0, 3),
})}

Extract any updates to the user profile from the observation above.
Return a JSON object with ONLY the fields that should be updated. Use empty {} if nothing changes.
Always include a top-level "confidence" number in [0,1] reflecting how certain you are.
A single sarcastic or speculative message should be confidence < 0.5.
Allowed fields: identity (name/role/company/team), expertise (array), activeProjects (array), communicationStyle (verbosity/format/tone), preferences (responseFormat/avoidTopics/preferredSources), antiPreferences (array), corrections (array), responseStyleDislikes (array), confidence (number).`;

  // Try Anthropic first (always available when this function runs in chat pipeline)
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
          model: HAIKU_MODEL_ID,
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = (await res.json()) as { content: { type: string; text: string }[] };
        const text = json.content.find((b) => b.type === "text")?.text?.trim() ?? "{}";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      }
    } catch {
      // fall through to OpenAI
    }
  }

  // Fallback: OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 300,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const text = json.choices[0]?.message?.content?.trim() ?? "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    return null;
  }
}

function applyDiff(
  ukm: UserKnowledgeModel,
  diff: Partial<UserKnowledgeModel>,
): UserKnowledgeModel {
  return {
    ...ukm,
    identity: { ...ukm.identity, ...(diff.identity ?? {}) },
    communicationStyle: { ...ukm.communicationStyle, ...(diff.communicationStyle ?? {}) },
    preferences: { ...ukm.preferences, ...(diff.preferences ?? {}) },
    // Merge-and-dedupe instead of replacing — single noisy turn can't wipe projects.
    activeProjects: diff.activeProjects?.length
      ? [...new Set([...ukm.activeProjects, ...diff.activeProjects])].slice(-15)
      : ukm.activeProjects,
    relationships: diff.relationships?.length
      ? [...ukm.relationships, ...diff.relationships.filter(
          (r) => !ukm.relationships.some((e) => e.name === r.name),
        )]
      : ukm.relationships,
    expertise: diff.expertise?.length
      ? [...new Set([...ukm.expertise, ...diff.expertise])].slice(-20)
      : ukm.expertise,
    // For anti-prefs, keep MOST RECENT (slice from tail) so old corrections age out
    // and frequently-violated rules don't fall out of a FIFO window.
    antiPreferences: diff.antiPreferences?.length
      ? [...new Set([...ukm.antiPreferences, ...diff.antiPreferences])].slice(-20)
      : ukm.antiPreferences,
    corrections: diff.corrections?.length
      ? [...new Set([...ukm.corrections, ...diff.corrections])].slice(-20)
      : ukm.corrections,
    responseStyleDislikes: diff.responseStyleDislikes?.length
      ? [...new Set([...ukm.responseStyleDislikes, ...diff.responseStyleDislikes])].slice(-20)
      : ukm.responseStyleDislikes,
    correctionCount: ukm.correctionCount + (diff.corrections?.length ?? 0),
  };
}

// Compress UKM to a ~200-token summary for system prompt injection.
// `currentMessage` (optional) is used to score project relevance — projects whose
// names share tokens with the message are surfaced first.
export function compressUkmForPrompt(ukm: UserKnowledgeModel, currentMessage?: string): string {
  const parts: string[] = [];
  const { identity } = ukm;

  if (identity.name) parts.push(identity.name);
  if (identity.role && identity.company) parts.push(`${identity.role} at ${identity.company}`);
  else if (identity.role) parts.push(identity.role);
  if (identity.team) parts.push(`(${identity.team} team)`);

  if (ukm.activeProjects.length) {
    const projects = currentMessage
      ? rankProjectsByRelevance(ukm.activeProjects, currentMessage).slice(0, 3)
      : ukm.activeProjects.slice(0, 3);
    parts.push(`Working on: ${projects.join(", ")}`);
  }

  const style = ukm.communicationStyle;
  if (style.format) parts.push(`Prefers ${style.format} format`);
  if (style.verbosity) parts.push(`${style.verbosity} responses`);

  if (ukm.expertise.length) {
    parts.push(`Expertise: ${ukm.expertise.slice(0, 3).join(", ")}`);
  }

  // Surface chronic correction rate so model knows to be extra careful
  if (ukm.correctionCount >= 5) {
    parts.push(`Note: user has corrected past responses ${ukm.correctionCount} times — verify before asserting`);
  }

  return parts.join(". ") + (parts.length ? "." : "");
}

function rankProjectsByRelevance(projects: string[], message: string): string[] {
  const msgTokens = new Set(
    (message.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? []),
  );
  const scored = projects.map((p) => {
    const tokens = (p.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? []);
    const hits = tokens.filter((t) => msgTokens.has(t)).length;
    return { p, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map((s) => s.p);
}

// Build anti-preference block for system prompt — most recent rules first, capped at 8.
export function buildAntiPreferenceBlock(ukm: UserKnowledgeModel): string {
  // Take from the END of each list (most recently observed) per applyDiff's tail-keep policy.
  const recent = (arr: string[], n: number) => arr.slice(-n);
  const all = [
    ...recent(ukm.corrections, 4),
    ...recent(ukm.antiPreferences, 4),
    ...recent(ukm.responseStyleDislikes, 4),
  ];
  const deduped = [...new Set(all)].slice(0, 8);

  if (!deduped.length) return "";
  return deduped.map((p) => `- ${p}`).join("\n");
}

function emptyUkm(): UserKnowledgeModel {
  return {
    identity: {},
    activeProjects: [],
    relationships: [],
    communicationStyle: {},
    preferences: {},
    antiPreferences: [],
    corrections: [],
    responseStyleDislikes: [],
    expertise: [],
    correctionCount: 0,
  };
}
