/**
 * TokenOptimizationMiddleware — provider-agnostic orchestrator.
 *
 * Pipeline (per request):
 *  1.  Merge explicit systemPrompt into messages.
 *  2.  Count tokens BEFORE.
 *  3.  Detect sensitive-domain content → skip aggressive compression.
 *  4.  Auto-detect task type from the last user message (if not provided).
 *  5.  Clean each message (whitespace, duplicates, boilerplate).
 *  6.  Compress history (keep last N turns, summarise older ones).
 *  7.  Prune and inject context documents (BM25 top-K, budget).
 *  8.  Normalise prompts (verbose phrase replacement).
 *  9.  Enforce input token budget.
 * 10.  Determine dynamic max_output_tokens.
 * 11.  Count tokens AFTER and log savings.
 * 12.  Return OptimizationResult.
 *
 * Usage (OpenAI):
 *   const mw = new TokenOptimizationMiddleware();
 *   const { messages, maxTokens, _opt } = mw.forOpenAI(rawMessages, { taskType: "summarization" });
 *   const response = await openai.chat.completions.create({ model: "gpt-4o", messages, max_tokens: maxTokens });
 *
 * Usage (Anthropic):
 *   const mw = new TokenOptimizationMiddleware({ provider: "anthropic" });
 *   const { system, messages, maxTokens } = mw.forAnthropic(rawMessages, { system: "You are helpful." });
 *   const response = await anthropic.messages.create({ model: "claude-sonnet-4-6", system, messages, max_tokens: maxTokens });
 */

import { BudgetManager } from "./budget-manager";
import { CacheLayer } from "./cache-layer";
import { ContextPruner } from "./context-pruner";
import { HistoryCompressor } from "./history-compressor";
import { InputCleaner } from "./input-cleaner";
import { PromptNormalizer } from "./prompt-normalizer";
import { TokenCounter } from "./token-counter";
import { defaultConfig } from "./types";
import type { Message, OptimizationConfig, OptimizationResult, TaskType } from "./types";

export interface OpenAIPayload {
  messages: Message[];
  max_tokens: number;
  /** Audit metadata — strip before forwarding to the SDK if desired. */
  _opt: OptimizationAudit;
}

export interface AnthropicPayload {
  system?: string;
  messages: Message[];
  max_tokens: number;
  _opt: OptimizationAudit;
}

export interface OptimizationAudit {
  tokensBefore: number;
  tokensAfter:  number;
  savingsTokens: number;
  savingsPct:   number;
  warnings:     string[];
  cacheHits:    number;
}

export interface ProcessOptions {
  documents?: string[];
  taskType?:  TaskType;
  systemPrompt?: string;
}

export class TokenOptimizationMiddleware {
  private readonly cfg:      OptimizationConfig;
  private readonly counter:  TokenCounter;
  private readonly cleaner:  InputCleaner;
  private readonly norm:     PromptNormalizer;
  private readonly history:  HistoryCompressor;
  private readonly pruner:   ContextPruner;
  private readonly budget:   BudgetManager;
  private readonly cache:    CacheLayer | null;

  constructor(config?: Partial<OptimizationConfig>) {
    this.cfg     = defaultConfig(config);
    this.counter = new TokenCounter();
    this.cleaner = new InputCleaner();
    this.norm    = new PromptNormalizer();
    this.history = new HistoryCompressor(this.counter, this.cfg.historyKeepTurns);
    this.pruner  = new ContextPruner(
      this.counter,
      this.cfg.chunkSizeTokens,
      this.cfg.chunkOverlapTokens,
      this.cfg.contextTopKChunks,
    );
    this.budget = new BudgetManager(this.cfg.budget, this.counter);
    this.cache  = this.cfg.enableCaching ? new CacheLayer() : null;
  }

  // ------------------------------------------------------------------
  // Core pipeline
  // ------------------------------------------------------------------

