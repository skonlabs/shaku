/**
 * HistoryCompressor — keeps the last N turns verbatim and collapses older
 * turns into a compact memory block via extractive summarisation.
 *
 * No API calls are made; summarisation is pure deterministic TypeScript.
 */
import { TokenCounter } from "./token-counter";
import type { Message } from "./types";

// ---------------------------------------------------------------------------
// Stop-words for frequency scoring
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","shall","can",
  "must","that","this","these","those","it","its","they","them","their","we",
  "our","you","your","i","my","he","she","his","her","not","no","so","if","as",
  "up","out","what","which","who","how","when","where","why","all","more",
  "also","than","then","about","into","through","over","after","before","just",
  "only","very",
]);

// ---------------------------------------------------------------------------
// Extractive summariser (deterministic, no API calls)
// ---------------------------------------------------------------------------
export class ExtractiveSummarizer {
  /**
   * Return an extractive summary selecting the most informative sentences.
   * Texts with ≤ maxSentences sentences are returned as-is.
   */
  summarize(text: string, maxSentences = 5, maxChars?: number): string {
    if (!text) return text;
    const sentences = this.splitSentences(text);
    if (!sentences.length) return text;

    if (sentences.length <= maxSentences) {
      return this.maybeTruncate(text, maxChars);
    }

    const scores = this.scoreSentences(sentences);
    const rankedIndices = [...scores.keys()]
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, maxSentences)
      .sort((a, b) => a - b); // restore original order

    const summary = rankedIndices.map((i) => sentences[i]).join(" ");
    return this.maybeTruncate(summary, maxChars);
  }

  // ------------------------------------------------------------------

  private splitSentences(text: string): string[] {
    // Sentence splitter that protects common abbreviations, decimals, and URLs.
    // Strategy: temporarily mask "fragile" dots, split, then unmask.
    const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|St|Inc|Ltd|Co|Corp|vs|etc|e\.g|i\.e|a\.m|p\.m|U\.S|U\.K)\.\s+/gi;
    const URL_DOT = /(https?:\/\/[^\s]*?)\.(\s)/g;
    const DECIMAL = /(\d)\.(\d)/g;
    let masked = text
      .replace(ABBREV, (m) => m.replace(/\./g, "§DOT§"))
      .replace(URL_DOT, (_, a, b) => `${a}§DOT§${b}`)
      .replace(DECIMAL, (_, a, b) => `${a}§DOT§${b}`);
    const sentences = masked
      .trim()
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/§DOT§/g, "."))
      .filter(Boolean);
    return sentences;
  }

  private scoreSentences(sentences: string[]): number[] {
    const allWords = sentences.flatMap((s) => this.tokenize(s));
    const freq = new Map<string, number>();
    for (const w of allWords) freq.set(w, (freq.get(w) ?? 0) + 1);

    const maxFreq = Math.max(...freq.values(), 1);
    const n = sentences.length;

    return sentences.map((sent, i) => {
      const words = this.tokenize(sent);
      if (!words.length) return 0;

      const freqScore =
        words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / maxFreq / words.length;

      const posBonus = i === 0 ? 0.2 : i === n - 1 ? 0.15 : 0;
      const lengthScore = Math.min(1, words.length / 20) * 0.05;

      return freqScore + posBonus + lengthScore;
    });
  }

  private tokenize(text: string): string[] {
    // Allow 2+ char alphanumeric tokens (was [a-z]{3,} which dropped "go", "ai", "sdk").
    return (text.toLowerCase().match(/\b[a-z0-9]{2,}\b/g) ?? []).filter(
      (w) => !STOP_WORDS.has(w),
    );
  }

  private maybeTruncate(text: string, maxChars?: number): string {
    if (maxChars !== undefined && text.length > maxChars) {
      const cut = text.lastIndexOf(" ", maxChars);
      return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars)) + "…";
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// History compressor
// ---------------------------------------------------------------------------

type Turn = [Message, Message | null]; // [user/lone-msg, optional assistant]

export class HistoryCompressor {
  private readonly summarizer = new ExtractiveSummarizer();

  constructor(
    private readonly counter: TokenCounter,
    private readonly keepTurns = 10,
  ) {}

  /**
   * Return a compressed message list:
   *   - System messages preserved verbatim
   *   - Most recent keepTurns user/assistant turns preserved verbatim
   *   - Older turns collapsed into one summary block
   *   - Result further trimmed to tokenBudget if provided
   */
  compress(messages: Message[], tokenBudget?: number): Message[] {
    if (!messages.length) return messages;

    const systemMsgs = messages.filter((m) => m.role === "system");
    const convMsgs   = messages.filter((m) => m.role !== "system");
    const turns      = this.pairTurns(convMsgs);

    if (turns.length <= this.keepTurns) {
      if (tokenBudget != null) return this.trimToTokenBudget(messages, tokenBudget, systemMsgs);
      return messages;
    }

    const oldTurns    = turns.slice(0, -this.keepTurns);
    const recentTurns = turns.slice(-this.keepTurns);

    const summaryText = this.summarizeTurns(oldTurns);
    // Use assistant role to preserve user/assistant alternation when the next real
    // message is also "user" — Anthropic rejects two consecutive user messages.
    const memoryMsg: Message = {
      role: "assistant",
      content: `[Earlier conversation summary — for context only, do not respond to this]\n${summaryText}`,
    };

    const recentMsgs = recentTurns.flatMap(([u, a]) => (a ? [u, a] : [u]));
    const result = [...systemMsgs, memoryMsg, ...recentMsgs];

    return tokenBudget != null ? this.trimToTokenBudget(result, tokenBudget, systemMsgs) : result;
  }

  // ------------------------------------------------------------------

  private pairTurns(messages: Message[]): Turn[] {
    const turns: Turn[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === "user" && i + 1 < messages.length && messages[i + 1].role === "assistant") {
        turns.push([msg, messages[i + 1]]);
        i += 2;
      } else {
        turns.push([msg, null]);
        i++;
      }
    }
    return turns;
  }

  private summarizeTurns(turns: Turn[]): string {
    const lines = turns.flatMap(([u, a]) => {
      const parts = [`User: ${u.content.slice(0, 400)}`];
      if (a) parts.push(`Assistant: ${a.content.slice(0, 400)}`);
      return parts;
    });
    return this.summarizer.summarize(lines.join("\n"), 10, 900);
  }

  private trimToTokenBudget(
    messages: Message[],
    budget: number,
    systemMsgs: Message[],
  ): Message[] {
    const result = [...messages];

    while (
      this.counter.countMessages(result) > budget &&
      result.length > systemMsgs.length + 1
    ) {
      const idx = result.findIndex((m) => m.role !== "system");
      if (idx === -1) break;
      result.splice(idx, 1);
    }

    return result;
  }
}
