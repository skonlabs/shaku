import { describe, it, expect } from "vitest";
import {
  detectStructuredPii,
  applyPreferences,
  redactText,
  reInjectPii,
  redactOutputPii,
  DEFAULT_PII_PREFERENCES,
} from "../pii";

describe("detectStructuredPii", () => {
  it("detects SSN", () => {
    const tags = detectStructuredPii("My SSN is 123-45-6789.");
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe("ssn");
    expect(tags[0].value).toBe("123-45-6789");
    expect(tags[0].placeholder).toBe("[SSN_1]");
  });

  it("detects credit card", () => {
    const tags = detectStructuredPii("Card: 4111 1111 1111 1111");
    expect(tags.some((t) => t.type === "credit_card")).toBe(true);
  });

  it("detects email", () => {
    const tags = detectStructuredPii("Email me at alice@example.com");
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe("email");
    expect(tags[0].value).toBe("alice@example.com");
  });

  it("detects multiple PII of same type with incrementing placeholder", () => {
    const tags = detectStructuredPii("a@b.com and c@d.com");
    expect(tags).toHaveLength(2);
    expect(tags[0].placeholder).toBe("[EMAIL_1]");
    expect(tags[1].placeholder).toBe("[EMAIL_2]");
  });

  it("returns empty for clean text", () => {
    expect(detectStructuredPii("Hello, how are you today?")).toHaveLength(0);
  });

  it("detects phone number", () => {
    const tags = detectStructuredPii("Call me at 555-867-5309");
    expect(tags.some((t) => t.type === "phone")).toBe(true);
  });
});

describe("applyPreferences", () => {
  it("routes SSN to autoRedact by default", () => {
    const tags = detectStructuredPii("SSN: 123-45-6789");
    const result = applyPreferences(tags, {});
    expect(result.autoRedact).toHaveLength(1);
    expect(result.autoRedact[0].type).toBe("ssn");
    expect(result.autoSend).toHaveLength(0);
    expect(result.needsConfirm).toHaveLength(0);
  });

  it("routes email to needsConfirm by default", () => {
    const tags = detectStructuredPii("test@example.com");
    const result = applyPreferences(tags, {});
    expect(result.needsConfirm).toHaveLength(1);
    expect(result.needsConfirm[0].type).toBe("email");
  });

  it("respects always_send preference", () => {
    const tags = detectStructuredPii("test@example.com");
    const result = applyPreferences(tags, { email: "always_send" });
    expect(result.autoSend).toHaveLength(1);
    expect(result.needsConfirm).toHaveLength(0);
  });

  it("respects always_redact override", () => {
    const tags = detectStructuredPii("test@example.com");
    const result = applyPreferences(tags, { email: "always_redact" });
    expect(result.autoRedact).toHaveLength(1);
  });
});

describe("redactText", () => {
  it("replaces values with placeholders", () => {
    const text = "SSN: 123-45-6789";
    const tags = detectStructuredPii(text);
    const { redacted, mapping } = redactText(text, tags);
    expect(redacted).toBe("SSN: [SSN_1]");
    expect(mapping["[SSN_1]"]).toBe("123-45-6789");
  });

  it("handles multiple redactions preserving offsets", () => {
    const text = "Email: a@b.com, also c@d.com";
    const tags = detectStructuredPii(text);
    const { redacted } = redactText(text, tags);
    expect(redacted).not.toContain("a@b.com");
    expect(redacted).not.toContain("c@d.com");
    expect(redacted).toContain("[EMAIL_1]");
    expect(redacted).toContain("[EMAIL_2]");
  });

  it("returns empty mapping for no redactions", () => {
    const { redacted, mapping } = redactText("hello", []);
    expect(redacted).toBe("hello");
    expect(mapping).toEqual({});
  });
});

describe("reInjectPii", () => {
  it("restores placeholders to original values", () => {
    const mapping = { "[SSN_1]": "123-45-6789", "[EMAIL_1]": "a@b.com" };
    const result = reInjectPii("SSN: [SSN_1], email: [EMAIL_1]", mapping);
    expect(result).toBe("SSN: 123-45-6789, email: a@b.com");
  });

  it("is a no-op with empty mapping", () => {
    expect(reInjectPii("hello world", {})).toBe("hello world");
  });
});

describe("redactOutputPii", () => {
  it("redacts SSN not in allowed set", () => {
    const { text, redacted } = redactOutputPii("Your SSN 123-45-6789 is noted.", new Set());
    expect(redacted).toBe(true);
    expect(text).not.toContain("123-45-6789");
  });

  it("preserves SSN that is in allowed set", () => {
    const { text, redacted } = redactOutputPii(
      "Your SSN 123-45-6789 is noted.",
      new Set(["123-45-6789"]),
    );
    expect(redacted).toBe(false);
    expect(text).toContain("123-45-6789");
  });

  it("does not redact email (not SSN or CC)", () => {
    const { redacted } = redactOutputPii("Contact a@b.com", new Set());
    expect(redacted).toBe(false);
  });

  it("returns unchanged text when nothing to redact", () => {
    const { text, redacted } = redactOutputPii("All good here.", new Set());
    expect(redacted).toBe(false);
    expect(text).toBe("All good here.");
  });
});

describe("DEFAULT_PII_PREFERENCES", () => {
  it("auto-redacts SSN and credit card", () => {
    expect(DEFAULT_PII_PREFERENCES.ssn).toBe("always_redact");
    expect(DEFAULT_PII_PREFERENCES.credit_card).toBe("always_redact");
  });

  it("asks for email, phone, name", () => {
    expect(DEFAULT_PII_PREFERENCES.email).toBe("always_ask");
    expect(DEFAULT_PII_PREFERENCES.phone).toBe("always_ask");
    expect(DEFAULT_PII_PREFERENCES.name).toBe("always_ask");
  });
});
