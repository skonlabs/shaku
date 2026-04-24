/**
 * CacheLayer — namespaced LRU cache with TTL.
 *
 * Namespaces:
 *   clean     — cleaned input text
 *   summary   — extractive summaries
 *   embedding — text embeddings
 *   response  — final model responses
 *
 * Uses a simple FNV-1a hash for cache keys (no Web Crypto / Node needed).
 * LRU eviction removes the oldest 25 % of entries when the store is full.
 */

interface CacheEntry<T = unknown> {
  value: T;
  ts: number; // Date.now() ms
}

/** FNV-1a 32-bit hash — fast, deterministic, no external deps. */
function fnv1a(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = Math.imul(hash ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class CacheLayer {
  private readonly store = new Map<string, CacheEntry>();
  private hitCount  = 0;
  private missCount = 0;

  constructor(
    private readonly maxSize  = 1_000,
    private readonly ttlMs    = 3_600_000, // 1 hour
  ) {}

  // ------------------------------------------------------------------
  // Typed accessors
  // ------------------------------------------------------------------

  getClean(rawText: string): string | undefined       { return this.get("clean", rawText) as string | undefined; }
  setClean(rawText: string, cleaned: string): void    { this.set("clean", rawText, cleaned); }

  getSummary(text: string): string | undefined        { return this.get("summary", text) as string | undefined; }
  setSummary(text: string, summary: string): void     { this.set("summary", text, summary); }

  getEmbedding(text: string): number[] | undefined    { return this.get("embedding", text) as number[] | undefined; }
  setEmbedding(text: string, vec: number[]): void     { this.set("embedding", text, vec); }

  getResponse(key: string): unknown                   { return this.get("response", key); }
  setResponse(key: string, response: unknown): void   { this.set("response", key, response); }

  // ------------------------------------------------------------------
  // Generic get / set
  // ------------------------------------------------------------------

  get(namespace: string, content: string): unknown {
    const key   = this.cacheKey(namespace, content);
    const entry = this.store.get(key);

    if (!entry) { this.missCount++; return undefined; }
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      this.missCount++;
      return undefined;
    }

    entry.ts = Date.now(); // refresh for LRU
    this.hitCount++;
    return entry.value;
  }

  set(namespace: string, content: string, value: unknown): void {
    const key = this.cacheKey(namespace, content);
    if (this.store.size >= this.maxSize && !this.store.has(key)) this.evict();
    this.store.set(key, { value, ts: Date.now() });
  }

  // ------------------------------------------------------------------
  // Stats & maintenance
  // ------------------------------------------------------------------

  get hits():    number { return this.hitCount; }
  get misses():  number { return this.missCount; }
  get size():    number { return this.store.size; }
  get hitRate(): number {
    const total = this.hitCount + this.missCount;
    return total ? Math.round((this.hitCount / total) * 10_000) / 10_000 : 0;
  }

  stats(): Record<string, unknown> {
    return {
      hits:     this.hitCount,
      misses:   this.missCount,
      hitRate:  this.hitRate,
      size:     this.store.size,
      maxSize:  this.maxSize,
      ttlMs:    this.ttlMs,
    };
  }

  clear(): void {
    this.store.clear();
    this.hitCount  = 0;
    this.missCount = 0;
  }

  // ------------------------------------------------------------------

  private cacheKey(namespace: string, content: string): string {
    return `${namespace}:${fnv1a(content)}`;
  }

  private evict(): void {
    const sorted = [...this.store.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const nEvict = Math.max(1, Math.floor(sorted.length / 4));
    for (const [key] of sorted.slice(0, nEvict)) this.store.delete(key);
  }
}
