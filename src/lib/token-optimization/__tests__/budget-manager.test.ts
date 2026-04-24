import { describe, expect, it } from "vitest";
import { BudgetManager, TASK_OUTPUT_TOKENS } from "../budget-manager";
import { TokenCounter } from "../token-counter";
import type { Message, TaskType, TokenBudget } from "../types";

const counter = new TokenCounter();

function mgr(budget: Partial<TokenBudget> = {}) {
  return new BudgetManager(
    { maxInputTokens: 500, maxOutputTokens: 300, maxTotalTokens: 800, ...budget },
    counter,
  );
}

// ---------------------------------------------------------------------------
// Task output tokens
// ---------------------------------------------------------------------------
describe("BudgetManager.getOutputTokens", () => {
  it("classification → 50", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("classification")).toBe(50);
  });

  it("extraction → 150", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("extraction")).toBe(150);
  });

  it("summarization → 300", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("summarization")).toBe(300);
  });

  it("generation → 800 (uncapped)", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("generation")).toBe(800);
  });

  it("reasoning → 1200 (uncapped)", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("reasoning")).toBe(1_200);
  });

  it("coding → 1200 (uncapped)", () => {
    expect(mgr({ maxOutputTokens: 10_000 }).getOutputTokens("coding")).toBe(1_200);
  });

  it("generation capped by maxOutputTokens", () => {
    expect(mgr({ maxOutputTokens: 300 }).getOutputTokens("generation")).toBe(300);
  });

  it("undefined task → default (capped)", () => {
    const result = mgr({ maxOutputTokens: 300 }).getOutputTokens(undefined);
    expect(result).toBeLessThanOrEqual(300);
  });

  it("all task types are defined", () => {
    const types: TaskType[] = ["classification","extraction","summarization","generation","reasoning","coding"];
    for (const t of types) expect(TASK_OUTPUT_TOKENS[t]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Check methods
// ---------------------------------------------------------------------------
describe("BudgetManager.check*", () => {
  const m = mgr();

  it("checkInput within budget → true", () => { expect(m.checkInput(500)).toBe(true); });
  it("checkInput over budget → false",  () => { expect(m.checkInput(501)).toBe(false); });
  it("checkOutput within → true",       () => { expect(m.checkOutput(300)).toBe(true); });
  it("checkOutput over → false",        () => { expect(m.checkOutput(301)).toBe(false); });
  it("checkTotal within → true",        () => { expect(m.checkTotal(400, 300)).toBe(true); });
  it("checkTotal over → false",         () => { expect(m.checkTotal(501, 300)).toBe(false); });
});

// ---------------------------------------------------------------------------
// enforceInputBudget
// ---------------------------------------------------------------------------
describe("BudgetManager.enforceInputBudget", () => {
  it("returns messages unchanged when under budget", () => {
    const msgs: Message[] = [
      { role: "system", content: "System." },
      { role: "user",   content: "Hello." },
    ];
    const { messages, warnings } = mgr().enforceInputBudget(msgs);
    expect(messages).toHaveLength(msgs.length);
    expect(warnings).toHaveLength(0);
  });

  it("trims from front when over budget", () => {
    const m = mgr({ maxInputTokens: 35 });
    const msgs: Message[] = [
      { role: "system",    content: "System prompt." },
      { role: "user",      content: "Old question that takes many tokens indeed." },
      { role: "assistant", content: "Old answer with many tokens as well." },
      { role: "user",      content: "New short question." },
    ];
    const { messages, warnings } = m.enforceInputBudget(msgs);
    expect(warnings.length).toBeGreaterThan(0);
    // System always preserved
    expect(messages[0].role).toBe("system");
    // Last user message preserved
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("New short question");
  });

  it("system messages are never removed", () => {
    const m = mgr({ maxInputTokens: 30 });
    const msgs: Message[] = [
      { role: "system", content: "Important system." },
      { role: "user",   content: "Hi" },
    ];
    const { messages } = m.enforceInputBudget(msgs);
    expect(messages.some((m) => m.role === "system")).toBe(true);
    expect(messages.find((m) => m.role === "system")?.content).toBe("Important system.");
  });

  it("empty list returns empty", () => {
    const { messages, warnings } = mgr().enforceInputBudget([]);
    expect(messages).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("extreme budget triggers truncation warning", () => {
    const m = mgr({ maxInputTokens: 20 });
    const msgs: Message[] = [{ role: "user", content: "A".repeat(500) }];
    const { warnings } = m.enforceInputBudget(msgs);
    expect(warnings.some((w) => w.toLowerCase().includes("truncat"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compressMessage
// ---------------------------------------------------------------------------
describe("BudgetManager.compressMessage", () => {
  const m = mgr();

  it("short message returned unchanged", () => {
    const msg: Message = { role: "user", content: "Short." };
    const { wasCompressed } = m.compressMessage(msg, 1_000);
    expect(wasCompressed).toBe(false);
  });

  it("oversized message is compressed", () => {
    const long = Array.from({ length: 50 }, (_, i) => `Sentence ${i} with extra words.`).join(" ");
    const msg: Message = { role: "user", content: long };
    const { message, wasCompressed } = m.compressMessage(msg, 30);
    expect(wasCompressed).toBe(true);
    expect(message.content.length).toBeLessThan(long.length);
  });

  it("sensitive mode uses truncation only", () => {
    const long = "A".repeat(2_000);
    const msg: Message = { role: "user", content: long };
    const { message, wasCompressed } = m.compressMessage(msg, 50, true);
    expect(wasCompressed).toBe(true);
    expect(message.content).toMatch(/sensitive domain/i);
  });

  it("role is preserved", () => {
    const msg: Message = { role: "assistant", content: "A".repeat(500) };
    const { message } = m.compressMessage(msg, 30);
    expect(message.role).toBe("assistant");
  });
});
