// Exhaustive Response Strategy — triggered when retrieval quality < 0.015.
// The AI NEVER says "I don't know." It exhausts 4 escalating levels.

import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieve, webSearch, type RetrievedChunk } from "./retrieval";
import type { Intent } from "@/lib/llm/types";

export interface ExhaustiveResult {
  chunks: RetrievedChunk[];
  level: 1 | 2 | 3 | 4;
  webSearched: boolean;
}

export async function exhaustiveRetrieve(
  userId: string,
  conversationId: string,
  originalQuery: string,
  intent: Intent,
  supabase: SupabaseClient,
  sendStatusUpdate?: (msg: string) => void,
): Promise<ExhaustiveResult> {
  // Level 1: Broaden retrieval with synonyms / broader terms
  sendStatusUpdate?.("🔍 Searching your sources more broadly...");
  const broadQuery = await broadenQuery(originalQuery);
  const level1 = await retrieve(userId, broadQuery, intent, conversationId, supabase, {
    topK: 30,
    includeConversationUploads: true,
  });

  if (level1.qualityScore >= 0.015) {
    return { chunks: level1.chunks, level: 1, webSearched: false };
  }

  // Level 2: Search conversation history + ALL memories
  sendStatusUpdate?.("🔍 Searching your conversation history and memory...");
  const [historyChunks, memoryChunks] = await Promise.all([
    searchConversationHistory(userId, originalQuery, supabase),
    searchAllMemories(userId, originalQuery, supabase),
  ]);

  const level2Chunks = deduplicateChunks([...level1.chunks, ...historyChunks, ...memoryChunks]);
  if (level2Chunks.length >= 3) {
    return { chunks: level2Chunks.slice(0, 20), level: 2, webSearched: false };
  }

  // Level 3: Web search — only if the user has explicitly opted in (issue #15).
  // Sending queries to Bing requires user consent: the query may contain private
  // context, and results mix public web facts into the private memory workflow.
  const webSearchAllowed = await isWebSearchEnabled(userId, supabase);
  if (webSearchAllowed) {
    sendStatusUpdate?.("🌐 Searching the web...");
    const webChunks = await webSearch(originalQuery, 5);
    if (webChunks.length > 0) {
      // User sources always have priority over web results
      return {
        chunks: [...level2Chunks, ...webChunks].slice(0, 20),
        level: 3,
        webSearched: true,
      };
    }
  }

  // Level 4: Return whatever partial information we have (synthesize from memory)
  return {
    chunks: level2Chunks.slice(0, 10),
    level: 4,
    webSearched: false,
  };
}

async function isWebSearchEnabled(userId: string, supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("user_memory_preferences")
      .select("web_search_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    return (data?.web_search_enabled as boolean | null) ?? false;
  } catch {
    return false; // default: off
  }
}

async function broadenQuery(query: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return query;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 100,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Rephrase this query using broader terms, synonyms, and related concepts to improve search coverage. Return ONLY the rephrased query.
Query: ${query}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return query;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content?.trim() || query;
  } catch {
    return query;
  }
}

async function searchConversationHistory(
  _userId: string,
  query: string,
  supabase: SupabaseClient,
): Promise<RetrievedChunk[]> {
  // Build keyword fragments from the query for broad ilike matching.
  // Limit to words ≥ 4 chars to avoid stop-word noise.
  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  // RLS scopes to the authenticated user's conversations automatically.
  const { data } = await supabase
    .from("messages")
    .select("id, content, conversation_id, role, created_at")
    .eq("is_active", true)
    .ilike("content", `%${keywords[0]}%`)
    .limit(15);

  if (!data?.length) return [];

  // Re-rank by keyword overlap
  const scored = data
    .map((m) => {
      const lower = m.content.toLowerCase();
      const hits = keywords.filter((k) => lower.includes(k)).length;
      return { m, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10);

  return scored.map(({ m }, i) => ({
    id: `hist-${m.id}`,
    sourceType: "conversation_history",
    sourceId: m.conversation_id,
    sourceItemId: m.id,
    content: m.content,
    metadata: { role: m.role, created_at: m.created_at },
    score: 0.3 / (i + 1),
  }));
}

async function searchAllMemories(
  userId: string,
  query: string,
  supabase: SupabaseClient,
): Promise<RetrievedChunk[]> {
  const { data } = await supabase
    .from("memories")
    .select("id, type, content, confidence")
    .eq("user_id", userId)
    .is("superseded_by", null)
    .textSearch("search_vector", query, { config: "english" })
    .limit(10);

  return (data ?? []).map((m, i) => ({
    id: `mem-${m.id}`,
    sourceType: "memory",
    sourceId: userId,
    sourceItemId: m.id,
    content: m.content,
    metadata: { type: m.type, confidence: m.confidence },
    score: 0.4 / (i + 1),
  }));
}

function deduplicateChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    // Fingerprint: first 60 chars + last 60 chars + length bucket.
    // Using only a prefix is fragile when chunks start with identical boilerplate
    // (e.g. "Source: X\n..."). The combined start+end+length fingerprint is
    // cheap and catches both identical and near-duplicate chunks.
    const text = c.content.toLowerCase().trim();
    const key = `${text.slice(0, 60)}|${text.slice(-60)}|${Math.floor(text.length / 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
