import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Missing Supabase env vars: VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  },
});

export type Profile = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  plan: string;
  theme: string;
  language: string;
  memory_enabled: boolean;
  has_completed_onboarding: boolean;
  pii_preferences: Record<string, string>;
};

export type Conversation = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string | null;
  status: string;
  pinned: boolean;
  memory_enabled: boolean;
  model_override: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> & {
    follow_ups?: string[];
    feedback?: { rating: "up" | "down"; reasons?: string[]; note?: string };
    attachments?: Array<{ name: string; url: string; size: number; type: string }>;
    versions?: Array<{ content: string; created_at: string }>;
  };
  is_edited: boolean;
  original_content: string | null;
  parent_message_id: string | null;
  is_active: boolean;
  truncated: boolean;
  share_id: string | null;
  created_at: string;
};
