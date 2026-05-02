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

    // Enrich with per-space counts (chats + memories) for the mini-card.
    const projects = data ?? [];
    const ids = projects.map((p) => p.id);
    const counts: Record<string, { chats: number; memories: number }> = {};
    for (const id of ids) counts[id] = { chats: 0, memories: 0 };

    if (ids.length > 0) {
      const [convRes, memRes] = await Promise.all([
        supabase
          .from("conversations")
          .select("project_id")
          .eq("user_id", userId)
          .in("project_id", ids)
          .neq("status", "deleted"),
        supabase
          .from("memories")
          .select("project_id")
          .eq("user_id", userId)
          .in("project_id", ids),
      ]);
      for (const row of convRes.data ?? []) {
        const k = row.project_id as string | null;
        if (k && counts[k]) counts[k].chats += 1;
      }
      for (const row of memRes.data ?? []) {
        const k = row.project_id as string | null;
        if (k && counts[k]) counts[k].memories += 1;
      }
    }

    return {
      projects: projects.map((p) => ({ ...p, ...counts[p.id] })),
      error: null,
    };
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
      .select("id, title, status, pinned, updated_at, messages(count)")
      .eq("user_id", userId)
      .eq("project_id", data.project_id)
      .neq("status", "deleted")
      .order("updated_at", { ascending: false });
    if (error) return { conversations: [], error: "Couldn't load conversations." };
    const filtered = (rows ?? []).filter((c) => {
      const msgCount = Array.isArray((c as { messages?: { count: number }[] }).messages)
        ? ((c as { messages?: { count: number }[] }).messages?.[0]?.count ?? 0)
        : 0;
      return !!c.title || msgCount > 0 || c.pinned;
    }).map(({ messages: _messages, ...rest }) => rest);
    return { conversations: filtered, error: null };
  });
