/**
 * InputCleaner — strips noise from user inputs while preserving every
 * task-critical detail.
 *
 * Conservative by design: sensitive-domain content skips boilerplate removal
 * so no legally / medically / financially relevant wording is lost.
 */

// ---------------------------------------------------------------------------
// Boilerplate patterns: [regex, replacement]
// ---------------------------------------------------------------------------
const BOILERPLATE: Array<[RegExp, string]> = [
  // Email / letter openers
  [/I hope this (email|message|note|letter) finds you well\.?/gi, ""],
  [/I (am writing|wanted to (?:reach out|contact)(?: you)?)(?: today)?(?: to)?/gi, ""],
  [/Please (?:do not hesitate|feel free) to (?:contact|reach out|get in touch)[^.]*\./gi, ""],
  // Redundant discourse markers
  [/\bIt is (?:worth|important to) (?:noting|mentioning|highlight(?:ing)?|remember) that\b/gi, ""],
  [/\bPlease note that\b/gi, ""],
  [/\bIt should be noted that\b/gi, ""],
  [/\bAs (?:you |we )?(?:may )?(?:know|be aware)[,.]?\b/gi, ""],
  [/\bAt the end of the day[,.]?\b/gi, ""],
  [/\bFor (?:all intents and purposes|the (?:purpose|avoidance) of doubt)[,.]?\b/gi, ""],
  [/\bFirst and foremost[,.]?\b/gi, ""],
  [/\bLast but (?:certainly )?not least[,.]?\b/gi, "Finally,"],
  [/\bIn (?:summary|conclusion|closing)[,.]?\b/gi, ""],
  [/\bTo (?:summarize|sum up|recap)[,.]?\b/gi, ""],
  [/\bAs (?:mentioned|stated|discussed|noted) (?:above|previously|earlier|before)[,.]?\b/gi, ""],
  [/\bNeedless to say[,.]?\b/gi, ""],
  [/\bObviously[,.]?\b/gi, ""],
  [/\bOf course[,.]?\b/gi, ""],
  // Excessive hedging chains
  [/\bit might possibly be the case that\b/gi, "possibly"],
  [/\bperhaps it could (?:be argued|be said) that\b/gi, "arguably"],
  [/\bsome (?:people|experts|analysts) (?:might |may |would )?(?:argue|say|suggest|think) that\b/gi, ""],
];

// ---------------------------------------------------------------------------
// Metadata / markup patterns: [regex, replacement]
// ---------------------------------------------------------------------------
const METADATA: Array<[RegExp, string]> = [
  [/<!DOCTYPE[^>]*>/gi, ""],
  [/<head[^>]*>[\s\S]*?<\/head>/gi, ""],
  [/<script[^>]*>[\s\S]*?<\/script>/gi, ""],
  [/<style[^>]*>[\s\S]*?<\/style>/gi, ""],
  [/<!--[\s\S]*?-->/g, ""],
  // Inline HTML tags — preserve text content
  [/<[^>]{1,200}>/g, " "],
  // Markdown images — keep alt text
  [/!\[([^\]]*)\]\([^)]+\)/g, "$1"],
  // Bare URLs
  [/(?<!\()\bhttps?:\/\/\S{10,}(?!\))/g, "[url]"],
  // Base64 data URIs
  [/data:[a-z/]+;base64,[A-Za-z0-9+/=]{20,}/gi, "[base64]"],
  // Email-style headers
  [/^(?:Date|From|To|CC|BCC|Subject|Sent|Received|Message-ID)\s*:[^\n]*\n?/gim, ""],
];

// ---------------------------------------------------------------------------
// Sensitive-domain keyword sets
// ---------------------------------------------------------------------------
const SENSITIVE_KW: Record<string, string[]> = {
  legal: [
    "pursuant to", "whereas ", "hereinafter", "indemnif", "liability",
    "breach of contract", "arbitration", "jurisdiction", "statute",
    "regulatory compliance", "attorney", "counsel", "plaintiff", "defendant",
    "court order", "tribunal", "force majeure", "intellectual property",
  ],
  medical: [
    "diagnosis", "treatment plan", "medication", "dosage", "symptom",
    "clinical trial", "patient record", "prescription", "contraindication",
    "adverse effect", "prognosis", "therapy", "medical history",
    "ehr", "phi", "hipaa",
  ],
  financial: [
    "investment advice", "securities", "portfolio", "dividend",
    "fiduciary duty", "prospectus", "material disclosure", "interest rate risk",
    "yield curve", "collateral", "derivatives", "audit report",
    "financial statement", "balance sheet", "insider trading",
  ],
  compliance: [
    "gdpr", "hipaa", "sox ", "pci-dss", "iso 27001", "regulatory requirement",
    "audit trail", "data protection officer", "privacy policy",
    "consent form", "data retention", "right to erasure",
  ],
};

export interface SensitivityResult {
  isSensitive: boolean;
  matchedDomains: string[];
}

export class InputCleaner {
  /**
   * Clean text by removing markup, duplicate paragraphs, and boilerplate.
   * When isSensitive is true only safe whitespace / dedup passes run.
   */
  clean(text: string, isSensitive = false): string {
    if (!text) return text;

    text = this.stripMetadata(text);
    text = this.normaliseWhitespace(text);
    text = this.deduplicateParagraphs(text);

    if (!isSensitive) {
      text = this.removeBoilerplate(text);
      text = this.normaliseWhitespace(text);
    }

    return text.trim();
  }

  /** Check whether text contains sensitive-domain content. */
  checkSensitivity(text: string, domains?: string[]): SensitivityResult {
    const lower = text.toLowerCase();
    const check = domains ?? Object.keys(SENSITIVE_KW);
    const matchedDomains: string[] = [];
    for (const domain of check) {
      const kws = SENSITIVE_KW[domain] ?? [];
      if (kws.some((kw) => lower.includes(kw))) {
        matchedDomains.push(domain);
      }
    }
    return { isSensitive: matchedDomains.length > 0, matchedDomains };
  }

  // ------------------------------------------------------------------
  // Helpers (public for unit-testing individual steps)
  // ------------------------------------------------------------------

  normaliseWhitespace(text: string): string {
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  private stripMetadata(text: string): string {
    for (const [pattern, replacement] of METADATA) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  private deduplicateParagraphs(text: string): string {
    const paragraphs = text.split(/\n\n+/);
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const para of paragraphs) {
      const stripped = para.trim();
      if (!stripped) continue;
      const fingerprint = stripped.toLowerCase().replace(/\s+/g, " ");
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        unique.push(stripped);
      }
    }
    return unique.join("\n\n");
  }

  private removeBoilerplate(text: string): string {
    for (const [pattern, replacement] of BOILERPLATE) {
      text = text.replace(pattern, replacement);
    }
    return text.replace(/  +/g, " ").replace(/^\s*\n/gm, "");
  }
}
