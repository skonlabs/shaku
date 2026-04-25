// Step 6: Context assembly — loads conversation state, retrieves memories,
// injects UKM summary, and builds the final ordered context block.
//
// Priority order per spec:
//   1. System instructions (~400 tokens)
//   2. UKM summary (~200 tokens)
//   3. Conversation facts + style + topics (~100 tokens)
//   4. User's current message
//   5. Retrieved context (0–6,000 tokens)
//   6. Memory entries (0–500 tokens)
//   7. Conversation history (0–3,000 tokens)

import { embed } from "@/lib/embeddings";
import { loadUkm, compressUkmForPrompt, buildAntiPreferenceBlock } from "@/lib/knowledge/ukm";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedChunk } from "./retrieval";

export interface ConversationState {
  summary: string | null;
  summaryCoveredUntil: number;
  conversationFacts: string[];
  activeTopics: string[];
  styleProfile: Record<string, string>;
  conversationTone: { current: string; confidence: number; signals: string[] };
}

export interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  confidence: number;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  memoriesUsed: MemoryEntry[];
  sourcesSearched: { name: string; type: string; itemsSearched: number }[];
  convState: ConversationState;
}

const TOKEN_BUDGET_RETRIEVAL = 10_000;
const TOKEN_BUDGET_MEMORY = 2_000;
const TOKEN_BUDGET_HISTORY = 50_000;
const TOKEN_BUDGET_FACTS = 300;

