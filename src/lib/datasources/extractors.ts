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

// ─── Spreadsheet extraction ───────────────────────────────────────────────────
// Single source-of-truth algorithm used by both this datasource pipeline and
// uploads.functions.ts (duplicated there to keep each module self-contained).
//
// Design principles:
//  1. Bounding box from !ref + cell key scan + merge extents — never content-based
//     filtering, which silently drops empty-but-valid columns and rows.
//  2. Merge map covers every address in every region; empty-anchor merges still
//     register their region so non-anchor cells are not mistakenly shown as data.
//  3. Cell value: prefer w (formatted display string) over v (raw value) so
//     numbers, dates, and percentages appear exactly as Excel renders them.
//  4. sheetStubs / cellFormula / cellNF not used — they add cost/risk with no
//     benefit once we rely on w first and v as fallback.

type XLSXMod = typeof import("xlsx");
type CellObj = { v?: unknown; w?: string; t?: string };
type MergeRange = { s: { r: number; c: number }; e: { r: number; c: number } };

async function extractSpreadsheet(bytes: Uint8Array, name: string): Promise<string> {
  const XLSX = await import("xlsx");
  // cellDates:true converts date serial numbers to JS Date objects so we can
  // format them as ISO strings when w is missing.
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });

  if (!wb.SheetNames.length) return `(empty workbook: ${name})`;

  const sections: string[] = [
    `Workbook: ${name}  |  ${wb.SheetNames.length} sheet(s): ${wb.SheetNames.join(", ")}`,
  ];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    // !ref is absent on chart sheets, macro sheets, and dialog sheets
    if (!sheet || !sheet["!ref"]) {
      sections.push(`\n=== ${sheetName} ===\n(no data grid)`);
      continue;
    }
    try {
      sections.push(sheetToText(XLSX, sheet, sheetName));
    } catch (e) {
      sections.push(
        `\n=== ${sheetName} ===\n[error: ${e instanceof Error ? e.message : String(e)}]`,
      );
    }
  }

  return sections.join("\n");
}

function sheetToText(
  XLSX: XLSXMod,
  sheet: Record<string, unknown>,
  sheetName: string,
): string {
  const merges: MergeRange[] = (sheet["!merges"] as MergeRange[]) ?? [];

  // ── Step 1: bounding box ──────────────────────────────────────────────────
  // Start from the declared !ref range (SheetJS always sets this for data
  // sheets), then extend by scanning every cell key (catches cells outside a
  // stale !ref) and every merge region endpoint.
  const declared = XLSX.utils.decode_range(sheet["!ref"] as string);
  let minR = declared.s.r, minC = declared.s.c;
  let maxR = declared.e.r, maxC = declared.e.c;

  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r < minR) minR = r;  if (c < minC) minC = c;
    if (r > maxR) maxR = r;  if (c > maxC) maxC = c;
  }
  for (const m of merges) {
    if (m.s.r < minR) minR = m.s.r;  if (m.s.c < minC) minC = m.s.c;
    if (m.e.r > maxR) maxR = m.e.r;  if (m.e.c > maxC) maxC = m.e.c;
  }

  // ── Step 2: merge value map ───────────────────────────────────────────────
  // Every address inside a merge region gets the anchor's display value.
  // Empty-anchor merges still populate the map with "" so we know those cells
  // are part of a region and won't accidentally pull stale data from elsewhere.
  const mergeMap = new Map<string, string>();
  for (const m of merges) {
    const anchorVal = cellStr(sheet[XLSX.utils.encode_cell(m.s)] as CellObj | undefined);
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        mergeMap.set(XLSX.utils.encode_cell({ r, c }), anchorVal);
      }
    }
  }

  // ── Step 3: read every cell in the bounding box ───────────────────────────
  const rows: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    const cells: string[] = [];
    let rowHasData = false;
    for (let c = minC; c <= maxC; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      // Cell's own value first; merge map as fallback (covers non-anchor cells)
      let val = cellStr(sheet[addr] as CellObj | undefined);
      if (!val && mergeMap.has(addr)) val = mergeMap.get(addr)!;
      if (val) rowHasData = true;
      cells.push(val);
    }
    // Only skip rows that are completely empty (all cells blank)
    if (rowHasData) rows.push(cells.join("\t"));
  }

  return `\n=== ${sheetName} | ${rows.length} rows × ${maxC - minC + 1} cols ===\n${rows.join("\n") || "(empty)"}`;
}

function cellStr(cell: CellObj | undefined): string {
  if (!cell) return "";
  // w = the formatted display string exactly as Excel renders it — always prefer
  if (cell.w != null) {
    const s = String(cell.w).replace(/[\t\r\n]+/g, " ").trim();
    if (s) return s;
  }
  const v = cell.v;
  if (v === undefined || v === null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).replace(/[\t\r\n]+/g, " ").trim();
}

function extractDelimited(bytes: Uint8Array, type: string): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  if (!text) return "";
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
