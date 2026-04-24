import { describe, expect, it } from "vitest";
import { TokenOptimizationMiddleware } from "../middleware";
import type { Message } from "../types";

function makeMsgs(nTurns = 3, withSystem = true): Message[] {
  const msgs: Message[] = [];
  if (withSystem) msgs.push({ role: "system", content: "You are a helpful assistant." });
  for (let i = 0; i < nTurns; i++) {
    msgs.push({ role: "user",      content: `User question ${i}: explain topic ${i} in detail.` });
    msgs.push({ role: "assistant", content: `Answer ${i}: topic ${i} involves A, B, and C.` });
  }
  msgs.push({ role: "user", content: "Final question: summarize everything." });
  return msgs;
}

const DOCS = [
  "Python is a popular programming language for data science and machine learning.",
  "JavaScript powers most web browsers and Node.js for server-side development.",
  "Machine learning algorithms include regression, classification, and clustering.",
  "Databases like PostgreSQL and MySQL store structured relational data efficiently.",
  "Docker containers package applications for consistent deployment environments.",
];

// ---------------------------------------------------------------------------
// process() — basic pipeline
// ---------------------------------------------------------------------------
describe("process() — basics", () => {
  const mw = new TokenOptimizationMiddleware();

  it("returns an OptimizationResult", () => {
    expect(mw.process(makeMsgs())).toBeDefined();
  });

  it("result has messages array", () => {
    expect(Array.isArray(mw.process(makeMsgs()).messages)).toBe(true);
  });

  it("result has positive maxOutputTokens", () => {
    expect(mw.process(makeMsgs()).maxOutputTokens).toBeGreaterThan(0);
  });

  it("result has positive tokensBefore", () => {
    expect(mw.process(makeMsgs()).inputTokensBefore).toBeGreaterThan(0);
  });

  it("savingsPct is non-negative", () => {
    expect(mw.process(makeMsgs()).savingsPct).toBeGreaterThanOrEqual(0);
  });

  it("system message separated into systemPrompt field", () => {
    const r = mw.process(makeMsgs());
    expect(r.systemPrompt).not.toBeNull();
    expect(r.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("empty messages return empty result", () => {
    const r = mw.process([]);
    expect(r.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// System prompt merging
// ---------------------------------------------------------------------------
describe("process() — system prompt merging", () => {
  it("accepts systemPrompt via options", () => {
    const mw = new TokenOptimizationMiddleware();
    const r  = mw.process([{ role: "user", content: "Hello" }], { systemPrompt: "Be concise." });
    expect(r.systemPrompt).toBe("Be concise.");
  });

  it("system in messages takes precedence over separate systemPrompt", () => {
    const mw = new TokenOptimizationMiddleware();
    const msgs: Message[] = [
      { role: "system", content: "From messages." },
      { role: "user",   content: "Hi" },
    ];
    const r = mw.process(msgs, { systemPrompt: "Passed separately." });
    // Existing system message is not overwritten
    expect(r.systemPrompt).toContain("From messages.");
  });
});

// ---------------------------------------------------------------------------
// Task type
// ---------------------------------------------------------------------------
describe("process() — task type", () => {
  const mw = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 8_000, maxOutputTokens: 10_000, maxTotalTokens: 18_000 } });

  it("classification → 50 output tokens", () => {
    expect(mw.process([{ role: "user", content: "Test" }], { taskType: "classification" }).maxOutputTokens).toBe(50);
  });

  it("extraction → 150 output tokens", () => {
    expect(mw.process([{ role: "user", content: "Test" }], { taskType: "extraction" }).maxOutputTokens).toBe(150);
  });

  it("summarization → 300 output tokens", () => {
    expect(mw.process([{ role: "user", content: "Test" }], { taskType: "summarization" }).maxOutputTokens).toBe(300);
  });

  it("coding → 1200 output tokens", () => {
    expect(mw.process([{ role: "user", content: "Test" }], { taskType: "coding" }).maxOutputTokens).toBe(1_200);
  });

  it("auto-detects summarization from last user message", () => {
    const mw2 = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 8_000, maxOutputTokens: 10_000, maxTotalTokens: 18_000 } });
    const r = mw2.process([{ role: "user", content: "Summarize this article for me." }]);
    expect(r.maxOutputTokens).toBe(300);
  });

  it("auto-detects classification", () => {
    const mw2 = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 8_000, maxOutputTokens: 10_000, maxTotalTokens: 18_000 } });
    const r = mw2.process([{ role: "user", content: "Classify this customer review." }]);
    expect(r.maxOutputTokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Sensitive content
// ---------------------------------------------------------------------------
describe("process() — sensitive content", () => {
  it("sensitive content produces warning", () => {
    const mw = new TokenOptimizationMiddleware();
    const r  = mw.process([{
      role: "user",
      content: "Pursuant to GDPR compliance requirements, maintain the audit trail.",
    }]);
    expect(r.warnings.some((w) => w.toLowerCase().includes("sensitive"))).toBe(true);
  });

  it("sensitive terms are preserved in output", () => {
    const mw = new TokenOptimizationMiddleware();
    const content = "Pursuant to the liability clause, the plaintiff must comply with jurisdiction.";
    const r = mw.process([{ role: "user", content }]);
    const out = r.messages.map((m) => m.content).join(" ");
    expect(out.toLowerCase()).toMatch(/liability|jurisdiction/);
  });

  it("non-sensitive text produces no sensitivity warning", () => {
    const mw = new TokenOptimizationMiddleware();
    const r = mw.process([{ role: "user", content: "How do I sort a list in Python?" }]);
    expect(r.warnings.some((w) => w.toLowerCase().includes("sensitive"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Document pruning
// ---------------------------------------------------------------------------
describe("process() — document pruning", () => {
  it("injects relevant context into last user message", () => {
    const mw = new TokenOptimizationMiddleware();
    const r  = mw.process([{ role: "user", content: "How does machine learning work?" }], { documents: DOCS });
    const combined = r.messages.map((m) => m.content).join(" ");
    expect(combined).toContain("[Relevant context]");
  });

  it("no documents → no context block", () => {
    const mw = new TokenOptimizationMiddleware();
    const r  = mw.process([{ role: "user", content: "Hello" }]);
    expect(r.messages.map((m) => m.content).join(" ")).not.toContain("[Relevant context]");
  });

  it("ML query surfaces ML document", () => {
    const mw = new TokenOptimizationMiddleware({ contextTopKChunks: 1 });
    const r  = mw.process([{ role: "user", content: "Explain machine learning algorithms." }], { documents: DOCS });
    const combined = r.messages.map((m) => m.content).join(" ").toLowerCase();
    expect(combined).toMatch(/machine learning|neural/);
  });
});

// ---------------------------------------------------------------------------
// History compression
// ---------------------------------------------------------------------------
describe("process() — history compression", () => {
  it("long history is compressed", () => {
    const mw      = new TokenOptimizationMiddleware({ historyKeepTurns: 2 });
    const msgs    = makeMsgs(20);
    const convIn  = msgs.filter((m) => m.role !== "system");
    const r       = mw.process(msgs);
    expect(r.messages.length).toBeLessThan(convIn.length);
  });

  it("last user message is always present", () => {
    const mw    = new TokenOptimizationMiddleware({ historyKeepTurns: 2 });
    const msgs  = makeMsgs(15);
    const last  = [...msgs].reverse().find((m) => m.role === "user")!;
    const r     = mw.process(msgs);
    const lastOut = [...r.messages].reverse().find((m) => m.role === "user");
    expect(lastOut?.content).toBe(last.content);
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------
describe("process() — budget enforcement", () => {
  it("output fits within budget (+small overhead margin)", () => {
    const mw  = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 200, maxOutputTokens: 100, maxTotalTokens: 300 } });
    const r   = mw.process(makeMsgs(5));
    expect(r.inputTokensAfter).toBeLessThanOrEqual(220);
  });

  it("very tight budget triggers warning", () => {
    const mw = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 20, maxOutputTokens: 50, maxTotalTokens: 70 } });
    const r  = mw.process(makeMsgs(3));
    expect(r.warnings.some((w) => w.toLowerCase().match(/exceed|truncat/))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
describe("process() — caching", () => {
  it("second call with same input registers cache hits", () => {
    const mw   = new TokenOptimizationMiddleware();
    const msgs = [{ role: "user" as const, content: "Hello   world    test." }];
    mw.process(msgs);
    const r2 = mw.process(msgs);
    expect(r2.cacheHits).toBeGreaterThanOrEqual(1);
  });

  it("disabled cache always has 0 hits", () => {
    const mw = new TokenOptimizationMiddleware({ enableCaching: false });
    mw.process([{ role: "user", content: "Hello world" }]);
    const r  = mw.process([{ role: "user", content: "Hello world" }]);
    expect(r.cacheHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// forOpenAI
// ---------------------------------------------------------------------------
describe("forOpenAI()", () => {
  const mw = new TokenOptimizationMiddleware();

  it("returns messages and max_tokens", () => {
    const out = mw.forOpenAI(makeMsgs());
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.max_tokens).toBeGreaterThan(0);
  });

  it("includes _opt audit metadata", () => {
    const out = mw.forOpenAI(makeMsgs());
    expect(out._opt).toBeDefined();
    expect(out._opt.tokensBefore).toBeGreaterThan(0);
    expect(typeof out._opt.savingsPct).toBe("number");
  });

  it("system role appears in messages for OpenAI", () => {
    const out = mw.forOpenAI(makeMsgs());
    expect(out.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("explicit task type respected", () => {
    const mw2 = new TokenOptimizationMiddleware({ budget: { maxInputTokens: 8_000, maxOutputTokens: 10_000, maxTotalTokens: 18_000 } });
    const out  = mw2.forOpenAI([{ role: "user", content: "Test" }], { taskType: "extraction" });
    expect(out.max_tokens).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// forAnthropic
// ---------------------------------------------------------------------------
describe("forAnthropic()", () => {
  const mw = new TokenOptimizationMiddleware({ provider: "anthropic" });

  it("returns messages and max_tokens", () => {
    const out = mw.forAnthropic(makeMsgs());
    expect(out.messages).toBeDefined();
    expect(out.max_tokens).toBeGreaterThan(0);
  });

  it("system at top level, not in messages", () => {
    const out = mw.forAnthropic(makeMsgs(), { system: "Be helpful." });
    expect(out.system).toBeDefined();
    expect(out.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("messages do not contain system role", () => {
    const out = mw.forAnthropic(makeMsgs());
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("explicit task type for coding → 1200", () => {
    const mw2 = new TokenOptimizationMiddleware({ provider: "anthropic", budget: { maxInputTokens: 8_000, maxOutputTokens: 10_000, maxTotalTokens: 18_000 } });
    const out  = mw2.forAnthropic([{ role: "user", content: "Test" }], { taskType: "coding" });
    expect(out.max_tokens).toBe(1_200);
  });
});
