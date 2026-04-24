// text-embedding-3-small: 1536 dimensions, $0.02/M tokens
// Uses raw fetch to stay compatible with Cloudflare Workers

const EMBED_MODEL = "text-embedding-3-small";

export async function embed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Embedding failed (${res.status}): ${err.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

// Batch embedding: up to 100 texts per call
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const results: number[][] = [];
  // Process in batches of 100
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Batch embedding failed (${res.status}): ${err.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Sort by index to preserve order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    results.push(...sorted.map((d) => d.embedding));
  }
  return results;
}

// Format a float[] as a PostgreSQL vector literal for use in RPC calls
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
