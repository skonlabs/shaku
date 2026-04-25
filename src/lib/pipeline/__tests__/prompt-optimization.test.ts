import { describe, it, expect } from "vitest";
import {
  buildSystemAdditions,
  detectFormatHint,
  wrapUserMessage,
  wrapSource,
  wrapMemory,
} from "../prompt-optimization";

describe("buildSystemAdditions", () => {
  it("includes intent-specific instructions for question intent", () => {
    const result = buildSystemAdditions("question", {}, "casual", false);
    expect(result).toContain("Cite sources");
  });

  it("includes action card instructions for action intent", () => {
    const result = buildSystemAdditions("action", {}, "casual", false);
    expect(result).toContain("Approve");
  });

  it("includes analysis instructions", () => {
    const result = buildSystemAdditions("analysis", {}, "casual", false);
    expect(result).toContain("numbers");
  });

  it("includes chart instruction for analysis", () => {
    const result = buildSystemAdditions("analysis", {}, "casual", false);
    expect(result).toContain("chart");
  });

  it("excludes chart instruction for casual_chat", () => {
    const result = buildSystemAdditions("casual_chat", {}, "casual", false);
    expect(result).not.toContain("chart");
  });

  it("includes follow-up instruction for non-trivial intents", () => {
    const result = buildSystemAdditions("question", {}, "casual", false);
    expect(result).toContain("followups");
  });

  it("omits follow-up instruction for acknowledgment", () => {
    const result = buildSystemAdditions("acknowledgment", {}, "casual", false);
    expect(result).not.toContain("followups");
  });

  it("always includes safety framing", () => {
    const result = buildSystemAdditions("question", {}, "casual", false);
    expect(result).toContain("DATA");
  });

  it("injects style profile verbosity", () => {
    const result = buildSystemAdditions("question", { verbosity: "concise" }, "casual", false);
    expect(result).toContain("concise");
  });

  it("injects tone instructions for focused tone", () => {
    const result = buildSystemAdditions("question", {}, "focused", false);
    expect(result).toContain("direct");
  });

  it("includes follow-up reference when isFollowUp", () => {
    const result = buildSystemAdditions("question", {}, "casual", true, "previous question");
    expect(result).toContain("follow-up");
    expect(result).toContain("previous question");
  });
});

describe("detectFormatHint", () => {
  it("returns bulleted list hint for 'list all'", () => {
    expect(detectFormatHint("list all the steps")).toContain("bulleted");
  });

  it("returns comparison table hint for 'compare'", () => {
    expect(detectFormatHint("compare option A and option B")).toContain("table");
  });

  it("returns number hint for 'how much'", () => {
    expect(detectFormatHint("how much does it cost?")).toContain("number");
  });

  it("returns numbered steps hint for 'step by step'", () => {
    expect(detectFormatHint("show me step by step how to do it")).toContain("numbered");
  });

  it("returns sections hint for 'summarize'", () => {
    expect(detectFormatHint("summarize the document")).toContain("sections");
  });

  it("returns null for plain questions", () => {
    expect(detectFormatHint("what is the capital of France?")).toBeNull();
  });
});

describe("wrapUserMessage", () => {
  it("wraps content in user_message tags", () => {
    const result = wrapUserMessage("hello world");
    expect(result).toBe("<user_message>hello world</user_message>");
  });
});

describe("wrapSource", () => {
  it("wraps content with name and type attributes", () => {
    const result = wrapSource("MyDoc", "datasource", "content here");
    expect(result).toBe('<source name="MyDoc" type="datasource">content here</source>');
  });
});

describe("wrapMemory", () => {
  it("wraps content with type attribute", () => {
    const result = wrapMemory("preference", "User prefers bullet points");
    expect(result).toBe('<memory type="preference">User prefers bullet points</memory>');
  });
});
