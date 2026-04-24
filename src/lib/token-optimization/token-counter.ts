/**
 * TokenCounter — deterministic token counting for Cloudflare Workers.
 *
 * Uses a 4 chars-per-token approximation consistent with the rest of the
 * project (src/lib/tokens.ts). No WASM / tiktoken required.
 */

const CHARS_PER_TOKEN = 4;

/** Per-provider framing overhead (tokens added per message for role metadata). */
const MSG_OVERHEAD: Record<string, number> = {
  openai: 4,     // per OpenAI token-counting cookbook
  anthropic: 5,  // slightly higher for Anthropic's XML-style framing
};

export class TokenCounter {
  /** Count tokens in a single text string. */
  count(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
  }

  /**
   * Count total tokens for a messages array including role-framing overhead.
   *
   * Overhead model (OpenAI):
   *   3 tokens reply-priming + 4 per message for role framing.
   */
  countMessages(messages: Array<{ role: string; content: string }>, provider = "openai"): number {
    const overhead = MSG_OVERHEAD[provider] ?? 4;
    let total = 3; // reply-priming
    for (const msg of messages) {
      total += overhead;
      total += this.count(msg.content ?? "");
    }
    return total;
  }

  /**
   * Convert a token budget into a safe character limit.
   * Uses a slightly conservative 3.8 chars-per-token ratio.
   */
  estimateCharBudget(tokenBudget: number): number {
    return Math.floor(tokenBudget * 3.8);
  }
}
