// Datasource processing pipeline: extract → chunk → embed → index.
// Called for both datasource panel uploads and connector syncs.
//
// Uses ctx.waitUntil() for async execution in CF Workers
// (replaces pg-boss which requires Node.js pg client).
//
// Total time target: 30–60 seconds for typical document.

import { extractContent } from "./extractors";
import { chunkByFileType } from "./chunkers";
import { embedBatch } from "@/lib/embeddings";

export type ProcessingStatus = "uploading" | "processing" | "ready" | "error";

export interface ProcessingOptions {
  sourceType: "datasource" | "connector" | "conversation_upload" | "url_in_message";
  sourceId: string; // datasource_file.id or connector.id
  sourceItemId?: string; // connector-specific item ID
  metadata?: Record<string, unknown>;
  conversationId?: string; // for conversation_upload: sets expiry
  expiresInDays?: number; // for temporary chunks
}

export async function processFile(
  userId: string,
  bytes: Uint8Array,
  fileName: string,
  fileType: string,
  opts: ProcessingOptions,
  supabase: any,
): Promise<{ chunkCount: number; contentHash: string; skipped?: boolean }> {
  const contentHash = await hashBytes(bytes);

  // Check if we already indexed this exact content for this specific source (deduplication).
  // Both content_hash AND source_id are required: identical content from different sources
  // should each be indexed independently.
  const { count: existingCount } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("source_type", opts.sourceType)
    .eq("content_hash", contentHash)
    .eq("source_id", opts.sourceId); // add source_id to dedup check

  if ((existingCount ?? 0) > 0) {
    return { chunkCount: 0, contentHash, skipped: true }; // return 0, not old count
  }

  // 1. Extract text content
  let content: string;
  try {
    content = await extractContent(bytes, fileType, fileName);
  } catch (e) {
    throw new Error(
      `Failed to extract content from ${fileName}: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  if (!content.trim()) {
    return { chunkCount: 0, contentHash };
  }

  // 2. Chunk by file type
  const chunks = chunkByFileType(content, fileType);
  if (!chunks.length) return { chunkCount: 0, contentHash };

  // 3. Generate embeddings in batch.
  // Don't fall back to empty embeddings on failure — instead flag chunks so they
  // can be re-embedded on the next sync. This prevents the dedup hash from
  // permanently locking out chunks that were inserted without embeddings.
  let embeddings: number[][] | null = null;
  try {
    embeddings = await embedBatch(chunks);
  } catch (e) {
    console.error("[processor] embedBatch failed, inserting with needs_embedding flag", e);
  }

  // 4. Index in PostgreSQL
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86400 * 1000).toISOString()
    : null;

  const records = chunks.map((chunk, i) => ({
    user_id: userId,
    source_type: opts.sourceType,
    source_id: opts.sourceId,
    source_item_id: opts.sourceItemId ?? null,
    content: chunk,
    // Dedicated columns for efficient filtering/display (migration 0008)
    chunk_index: i,
    chunk_total: chunks.length,
    token_count: Math.ceil(chunk.length / 4), // ~4 chars/token approximation
    document_name: fileName,
    metadata: {
      ...opts.metadata,
      file_name: fileName,
      file_type: fileType,
    },
    content_hash: contentHash,
    embedding: embeddings?.[i]?.length ? `[${embeddings[i].join(",")}]` : null,
    expires_at: expiresAt,
  }));

  // Insert in batches of 50 to avoid request size limits
  const BATCH = 50;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase.from("chunks").insert(batch);
    if (error) {
      // Unique constraint violation: a concurrent request already indexed this content.
      if ((error as { code?: string }).code === "23505") {
        return { chunkCount: 0, contentHash, skipped: true };
      }
      throw new Error(`Failed to index chunks: ${error.message}`);
    }
  }

  return { chunkCount: chunks.length, contentHash };
}

// Process a URL: fetch → extract HTML → chunk → embed → index.
// Called from datasources.process route when a URL datasource is submitted.
export async function processUrl(
  userId: string,
  url: string,
  conversationId: string,
  supabase: any,
): Promise<{ chunkCount: number }> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Ekonomical/1.0 (content indexer)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    throw new Error(`Could not fetch ${url}: ${e instanceof Error ? e.message : "timeout"}`);
  }

  const bytes = new TextEncoder().encode(html);
  const { chunkCount } = await processFile(
    userId,
    bytes,
    new URL(url).hostname,
    "html",
    {
      sourceType: "url_in_message",
      sourceId: conversationId,
      sourceItemId: url,
      metadata: { url, title: new URL(url).hostname },
      expiresInDays: 1, // URL-in-message: expire after 1 day
    },
    supabase,
  );

  return { chunkCount };
}

// Process pre-extracted text content: chunk → embed → index.
// Used by the chat upload pipeline to avoid re-extracting content that has
// already been parsed (saves time and avoids double-parsing binary formats).
export async function processExtractedContent(
  userId: string,
  content: string,
  fileName: string,
  fileType: string,
  opts: ProcessingOptions,
  supabase: any,
): Promise<{ chunkCount: number; contentHash: string; skipped?: boolean }> {
  const contentHash = await hashContent(content);

  const { count: existingCount } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("source_type", opts.sourceType)
    .eq("content_hash", contentHash)
    .eq("source_id", opts.sourceId);

  if ((existingCount ?? 0) > 0) {
    return { chunkCount: 0, contentHash, skipped: true };
  }

  if (!content.trim()) return { chunkCount: 0, contentHash };

  const chunks = chunkByFileType(content, fileType);
  if (!chunks.length) return { chunkCount: 0, contentHash };

  let embeddings: number[][] | null = null;
  try {
    embeddings = await embedBatch(chunks);
  } catch (e) {
    console.error("[processExtractedContent] embedBatch failed, inserting with needs_embedding flag", e);
  }

  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86400 * 1000).toISOString()
    : null;

  const records = chunks.map((chunk, i) => ({
    user_id: userId,
    source_type: opts.sourceType,
    source_id: opts.sourceId,
    source_item_id: opts.sourceItemId ?? null,
    content: chunk,
    chunk_index: i,
    chunk_total: chunks.length,
    token_count: Math.ceil(chunk.length / 4),
    document_name: fileName,
    metadata: { ...opts.metadata, file_name: fileName, file_type: fileType },
    content_hash: contentHash,
    embedding: embeddings?.[i]?.length ? `[${embeddings[i].join(",")}]` : null,
    expires_at: expiresAt,
  }));

  const BATCH = 50;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase.from("chunks").insert(batch);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return { chunkCount: 0, contentHash, skipped: true };
      }
      throw new Error(`Failed to index chunks: ${error.message}`);
    }
  }

  return { chunkCount: chunks.length, contentHash };
}

// SHA-256 hash of bytes (CF Workers has native crypto.subtle)
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  return hashBytes(bytes);
}
