import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { HAIKU_MODEL_ID } from "@/lib/llm/registry";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { processExtractedContent } from "@/lib/datasources/processor";

const HARD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB ceiling
const BUCKET = "chat-uploads";

// How many chars to include verbatim in every chat request (≈ 25K tokens).
// Content beyond this is still fully indexed for semantic retrieval.
const MAX_DIRECT_CHARS = 100_000;
// Files with more content than this are vectorized in the background so the
// upload response is not delayed by embedding API latency.
const BACKGROUND_VECTORIZE_THRESHOLD = 50_000;

/**
 * Upload a file to Supabase Storage AND extract its text content (when possible).
 *
 * Supported parsing:
 *  - PDF                  → unpdf
 *  - DOCX                 → mammoth
 *  - XLSX / XLS / CSV     → xlsx (SheetJS)
 *  - TXT / MD / JSON / code / xml / html / yaml / log → UTF-8 decode
 *  - Audio                → OpenAI Whisper transcription
 *  - Images               → OCR transcript + searchable text
 *  - Other binary         → no extraction; model gets filename only
 */
export const uploadChatFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      conversation_id: z.string().uuid(),
      name: z.string().trim().min(1).max(255),
      type: z.string().trim().max(120),
      data_b64: z.string(),
      max_mb: z.number().int().min(1).max(25).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", data.conversation_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (conversationError || !conversation) {
      throw new Error("Conversation not found.");
    }

    const bytes = decodeBase64(data.data_b64);
    const limitBytes = Math.min((data.max_mb ?? 1) * 1024 * 1024, HARD_MAX_BYTES);
    if (bytes.byteLength > limitBytes) {
      const mb = Math.round((limitBytes / (1024 * 1024)) * 10) / 10;
      throw new Error(`That file is too large. Max ${mb} MB.`);
    }

    const normalizedType = normalizeMimeType(data.name, data.type);
    const kind = classify(data.name, normalizedType);
    if (bytes.byteLength === 0) {
      return {
        name: data.name,
        size: 0,
        type: normalizedType,
        url: null,
        path: null,
        kind,
        extracted_text: `(Attached file "${data.name}" is empty.)`,
        extraction_error: null,
        storage_error: "The file is empty, so there was nothing to store.",
      };
    }
    const safeName = data.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
    const path = `${userId}/${data.conversation_id}/${crypto.randomUUID()}-${safeName}`;

    // ---- Extract text first (best-effort; do not block on storage) ----
    let extractedText: string | null = null;
    let extractionError: string | null = null;
    try {
      if (kind === "pdf") extractedText = await extractPdf(bytes);
      else if (kind === "docx") extractedText = await extractDocx(bytes);
      else if (kind === "spreadsheet") extractedText = await extractSpreadsheet(bytes, data.name);
      else if (kind === "text") extractedText = decodeText(bytes);
      else if (kind === "audio")
        extractedText = await transcribeAudio(bytes, data.name, normalizedType);
      else if (kind === "image") extractedText = await ocrImage(bytes, data.name, normalizedType);
    } catch (e) {
      console.error("[uploadChatFile] extraction failed:", data.name, e);
      extractionError = e instanceof Error ? e.message : "Extraction failed";
    }

    // Auto-vectorize so retrieval can find any part of the file regardless of size.
    // Small files: await inline (few chunks, fast). Large files: fire-and-forget so
    // the upload response is not delayed by embedding API latency.
    if (extractedText) {
      const ext = data.name.split(".").pop()?.toLowerCase() ?? "";
      const vectorizeOpts = {
        sourceType: "conversation_upload" as const,
        sourceId: path,
        conversationId: data.conversation_id,
        expiresInDays: 30,
        metadata: { file_name: data.name, file_type: ext },
      };
      if (extractedText.length <= BACKGROUND_VECTORIZE_THRESHOLD) {
        try {
          await processExtractedContent(userId, extractedText, data.name, ext, vectorizeOpts, supabase);
        } catch (e) {
          console.warn("[uploadChatFile] vectorization failed:", e);
        }
      } else {
        void processExtractedContent(userId, extractedText, data.name, ext, vectorizeOpts, supabase)
          .catch((e) => console.warn("[uploadChatFile] background vectorization failed:", e));
      }
    }

    // Truncate what is sent in every chat request. Anything beyond MAX_DIRECT_CHARS
    // is already indexed above and will surface through semantic retrieval.
    if (extractedText && extractedText.length > MAX_DIRECT_CHARS) {
      extractedText =
        extractedText.slice(0, MAX_DIRECT_CHARS) +
        `\n\n[…file continues — full content indexed for search. Ask specific questions to retrieve any section.]`;
    }

    // ---- Upload to storage (can fail independently of parsing) ----
    let signedUrl: string | null = null;
    let storageError: string | null = null;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: normalizedType,
      upsert: false,
    });

    if (upErr) {
      console.error("[uploadChatFile]", upErr);
      storageError = formatStorageError(upErr);
    } else {
      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signErr || !signed) {
        console.error("[uploadChatFile] signed URL failed", signErr);
        storageError = "The file uploaded, but I couldn't prepare its download link.";
      } else {
        signedUrl = signed.signedUrl;
      }
    }

    return {
      name: data.name,
      size: bytes.byteLength,
      type: normalizedType,
      url: signedUrl,
      path: signedUrl ? path : null,
      kind,
      extracted_text: extractedText,
      extraction_error: extractionError,
      storage_error: storageError,
    };
  });

