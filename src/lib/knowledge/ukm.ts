// User Knowledge Model (UKM) — structured profile built from memories + observations.
// Updated incrementally after each conversation and rebuilt weekly.

import type { SupabaseClient } from "@supabase/supabase-js";

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

  return (data as UserKnowledgeModel | null) ?? emptyUkm();
}

export async function updateUkmFromMemory(
  userId: string,
  memoryContent: string,
  memoryType: string,
  supabase: SupabaseClient,
): Promise<void> {
  const ukm = await loadUkm(userId, supabase);
  const diff = await inferUkmDiff(memoryContent, memoryType, ukm);
  if (!diff) return;

  const updated = applyDiff(ukm, diff);
  await supabase.from("user_knowledge_models").upsert({
    user_id: userId,
    ...updated,
    updated_at: new Date().toISOString(),
  });
}

async function inferUkmDiff(
  memoryContent: string,
  memoryType: string,
  currentUkm: UserKnowledgeModel,
): Promise<Partial<UserKnowledgeModel> | null> {
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
            content: `New memory (type: ${memoryType}): "${memoryContent}"

Current profile: ${JSON.stringify({
  identity: currentUkm.identity,
  expertise: currentUkm.expertise.slice(0, 3),
  preferences: currentUkm.preferences,
})}

If this memory should update any profile fields, return a JSON diff object. Return {} if no changes needed.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(json.choices[0]?.message?.content?.trim() ?? "{}");
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
    activeProjects: diff.activeProjects?.length ? diff.activeProjects : ukm.activeProjects,
    expertise: diff.expertise?.length
      ? [...new Set([...ukm.expertise, ...diff.expertise])]
      : ukm.expertise,
    antiPreferences: diff.antiPreferences?.length
      ? [...new Set([...ukm.antiPreferences, ...diff.antiPreferences])]
      : ukm.antiPreferences,
    corrections: diff.corrections?.length
      ? [...new Set([...ukm.corrections, ...diff.corrections])]
      : ukm.corrections,
  };
}

// Compress UKM to a ~200-token summary for system prompt injection
export function compressUkmForPrompt(ukm: UserKnowledgeModel): string {
  const parts: string[] = [];
  const { identity } = ukm;

  if (identity.name) parts.push(identity.name);
  if (identity.role && identity.company) parts.push(`${identity.role} at ${identity.company}`);
  else if (identity.role) parts.push(identity.role);
  if (identity.team) parts.push(`(${identity.team} team)`);

  if (ukm.activeProjects.length) {
    parts.push(`Working on: ${ukm.activeProjects.slice(0, 3).join(", ")}`);
  }

  const style = ukm.communicationStyle;
  if (style.format) parts.push(`Prefers ${style.format} format`);
  if (style.verbosity) parts.push(`${style.verbosity} responses`);

  if (ukm.expertise.length) {
    parts.push(`Expertise: ${ukm.expertise.slice(0, 3).join(", ")}`);
  }

  return parts.join(". ") + (parts.length ? "." : "");
}

// Build anti-preference block for system prompt
export function buildAntiPreferenceBlock(ukm: UserKnowledgeModel): string {
  const all = [
    ...ukm.antiPreferences,
    ...ukm.corrections,
    ...ukm.responseStyleDislikes,
  ].slice(0, 10);

  if (!all.length) return "";
  return all.map((p) => `- ${p}`).join("\n");
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
