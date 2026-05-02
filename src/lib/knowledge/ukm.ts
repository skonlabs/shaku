// User Knowledge Model (UKM) — structured profile built from memories + observations.
// Updated incrementally after each conversation and rebuilt weekly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { HAIKU_MODEL_ID } from "@/lib/llm/registry";

// Provenance of an identity field:
//   user_asserted — user explicitly stated it ("my name is X", "I work at Y")
//   observed      — repeated corroboration across ≥3 separate exchanges
//   inferred      — assistant inferred from a single conversation turn
//
// Protection order: user_asserted > observed > inferred.
// A field already set by user_asserted can only be changed by another user_asserted
// update, preventing speculative inference from silently overwriting stable facts.
export type IdentitySource = "user_asserted" | "observed" | "inferred";

export interface UserKnowledgeModel {
  identity: {
    name?: string;
    role?: string;
    company?: string;
    team?: string;
  };
  // Provenance for each identity field. Keys match identity field names.
  identitySources: Partial<Record<keyof UserKnowledgeModel["identity"], IdentitySource>>;
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

  return {
    identity: (data.identity as UserKnowledgeModel["identity"]) ?? {},
    identitySources:
      (data.identity_sources as UserKnowledgeModel["identitySources"]) ?? {},
    activeProjects: (data.active_projects as string[]) ?? [],
    relationships: (data.relationships as UserKnowledgeModel["relationships"]) ?? [],
    communicationStyle:
      (data.communication_style as UserKnowledgeModel["communicationStyle"]) ?? {},
    preferences: (data.preferences as UserKnowledgeModel["preferences"]) ?? {},
    antiPreferences: (data.anti_preferences as string[]) ?? [],
    corrections: (data.corrections as string[]) ?? [],
    responseStyleDislikes: (data.response_style_dislikes as string[]) ?? [],
    expertise: (data.expertise as string[]) ?? [],
    correctionCount: (data.correction_count as number) ?? 0,
  };
}

const PROVENANCE_RANK: Record<IdentitySource, number> = {
  user_asserted: 3,
  observed:      2,
  inferred:      1,
};

// Derive the provenance level for an incoming identity update based on memory type.
// "correction" and "long_term" memories that explicitly name the user are treated as
// user_asserted. Everything else is inferred until corroborated.
function provenanceFromType(memoryType: string): IdentitySource {
  if (memoryType === "correction") return "user_asserted";
  if (memoryType === "long_term")  return "user_asserted";
  return "inferred";
}

export async function updateUkmFromMemory(
  userId: string,
  memoryContent: string,
  memoryType: string,
  supabase: SupabaseClient,
  opts: { minConfidence?: number } = {},
): Promise<void> {
  const minConfidence = opts.minConfidence ?? 0.7;

  const ukm = await loadUkm(userId, supabase);
  const diff = await inferUkmDiff(memoryContent, memoryType, ukm);
  if (!diff) return;

  const reportedConf = (diff as { confidence?: number }).confidence;
  if (typeof reportedConf === "number" && reportedConf < minConfidence) return;

  // Apply provenance-aware protection to identity fields.
  // A field already established at a higher provenance level cannot be overwritten
  // by a lower-provenance observation. This prevents one speculative inference from
  // silently replacing a user-confirmed fact.
  const incomingProvenance = provenanceFromType(memoryType);
  const updatedSources: UserKnowledgeModel["identitySources"] = { ...ukm.identitySources };

  if (diff.identity) {
    const filtered: typeof diff.identity = {};
    for (const k of Object.keys(diff.identity) as Array<keyof typeof diff.identity>) {
      const incoming = diff.identity[k];
      const existingSource = ukm.identitySources[k];
      const existingRank = existingSource ? PROVENANCE_RANK[existingSource] : 0;
      const incomingRank = PROVENANCE_RANK[incomingProvenance];

      // Allow: no existing value, or equal/higher provenance incoming update.
      if (!ukm.identity[k] || incomingRank >= existingRank) {
        filtered[k] = incoming;
        updatedSources[k] = incomingProvenance;
      }
    }
    diff.identity = filtered;
  }

  const updated = applyDiff(ukm, diff);
  try {
    await supabase.from("user_knowledge_models").upsert(
      {
        user_id: userId,
        identity: updated.identity,
        identity_sources: updatedSources,
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
          max_tokens: 500,
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
        max_tokens: 500,
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
    const expertise = currentMessage
      ? rankProjectsByRelevance(ukm.expertise, currentMessage).slice(0, 3)
      : ukm.expertise.slice(0, 3);
    parts.push(`Expertise: ${expertise.join(", ")}`);
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
    identitySources: {},
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
