import { describe, expect, it } from "vitest";
import { ExtractiveSummarizer, HistoryCompressor } from "../history-compressor";
import { TokenCounter } from "../token-counter";
import type { Message } from "../types";

const counter = new TokenCounter();

function makeConversation(nTurns: number, withSystem = true): Message[] {
  const msgs: Message[] = [];
  if (withSystem) msgs.push({ role: "system", content: "You are a helpful assistant." });
  for (let i = 0; i < nTurns; i++) {
    msgs.push({ role: "user",      content: `User question ${i}: how do I implement feature ${i}?` });
    msgs.push({ role: "assistant", content: `Answer ${i}: you need steps A, B, and C for feature ${i}.` });
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// ExtractiveSummarizer
// ---------------------------------------------------------------------------
describe("ExtractiveSummarizer", () => {
  const s = new ExtractiveSummarizer();

  it("returns empty for empty input", () => {
    expect(s.summarize("")).toBe("");
  });

  it("returns short text unchanged (≤ maxSentences)", () => {
    const text = "Just one sentence.";
    expect(s.summarize(text, 5)).toBe(text);
  });

  it("shortens long text", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i} with useful content here.`).join(" ");
    const result = s.summarize(text, 5);
    expect(result.length).toBeLessThan(text.length);
  });

  it("respects maxChars", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i} with data.`).join(" ");
    const result = s.summarize(text, 5, 100);
    expect(result.length).toBeLessThanOrEqual(105); // small margin for ellipsis
  });

  it("is deterministic", () => {
    const text = Array.from({ length: 15 }, (_, i) => `Info about topic ${i} here.`).join(" ");
    expect(s.summarize(text)).toBe(s.summarize(text));
  });
});

// ---------------------------------------------------------------------------
// HistoryCompressor — no compression needed
// ---------------------------------------------------------------------------
describe("HistoryCompressor — short history", () => {
  const comp = new HistoryCompressor(counter, 5);

  it("returns unchanged when turns ≤ keepTurns", () => {
    const msgs = makeConversation(3);
    expect(comp.compress(msgs)).toHaveLength(msgs.length);
  });

  it("returns empty array for empty input", () => {
    expect(comp.compress([])).toHaveLength(0);
  });

  it("system message is always first", () => {
    const msgs = makeConversation(3);
    const result = comp.compress(msgs);
    expect(result[0].role).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// HistoryCompressor — compression
// ---------------------------------------------------------------------------
describe("HistoryCompressor — long history", () => {
  const comp = new HistoryCompressor(counter, 3);

  it("compresses to fewer messages than input", () => {
    const msgs = makeConversation(10);
    expect(comp.compress(msgs).length).toBeLessThan(msgs.length);
  });

  it("system message preserved", () => {
    const msgs = makeConversation(10);
    const result = comp.compress(msgs);
    const sysMsgs = result.filter((m) => m.role === "system");
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toBe("You are a helpful assistant.");
  });

  it("summary block injected as first non-system message", () => {
    const msgs = makeConversation(10);
    const result = comp.compress(msgs);
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs[0].content.toLowerCase()).toMatch(/summary|earlier/);
  });

  it("last user message preserved verbatim", () => {
    const msgs = makeConversation(10);
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")!;
    const result   = comp.compress(msgs);
    const lastResultUser = [...result].reverse().find((m) => m.role === "user")!;
    expect(lastResultUser.content).toBe(lastUser.content);
  });

  it("recent turns = keepTurns × 2 messages (+ summary + system)", () => {
    const msgs = makeConversation(10);
    const result = comp.compress(msgs);
    // 1 system + 1 summary + 3*2 recent
    expect(result.length).toBe(1 + 1 + 3 * 2);
  });
});

// ---------------------------------------------------------------------------
// HistoryCompressor — token budget
// ---------------------------------------------------------------------------
describe("HistoryCompressor — token budget", () => {
  it("trimmed result fits within budget", () => {
    const comp = new HistoryCompressor(counter, 5);
    const msgs = makeConversation(20);
    const budget = 200;
    const result = comp.compress(msgs, budget);
    expect(counter.countMessages(result)).toBeLessThanOrEqual(budget);
  });

  it("always keeps at least one message", () => {
    const comp = new HistoryCompressor(counter, 5);
    const msgs: Message[] = [
      { role: "system", content: "Sys." },
      { role: "user",   content: "Hi" },
    ];
    const result = comp.compress(msgs, 100_000);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
