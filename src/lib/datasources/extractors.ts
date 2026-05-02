// File content extraction for the datasources pipeline.
// All extractors run in Cloudflare Workers (no Node.js APIs).
//
// Fixes:
//   - RTF: proper control-sequence stripping (was just toString('utf-8'))
//   - PPTX: full implementation via fflate ZIP + OpenXML parsing
//   - Images: describe via vision model → text chunk for searchability
import { HAIKU_MODEL_ID } from "@/lib/llm/registry";

export async function extractContent(
  bytes: Uint8Array,
  fileType: string,
  fileName: string,
): Promise<string> {
  const type = fileType.toLowerCase().replace(".", "");

  switch (type) {
    case "docx":
    case "doc":
      return extractDocx(bytes);

    case "pdf":
      return extractPdf(bytes);

    case "xlsx":
    case "xls":
    case "xlsm":
    case "xlsb":
    case "ods":
      return extractSpreadsheet(bytes, fileName);

    case "csv":
    case "tsv":
      return extractDelimited(bytes, type);

    case "pptx":
    case "ppt":
      return extractPptx(bytes);

    case "rtf":
      return extractRtf(bytes);

    case "txt":
    case "md":
    case "markdown":
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "env":
    case "sql":
    case "log":
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();

    case "html":
    case "htm":
      return extractHtml(bytes);

    case "py":
    case "js":
    case "ts":
    case "tsx":
    case "jsx":
    case "java":
    case "cpp":
    case "c":
    case "h":
    case "hpp":
    case "cs":
    case "go":
    case "rs":
    case "php":
    case "rb":
    case "swift":
    case "kt":
    case "css":
    case "scss":
    case "sh":
    case "bash":
    case "xml":
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();

    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return describeImageForSearch(bytes, fileName, type);

    default:
      // Try UTF-8 decode as fallback
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      } catch {
        return `[Binary file: ${fileName}]`;
      }
  }
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer: ab as ArrayBuffer });
  return result.value.trim();
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : text).trim();
}

async function extractSpreadsheet(bytes: Uint8Array, name: string): Promise<string> {
  const XLSX = await import("xlsx");
  // cellDates: parse Excel serial dates to JS Date; cellNF: keep number formats
  const wb = XLSX.read(bytes, { type: "array", cellDates: true, cellNF: false });
  const parts: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) {
      parts.push(`--- Sheet: ${sheetName} ---\n(empty)`);
      continue;
    }

    // Convert to AOA so we can render a readable, aligned table per tab.
    // blankrows:false drops fully empty rows; defval:"" keeps column alignment.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false, // use formatted strings (dates, percents, currency) when available
    });

    if (!rows.length) {
      parts.push(`--- Sheet: ${sheetName} ---\n(empty)`);
      continue;
    }

    // Render as TSV-style rows. Tabs preserve cell boundaries better than CSV
    // for LLM consumption and avoid quoting issues with commas inside cells.
    const lines: string[] = [];
    for (const row of rows) {
      const cells = (row as unknown[]).map((c) => {
        if (c === null || c === undefined) return "";
        if (c instanceof Date) return c.toISOString().slice(0, 10);
        return String(c).replace(/[\t\r\n]+/g, " ").trim();
      });
      // Skip rows that became fully empty after normalization
      if (cells.some((c) => c.length > 0)) lines.push(cells.join("\t"));
    }

    parts.push(`--- Sheet: ${sheetName} (${lines.length} rows) ---\n${lines.join("\n")}`);
  }

  return parts.length ? parts.join("\n\n") : `(empty spreadsheet: ${name})`;
}

function extractDelimited(bytes: Uint8Array, type: string): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  if (!text) return "";
  // Return as-is; chunker handles row splitting. Label so the LLM knows the format.
  const label = type === "tsv" ? "TSV" : "CSV";
  return `--- ${label} ---\n${text}`;
}