// ---------------- helpers ----------------

type Kind = "pdf" | "docx" | "spreadsheet" | "text" | "audio" | "image" | "other";

function classify(name: string, mime: string): Kind {
  const n = name.toLowerCase();
  const m = (mime || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    n.endsWith(".docx")
  ) {
    return "docx";
  }
  if (
    n.endsWith(".xlsx") ||
    n.endsWith(".xls") ||
    n.endsWith(".csv") ||
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel" ||
    m === "text/csv"
  ) {
    return "spreadsheet";
  }
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(n)) return "image";
  if (m.startsWith("audio/") || /\.(mp3|wav|m4a|webm|ogg|flac|aac)$/i.test(n)) return "audio";
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m === "application/typescript" ||
    /\.(txt|md|markdown|json|jsonl|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|yaml|yml|toml|ini|env|sql|log)$/i.test(
      n,
    )
  ) {
    return "text";
  }
  return "other";
}

function normalizeMimeType(name: string, mime: string): string {
  const lower = name.toLowerCase();
  const clean = (mime || "").trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;

  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log"))
    return "text/plain";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "application/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".jsx"))
    return "text/plain";
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".env")
  ) {
    return "text/plain";
  }
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : text).trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer: ab as ArrayBuffer });
  return result.value.trim();
}

type XLSXMod = typeof import("xlsx");
type SpreadsheetCell = { v?: unknown; w?: string; t?: string };
type SpreadsheetMerge = { s: { r: number; c: number }; e: { r: number; c: number } };

async function extractSpreadsheet(bytes: Uint8Array, name: string): Promise<string> {
  const XLSX = await import("xlsx");
  // cellDates:true converts serial numbers to JS Date objects for clean ISO formatting.
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
      sections.push(spreadsheetSheetToText(XLSX, sheet, sheetName));
    } catch (e) {
      sections.push(
        `\n=== ${sheetName} ===\n[error: ${e instanceof Error ? e.message : String(e)}]`,
      );
    }
  }

  return sections.join("\n");
}

function spreadsheetSheetToText(
  XLSX: XLSXMod,
  sheet: Record<string, unknown>,
  sheetName: string,
): string {
  const merges: SpreadsheetMerge[] = (sheet["!merges"] as SpreadsheetMerge[]) ?? [];

  // Step 1: bounding box — start from !ref, then extend via cell key scan + merge extents.
  // Never use content-based filtering: silently drops empty-but-valid columns and rows.
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

  // Step 2: merge value map — every address in every region gets the anchor's display value.
  // Empty-anchor merges still populate with "" so non-anchor cells aren't mistaken for data.
  const mergeMap = new Map<string, string>();
  for (const m of merges) {
    const anchorVal = spreadsheetCellStr(sheet[XLSX.utils.encode_cell(m.s)] as SpreadsheetCell | undefined);
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        mergeMap.set(XLSX.utils.encode_cell({ r, c }), anchorVal);
      }
    }
  }

  // Step 3: read every cell in the full bounding box
  const rows: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    const cells: string[] = [];
    let rowHasData = false;
    for (let c = minC; c <= maxC; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      let val = spreadsheetCellStr(sheet[addr] as SpreadsheetCell | undefined);
      if (!val && mergeMap.has(addr)) val = mergeMap.get(addr)!;
      if (val) rowHasData = true;
      cells.push(val);
    }
    // Only skip rows where every cell is blank
    if (rowHasData) rows.push(cells.join("\t"));
  }

  return `\n=== ${sheetName} | ${rows.length} rows × ${maxC - minC + 1} cols ===\n${rows.join("\n") || "(empty)"}`;
}

