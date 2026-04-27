// Memory classifier: extracts structured memory from conversation exchanges.
// Returns all 6 spec fields: new_memories, memory_updates, task_updates,
// conversation_summary_update, do_not_store, confidence.

export type MemoryType =
  | "preference"
  | "semantic"
  | "episodic"
  | "behavioral"
  | "anti_preference"
  | "correction"
  | "response_style"
  | "project"
  | "short_term"
  | "long_term"
  | "document";

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  confidence: number;
  shouldPromote: boolean;
}

export interface MemoryUpdate {
  existingContent: string; // substring to match existing memory
  updatedContent: string;
  confidence: number;
}

export interface TaskUpdate {
  title?: string;
  goal?: string;
  currentStep?: string;
  completedSteps?: string[];
  openQuestions?: string[];
  decisions?: string[];
  nextActions?: string[];
}

export interface ExtractionResult {
  newMemories: ExtractedMemory[];
  memoryUpdates: MemoryUpdate[];
  taskUpdates: TaskUpdate | null;
  conversationSummaryUpdate: string;
  doNotStore: string[];
  confidence: number;
}

const EXTRACTION_SCHEMA = `{
  "new_memories": [{"type":"preference|semantic|episodic|behavioral|anti_preference|correction|response_style|project|short_term|long_term|document","content":"concise fact","confidence":0.0-1.0}],
  "memory_updates": [{"existing_content":"substring of existing memory to update","updated_content":"new version","confidence":0.0-1.0}],
  "task_updates": {"title":"string","goal":"string","current_step":"string","completed_steps":["..."],"open_questions":["..."],"decisions":["..."],"next_actions":["..."]} | null,
  "conversation_summary_update": "one-sentence summary of this exchange, or empty string",
  "do_not_store": ["reasons why certain items were NOT stored"],
  "confidence": 0.0-1.0
}`;

export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  modelId = "gpt-4o-mini",
): Promise<ExtractedMemory[]> {
  const result = await extractFullMemory(userMessage, assistantResponse, modelId);
  return result.newMemories;
}

