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
import type { SupabaseClient } from "@supabase/supabase-js";

type AnySupabaseClient = SupabaseClient<any, any, any>;

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
  supabase: AnySupabaseClient,
): Promise<{ chunkCount: number; contentHash: string }> {
  const contentHash = await hashBytes(bytes);

  // Check if we already indexed this exact content (deduplication)
  const { count: existingCount } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("source_type", opts.sourceType)
    .eq("content_hash", contentHash);

  if (existingCount && existingCount > 0) {
    return { chunkCount: existingCount, contentHash };
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

  // 3. Generate embeddings in batch
  let embeddings: number[][];
  try {
    embeddings = await embedBatch(chunks);
  } catch {
    // Proceed without embeddings (text search still works)
    embeddings = chunks.map(() => []);
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
    metadata: {
      ...opts.metadata,
      file_name: fileName,
      file_type: fileType,
      chunk_index: i,
      total_chunks: chunks.length,
    },
    content_hash: contentHash,
    embedding: embeddings[i]?.length ? `[${embeddings[i].join(",")}]` : null,
    expires_at: expiresAt,
  }));

  // Insert in batches of 50 to avoid request size limits
  const BATCH = 50;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase.from("chunks").insert(batch);
    if (error) throw new Error(`Failed to index chunks: ${error.message}`);
  }

  return { chunkCount: chunks.length, contentHash };
}

// Process a URL: fetch → extract HTML → chunk → embed → index (temporary)
export async function processUrl(
  userId: string,
  url: string,
  conversationId: string,
  supabase: AnySupabaseClient,
): Promise<{ chunkCount: number }> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Cortex/1.0 (content indexer)" },
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

// Delete all chunks for a datasource file or connector
export async function deleteChunks(
  userId: string,
  sourceType: string,
  sourceId: string,
  supabase: AnySupabaseClient,
): Promise<void> {
  await supabase
    .from("chunks")
    .delete()
    .eq("user_id", userId)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId);
}

// SHA-256 hash of bytes (CF Workers has native crypto.subtle)
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
