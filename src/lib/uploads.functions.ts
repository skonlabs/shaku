import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const BUCKET = "chat-uploads";
const MAX_EXTRACTED_CHARS = 120_000; // cap to keep prompt size sane

/**
 * Upload a file to Supabase Storage AND extract its text content (when possible).
 *
 * Supported parsing:
 *  - PDF                  → unpdf
 *  - DOCX                 → mammoth
 *  - XLSX / XLS / CSV     → xlsx (SheetJS)
 *  - TXT / MD / JSON / code / any text-ish mime → UTF-8 decode
 *  - Audio (mp3/wav/m4a/webm/ogg) → OpenAI Whisper transcription
 *  - Images               → no extraction here (model "sees" them via URL)
 *  - Other binary         → no extraction; model gets filename only
 */
export const uploadChatFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      conversation_id: z.string().uuid(),
      name: z.string().min(1).max(255),
      type: z.string().max(120),
      data_b64: z.string().min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    const bytes = decodeBase64(data.data_b64);
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error("That file is too large. Max 25 MB.");
    }

    const safeName = data.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
    const path = `${userId}/${data.conversation_id}/${crypto.randomUUID()}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, {
        contentType: data.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.error("[uploadChatFile]", upErr);
      throw new Error("I couldn't upload that file. Please try again.");
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days
    if (signErr || !signed) throw new Error("I couldn't prepare the file URL.");

    // ---- Extract text (best-effort; never fail the upload) ----
    let extractedText: string | null = null;
    let extractionError: string | null = null;
    const kind = classify(data.name, data.type);
    try {
      if (kind === "pdf") extractedText = await extractPdf(bytes);
      else if (kind === "docx") extractedText = await extractDocx(bytes);
      else if (kind === "spreadsheet") extractedText = await extractSpreadsheet(bytes, data.name);
      else if (kind === "text") extractedText = decodeText(bytes);
      else if (kind === "audio") extractedText = await transcribeAudio(bytes, data.name, data.type);
      // images / other → leave null
    } catch (e) {
      console.error("[uploadChatFile] extraction failed:", data.name, e);
      extractionError = e instanceof Error ? e.message : "Extraction failed";
    }

    if (extractedText && extractedText.length > MAX_EXTRACTED_CHARS) {
      extractedText =
        extractedText.slice(0, MAX_EXTRACTED_CHARS) +
        `\n\n[…truncated; showing first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters of ${extractedText.length.toLocaleString()}.]`;
    }

    return {
      name: data.name,
      size: bytes.byteLength,
      type: data.type,
      url: signed.signedUrl,
      path,
      kind,
      extracted_text: extractedText,
      extraction_error: extractionError,
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
  )
    return "docx";
  if (
    n.endsWith(".xlsx") ||
    n.endsWith(".xls") ||
    n.endsWith(".csv") ||
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel" ||
    m === "text/csv"
  )
    return "spreadsheet";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || /\.(mp3|wav|m4a|webm|ogg|flac|aac)$/.test(n)) return "audio";
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m === "application/typescript" ||
    /\.(txt|md|markdown|json|jsonl|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|yaml|yml|toml|ini|env|sql|log)$/.test(
      n,
    )
  )
    return "text";
  return "other";
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
  // mammoth wants an ArrayBuffer
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer: ab as ArrayBuffer });
  return result.value.trim();
}

async function extractSpreadsheet(bytes: Uint8Array, name: string): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) {
      parts.push(`--- Sheet: ${sheetName} ---\n${csv.trim()}`);
    }
  }
  if (parts.length === 0) return `(empty spreadsheet: ${name})`;
  return parts.join("\n\n");
}

async function transcribeAudio(
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Audio transcription unavailable (OPENAI_API_KEY not set).");
  }
  const form = new FormData();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append(
    "file",
    new Blob([ab], { type: mime || "audio/mpeg" }),
    name || "audio.mp3",
  );
  form.append("model", "whisper-1");
  form.append("response_format", "text");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Whisper failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}
