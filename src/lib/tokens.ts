// Token estimation for Cloudflare Workers (no WASM / tiktoken required).
//
// Heuristic (tuned to be conservative — better to slightly over-estimate than
// blow the model's context window):
//   - Base ratio: 3.5 chars/token (closer to real BPE for English prose + code
//     than the old 4.0; code/JSON have higher punctuation density).
//   - Non-ASCII multiplier (1.6×): CJK and other non-Latin scripts tokenize
//     to ~1 token per character. We blend by the share of non-ASCII chars.
//   - Floor of 1 token for any non-empty string.
//
// Actual billing uses provider-reported counts from API responses; this is
// only used for routing/budget decisions where over-estimating is safer.

const BASE_CHARS_PER_TOKEN = 3.5;
const NON_ASCII_MULTIPLIER = 1.6;
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/g;

export function countTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const nonAscii = (text.match(NON_ASCII_RE) ?? []).length;
  const nonAsciiShare = nonAscii / len;
  // Effective multiplier: 1.0 for pure ASCII, up to NON_ASCII_MULTIPLIER for all non-ASCII
  const multiplier = 1 + (NON_ASCII_MULTIPLIER - 1) * nonAsciiShare;
  return Math.max(1, Math.ceil((len / BASE_CHARS_PER_TOKEN) * multiplier));
}

export function countTokensMessages(messages: { role: string; content: string }[]): number {
  // Every message adds ~4 tokens overhead (role framing); +3 for reply priming
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 3);
}

// Model context windows (input tokens)
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
};

// Model output limits — used for capping max_tokens in LLM calls
export const MODEL_MAX_OUTPUT: Record<string, number> = {
  "claude-haiku-4-5-20251001": 8_192,
  "claude-sonnet-4-6": 64_000,
  "claude-opus-4-7": 32_000,
  "gpt-4o-mini": 16_384,
  "gpt-4o": 16_384,
  "gemini-2.0-flash": 8_192,
  "gemini-1.5-pro": 8_192,
  "gemini-1.5-flash": 8_192,
};

// Cost per million tokens (input / output), USD
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
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
