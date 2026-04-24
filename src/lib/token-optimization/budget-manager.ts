/**
 * BudgetManager — enforces token budgets and computes dynamic output limits.
 *
 * Rules:
 *  - System messages are NEVER removed or truncated.
 *  - The most recent user message is NEVER removed (may be truncated last-resort).
 *  - Oldest non-system messages are dropped first.
 *  - Sensitive content uses tail-truncation only (no extractive summarisation).
 */
import { ExtractiveSummarizer } from "./history-compressor";
import { TokenCounter } from "./token-counter";
import type { Message, TaskType, TokenBudget } from "./types";

// ---------------------------------------------------------------------------
// Dynamic output-token limits per task type
// ---------------------------------------------------------------------------
export const TASK_OUTPUT_TOKENS: Record<TaskType, number> = {
  classification: 50,
  extraction:     150,
  summarization:  300,
  generation:     800,
  reasoning:      1_200,
  coding:         1_200,
};

const DEFAULT_OUTPUT_TOKENS = 800;

export class BudgetManager {
  private readonly summarizer = new ExtractiveSummarizer();

  constructor(
    private readonly budget: TokenBudget,
    private readonly counter: TokenCounter,
  ) {}

  /** Recommended max_tokens for the given task type, capped by budget. */
  getOutputTokens(taskType?: TaskType): number {
    const limit = taskType ? (TASK_OUTPUT_TOKENS[taskType] ?? DEFAULT_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
    return Math.min(limit, this.budget.maxOutputTokens);
  }

  checkInput(tokens: number): boolean { return tokens <= this.budget.maxInputTokens; }
  checkOutput(tokens: number): boolean { return tokens <= this.budget.maxOutputTokens; }
  checkTotal(input: number, output: number): boolean {
    return input + output <= this.budget.maxTotalTokens;
  }

  /**
   * Trim messages to fit maxInputTokens.
   * Returns { messages, warnings }.
   */
  enforceInputBudget(
    messages: Message[],
    provider = "openai",
  ): { messages: Message[]; warnings: string[] } {
    const warnings: string[] = [];
    const current = this.counter.countMessages(messages, provider);

    if (current <= this.budget.maxInputTokens) return { messages, warnings };

    warnings.push(
      `Input (${current} tokens) exceeds budget (${this.budget.maxInputTokens} tokens). Trimming oldest messages.`,
    );

    const systemMsgs = messages.filter((m) => m.role === "system");
    let convMsgs     = messages.filter((m) => m.role !== "system");

    // Drop from front while over budget (keep at least 1 conv message)
    while (convMsgs.length > 1) {
      const test = [...systemMsgs, ...convMsgs];
      if (this.counter.countMessages(test, provider) <= this.budget.maxInputTokens) {
        return { messages: test, warnings };
      }
      convMsgs = convMsgs.slice(1);
    }

    // Last resort: truncate the remaining message's content
    if (convMsgs.length) {
      const sysTokens = systemMsgs.length
        ? this.counter.countMessages(systemMsgs, provider)
        : 3;
      const available = Math.max(100, this.budget.maxInputTokens - sysTokens - 30);
      const charLimit = this.counter.estimateCharBudget(available);
      const last = convMsgs[0];

      if (last.content.length > charLimit) {
        convMsgs = [{
          ...last,
          content: last.content.slice(0, charLimit).trimEnd() + " …[truncated to fit token budget]",
        }];
        warnings.push("Last message was truncated to fit within the token budget.");
      }
    }

    return { messages: [...systemMsgs, ...convMsgs], warnings };
  }

  /**
   * Compress a single oversized message.
   * Returns { message, wasCompressed }.
   */
  compressMessage(
    message: Message,
    maxTokens: number,
    isSensitive = false,
  ): { message: Message; wasCompressed: boolean } {
    if (this.counter.count(message.content) <= maxTokens) {
      return { message, wasCompressed: false };
    }

    const charLimit = this.counter.estimateCharBudget(maxTokens);

    if (isSensitive) {
      const truncated = message.content.slice(0, charLimit) +
        "\n…[content truncated — sensitive domain detected]";
      return { message: { ...message, content: truncated }, wasCompressed: true };
    }

    const compressed = this.summarizer.summarize(message.content, 12, charLimit);
    return { message: { ...message, content: compressed }, wasCompressed: true };
  }
}
