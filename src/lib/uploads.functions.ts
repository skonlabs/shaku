import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const BUCKET = "chat-uploads";

/**
 * Upload a file to Supabase Storage (chat-uploads bucket) under
 * `${user_id}/${conversation_id}/${randomid}-${filename}`.
 * Returns a signed URL valid for 7 days (ephemeral).
 *
 * Uses the user's authenticated client — RLS storage policies enforce
 * that users can only write under their own `${user_id}/...` prefix.
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

    return {
      name: data.name,
      size: bytes.byteLength,
      type: data.type,
      url: signed.signedUrl,
      path,
    };
  });

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