export async function assembleContext(opts: {
  userId: string;
  conversationId: string;
  projectId: string | null;
  currentMessage: string;
  retrievedChunks: RetrievedChunk[];
  supabase: SupabaseClient;
  systemInstructions: string;
  preloadedHistory?: { role: "user" | "assistant"; content: string; createdAt: string }[];
}): Promise<AssembledContext> {
  const {
    userId,
    conversationId,
    projectId,
    currentMessage,
    retrievedChunks,
    supabase,
    systemInstructions,
    preloadedHistory,
  } = opts;

  // Load everything in parallel; skip history DB query if caller preloaded it
  const [convState, convHistory, ukm, memories] = await Promise.all([
    loadConversationState(conversationId, supabase),
    preloadedHistory
      ? Promise.resolve(preloadedHistory)
      : loadConversationHistory(conversationId, supabase),
    loadUkm(userId, supabase),
    retrieveMemories(userId, projectId, currentMessage, supabase),
  ]);

  // Build context sections
  const ukmSummary = compressUkmForPrompt(ukm);
  const antiPrefs = buildAntiPreferenceBlock(ukm);
  const factsBlock = buildFactsBlock(convState);
  const retrievalBlock = buildRetrievalBlock(retrievedChunks, TOKEN_BUDGET_RETRIEVAL);
  const memoryBlock = buildMemoryBlock(memories, TOKEN_BUDGET_MEMORY);
  const historyMessages = truncateHistory(convHistory, TOKEN_BUDGET_HISTORY);

  // Build system prompt
  const systemPrompt = [
    systemInstructions,
    ukmSummary ? `\n## About the user\n${ukmSummary}` : "",
    antiPrefs ? `\n## Avoid (user dislikes)\n${antiPrefs}` : "",
    factsBlock ? `\n## Conversation context\n${factsBlock}` : "",
    memoryBlock ? `\n## Memory\n${memoryBlock}` : "",
    retrievalBlock ? `\n## Sources\n${retrievalBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    systemPrompt,
    messages: historyMessages,
    memoriesUsed: memories,
    sourcesSearched: [],
    convState,
  };
}

export async function loadConversationState(
  conversationId: string,
  supabase: SupabaseClient,
): Promise<ConversationState> {
  const { data } = await supabase
    .from("conversation_states")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return {
    summary: data?.summary ?? null,
    summaryCoveredUntil: data?.summary_covers_until ?? 0,
    conversationFacts: data?.conversation_facts ?? [],
    activeTopics: data?.active_topics ?? [],
    styleProfile: data?.style_profile ?? {},
    conversationTone: data?.conversation_tone ?? { current: "casual", confidence: 0.5, signals: [] },
  };
}

async function loadConversationHistory(
  conversationId: string,
  supabase: SupabaseClient,
): Promise<{ role: "user" | "assistant"; content: string; createdAt: string }[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true })
    .limit(50);

  return (data ?? []).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    createdAt: m.created_at,
  }));
}

async function retrieveMemories(
  userId: string,
  projectId: string | null,
  query: string,
  supabase: SupabaseClient,
): Promise<MemoryEntry[]> {
  try {
    const embedding = await embed(query);
    const { data } = await supabase.rpc("search_memories", {
      query_embedding: `[${embedding.join(",")}]`,
      target_user_id: userId,
      target_project_id: projectId,
      match_count: 10,
    });

    if (data?.length) {
      const ids = data.map((m: { id: string }) => m.id);
      void supabase.rpc("increment_memory_access", { memory_ids: ids });
    }

    return (data ?? []).map((m: Record<string, unknown>) => ({
      id: m.id as string,
      type: m.type as string,
      content: m.content as string,
      confidence: m.confidence as number,
    }));
  } catch {
    return [];
  }
}


function buildFactsBlock(state: ConversationState): string {
  const parts: string[] = [];
  if (state.conversationFacts.length) {
    parts.push(`Facts: ${state.conversationFacts.join("; ")}`);
  }
  if (state.activeTopics.length) {
    parts.push(`Topics: ${state.activeTopics.join(", ")}`);
  }
  if (state.styleProfile.tone) {
    parts.push(`Tone: ${state.styleProfile.tone}`);
  }
  if (state.conversationTone.current !== "casual") {
    parts.push(`Current tone: ${state.conversationTone.current}`);
  }
  const text = parts.join(". ");
  return text.slice(0, TOKEN_BUDGET_FACTS * 4);
}

function buildRetrievalBlock(chunks: RetrievedChunk[], tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  let used = 0;
  const parts: string[] = [];

  for (const chunk of chunks) {
    const sourceName = (chunk.metadata?.title as string | undefined) ?? chunk.sourceType;
    const text = `<source name="${sourceName}" type="${chunk.sourceType}">\n${chunk.content}\n</source>`;
    if (used + text.length > charBudget) break;
    parts.push(text);
    used += text.length;
  }

  return parts.join("\n\n");
}

function buildMemoryBlock(memories: MemoryEntry[], tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  let used = 0;
  const parts: string[] = [];

  for (const m of memories) {
    const text = `<memory type="${m.type}">${m.content}</memory>`;
    if (used + text.length > charBudget) break;
    parts.push(text);
    used += text.length;
  }

  return parts.join("\n");
}

function truncateHistory(
  history: { role: "user" | "assistant"; content: string }[],
  tokenBudget: number,
): { role: "user" | "assistant"; content: string }[] {
  const charBudget = tokenBudget * 4;
  // Take most recent messages first (reverse), accumulate, then reverse back
  let used = 0;
  const selected: { role: "user" | "assistant"; content: string }[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const len = msg.content.length + 10; // role overhead
    if (used + len > charBudget && selected.length > 0) break;
    selected.unshift(msg);
    used += len;
  }

  return selected;
}

// Update conversation state after a completed exchange (called async)
export async function updateConversationState(
  conversationId: string,
  newFacts: string[],
  newTopics: string[],
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existing } = await supabase
    .from("conversation_states")
    .select("conversation_facts, active_topics, summary_covers_until")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  const facts = [...(existing?.conversation_facts ?? []), ...newFacts].slice(-20);
  const topics = [...new Set([...(existing?.active_topics ?? []), ...newTopics])].slice(-10);

  await supabase.from("conversation_states").upsert({
    conversation_id: conversationId,
    conversation_facts: facts,
    active_topics: topics,
    updated_at: new Date().toISOString(),
  });
}
