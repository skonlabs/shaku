/**
 * TokenCounter — deterministic token counting for Cloudflare Workers.
 *
 * Delegates to the canonical heuristic in src/lib/tokens.ts (3.5 chars/token
 * with non-ASCII multiplier) so all budget decisions in the codebase agree.
 */

import { countTokens } from "@/lib/tokens";

/** Per-provider framing overhead (tokens added per message for role metadata). */
const MSG_OVERHEAD: Record<string, number> = {
  openai: 4, // per OpenAI token-counting cookbook
  anthropic: 5, // slightly higher for Anthropic's XML-style framing
};

export class TokenCounter {
  /** Count tokens in a single text string. */
  count(text: string): number {
    return countTokens(text ?? "");
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
   * Uses a conservative 3.0 chars-per-token ratio so the resulting char cap
   * never exceeds the token budget when re-counted.
   */
  estimateCharBudget(tokenBudget: number): number {
    return Math.floor(tokenBudget * 3.0);
  }
}
