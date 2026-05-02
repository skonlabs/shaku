// Task state CRUD — wraps upsert_task and get_active_task RPCs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskUpdate } from "./classifier";

export interface ActiveTask {
  id: string;
  title: string;
  goal: string;
  status: string;
  currentStep: string | null;
  completedSteps: string[];
  openQuestions: string[];
  decisions: string[];
  artifacts: string[];
  nextActions: string[];
  updatedAt: string;
}

export async function loadActiveTask(
  conversationId: string,
  supabase: SupabaseClient,
): Promise<ActiveTask | null> {
  try {
    const { data, error } = await supabase.rpc("get_active_task", {
      target_conversation_id: conversationId,
    });
    if (error || !data || data.length === 0) return null;
    const t = data[0] as Record<string, unknown>;
    const toStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
    return {
      id: t.id as string,
      title: (t.title as string) ?? "",
      goal: (t.goal as string) ?? "",
      status: (t.status as string) ?? "active",
      currentStep: (t.current_step as string | null) ?? null,
      completedSteps: toStrArr(t.completed_steps),
      openQuestions: toStrArr(t.open_questions),
      decisions: toStrArr(t.decisions),
      artifacts: toStrArr(t.artifacts),
      nextActions: toStrArr(t.next_actions),
      updatedAt: t.updated_at as string,
    };
  } catch {
    return null;
  }
}

export async function upsertTask(
  conversationId: string,
  update: TaskUpdate,
  supabase: SupabaseClient,
): Promise<string | null> {
  if (!update.title && !update.goal) return null;
  try {
    const { data, error } = await supabase.rpc("upsert_task", {
      p_conversation_id: conversationId,
      p_title: update.title ?? "",
      p_goal: update.goal ?? "",
      p_current_step: update.currentStep ?? null,
      p_completed_steps: update.completedSteps ?? null,
      p_open_questions: update.openQuestions ?? null,
      p_decisions: update.decisions ?? null,
      p_next_actions: update.nextActions ?? null,
    });
    if (error) return null;
    return data as string;
  } catch {
    return null;
  }
}
