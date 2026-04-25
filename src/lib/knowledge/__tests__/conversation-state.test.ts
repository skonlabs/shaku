import { describe, it, expect } from "vitest";
import { detectTone } from "../conversation-state";
import type { ToneState } from "../conversation-state";

const defaultPrev: ToneState = { current: "casual", confidence: 0.5, signals: [] };

describe("detectTone", () => {
  it("detects urgent tone from urgency keywords", () => {
    const msgs = [{ role: "user", content: "I need this ASAP, it's an emergency deadline!" }];
    const tone = detectTone(msgs, defaultPrev);
    expect(tone.current).toBe("urgent");
    expect(tone.confidence).toBeGreaterThan(0.8);
  });

  it("detects frustrated tone", () => {
    const msgs = [{ role: "user", content: "This doesn't make sense, this is useless." }];
    const tone = detectTone(msgs, defaultPrev);
    expect(tone.current).toBe("frustrated");
  });

  it("detects focused tone for rapid short messages", () => {
    const msgs = [
      { role: "user", content: "ok" },
      { role: "user", content: "go on" },
      { role: "user", content: "next" },
    ];
    const tone = detectTone(msgs, defaultPrev);
    expect(tone.current).toBe("focused");
  });

  it("detects exploratory tone", () => {
    const msgs = [
      { role: "user", content: "I'm curious about this topic and would love to explore it further. Tell me more!" },
    ];
    const tone = detectTone(msgs, defaultPrev);
    expect(tone.current).toBe("exploratory");
  });

  it("defaults to casual for neutral messages", () => {
    const msgs = [
      { role: "user", content: "What is photosynthesis and how does it work in plants?" },
    ];
    const tone = detectTone(msgs, defaultPrev);
    expect(tone.current).toBe("casual");
  });

  it("blends with previous tone when confidence is low", () => {
    const prevFocused: ToneState = { current: "focused", confidence: 0.9, signals: [] };
    const msgs = [{ role: "user", content: "Can you help me?" }];
    const tone = detectTone(msgs, prevFocused);
    // Low confidence new tone → blends with previous focused tone
    expect(tone.current).toBe("focused");
  });

  it("returns signals array", () => {
    const msgs = [{ role: "user", content: "URGENT: need this immediately!" }];
    const tone = detectTone(msgs, defaultPrev);
    expect(Array.isArray(tone.signals)).toBe(true);
    expect(tone.signals.length).toBeGreaterThan(0);
  });

  it("handles empty messages array", () => {
    const tone = detectTone([], defaultPrev);
    expect(tone.current).toBe("casual");
  });
});
