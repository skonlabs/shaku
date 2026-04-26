import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Supported file extensions (server-side validation)
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "txt", "md", "rtf", "xlsx", "xls", "csv", "tsv",
  "pptx", "ppt", "png", "jpg", "jpeg", "gif", "webp",
  "py", "js", "ts", "tsx", "jsx", "java", "cpp", "c", "h", "hpp",
  "cs", "go", "rs", "rb", "php", "swift", "kt", "html", "htm", "css",
  "scss", "sh", "sql", "json", "xml", "yaml", "yml", "toml",
]);

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB for datasource files

export const listFolders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("datasource_folders")
      .select("id, parent_id, name, created_at")
      .eq("user_id", userId)
      .order("name", { ascending: true });
    if (error) return { folders: [], error: "Couldn't load folders." };
    return { folders: data ?? [], error: null };
  });

export const createFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      name: z.string().min(1).max(100),
      parent_id: z.string().uuid().nullable().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("datasource_folders")
      .insert({ user_id: userId, name: data.name, parent_id: data.parent_id ?? null })
      .select("id, name")
      .single();
    if (error) throw new Error("Couldn't create folder.");
    return { folder: row };
  });

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("datasource_folders")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't delete folder.");
    return { success: true };
  });

export const listFiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ folder_id: z.string().uuid().nullable().optional() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    let query = supabase
      .from("datasource_files")
      .select("id, folder_id, name, file_type, file_size_bytes, status, chunk_count, last_refreshed_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (data.folder_id !== undefined) {
      if (data.folder_id === null) {
        query = query.is("folder_id", null);
      } else {
        query = query.eq("folder_id", data.folder_id);
      }
    }

    const { data: files, error } = await query;
    if (error) return { files: [], error: "Couldn't load files." };
    return { files: files ?? [], error: null };
  });

// Create a datasource file record and return upload URL.
// Actual processing is triggered separately via datasources.process route.
export const createDatasourceFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      name: z.string().min(1).max(255),
      file_type: z.string().min(1).max(50),
      file_size_bytes: z.number().int().positive().max(MAX_FILE_BYTES),
      folder_id: z.string().uuid().nullable().optional(),
      url: z.string().url().nullable().optional(), // for URL datasources
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    // Validate file extension
    const ext = data.name.split(".").pop()?.toLowerCase() ?? "";
    if (!data.url && !ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`File type .${ext} is not supported.`);
    }

    const { data: row, error } = await supabase
      .from("datasource_files")
      .insert({
        user_id: userId,
        folder_id: data.folder_id ?? null,
        name: data.name,
        file_type: ext || data.file_type,
        file_size_bytes: data.file_size_bytes,
        url: data.url ?? null,
        status: data.url ? "processing" : "uploading",
      })
      .select("id, name, status")
      .single();

    if (error) throw new Error("Couldn't create file record.");
    return { file: row };
  });

export const deleteDatasourceFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    // Get the file to find its storage path
    const { data: file } = await supabase
      .from("datasource_files")
      .select("id, storage_path")
      .eq("id", data.id)
      .eq("user_id", userId)
      .single();

    if (!file) throw new Error("File not found.");

    // Delete from storage if it has a path.
    // Note: storage bucket is "datasource-files" (hyphen), table is "datasource_files" (underscore)
    if (file.storage_path) {
      await supabase.storage.from("datasource-files").remove([file.storage_path]);
    }

    // Delete chunks
    await supabase
      .from("chunks")
      .delete()
      .eq("user_id", userId)
      .eq("source_type", "datasource")
      .eq("source_id", data.id);

    // Delete file record
    await supabase.from("datasource_files").delete().eq("id", data.id).eq("user_id", userId);

    return { success: true };
  });

export const updateDatasourceFileStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      status: z.enum(["uploading", "processing", "ready", "error"]),
      chunk_count: z.number().int().min(0).optional(),
      content_hash: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const update: Record<string, unknown> = {
      status: data.status,
      last_refreshed_at: new Date().toISOString(),
    };
    if (data.chunk_count !== undefined) update.chunk_count = data.chunk_count;
    if (data.content_hash) update.content_hash = data.content_hash;

    const { error } = await supabase
      .from("datasource_files")
      .update(update)
      .eq("id", data.id)
      .eq("user_id", userId);

    if (error) throw new Error("Couldn't update file status.");
    return { success: true };
  });