export async function extractFullMemory(
  userMessage: string,
  assistantResponse: string,
  modelId = "gpt-4o-mini",
): Promise<ExtractionResult> {
  const empty: ExtractionResult = {
    newMemories: [],
    memoryUpdates: [],
    taskUpdates: null,
    conversationSummaryUpdate: "",
    doNotStore: [],
    confidence: 0,
  };

  const key = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return empty;

  const useAnthropic = !process.env.OPENAI_API_KEY && !!process.env.ANTHROPIC_API_KEY;

  try {
    const prompt = `Analyze this conversation exchange and extract structured memory data.

EXTRACT only durable, future-relevant facts. DO NOT store:
- Temporary formatting instructions
- Facts from retrieved/cited sources (those belong in the source system)
- Intermediate reasoning steps
- Sensitive data (SSNs, passwords, financial account numbers)
- Generic pleasantries

MEMORY TYPES:
- preference: user likes/prefers something
- anti_preference: user dislikes/avoids something
- correction: user correcting a past AI assumption
- behavioral: how the user typically acts/works
- response_style: preferred AI response format/tone
- project: project/task context facts
- episodic: important event/decision from this exchange
- semantic: factual knowledge about user/domain
- long_term: stable identity facts (name, role, company)
- short_term: temporary context relevant only within this conversation (NOT for permanent storage)
- document: key fact extracted from an uploaded document

TASK UPDATES: if the conversation is working on a specific goal/project,
extract structured task progress updates.

Return ONLY valid JSON matching this schema exactly:
${EXTRACTION_SCHEMA}

User: ${userMessage.slice(0, 1000)}
Assistant: ${assistantResponse.slice(0, 600)}`;

    let raw = "";
    if (useAnthropic) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });
      const res = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system:
          "You are a memory extraction engine. Return ONLY valid JSON, no markdown, no explanation.",
        messages: [{ role: "user", content: prompt }],
      });
      const block = res.content[0];
      raw = block?.type === "text" ? block.text.trim() : "{}";
    } else {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 800,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You are a memory extraction engine. Return ONLY valid JSON.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return empty;
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      raw = json.choices[0]?.message?.content?.trim() ?? "{}";
    }

    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed: {
      new_memories?: { type: MemoryType; content: string; confidence: number }[];
      memory_updates?: { existing_content: string; updated_content: string; confidence: number }[];
      task_updates?: Record<string, unknown> | null;
      conversation_summary_update?: string;
      do_not_store?: string[];
      confidence?: number;
    };

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return empty;
    }

    const newMemories: ExtractedMemory[] = (parsed.new_memories ?? [])
      .filter((m) => m.confidence >= 0.6 && m.content?.length > 5)
      .map((m) => ({
        type: m.type,
        content: m.content.slice(0, 500),
        confidence: m.confidence,
        // short_term memories are conversation-scoped and must never be promoted
        shouldPromote: m.confidence >= 0.8 && m.type !== "short_term",
      }));

    const memoryUpdates: MemoryUpdate[] = (parsed.memory_updates ?? [])
      .filter((u) => u.existing_content && u.updated_content)
      .map((u) => ({
        existingContent: u.existing_content,
        updatedContent: u.updated_content.slice(0, 500),
        confidence: u.confidence ?? 0.7,
      }));

    let taskUpdates: TaskUpdate | null = null;
    if (parsed.task_updates && typeof parsed.task_updates === "object") {
      const tu = parsed.task_updates as Record<string, unknown>;
      taskUpdates = {
        title: typeof tu.title === "string" ? tu.title : undefined,
        goal: typeof tu.goal === "string" ? tu.goal : undefined,
        currentStep: typeof tu.current_step === "string" ? tu.current_step : undefined,
        completedSteps: Array.isArray(tu.completed_steps)
          ? (tu.completed_steps as string[]).filter((s) => typeof s === "string")
          : undefined,
        openQuestions: Array.isArray(tu.open_questions)
          ? (tu.open_questions as string[]).filter((s) => typeof s === "string")
          : undefined,
        decisions: Array.isArray(tu.decisions)
          ? (tu.decisions as string[]).filter((s) => typeof s === "string")
          : undefined,
        nextActions: Array.isArray(tu.next_actions)
          ? (tu.next_actions as string[]).filter((s) => typeof s === "string")
          : undefined,
      };
      // Discard empty task updates
      const hasAnyField = Object.values(taskUpdates).some(
        (v) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true),
      );
      if (!hasAnyField) taskUpdates = null;
    }

    return {
      newMemories,
      memoryUpdates,
      taskUpdates,
      conversationSummaryUpdate:
        typeof parsed.conversation_summary_update === "string"
          ? parsed.conversation_summary_update.slice(0, 300)
          : "",
      doNotStore: Array.isArray(parsed.do_not_store) ? (parsed.do_not_store as string[]) : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
    };
  } catch {
    return empty;
  }
}

// Detect if user is making a correction in their message
export function detectCorrection(userMessage: string): boolean {
  return (
    /\b(no,?\s+i\s+meant|that'?s\s+(wrong|incorrect)|actually[,\s])/i.test(userMessage) ||
    /\b(not\s+quite|i\s+said|you\s+misunderstood)\b/i.test(userMessage)
  );
}

// Detect rephrasing (same question worded differently) — Jaccard similarity on word sets.
export function detectRephrasing(
  newMessage: string,
  previousMessages: string[],
  threshold = 0.8,
): boolean {
  const newWords = new Set(tokenize(newMessage));
  for (const prev of previousMessages.slice(-3)) {
    const prevWords = new Set(tokenize(prev));
    const intersection = new Set([...newWords].filter((w) => prevWords.has(w)));
    const union = new Set([...newWords, ...prevWords]);
    if (union.size > 0 && intersection.size / union.size >= threshold) return true;
  }
  return false;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}
