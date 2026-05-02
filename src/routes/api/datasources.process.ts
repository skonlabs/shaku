// POST: Process an uploaded datasource file (extract → chunk → embed → index).
// Called by the client after uploading a file to Supabase Storage.
// Uses waitUntil for async processing so response returns quickly.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

const BodySchema = z.object({
  file_id: z.string().uuid(),
  storage_path: z.string().min(1),
  file_type: z.string().min(1).max(50),
  file_name: z.string().min(1).max(255),
});

export const Route = createFileRoute("/api/datasources/process")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.toLowerCase().startsWith("bearer ")) {
          return jsonError("Unauthorized", 401);
        }

        const token = authHeader.slice(7).trim();
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });

        const { data: userData } = await supabase.auth.getUser(token);
        if (!userData.user) return jsonError("Unauthorized", 401);
        const userId = userData.user.id;

        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return jsonError("Invalid request", 400);
        }

        // Verify file belongs to user
        const { data: file } = await supabase
          .from("datasource_files")
          .select("id, status")
          .eq("id", body.file_id)
          .eq("user_id", userId)
          .single();

        if (!file) return jsonError("File not found", 404);
        if (file.status === "ready") {
          return new Response(JSON.stringify({ status: "already_processed" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Mark as processing
        await supabase
          .from("datasource_files")
          .update({ status: "processing" })
          .eq("id", body.file_id);

        // Start processing. Use waitUntil when available; otherwise await so the
        // work is not cancelled after the response is returned.
        const processPromise = processFileAsync(
          userId,
          body.file_id,
          body.storage_path,
          body.file_type,
          body.file_name,
          supabase,
        );

        const cfCtx = (globalThis as Record<string, unknown>).__cfContext as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
        if (cfCtx?.waitUntil) {
          cfCtx.waitUntil(processPromise);
        } else {
          await processPromise;
        }

        return new Response(JSON.stringify({ ok: true, status: "processing" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

async function processFileAsync(
  userId: string,
  fileId: string,
  storagePath: string,
  fileType: string,
  fileName: string,
  supabase: any,
): Promise<void> {
  try {
    // Download from Supabase Storage.
    // Note: storage bucket is "datasource-files" (hyphen), table is "datasource_files" (underscore)
    const { data: fileData, error: dlErr } = await supabase.storage
      .from("datasource-files")
      .download(storagePath);

    if (dlErr || !fileData) {
      throw new Error(`Download failed: ${dlErr?.message}`);
    }

    const bytes = new Uint8Array(await fileData.arrayBuffer());
    const { processFile } = await import("@/lib/datasources/processor");

    const result = await processFile(userId, bytes, fileName, fileType, {
      sourceType: "datasource",
      sourceId: fileId,
      metadata: { file_name: fileName, file_type: fileType },
    }, supabase);

    await supabase.from("datasource_files").update({
      status: "ready",
      chunk_count: result.chunkCount,
      content_hash: result.contentHash,
      last_refreshed_at: new Date().toISOString(),
    }).eq("id", fileId);
  } catch (e) {
    console.error("[datasources.process] processing failed:", e);
    await supabase.from("datasource_files").update({
      status: "error",
      error_message: e instanceof Error ? e.message : "Processing failed",
    }).eq("id", fileId);
  }
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
