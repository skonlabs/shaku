import { describe, expect, it } from "vitest";
import { InputCleaner } from "../input-cleaner";

const cleaner = new InputCleaner();

describe("InputCleaner.normaliseWhitespace", () => {
  it("collapses multiple spaces", () => {
    expect(cleaner.normaliseWhitespace("hello   world")).not.toContain("  ");
  });

  it("collapses multiple blank lines to two newlines max", () => {
    expect(cleaner.normaliseWhitespace("a\n\n\n\nb")).not.toContain("\n\n\n");
  });

  it("removes trailing spaces on lines", () => {
    expect(cleaner.normaliseWhitespace("line   \nnext")).not.toContain("   \n");
  });
});

describe("InputCleaner.clean — deduplication", () => {
  it("removes exact duplicate paragraphs", () => {
    const text = "Hello world.\n\nHello world.";
    expect(cleaner.clean(text).split("Hello world.").length - 1).toBe(1);
  });

  it("keeps distinct paragraphs", () => {
    const text = "First para.\n\nSecond para.";
    const r = cleaner.clean(text);
    expect(r).toContain("First para.");
    expect(r).toContain("Second para.");
  });

  it("three duplicates reduced to one", () => {
    const p = "Same paragraph text.";
    const r = cleaner.clean(`${p}\n\n${p}\n\n${p}`);
    expect((r.match(/Same paragraph text\./g) ?? []).length).toBe(1);
  });
});

describe("InputCleaner.clean — metadata stripping", () => {
  it("strips HTML tags but keeps text", () => {
    const r = cleaner.clean("<p>Hello <b>world</b></p>");
    expect(r).not.toContain("<p>");
    expect(r).toContain("Hello");
    expect(r).toContain("world");
  });

  it("strips script tags", () => {
    const r = cleaner.clean("<script>alert('xss')</script>Safe text");
    expect(r).not.toContain("<script>");
    expect(r).toContain("Safe text");
  });

  it("strips bare URLs", () => {
    const r = cleaner.clean("Visit https://example.com/very/long/path for details");
    expect(r).not.toContain("https://");
  });

  it("keeps markdown alt text", () => {
    const r = cleaner.clean("See ![system diagram](https://example.com/img.png)");
    expect(r).toContain("system diagram");
  });

  it("strips base64 data URIs", () => {
    const b64 = "data:image/png;base64," + "A".repeat(50);
    expect(cleaner.clean(`Image: ${b64}`)).not.toContain("base64,");
  });
});

describe("InputCleaner.clean — boilerplate removal", () => {
  it("removes email opener", () => {
    const r = cleaner.clean("I hope this email finds you well. Now to the point.");
    expect(r).not.toContain("I hope this email");
    expect(r).toContain("Now to the point");
  });

  it("removes 'Please note that'", () => {
    const r = cleaner.clean("Please note that the deadline is Friday.");
    expect(r).not.toContain("Please note that");
    expect(r).toContain("deadline");
  });

  it("removes 'As mentioned earlier'", () => {
    const r = cleaner.clean("As mentioned earlier, we need speed.");
    expect(r).not.toContain("As mentioned earlier");
    expect(r).toContain("speed");
  });

  it("does NOT remove boilerplate for sensitive content", () => {
    const text = "I hope this email finds you well. Pursuant to GDPR regulations…";
    const r = cleaner.clean(text, /* isSensitive */ true);
    expect(r).toContain("I hope this email");
  });
});

describe("InputCleaner.checkSensitivity", () => {
  it("detects legal domain", () => {
    const { isSensitive, matchedDomains } = cleaner.checkSensitivity(
      "Pursuant to the indemnification clause in the agreement.",
    );
    expect(isSensitive).toBe(true);
    expect(matchedDomains).toContain("legal");
  });

  it("detects medical domain", () => {
    const { isSensitive, matchedDomains } = cleaner.checkSensitivity(
      "The patient diagnosis requires medication adjustment.",
    );
    expect(isSensitive).toBe(true);
    expect(matchedDomains).toContain("medical");
  });

  it("detects financial domain", () => {
    const { isSensitive } = cleaner.checkSensitivity(
      "The audit report shows balance sheet discrepancies.",
    );
    expect(isSensitive).toBe(true);
  });

  it("detects compliance domain", () => {
    const { isSensitive } = cleaner.checkSensitivity(
      "GDPR requires an audit trail maintained for five years.",
    );
    expect(isSensitive).toBe(true);
  });

  it("normal text is not sensitive", () => {
    const { isSensitive } = cleaner.checkSensitivity(
      "How do I sort a list in Python?",
    );
    expect(isSensitive).toBe(false);
  });

  it("empty text is not sensitive", () => {
    expect(cleaner.checkSensitivity("").isSensitive).toBe(false);
  });

  it("honours domain filter", () => {
    const { matchedDomains } = cleaner.checkSensitivity(
      "The audit report per GDPR requirements.",
      ["legal"],
    );
    expect(matchedDomains).not.toContain("compliance");
    expect(matchedDomains).not.toContain("financial");
  });
});

describe("InputCleaner.clean — edge cases", () => {
  it("empty string returns empty", () => {
    expect(cleaner.clean("")).toBe("");
  });

  it("result is stripped", () => {
    const r = cleaner.clean("  hello world  ");
    expect(r).toBe(r.trim());
  });

  it("clean is idempotent", () => {
    const text = "Normal text here.\n\nAnother paragraph.";
    expect(cleaner.clean(cleaner.clean(text))).toBe(cleaner.clean(text));
  });
});