// PPTX: ZIP containing OpenXML slide files (ppt/slides/slideN.xml)
async function extractPptx(bytes: Uint8Array): Promise<string> {
  try {
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes);
    const slideKeys = Object.keys(files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? "0");
        const nb = parseInt(b.match(/\d+/)?.[0] ?? "0");
        return na - nb;
      });

    const slides: string[] = [];
    for (const key of slideKeys) {
      const xml = strFromU8(files[key]);
      // Extract all <a:t> element text content from the OpenXML
      const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
        .map((m) => m[1].trim())
        .filter(Boolean);
      // Also extract speaker notes from notesSlideN.xml if present
      const noteKey = key.replace("slides/slide", "noteSlides/notesSlide");
      if (files[noteKey]) {
        const noteXml = strFromU8(files[noteKey]);
        const noteTexts = [...noteXml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
          .map((m) => m[1].trim())
          .filter(Boolean);
        if (noteTexts.length) texts.push(`[Notes: ${noteTexts.join(" ")}]`);
      }
      if (texts.length) slides.push(`[Slide ${slides.length + 1}]\n${texts.join(" ")}`);
    }
    return slides.join("\n\n");
  } catch (e) {
    return `[Could not parse PPTX file: ${e instanceof Error ? e.message : "unknown error"}]`;
  }
}

// RTF: strip control sequences to extract readable text
function extractRtf(bytes: Uint8Array): string {
  // RTF files use Windows-1252 encoding typically
  const text = new TextDecoder("windows-1252", { fatal: false }).decode(bytes);

  let result = text;
  // Remove RTF header
  result = result.replace(/^{\\rtf\d[^{}]*/, "");
  // Remove font tables, color tables, and other header groups
  result = result.replace(/\\fonttbl[^}]*}/g, "");
  result = result.replace(/\\colortbl[^;]*;}/g, "");
  result = result.replace(/\\stylesheet[^}]*}/g, "");
  result = result.replace(/\\info[^}]*}/g, "");
  // Remove escaped curly braces and backslashes
  result = result.replace(/\\{/g, "LBRACE_PLACEHOLDER");
  result = result.replace(/\\}/g, "RBRACE_PLACEHOLDER");
  result = result.replace(/\\\\/g, "BACKSLASH_PLACEHOLDER");
  // Remove control words (\\word) and control symbols (\\symbol)
  result = result.replace(/\\[a-zA-Z]+\d*/g, " ");
  result = result.replace(/\\[^a-zA-Z\s]/g, "");
  // Remove hex escapes \'XX
  result = result.replace(/\\'\w{2}/g, "");
  // Remove remaining braces
  result = result.replace(/[{}]/g, "");
  // Restore escaped characters
  result = result.replace(/LBRACE_PLACEHOLDER/g, "{");
  result = result.replace(/RBRACE_PLACEHOLDER/g, "}");
  result = result.replace(/BACKSLASH_PLACEHOLDER/g, "\\");
  // Clean up whitespace
  result = result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return result || "[RTF file could not be parsed]";
}

// HTML: extract readable text using cheerio
async function extractHtml(bytes: Uint8Array): Promise<string> {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  try {
    const { load } = await import("cheerio");
    const $ = load(html);
    $("script, style, nav, header, footer, aside, [role='navigation']").remove();
    const main = $("main, article, .content, .main, #main, #content").first();
    const text = (main.length ? main : $("body")).text();
    return text.replace(/\s+/g, " ").trim();
  } catch {
    // Fallback: strip HTML tags with regex
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

// Images: generate a text description for vector search via vision model
// This makes image datasources searchable via semantic queries
async function describeImageForSearch(
  bytes: Uint8Array,
  fileName: string,
  ext: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return `[Image: ${fileName}]`;

  const mediaTypeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const mediaType = mediaTypeMap[ext] ?? "image/jpeg";

  // Convert to base64
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const b64 = btoa(bin);

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });

    const res = await client.messages.create({
      model: HAIKU_MODEL_ID,
      max_tokens: 512,
      system:
        "You are indexing an image for search. Describe its content comprehensively: what is shown, any text visible, charts or data, people, logos, locations. Be specific and use keywords a person would search for. Do not use markdown.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: b64,
              },
            },
            { type: "text", text: "Describe this image for search indexing." },
          ],
        },
      ],
    });

    const block = res.content[0];
    const description = block?.type === "text" ? block.text.trim() : "";
    return description || `[Image: ${fileName}]`;
  } catch {
    return `[Image: ${fileName}]`;
  }
}
