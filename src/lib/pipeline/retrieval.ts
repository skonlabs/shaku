// Step 5: Retrieval — hybrid search across user's chunks using search_chunks RPC.
// Calls the PostgreSQL function which merges vector + full-text via RRF.

import { embed } from "@/lib/embeddings";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Intent } from "@/lib/llm/types";

export interface RetrievedChunk {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceItemId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  sourcesSearched: { name: string; type: string; itemsSearched: number }[];
  qualityScore: number; // avg score of top-5; <0.015 triggers exhaustive strategy
  webSearchTriggered: boolean;
}

// Map intent to source types to search
const INTENT_SOURCE_MAP: Record<string, string[] | null> = {
  question: null, // null = search all
  search: null,
  analysis: null,
  action: ["connector"],
  follow_up: null,
  casual_chat: [], // empty = no retrieval needed
  acknowledgment: [],
  creative: ["conversation_upload", "datasource"], // search user's own content for creative tasks
};

export async function retrieve(
  userId: string,
  query: string,
  intent: Intent,
  conversationId: string,
  supabase: SupabaseClient,
  opts: { topK?: number; includeConversationUploads?: boolean } = {},
): Promise<RetrievalResult> {
  const { topK = 20, includeConversationUploads = true } = opts;

  // No retrieval for casual chat and acknowledgments
  const sourceTypeFilter = INTENT_SOURCE_MAP[intent];
  if (Array.isArray(sourceTypeFilter) && sourceTypeFilter.length === 0) {
    return { chunks: [], sourcesSearched: [], qualityScore: 1, webSearchTriggered: false };
  }

  // Build source type filter
  const sourceTypes: string[] = [];
  if (!sourceTypeFilter || sourceTypeFilter.includes("datasource")) {
    sourceTypes.push("datasource");
  }
  if (!sourceTypeFilter || sourceTypeFilter.includes("connector")) {
    sourceTypes.push("connector");
  }
  if (includeConversationUploads) {
    sourceTypes.push("conversation_upload");
  }
  // URL chunks are only relevant for information-seeking intents; skip for creative
  // and acknowledgment intents where they add noise without value.
  if (intent !== "creative" && intent !== "acknowledgment") {
    sourceTypes.push("url_in_message");
  }

  // Generate query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(query);
  } catch {
    // Fall back to pure text search if embedding fails
    return retrieveTextOnly(userId, query, sourceTypes, topK, supabase);
  }

  // Call hybrid search RPC
  const { data, error } = await supabase.rpc("search_chunks", {
    query_embedding: `[${queryEmbedding.join(",")}]`,
    query_text: query,
    source_types: sourceTypes.length > 0 ? sourceTypes : null,
    match_count: topK,
    rrf_k: 60,
  });

  if (error || !data) {
    console.error("[retrieval] search_chunks RPC failed", error);
    return { chunks: [], sourcesSearched: [], qualityScore: 0, webSearchTriggered: false };
  }

  const chunks: RetrievedChunk[] = (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string,
    sourceItemId: row.source_item_id as string | null,
    content: row.content as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    score: row.rrf_score as number,
  }));

  // Compute quality floor
  const topFive = chunks.slice(0, 5);
  const qualityScore =
    topFive.length === 0 ? 0 : topFive.reduce((s, c) => s + c.score, 0) / topFive.length;

  // Group by source for the "sources searched" footer
  const sourceGroups = new Map<string, number>();
  for (const c of chunks) {
    const key = (c.metadata.title as string) ?? c.sourceType;
    sourceGroups.set(key, (sourceGroups.get(key) ?? 0) + 1);
  }
  const sourcesSearched = [...sourceGroups.entries()].map(([name, count]) => ({
    name,
    type: "indexed",
    itemsSearched: count,
  }));

  return { chunks, sourcesSearched, qualityScore, webSearchTriggered: false };
}

// Fallback: pure tsvector full-text search when embedding is unavailable.
// User isolation is enforced by Supabase RLS on the chunks table — the supabase
// client is constructed with the user's JWT so auth.uid() inside RLS policies
// automatically scopes the query to owned rows.
async function retrieveTextOnly(
  _userId: string, // RLS enforces user scope via the authenticated client
  query: string,
  sourceTypes: string[],
  topK: number,
  supabase: SupabaseClient,
): Promise<RetrievalResult> {
  const { data } = await supabase
    .from("chunks")
    .select("id, source_type, source_id, source_item_id, content, metadata")
    .in("source_type", sourceTypes)
    .textSearch("search_vector", query, { config: "english" })
    .limit(topK);

  const chunks: RetrievedChunk[] = (data ?? []).map((row, i) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    content: row.content,
    metadata: row.metadata ?? {},
    score: 1 / (i + 1),
  }));

  return {
    chunks,
    sourcesSearched: [],
    qualityScore: chunks.length > 0 ? 0.5 : 0,
    webSearchTriggered: false,
  };
}

// Format retrieved chunks into an XML block for injection into the system prompt.
export function buildRetrievalContext(chunks: RetrievedChunk[], tokenBudget = 6_000): string {
  if (!chunks.length) return "";
  const charBudget = tokenBudget * 4;
  let used = 0;
  const parts: string[] = [];
  for (const chunk of chunks) {
    const sourceName = (chunk.metadata.title as string) ?? chunk.sourceType;
    const block = `<source name="${sourceName}" type="${chunk.sourceType}">\n${chunk.content}\n</source>`;
    if (used + block.length > charBudget) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

// Web search fallback (Sprint 7, triggered by exhaustive strategy)
export async function webSearch(query: string, topK = 5): Promise<RetrievedChunk[]> {
  const bingKey = process.env.BING_SEARCH_API_KEY;
  if (!bingKey) return [];

  try {
    const res = await fetch(
      `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${topK}&responseFilter=Webpages`,
      {
        headers: { "Ocp-Apim-Subscription-Key": bingKey },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];

    const json = (await res.json()) as {
      webPages?: { value: { name: string; url: string; snippet: string }[] };
    };

    return (json.webPages?.value ?? []).map((r, i) => ({
      id: `web-${i}`,
      sourceType: "web",
      sourceId: "web",
      sourceItemId: r.url,
      content: `${r.name}\n${r.snippet}`,
      metadata: { title: r.name, url: r.url, source_name: "Web" },
      score: 1 / (i + 1),
    }));
  } catch {
    return [];
  }
}
