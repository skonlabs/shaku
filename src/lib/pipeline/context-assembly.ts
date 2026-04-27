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

import { loadUkm, compressUkmForPrompt, buildAntiPreferenceBlock } from "@/lib/knowledge/ukm";
import { wrapSource, wrapMemory } from "@/lib/pipeline/prompt-optimization";
import { retrieveMemories as retrieveMemoriesCanonical } from "@/lib/memory/retrieval";
import { loadActiveTask } from "@/lib/memory/tasks";
import type { ActiveTask } from "@/lib/memory/tasks";
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
  pinned?: boolean;
  hybridScore?: number;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  memoriesUsed: MemoryEntry[];
  sourcesSearched: { name: string; type: string; itemsSearched: number }[];
  convState: ConversationState;
  activeTask: ActiveTask | null;
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

  // Load user memory preferences to respect per-user limits
  const memPrefs = await loadMemoryPreferences(userId, supabase);

  // Load everything in parallel; always use preloadedHistory (callers always provide it)
  const [convState, convHistory, ukm, memories, activeTask] = await Promise.all([
    loadConversationState(conversationId, supabase),
    preloadedHistory
      ? Promise.resolve(preloadedHistory)
      : Promise.resolve([] as { role: "user" | "assistant"; content: string; createdAt: string }[]),
    loadUkm(userId, supabase),
    retrieveMemories(userId, projectId, currentMessage, supabase, {
      limit: memPrefs.maxMemoriesPerCall,
      minConfidence: memPrefs.minConfidenceThreshold,
      excludedTypes: memPrefs.excludedTypes,
    }),
    loadActiveTask(conversationId, supabase),
  ]);

  // Build context sections (pass currentMessage so projects can be ranked by relevance)
  const ukmSummary = compressUkmForPrompt(ukm, currentMessage);
  const antiPrefs = buildAntiPreferenceBlock(ukm);
  const factsBlock = buildFactsBlock(convState);
  const retrievalBlock = buildRetrievalBlock(retrievedChunks, TOKEN_BUDGET_RETRIEVAL);
  const memoryBlock = buildMemoryBlock(memories, TOKEN_BUDGET_MEMORY);
  const historyMessages = truncateHistory(convHistory, TOKEN_BUDGET_HISTORY);

  const summaryBlock = convState.summary
    ? `Conversation summary (earlier messages): ${convState.summary}`
    : "";

  // Build task block if there is an active task
  const taskBlock = activeTask ? buildTaskBlock(activeTask) : "";

  // Build system prompt
  const systemPrompt = [
    systemInstructions,
    ukmSummary ? `\n## About the user\n${ukmSummary}` : "",
    antiPrefs ? `\n## Avoid (user dislikes)\n${antiPrefs}` : "",
    summaryBlock ? `\n## Earlier conversation\n${summaryBlock}` : "",
    factsBlock ? `\n## Conversation context\n${factsBlock}` : "",
    taskBlock ? `\n## Active task\n${taskBlock}` : "",
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
    activeTask,
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
    conversationTone: data?.conversation_tone ?? {
      current: "casual",
      confidence: 0.5,
      signals: [],
    },
  };
}

interface MemoryPrefs {
  maxMemoriesPerCall: number;
  minConfidenceThreshold: number;
  excludedTypes: string[];
}

async function loadMemoryPreferences(
  userId: string,
  supabase: SupabaseClient,
): Promise<MemoryPrefs> {
  try {
    const { data } = await supabase
      .from("user_memory_preferences")
      .select("max_memories_per_call, min_confidence_threshold, excluded_types")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      maxMemoriesPerCall: (data?.max_memories_per_call as number | null) ?? 10,
      minConfidenceThreshold: (data?.min_confidence_threshold as number | null) ?? 0.6,
      excludedTypes: (data?.excluded_types as string[] | null) ?? [],
    };
  } catch {
    return { maxMemoriesPerCall: 10, minConfidenceThreshold: 0.6, excludedTypes: [] };
  }
}

// Delegates to the canonical retrieveMemories module so we have one embed call
// path and consistent semantics. The `incrementAccess` side-effect is performed
// inside retrieveMemories (best-effort fire-and-forget).
async function retrieveMemories(
  userId: string,
  projectId: string | null,
  query: string,
  supabase: SupabaseClient,
  prefs: { limit: number; minConfidence: number; excludedTypes: string[] },
): Promise<MemoryEntry[]> {
  try {
    const results = await retrieveMemoriesCanonical(userId, query, supabase, {
      projectId,
      limit: prefs.limit,
    });
    return results
      .filter(
        (m) =>
          m.confidence >= prefs.minConfidence &&
          (prefs.excludedTypes.length === 0 || !prefs.excludedTypes.includes(m.type)),
      )
      .map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        confidence: m.confidence,
        pinned: m.pinned,
        hybridScore: m.hybridScore,
      }));
  } catch {
    return [];
  }
}

function buildTaskBlock(task: ActiveTask): string {
  const parts: string[] = [`Goal: ${task.goal || task.title}`];
  if (task.currentStep) parts.push(`Current step: ${task.currentStep}`);
  if (task.completedSteps.length) parts.push(`Completed: ${task.completedSteps.join("; ")}`);
  if (task.nextActions.length) parts.push(`Next: ${task.nextActions.join("; ")}`);
  if (task.openQuestions.length) parts.push(`Open questions: ${task.openQuestions.join("; ")}`);
  return parts.join(". ");
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
  // Conservative ~3 chars/token (matches token-counter.estimateCharBudget) and cut at word boundary.
  const charLimit = TOKEN_BUDGET_FACTS * 3;
  if (text.length <= charLimit) return text;
  const cutAt = text.lastIndexOf(" ", charLimit);
  return (cutAt > 0 ? text.slice(0, cutAt) : text.slice(0, charLimit)) + "…";
}

function buildRetrievalBlock(chunks: RetrievedChunk[], tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  let used = 0;
  const parts: string[] = [];

  for (const chunk of chunks) {
    const sourceName = (chunk.metadata?.title as string | undefined) ?? chunk.sourceType;
    const text = wrapSource(sourceName, chunk.sourceType, chunk.content);
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
    const text = wrapMemory(m.type, m.content);
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
