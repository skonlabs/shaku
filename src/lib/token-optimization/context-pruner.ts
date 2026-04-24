/**
 * ContextPruner — splits documents into overlapping chunks, ranks them by
 * BM25 relevance against a query, and returns the top-K chunks that fit
 * within a token budget (in original document order).
 *
 * No API calls; all scoring is deterministic.
 */
import { TokenCounter } from "./token-counter";

// ---------------------------------------------------------------------------
// Stop-words for BM25 tokenisation
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","have","do","it","its","this","that",
  "these","those","as","up","if","so","we","you","he","she","they","not","no",
  "all","more","also","than","then","i","my","me","our","us","your","his",
  "her","their","can","will","just","been","has","had",
]);

interface Chunk {
  text: string;
  score: number;
  sourceIndex: number;
  chunkIndex: number;
}

export class ContextPruner {
  // BM25 hyper-parameters
  private readonly K1 = 1.5;
  private readonly B  = 0.75;

  constructor(
    private readonly counter: TokenCounter,
    private readonly chunkSizeTokens = 512,
    private readonly overlapTokens = 64,
    private readonly topK = 5,
  ) {}

  /**
   * Return the most relevant chunks in original document order.
   * If tokenBudget is provided, chunks are greedily included until it's full.
   */
  prune(documents: string[], query: string, tokenBudget?: number): string[] {
    if (!documents.length) return [];
    const effectiveQuery = query.trim() || "the";

    const allChunks: Chunk[] = documents.flatMap((doc, i) =>
      this.chunkDocument(doc, i),
    );
    if (!allChunks.length) return [];

    const ranked = this.rankBM25(allChunks, effectiveQuery);
    let selected = ranked.slice(0, this.topK);
    if (tokenBudget != null) selected = this.applyBudget(selected, tokenBudget);

    // Restore document order
    selected.sort((a, b) => a.sourceIndex - b.sourceIndex || a.chunkIndex - b.chunkIndex);
    return selected.map((c) => c.text);
  }

  // ------------------------------------------------------------------
  // Chunking
  // ------------------------------------------------------------------

  private chunkDocument(text: string, docIdx: number): Chunk[] {
    if (!text.trim()) return [];

    const paragraphs = text.trim().split(/\n\n+/);
    const chunks: Chunk[] = [];
    let currentParas: string[] = [];
    let currentTokens = 0;
    let chunkIdx = 0;

    const flush = () => {
      if (!currentParas.length) return;
      chunks.push({ text: currentParas.join("\n\n"), score: 0, sourceIndex: docIdx, chunkIndex: chunkIdx++ });
      if (this.overlapTokens > 0 && currentParas.length) {
        const last = currentParas[currentParas.length - 1];
        currentParas = [last];
        currentTokens = this.counter.count(last);
      } else {
        currentParas = [];
        currentTokens = 0;
      }
    };

    for (const para of paragraphs) {
      const p = para.trim();
      if (!p) continue;
      const pTokens = this.counter.count(p);

      if (pTokens > this.chunkSizeTokens) {
        flush();
        const sentenceChunks = this.splitBySentences(p);
        for (const sc of sentenceChunks) {
          chunks.push({ text: sc, score: 0, sourceIndex: docIdx, chunkIndex: chunkIdx++ });
        }
        currentParas = [];
        currentTokens = 0;
      } else if (currentTokens + pTokens > this.chunkSizeTokens && currentParas.length) {
        flush();
        currentParas.push(p);
        currentTokens += pTokens;
      } else {
        currentParas.push(p);
        currentTokens += pTokens;
      }
    }

    if (currentParas.length) {
      chunks.push({ text: currentParas.join("\n\n"), score: 0, sourceIndex: docIdx, chunkIndex: chunkIdx });
    }

    return chunks;
  }

  private splitBySentences(text: string): string[] {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const results: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const sent of sentences) {
      const sTok = this.counter.count(sent);

      if (sTok > this.chunkSizeTokens) {
        if (current.length) { results.push(current.join(" ")); current = []; currentTokens = 0; }
        results.push(...this.splitByWords(sent));
        continue;
      }

      if (currentTokens + sTok > this.chunkSizeTokens && current.length) {
        results.push(current.join(" "));
        current = this.overlapTokens > 0 ? current.slice(-1) : [];
        currentTokens = current.length ? this.counter.count(current.join(" ")) : 0;
      }
      current.push(sent);
      currentTokens += sTok;
    }

    if (current.length) results.push(current.join(" "));
    return results.length ? results : [text];
  }

  private splitByWords(text: string): string[] {
    const words = text.split(/\s+/);
    const results: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const word of words) {
      const wTok = this.counter.count(word);
      if (currentTokens + wTok > this.chunkSizeTokens && current.length) {
        results.push(current.join(" "));
        current = this.overlapTokens > 0 ? current.slice(-1) : [];
        currentTokens = current.length ? this.counter.count(current.join(" ")) : 0;
      }
      current.push(word);
      currentTokens += wTok;
    }

    if (current.length) results.push(current.join(" "));
    return results.length ? results : [text];
  }

  // ------------------------------------------------------------------
  // BM25 ranking
  // ------------------------------------------------------------------

  private rankBM25(chunks: Chunk[], query: string): Chunk[] {
    const queryTerms = this.tokenize(query);
    if (!queryTerms.length) return [...chunks];

    const tokenized = chunks.map((c) => this.tokenize(c.text));
    const n = tokenized.length;

    // Document frequency
    const df = new Map<string, number>();
    for (const terms of tokenized) {
      for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
    }

    // IDF with smoothing
    const idf = new Map<string, number>();
    for (const [term, count] of df) {
      idf.set(term, Math.log((n - count + 0.5) / (count + 0.5) + 1));
    }

    const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / Math.max(n, 1);

    const scored: Chunk[] = chunks.map((chunk, i) => {
      const terms  = tokenized[i];
      const tf     = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      const docLen = terms.length;

      let score = 0;
      for (const qt of queryTerms) {
        const tfVal  = tf.get(qt) ?? 0;
        if (!tfVal) continue;
        const idfVal = idf.get(qt) ?? 0;
        const tfNorm = (tfVal * (this.K1 + 1)) /
          (tfVal + this.K1 * (1 - this.B + this.B * docLen / Math.max(avgLen, 1)));
        score += idfVal * tfNorm;
      }

      return { ...chunk, score };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  private applyBudget(chunks: Chunk[], budget: number): Chunk[] {
    const selected: Chunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const tokens = this.counter.count(chunk.text);
      if (used + tokens > budget) {
        if (!selected.length) {
          const charLimit = this.counter.estimateCharBudget(budget);
          selected.push({ ...chunk, text: chunk.text.slice(0, charLimit) });
        }
        break;
      }
      selected.push(chunk);
      used += tokens;
    }
    return selected;
  }

  private tokenize(text: string): string[] {
    return (text.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? []).filter(
      (w) => !STOP_WORDS.has(w),
    );
  }
}
