// Memory classifier: extracts memories from conversation exchanges.
// Confidence >0.8 → auto-create. 0.6–0.8 → suggest. <0.6 → skip.

export type MemoryType =
  | "preference"
  | "semantic"
  | "episodic"
  | "behavioral"
  | "anti_preference"
  | "correction"
  | "response_style"
  | "project";

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  confidence: number;
  shouldPromote: boolean; // whether to immediately save vs. suggest
}

// Promotion criteria: what should NOT become long-term memory
const DO_NOT_PROMOTE = [
  "temporary formatting instruction",
  "factual claim from retrieved source",
  "intermediate reasoning step",
];

export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  modelId = "gpt-4o-mini",
): Promise<ExtractedMemory[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 512,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Analyze this conversation exchange and extract memories worth storing long-term.

ONLY extract:
- User preferences ("I prefer...", "I like...", "I always...")
- Personal facts about the user (name, role, company, projects)
- Corrections the user makes about the AI's assumptions
- Decisions the user made
- Project milestones mentioned

DO NOT extract:
- Facts from retrieved sources (those live in source systems)
- Temporary formatting instructions
- Intermediate reasoning

Return JSON array: [{"type":"preference"|"semantic"|"episodic"|"correction"|"project","content":"concise statement","confidence":0.0-1.0}]
If nothing to extract, return []

User: ${userMessage.slice(0, 800)}
Assistant: ${assistantResponse.slice(0, 400)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const raw = json.choices[0]?.message?.content?.trim() ?? "[]";

    let parsed: { type: MemoryType; content: string; confidence: number }[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }

    return parsed
      .filter((m) => m.confidence >= 0.6 && m.content?.length > 5)
      .map((m) => ({
        type: m.type,
        content: m.content.slice(0, 500),
        confidence: m.confidence,
        shouldPromote: m.confidence >= 0.8,
      }));
  } catch {
    return [];
  }
}

// Detect if user is making a correction in their message
export function detectCorrection(userMessage: string): boolean {
  return /\b(no,?\s+i\s+meant|that'?s\s+(wrong|incorrect)|actually[,\s]/i.test(userMessage) ||
    /\b(not\s+quite|i\s+said|you\s+misunderstood)\b/i.test(userMessage);
}

// Detect rephrasing (same question worded differently)
export function detectRephrasing(
  newMessage: string,
  previousMessages: string[],
  threshold = 0.8,
): boolean {
  // Simple overlap-based similarity (Jaccard on word sets)
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
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
}
