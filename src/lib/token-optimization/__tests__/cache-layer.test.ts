import { describe, expect, it } from "vitest";
import { CacheLayer } from "../cache-layer";

function freshCache(maxSize = 20, ttlMs = 60_000) {
  return new CacheLayer(maxSize, ttlMs);
}

describe("CacheLayer — typed accessors", () => {
  it("getClean returns undefined for missing key", () => {
    expect(freshCache().getClean("missing")).toBeUndefined();
  });

  it("setClean then getClean returns value", () => {
    const c = freshCache();
    c.setClean("hello", "cleaned");
    expect(c.getClean("hello")).toBe("cleaned");
  });

  it("summary namespace is isolated", () => {
    const c = freshCache();
    c.setSummary("text", "summary");
    expect(c.getSummary("text")).toBe("summary");
    expect(c.getClean("text")).toBeUndefined();
  });

  it("embedding round-trips correctly", () => {
    const c = freshCache();
    c.setEmbedding("hello", [0.1, 0.2, 0.3]);
    expect(c.getEmbedding("hello")).toEqual([0.1, 0.2, 0.3]);
  });

  it("response stores arbitrary objects", () => {
    const c = freshCache();
    c.setResponse("req1", { content: "the answer" });
    expect(c.getResponse("req1")).toEqual({ content: "the answer" });
  });

  it("overwriting a key returns new value", () => {
    const c = freshCache();
    c.setClean("k", "old");
    c.setClean("k", "new");
    expect(c.getClean("k")).toBe("new");
  });

  it("different namespaces with same key are isolated", () => {
    const c = freshCache();
    c.setClean("key", "clean-value");
    c.setSummary("key", "summary-value");
    expect(c.getClean("key")).toBe("clean-value");
    expect(c.getSummary("key")).toBe("summary-value");
  });
});

describe("CacheLayer — TTL", () => {
  it("expired entry returns undefined", async () => {
    const c = new CacheLayer(10, 10); // 10 ms TTL
    c.setClean("key", "value");
    await new Promise((r) => setTimeout(r, 20));
    expect(c.getClean("key")).toBeUndefined();
  });

  it("non-expired entry returns value", () => {
    const c = freshCache();
    c.setClean("key", "value");
    expect(c.getClean("key")).toBe("value");
  });
});

describe("CacheLayer — hit/miss stats", () => {
  it("miss increments misses", () => {
    const c = freshCache();
    c.getClean("nonexistent");
    expect(c.misses).toBe(1);
  });

  it("hit increments hits", () => {
    const c = freshCache();
    c.setClean("k", "v");
    c.getClean("k");
    expect(c.hits).toBe(1);
  });

  it("hit rate is 0 when no calls made", () => {
    expect(freshCache().hitRate).toBe(0);
  });

  it("hit rate calculation: 1 hit 1 miss → 0.5", () => {
    const c = freshCache();
    c.setClean("k1", "v1");
    c.getClean("k1");   // hit
    c.getClean("k2");   // miss
    expect(c.hitRate).toBe(0.5);
  });

  it("expired entry counts as miss", async () => {
    const c = new CacheLayer(10, 10);
    c.setClean("k", "v");
    await new Promise((r) => setTimeout(r, 20));
    c.getClean("k");
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(1);
  });
});

describe("CacheLayer — eviction", () => {
  it("size never exceeds maxSize", () => {
    const c = new CacheLayer(8, 60_000);
    for (let i = 0; i < 20; i++) c.setClean(`k${i}`, `v${i}`);
    expect(c.size).toBeLessThanOrEqual(8);
  });

  it("accepts new entries after eviction", () => {
    const c = new CacheLayer(4, 60_000);
    for (let i = 0; i < 10; i++) c.setClean(`k${i}`, `v${i}`);
    // Should not throw; size bounded
    expect(c.size).toBeLessThanOrEqual(4);
  });
});

describe("CacheLayer — clear", () => {
  it("clear empties the store", () => {
    const c = freshCache();
    c.setClean("k", "v");
    c.clear();
    expect(c.getClean("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("clear resets stats", () => {
    const c = freshCache();
    c.setClean("k", "v");
    c.getClean("k");
    c.clear();
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(0);
  });
});

describe("CacheLayer — stats()", () => {
  it("stats shape is correct", () => {
    const s = freshCache(10, 3_600_000).stats();
    expect(s).toHaveProperty("hits");
    expect(s).toHaveProperty("misses");
    expect(s).toHaveProperty("hitRate");
    expect(s).toHaveProperty("size");
    expect(s).toHaveProperty("maxSize");
    expect(s).toHaveProperty("ttlMs");
  });

  it("maxSize matches constructor arg", () => {
    expect(new CacheLayer(42, 60_000).stats().maxSize).toBe(42);
  });
});
