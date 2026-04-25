// Token estimation for Cloudflare Workers (no WASM js-tiktoken needed).
// 1 token ≈ 4 characters for English text — close enough for context budget decisions.
// Actual billing uses provider-reported counts from API responses.

const CHARS_PER_TOKEN = 4;

export function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countTokensMessages(messages: { role: string; content: string }[]): number {
  // Every message adds ~4 tokens overhead (role framing)
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 3);
}

// Model context windows (input tokens)
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
};

// Model output limits
export const MODEL_MAX_OUTPUT: Record<string, number> = {
  "claude-haiku-4-5-20251001": 8_192,
  "claude-sonnet-4-6": 64_000,
  "claude-opus-4-7": 32_000,
  "gpt-4o-mini": 16_384,
  "gpt-4o": 16_384,
};

// Cost per million tokens (input / output), USD
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 5.0, output: 15.0 },
};

export function estimateCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const costs = MODEL_COSTS[modelId];
  if (!costs) return 0;
  return (tokensIn * costs.input + tokensOut * costs.output) / 1_000_000;
}

export function fitsInContext(modelId: string, estimatedTokens: number): boolean {
  const window = MODEL_CONTEXT_WINDOWS[modelId] ?? 128_000;
  return estimatedTokens < window * 0.9; // 10% safety margin
}
