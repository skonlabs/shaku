// Memory contradiction detection.
// When creating a new memory, search for semantically similar existing memories
// and check if they conflict with the new one.
//
// Correction priority rule (issue #12): an explicit user correction always supersedes
// the conflicting memory regardless of the old memory's confidence score. Users change
// their preferences; a recent explicit correction carries more truth than an old high-
// confidence inferred fact.

import { embed } from "@/lib/embeddings";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConflictingMemory {
  id: string;
  content: string;
  confidence: number;
  similarity: number;
}

export interface ContradictionOptions {
  projectId?: string | null;
  similarityThreshold?: number;
  // When true, all found contradictions are returned regardless of confidence
  // comparison — callers that represent explicit user corrections use this to
  // supersede old high-confidence memories unconditionally.
  isExplicitCorrection?: boolean;
}

export async function detectContradictions(
  userId: string,
  newContent: string,
  supabase: SupabaseClient,
  options: ContradictionOptions | number = {},
): Promise<ConflictingMemory[]> {
  const opts: ContradictionOptions =
    typeof options === "number" ? { similarityThreshold: options } : options;
  const similarityThreshold = opts.similarityThreshold ?? 0.85;
  const projectId = opts.projectId ?? null;
  const isExplicitCorrection = opts.isExplicitCorrection ?? false;

  let embedding: number[];
  try {
    embedding = await embed(newContent);
  } catch {
    return [];
  }

  const { data } = await supabase.rpc("search_memories", {
    query_embedding: `[${embedding.join(",")}]`,
    target_user_id: userId,
    target_project_id: projectId,
    match_count: 5,
  });

  if (!data) return [];

  const similar = (data as Record<string, unknown>[]).filter(
    (m) => (m.similarity as number) >= similarityThreshold,
  );

  if (similar.length === 0) return [];

  // For explicit corrections, skip the LLM contradiction check and return all
  // high-similarity memories as candidates for supersession. The user explicitly
  // said "going forward, do X instead" — that overrides any old inferred fact.
  if (isExplicitCorrection) {
    return similar.map((m) => ({
      id: m.id as string,
      content: m.content as string,
      confidence: m.confidence as number,
      similarity: m.similarity as number,
    }));
  }

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
            content: `New memory: "${newContent}"

Existing memories:
${similar.map((m, i) => `${i + 1}. "${m.content as string}"`).join("\n")}

Which existing memories directly CONTRADICT the new memory? Return JSON: [{"index": 1-based, "contradicts": true|false}]`,
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(json.choices[0]?.message?.content?.trim() ?? "[]") as {
      index: number;
      contradicts: boolean;
    }[];

    return parsed
      .filter((p) => p.contradicts)
      .map((p) => {
        const m = similar[p.index - 1];
        if (!m) return null;
        return {
          id: m.id as string,
          content: m.content as string,
          confidence: m.confidence as number,
          similarity: m.similarity as number,
        };
      })
      .filter((x): x is ConflictingMemory => x !== null);
  } catch {
    return [];
  }
}