  process(messages: Message[], opts: ProcessOptions = {}): OptimizationResult {
    const warnings: string[] = [];
    let cacheHits = 0;

    // Step 1 — merge explicit system prompt
    let msgs = [...messages];
    if (opts.systemPrompt && (msgs.length === 0 || msgs[0].role !== "system")) {
      msgs.unshift({ role: "system", content: opts.systemPrompt });
    }

    // Step 2 — token count BEFORE
    const tokensBefore = this.counter.countMessages(msgs, this.cfg.provider);

    // Step 3 — sensitive-domain detection
    const fullText = msgs.map((m) => m.content).join(" ");
    const { isSensitive, matchedDomains } = this.cleaner.checkSensitivity(
      fullText, this.cfg.sensitiveDomains,
    );
    if (isSensitive) {
      warnings.push(
        `Sensitive content detected (domains: ${matchedDomains.join(", ")}). ` +
        "Aggressive compression skipped; only safe cleaning applied.",
      );
    }

    // Step 4 — auto-detect task type
    let effectiveTask = opts.taskType ?? this.cfg.taskType;
    if (!effectiveTask) {
      const lastUser = this.lastUserContent(msgs);
      effectiveTask = this.norm.extractTaskTypeHint(lastUser);
    }

    // Step 5 — clean inputs
    if (this.cfg.enableCleaning) {
      const { cleaned, hits } = this.cleanMessages(msgs, isSensitive);
      msgs = cleaned;
      cacheHits += hits;
    }

    // Step 6 — compress history
    if (this.cfg.enableHistoryTrimming) {
      msgs = this.history.compress(msgs, this.cfg.budget.maxInputTokens);
    }

    // Step 7 — prune and inject context documents
    if (opts.documents?.length && this.cfg.enableContextPruning) {
      const query  = this.lastUserContent(msgs);
      const budget = Math.max(200, Math.floor(this.cfg.budget.maxInputTokens / 3));
      const pruned = this.pruner.prune(opts.documents, query, budget);
      if (pruned.length) {
        msgs = this.injectContext(msgs, pruned.join("\n\n---\n\n"));
      }
    }

    // Step 8 — normalise prompts (skip for sensitive content)
    if (this.cfg.enableNormalization && !isSensitive) {
      msgs = msgs.map((m) =>
        m.role === "system" ? m : { ...m, content: this.norm.normalize(m.content) },
      );
    }

    // Step 9 — enforce input budget
    const { messages: budgetMsgs, warnings: budgetWarnings } =
      this.budget.enforceInputBudget(msgs, this.cfg.provider);
    msgs = budgetMsgs;
    warnings.push(...budgetWarnings);

    // Step 10 — separate system prompt for output
    let systemPrompt: string | null = null;
    const finalMessages: Message[] = [];
    for (const m of msgs) {
      if (m.role === "system") {
        systemPrompt = systemPrompt ? systemPrompt + "\n" + m.content : m.content;
      } else {
        finalMessages.push(m);
      }
    }

    // Step 11 — dynamic output tokens
    const maxOutputTokens = this.budget.getOutputTokens(effectiveTask);

    // Step 12 — token count AFTER
    const tokensAfter = this.counter.countMessages(msgs, this.cfg.provider);
    const savingsTokens = Math.max(0, tokensBefore - tokensAfter);
    const savingsPct = tokensBefore > 0
      ? Math.round((savingsTokens / tokensBefore) * 10_000) / 100
      : 0;

    console.info(
      `[TokenOpt] ${tokensBefore} → ${tokensAfter} tokens (saved ${savingsTokens}, ${savingsPct}%) | ` +
      `task=${effectiveTask ?? "auto"} | sensitive=${isSensitive} | cacheHits=${cacheHits}`,
    );

    return {
      messages: finalMessages,
      systemPrompt,
      maxOutputTokens,
      inputTokensBefore: tokensBefore,
      inputTokensAfter:  tokensAfter,
      savingsTokens,
      savingsPct,
      warnings,
      cacheHits,
    };
  }

  // ------------------------------------------------------------------
  // Provider-specific convenience wrappers
  // ------------------------------------------------------------------

  /** Returns a payload ready for openai.chat.completions.create(). */
  forOpenAI(
    messages: Array<{ role: string; content: string }>,
    opts: ProcessOptions = {},
  ): OpenAIPayload {
    const typed  = messages.map(this.coerceMessage);
    const result = this.process(typed, opts);

    const outMessages: Message[] = [];
    if (result.systemPrompt) outMessages.push({ role: "system", content: result.systemPrompt });
    outMessages.push(...result.messages);

    return {
      messages:   outMessages,
      max_tokens: result.maxOutputTokens,
      _opt:       this.auditFrom(result),
    };
  }

  /** Returns a payload ready for anthropic.messages.create(). */
  forAnthropic(
    messages: Array<{ role: string; content: string }>,
    opts: ProcessOptions & { system?: string } = {},
  ): AnthropicPayload {
    const { system: explicitSystem, ...rest } = opts;
    const typed  = messages.map(this.coerceMessage);
    const result = this.process(typed, { ...rest, systemPrompt: explicitSystem });

    const payload: AnthropicPayload = {
      messages:   result.messages,
      max_tokens: result.maxOutputTokens,
      _opt:       this.auditFrom(result),
    };
    if (result.systemPrompt) payload.system = result.systemPrompt;
    return payload;
  }

  cacheStats(): Record<string, unknown> {
    return this.cache ? { enabled: true, ...this.cache.stats() } : { enabled: false };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private cleanMessages(
    messages: Message[],
    isSensitive: boolean,
  ): { cleaned: Message[]; hits: number } {
    let hits = 0;
    const cleaned = messages.map((msg): Message => {
      if (msg.role === "system") {
        return { ...msg, content: this.cleaner.normaliseWhitespace(msg.content) };
      }
      const cached = this.cache?.getClean(msg.content);
      if (cached !== undefined) { hits++; return { ...msg, content: cached }; }

      const result = this.cleaner.clean(msg.content, isSensitive);
      this.cache?.setClean(msg.content, result);
      return { ...msg, content: result };
    });
    return { cleaned, hits };
  }

  private injectContext(messages: Message[], contextBlock: string): Message[] {
    const result = [...messages];
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "user") {
        result[i] = { ...result[i], content: result[i].content + `\n\n[Relevant context]\n${contextBlock}` };
        return result;
      }
    }
    return result;
  }

  private lastUserContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content.slice(0, 500);
    }
    return "";
  }

  private coerceMessage = (m: { role: string; content: string }): Message => ({
    role:    m.role as Message["role"],
    content: typeof m.content === "string" ? m.content : String(m.content),
  });

  private auditFrom(r: OptimizationResult): OptimizationAudit {
    return {
      tokensBefore:  r.inputTokensBefore,
      tokensAfter:   r.inputTokensAfter,
      savingsTokens: r.savingsTokens,
      savingsPct:    r.savingsPct,
      warnings:      r.warnings,
      cacheHits:     r.cacheHits,
    };
  }
}