function spreadsheetCellStr(cell: SpreadsheetCell | undefined): string {
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

async function transcribeAudio(bytes: Uint8Array, name: string, mime: string): Promise<string> {
  const env = await getRuntimeEnv();
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Audio transcription unavailable right now.");
  }
  const form = new FormData();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append("file", new Blob([ab], { type: mime || "audio/mpeg" }), name || "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "text");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Audio transcription failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

const OCR_SYSTEM =
  "You are an OCR engine. Read the image and return ONLY the text content visible in it, preserving line breaks and reading order. Do NOT add commentary, headers, code fences, or explanations. If the image has no readable text, return a single short description line of what is shown.";

async function ocrImage(bytes: Uint8Array, name: string, mime: string): Promise<string> {
  const lowerName = name.toLowerCase();
  const lowerMime = (mime || "").toLowerCase();
  const isHeic =
    lowerMime === "image/heic" ||
    lowerMime === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif");
  if (isHeic) {
    return "(HEIC images aren't supported for OCR yet — please convert to JPG or PNG and re-upload.)";
  }

  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const b64 = btoa(bin);

  const env = await getRuntimeEnv();
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const openaiKey = env.OPENAI_API_KEY;

  if (anthropicKey) {
    return ocrImageAnthropic(b64, lowerName, lowerMime, anthropicKey);
  }
  if (openaiKey) {
    return ocrImageOpenAI(b64, lowerName, lowerMime, openaiKey);
  }
  console.error("[ocrImage] No vision API key resolved from runtime env", {
    hasProcessAnthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    hasProcessOpenAI: Boolean(process.env.OPENAI_API_KEY),
    resolvedKeys: Object.keys(env).filter((k) => k.includes("API_KEY")),
  });
  // Neither key available — image is still stored and passed to vision models directly.
  return `(Image file: ${name} — text extraction unavailable, but the image will be visible to the AI.)`;
}

async function ocrImageAnthropic(
  b64: string,
  lowerName: string,
  lowerMime: string,
  apiKey: string,
): Promise<string> {
  let mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/jpeg";
  if (lowerMime === "image/png" || lowerName.endsWith(".png")) mediaType = "image/png";
  else if (lowerMime === "image/gif" || lowerName.endsWith(".gif")) mediaType = "image/gif";
  else if (lowerMime === "image/webp" || lowerName.endsWith(".webp")) mediaType = "image/webp";

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });

  const TIMEOUT_MS = 60_000;
  const attempt = async (): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await client.messages.create(
        {
          model: HAIKU_MODEL_ID,
          max_tokens: 2048,
          system: OCR_SYSTEM,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
                { type: "text", text: "Extract all text from this image." },
              ],
            },
          ],
        },
        { signal: ctrl.signal },
      );
      const block = res.content[0];
      return block && block.type === "text" ? block.text : "";
    } finally {
      clearTimeout(timer);
    }
  };

  let raw = "";
  try {
    raw = await attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retriable =
      msg.includes("aborted") ||
      msg.includes("timeout") ||
      msg.includes("ECONNRESET") ||
      msg.includes("fetch failed") ||
      /\b(5\d\d)\b/.test(msg);
    if (!retriable) throw err;
    console.warn("[ocrImage:anthropic] retry after failure:", msg);
    await new Promise((r) => setTimeout(r, 1500));
    raw = await attempt();
  }

  const cleaned = postProcessOcr(raw);
  return cleaned || "(No readable text found in the image.)";
}

async function ocrImageOpenAI(
  b64: string,
  lowerName: string,
  lowerMime: string,
  apiKey: string,
): Promise<string> {
  let mimeType = "image/jpeg";
  if (lowerMime === "image/png" || lowerName.endsWith(".png")) mimeType = "image/png";
  else if (lowerMime === "image/gif" || lowerName.endsWith(".gif")) mimeType = "image/gif";
  else if (lowerMime === "image/webp" || lowerName.endsWith(".webp")) mimeType = "image/webp";

  const TIMEOUT_MS = 60_000;
  const attempt = async (): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 2048,
          messages: [
            { role: "system", content: OCR_SYSTEM },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${b64}`, detail: "high" },
                },
                { type: "text", text: "Extract all text from this image." },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`OpenAI OCR ${res.status}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  };

  let raw = "";
  try {
    raw = await attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retriable =
      msg.includes("aborted") ||
      msg.includes("timeout") ||
      msg.includes("ECONNRESET") ||
      msg.includes("fetch failed") ||
      /\b(5\d\d)\b/.test(msg);
    if (!retriable) throw err;
    console.warn("[ocrImage:openai] retry after failure:", msg);
    await new Promise((r) => setTimeout(r, 1500));
    raw = await attempt();
  }

  const cleaned = postProcessOcr(raw);
  return cleaned || "(No readable text found in the image.)";
}

function postProcessOcr(text: string): string {
  if (!text) return "";
  let t = text.replace(/\r\n?/g, "\n");
  t = t.replace(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/m, "$1");
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  t = t.replace(/[\uFFFD]+/g, "");
  t = t
    .split("\n")
    .filter((line) => !/^[\s\W_]{2,}$/.test(line.trim()) || line.trim().length === 0)
    .join("\n");
  t = t.replace(/[ \t]+/g, " ");
  t = t
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function formatStorageError(error: { message?: string; statusCode?: string }): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("violates row-level security policy")) {
    return "File uploads are blocked by storage permissions right now.";
  }
  if (msg.includes("mime") || msg.includes("content type")) {
    return "This file type isn't allowed by the storage bucket settings.";
  }
  if (msg.includes("size") || msg.includes("too large")) {
    return "That file exceeds the storage bucket size limit.";
  }
  return "I couldn't upload that file right now.";
}
