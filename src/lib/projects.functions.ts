import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listProjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, color, status, created_at, updated_at")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("updated_at", { ascending: false });
    if (error) return { projects: [], error: "Couldn't load projects." };
    return { projects: data ?? [], error: null };
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      name: z.string().min(1).max(100),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("projects")
      .insert({ user_id: userId, name: data.name, color: data.color ?? "#378ADD" })
      .select("*")
      .single();
    if (error) {
      console.error("[createProject] insert failed", { code: error.code, message: error.message, details: error.details, hint: error.hint });
      throw new Error(`Couldn't create project: ${error.message}`);
    }
    return { project: row };
  });

export const updateProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const update: Record<string, unknown> = {};
    if (data.name) update.name = data.name;
    if (data.color) update.color = data.color;
    const { error } = await supabase
      .from("projects")
      .update(update)
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't update project.");
    return { success: true };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    // Archive instead of hard-delete (preserves audit trail)
    const { error } = await supabase
      .from("projects")
      .update({ status: "archived" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message || "Couldn't archive project.");
    return { success: true };
  });

export const listProjectConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ project_id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("conversations")
      .select("id, title, status, pinned, updated_at")
      .eq("user_id", userId)
      .eq("project_id", data.project_id)
      .neq("status", "deleted")
      .order("updated_at", { ascending: false });
    if (error) return { conversations: [], error: "Couldn't load conversations." };
    return { conversations: rows ?? [], error: null };
  });
