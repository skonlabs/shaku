import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { TokenOptimizationMiddleware } from "@/lib/token-optimization";
import { retrieve } from "@/lib/pipeline/retrieval";
import { exhaustiveRetrieve } from "@/lib/pipeline/exhaustive-strategy";
import { assembleContext, updateConversationState } from "@/lib/pipeline/context-assembly";
import { processInput } from "@/lib/pipeline/input-processing";
import {
  rewriteQuery,
  buildSystemAdditions,
  detectFormatHint,
} from "@/lib/pipeline/prompt-optimization";
import {
  redactOutputPii,
  verifyCitations,
  scoreConfidence,
  isSafeContent,
  scoreAmbiguity,
} from "@/lib/pipeline/output-validation";
import { route, estimatePreRetrievalTokens } from "@/lib/llm/router";
import { recordModelResult, HAIKU_MODEL_ID } from "@/lib/llm/registry";
import { promoteConversationMemories } from "@/lib/memory/promotion";
import {
  extractConversationFacts,
  detectTone,
  maybeRegenerateSummary,
} from "@/lib/knowledge/conversation-state";
import type { ToneState } from "@/lib/knowledge/conversation-state";
import { updateUkmFromMemory } from "@/lib/knowledge/ukm";
import { redactText } from "@/lib/utils/pii";
import { countTokens } from "@/lib/tokens";
import type { ModelConfig } from "@/lib/llm/types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

const SYSTEM_PROMPT = `You are Cortex, a helpful, warm, and precise personal AI assistant.

Style:
- Conversational and natural. Skip hedging and disclaimers.
- Use Markdown when it helps (lists, code blocks, tables). Use plain prose for short answers.
- Be concise; expand when asked.
- If you're uncertain, say what you'd need to verify, then offer your best informed take. Never refuse with "I don't know."
- Never reveal which model powers you or expose technical details. You are simply Cortex.`;

const TITLE_PROMPT = `Generate a concise 3-6 word title for this conversation. Return ONLY the title text, no quotes, no punctuation at the end.`;
const MAX_ATTACHMENT_CONTEXT_CHARS = 80_000;
const MAX_ATTACHMENT_CHARS_PER_FILE = 24_000;

const ACK_RESPONSES = [
  "You're welcome! Let me know if you need anything else.",
  "Anytime! Happy to help.",
  "Glad I could help. What's next?",
  "Of course — just say the word if you need more.",
  "Sounds good! I'm here if anything else comes up.",
  "Happy to help. Let me know if you'd like to dig deeper.",
];

const BodySchema = z.object({
  conversation_id: z.string().uuid(),
  user_message: z.string().min(1).max(50000).optional(),
  regenerate: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(255),
        url: z.string().url().nullable().optional(),
        path: z.string().nullable().optional(),
        size: z.number().nonnegative(),
        type: z.string().max(120),
        kind: z.string().max(20).optional(),
        extracted_text: z.string().nullable().optional(),
        extraction_error: z.string().nullable().optional(),
        storage_error: z.string().nullable().optional(),
      }),
    )
    .max(10)
    .optional(),
});

export const Route = createFileRoute("/api/chat/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ---- Auth ----
        const authHeader =
          request.headers.get("authorization") ?? request.headers.get("Authorization");
        if (!authHeader?.toLowerCase().startsWith("bearer ")) {
          return jsonError("Unauthorized", 401);
        }
        const token = authHeader.slice(7).trim();

        const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData.user) return jsonError("Unauthorized", 401);
        const userId = userData.user.id;

        // ---- Validate body ----
        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return jsonError("Invalid request", 400);
        }
        if (!body.regenerate && !body.user_message) {
          return jsonError("Missing message", 400);
        }

        // ---- Verify conversation ownership ----
        const { data: convo } = await supabase
          .from("conversations")
          .select("id, title, user_id, project_id, model_override")
          .eq("id", body.conversation_id)
          .eq("user_id", userId)
          .maybeSingle();
        if (!convo) return jsonError("Conversation not found", 404);

        const projectId: string | null = convo.project_id ?? null;
        const modelOverride: string | null = convo.model_override ?? null;

        // ---- Rate limit ----
        let memoryEnabled = true;
        if (!body.regenerate) {
          const { data: userRow } = await supabase
            .from("users")
            .select("plan, memory_enabled")
            .eq("id", userId)
            .maybeSingle();
          memoryEnabled = userRow?.memory_enabled !== false;
          const plan = userRow?.plan ?? "free";
          const rl = await checkRateLimit(userId, plan, supabase);
          if (!rl.allowed) {
            const window = plan === "pro" ? "minute" : "hour";
            return new Response(
              JSON.stringify({
                error: "rate_limited",
                message: `You've used all ${rl.limit} messages this ${window}.`,
                reset_at: rl.resetAt,
                remaining: 0,
              }),
              { status: 429, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (body.regenerate && memoryEnabled === true) {
          const { data: uRow } = await supabase
            .from("users")
            .select("memory_enabled")
            .eq("id", userId)
            .maybeSingle();
          memoryEnabled = uRow?.memory_enabled !== false;
        }

        // ---- Input processing: PII, intent, adversarial check ----
        let processedMessage = body.user_message ?? "";
        let inputResult: Awaited<ReturnType<typeof processInput>> | null = null;
        if (!body.regenerate && body.user_message) {
          inputResult = await processInput(body.user_message, {});

          if (inputResult.adversarialScore >= 0.8) {
            return jsonError("I can't help with that request.", 400);
          }

          if (inputResult.piiAutoRedact.length > 0) {
            const { redacted } = redactText(body.user_message, inputResult.piiAutoRedact);
            processedMessage = redacted;
          }
        }

        // ---- Persist user message ----
        let userMsg: { id: string; created_at: string } | null = null;
        if (!body.regenerate) {
          const insert = await supabase
            .from("messages")
            .insert({
              conversation_id: convo.id,
              role: "user",
              content: processedMessage,
              metadata: body.attachments?.length ? { attachments: body.attachments } : {},
            })
            .select("id, created_at")
            .single();
          if (insert.error || !insert.data) {
            console.error("[chat.stream] insert user message", insert.error);
            return jsonError("I ran into a problem saving that.", 500);
          }
          userMsg = insert.data;
        }

        // ---- Acknowledgment fast path ----
        if (inputResult?.isAcknowledgment) {
          const reply = ACK_RESPONSES[Math.floor(Math.random() * ACK_RESPONSES.length)];
          const asst = await supabase
            .from("messages")
            .insert({
              conversation_id: convo.id,
              role: "assistant",
              content: reply,
              metadata: { ack: true },
            })
            .select("id, created_at")
            .single();
          await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", convo.id);
          return sse(async (send) => {
            send("user_message", userMsg);
            for (const word of reply.split(" ")) {
              send("delta", { text: word + " " });
              await new Promise((r) => setTimeout(r, 18));
            }
            send("done", {
              assistant_message_id: asst.data?.id,
              created_at: asst.data?.created_at,
              followups: [],
            });
          });
        }

        // ---- Load history ----
        // Descending + limit ensures we always get the most recent 50 messages,
        // including the just-inserted user message in long conversations.
        const { data: historyAll } = await supabase
          .from("messages")
          .select("id, role, content, created_at")
          .eq("conversation_id", convo.id)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(50);

        const history = (historyAll ?? []).reverse();

        // Regenerate: drop trailing assistant messages
        let priorVersion: { content: string; created_at: string } | null = null;
        if (body.regenerate) {
          while (history.length > 0 && history[history.length - 1].role === "assistant") {
            const last = history[history.length - 1];
            if (!priorVersion)
              priorVersion = { content: last.content, created_at: last.created_at };
            await supabase.from("messages").update({ is_active: false }).eq("id", last.id);
            history.pop();
          }
          if (history.length === 0 || history[history.length - 1].role !== "user") {
            return jsonError("Nothing to regenerate.", 400);
          }
        }

        const preloadedHistory = history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content as string,
            createdAt: m.created_at,
          }));

        const currentUserMessage = processedMessage || preloadedHistory.at(-1)?.content || "";

        // ---- Intent (from processInput or regenerate fallback) ----
        const intentResult = inputResult?.intent ?? {
          intent: "question" as const,
          confidence: 0.7,
          isFollowUp: false,
          followUpReference: null,
          complexity: 0.5,
          domain: "general",
        };
        const intent = intentResult.intent;

        // ---- Parallel: retrieval + query rewrite ----
        const shouldRetrieve = currentUserMessage.trim().length > 10 && intent !== "acknowledgment";
        const [retrievalResult, rewrittenQuery] = await Promise.all([
          shouldRetrieve
            ? retrieve(userId, currentUserMessage, intent, convo.id, supabase, { topK: 20 })
            : Promise.resolve({
                chunks: [],
                sourcesSearched: [],
                qualityScore: 1,
                webSearchTriggered: false,
              }),
          rewriteQuery(currentUserMessage, intentResult),
        ]);

        // ---- Exhaustive strategy if retrieval quality is low ----
        let finalChunks = retrievalResult.chunks;
        if (shouldRetrieve && retrievalResult.qualityScore < 0.4) {
          const exhaustive = await exhaustiveRetrieve(
            userId,
            convo.id,
            rewrittenQuery || currentUserMessage,
            intent,
            supabase,
          );
          if (exhaustive.chunks.length > finalChunks.length) {
            finalChunks = exhaustive.chunks;
          }
        }

        // ---- Assemble context (UKM + memories + retrieval + history) ----
        const assembled = await assembleContext({
          userId,
          conversationId: convo.id,
          projectId,
          currentMessage: rewrittenQuery || currentUserMessage,
          retrievedChunks: finalChunks,
          supabase,
          systemInstructions: SYSTEM_PROMPT,
          preloadedHistory,
        });

        // ---- System additions + format hint ----
        // (Anti-preferences already included in assembled.systemPrompt via assembleContext)
        const systemAdditions = buildSystemAdditions(
          intent,
          assembled.convState.styleProfile,
          assembled.convState.conversationTone.current,
          intentResult.isFollowUp,
          intentResult.followUpReference ?? undefined,
        );
        const formatHint = detectFormatHint(currentUserMessage);

        const finalSystemPrompt = [
          assembled.systemPrompt,
          systemAdditions ? `\n## Response guidance\n${systemAdditions}` : "",
          formatHint ? `\n## Format\n${formatHint}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        // ---- Model routing ----
        const estimatedCtxTokens = estimatePreRetrievalTokens(
          countTokens(SYSTEM_PROMPT),
          countTokens(preloadedHistory.map((m) => m.content).join(" ")) +
            preloadedHistory.length * 4,
          countTokens(currentUserMessage),
        );
        const routingDecision = route({
          intent: intentResult,
          estimatedContextTokens: estimatedCtxTokens,
          hasImages: (body.attachments ?? []).some(
            (a) => a.kind === "image" || (a.type ?? "").startsWith("image/"),
          ),
          modelOverride,
          conversationMomentum: 0.5,
        });
        const selectedModel = routingDecision.selected;

        // ---- Token optimization middleware ----
        const tokenMw = new TokenOptimizationMiddleware({
          provider: selectedModel.provider,
          historyKeepTurns: 20,
          enableContextPruning: false,
          budget: {
            maxInputTokens: Math.floor(selectedModel.contextWindow * 0.85),
            maxOutputTokens: selectedModel.maxOutputTokens,
            maxTotalTokens: selectedModel.contextWindow,
          },
        });
        const mwResult = tokenMw.process([
          { role: "system", content: finalSystemPrompt },
          ...(assembled.messages as { role: "user" | "assistant"; content: string }[]),
        ]);
        const optimizedMessages = mwResult.messages as {
          role: "user" | "assistant";
          content: string;
        }[];
        const optimizedSystemPrompt = mwResult.systemPrompt ?? finalSystemPrompt;

        const attachmentContext = buildAttachmentContext(body.attachments ?? []);

        // ---- Multimodal attachment expansion on last user turn (Anthropic format) ----
        const lastIdx = optimizedMessages.length - 1;
        if (
          lastIdx >= 0 &&
          optimizedMessages[lastIdx].role === "user" &&
          body.attachments?.length
        ) {
          const blocks: Anthropic.MessageParam["content"] = [];
          const textParts: string[] = [];
          const baseText =
            typeof optimizedMessages[lastIdx].content === "string"
              ? (optimizedMessages[lastIdx].content as string)
              : "";
          if (baseText.trim()) textParts.push(baseText);

          for (const a of body.attachments) {
            if ((a.kind === "image" || (a.type ?? "").startsWith("image/")) && a.url) {
              blocks.push({ type: "image", source: { type: "url", url: a.url } });
            }
          }
          if (attachmentContext) textParts.push(attachmentContext);
          blocks.unshift({ type: "text", text: textParts.join("") || "(see attachments)" });
          (optimizedMessages[lastIdx] as { role: string; content: unknown }).content = blocks;
        }

        // PII values the user explicitly sent — allowed to appear in output
        const allowedPiiValues = new Set<string>(
          [...(inputResult?.piiAutoSend ?? []), ...(inputResult?.piiNeedsConfirm ?? [])].map(
            (t) => t.value,
          ),
        );

        // ---- Stream ----
        return sse(async (send) => {
          // Capture CF context if available (Workers runtime)
          const cfCtx = (globalThis as Record<string, unknown>).__cfContext as
            | { waitUntil?: (p: Promise<unknown>) => void }
            | undefined;
          const runAfterResponse = (p: Promise<unknown>) => {
            if (cfCtx?.waitUntil) cfCtx.waitUntil(p);
            // else just let it run (dev/Node environments)
          };

          if (userMsg) send("user_message", userMsg);

          let activeModel = selectedModel;
          let assistantText = "";
          let streamError: unknown = null;
          let usedStaticFallback = false;
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          const startTimeMs = Date.now();
          const OVERLAP_CHARS = 240;
          let hitFinalCap = false;
          const runtimeKeys = getRuntimeKeys();
          const runnableModels = uniqueModels([selectedModel, ...routingDecision.fallback]).filter(
            (model) => modelHasRuntimeKey(model, runtimeKeys),
          );

          if (runnableModels.length === 0) {
            console.error("[chat.stream] no runnable models", {
              hasAnthropicKey: Boolean(runtimeKeys.anthropic),
              hasOpenAIKey: Boolean(runtimeKeys.openai),
              selectedProvider: selectedModel.provider,
              fallbackProviders: routingDecision.fallback.map((model) => model.provider),
            });
            usedStaticFallback = true;
            assistantText =
              "I can’t connect to the AI service right now. Please try again in a moment.";
            send("delta", { text: assistantText });
          } else {
            for (const candidateModel of runnableModels) {
              activeModel = candidateModel;
              assistantText = "";
              hitFinalCap = false;

              try {
                const PER_TURN_MAX_TOKENS = Math.min(16_000, candidateModel.maxOutputTokens);
                const MAX_AUTO_CONTINUES = candidateModel.provider === "anthropic" ? 3 : 0;

                if (candidateModel.provider === "anthropic") {
                  const apiKey = runtimeKeys.anthropic;
                  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
                  const anthropic = new Anthropic({ apiKey });
                  const turnMessages = [...optimizedMessages];
                  let stopReason: string | null = null;

                  for (let turn = 0; turn <= MAX_AUTO_CONTINUES; turn++) {
                    const claudeStream = anthropic.messages.stream({
                      model: candidateModel.id,
                      max_tokens: PER_TURN_MAX_TOKENS,
                      system: optimizedSystemPrompt,
                      messages: turnMessages,
                    });

                    let turnText = "";
                    const isContinuation = turn > 0;
                    const priorTail = isContinuation ? assistantText.slice(-OVERLAP_CHARS) : "";
                    let dedupResolved = !isContinuation;
                    let dedupBuffer = "";
                    const DEDUP_SCAN_BUDGET = OVERLAP_CHARS * 3;

                    stopReason = null;
                    for await (const event of claudeStream) {
                      if (
                        event.type === "content_block_delta" &&
                        event.delta.type === "text_delta"
                      ) {
                        const raw = event.delta.text;
                        turnText += raw;

                        let emit = raw;
                        if (!dedupResolved) {
                          dedupBuffer += raw;
                          const stripped = stripOverlapPrefix(dedupBuffer, priorTail);
                          if (stripped !== null) {
                            emit = stripped;
                            dedupResolved = true;
                          } else if (dedupBuffer.length >= DEDUP_SCAN_BUDGET) {
                            emit = dedupBuffer;
                            dedupResolved = true;
                          } else {
                            continue;
                          }
                        }

                        const { text: safeChunk } = redactOutputPii(emit, allowedPiiValues);
                        assistantText += safeChunk;
                        const visible = stripFollowupsTagPartial(safeChunk, assistantText);
                        if (visible) send("delta", { text: visible });
                      } else if (event.type === "message_start") {
                        totalInputTokens += event.message.usage?.input_tokens ?? 0;
                      } else if (event.type === "message_delta") {
                        stopReason = event.delta.stop_reason ?? stopReason;
                        totalOutputTokens += event.usage?.output_tokens ?? 0;
                      }
                    }

                    if (!dedupResolved && dedupBuffer.length > 0) {
                      const { text: safeChunk } = redactOutputPii(dedupBuffer, allowedPiiValues);
                      assistantText += safeChunk;
                      const visible = stripFollowupsTagPartial(safeChunk, assistantText);
                      if (visible) send("delta", { text: visible });
                    }

                    if (stopReason !== "max_tokens") break;
                    if (turn === MAX_AUTO_CONTINUES) {
                      hitFinalCap = true;
                      break;
                    }

                    turnMessages.push({ role: "assistant", content: turnText });
                    const tail = assistantText.slice(-OVERLAP_CHARS);
                    turnMessages.push({
                      role: "user",
                      content: `Continue exactly from where you stopped. Begin your reply by repeating verbatim these final characters of your previous message, then continue seamlessly:

"""${tail}"""

Do not add any preface, apology, or commentary.`,
                    });
                  }
                } else {
                  const apiKey = runtimeKeys.openai;
                  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
                  const openai = new OpenAI({ apiKey });

                  const oaiMessages = [
                    { role: "system" as const, content: optimizedSystemPrompt },
                    ...optimizedMessages.map((m) => ({
                      role: m.role as "user" | "assistant",
                      content: messageContentToText(m.content),
                    })),
                  ];

                  const stream = await openai.chat.completions.create({
                    model: candidateModel.id,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    messages: oaiMessages as any,
                    stream: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    stream_options: { include_usage: true } as any,
                    max_tokens: PER_TURN_MAX_TOKENS,
                  });

                  for await (const chunk of stream) {
                    const text = chunk.choices[0]?.delta?.content ?? "";
                    if (text) {
                      const { text: safeChunk } = redactOutputPii(text, allowedPiiValues);
                      assistantText += safeChunk;
                      const visible = stripFollowupsTagPartial(safeChunk, assistantText);
                      if (visible) send("delta", { text: visible });
                    }
                    if (chunk.usage) {
                      totalInputTokens = chunk.usage.prompt_tokens ?? 0;
                      totalOutputTokens = chunk.usage.completion_tokens ?? 0;
                    }
                  }
                }

                streamError = null;
                recordModelResult(candidateModel.id, false);
                break;
              } catch (err) {
                streamError = err;
                recordModelResult(candidateModel.id, true);
                console.error("[chat.stream] stream error", { model: candidateModel.id, err });
                if (assistantText.trim().length > 0) break;
              }
            }
          }

          // ---- Output validation ----
          const { visible, followups } = splitFollowups(assistantText);

          if (visible.trim().length > 0 && !isSafeContent(visible)) {
            send("error", { message: "I can't send that response. Please try again." });
            await supabase
              .from("conversations")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", convo.id);
            return;
          }

          const sourceNames = finalChunks.map(
            (c) => (c.metadata?.title as string | undefined) ?? c.sourceType,
          );
          const citationRatio = verifyCitations(visible, sourceNames);
          const ambiguity = scoreAmbiguity(currentUserMessage);
          const confidence = scoreConfidence({
            retrievalQualityAvg: retrievalResult.qualityScore,
            claimsVerifiedRatio: citationRatio,
            queryAmbiguity: ambiguity,
            modelCapability: activeModel.capability,
          });

          // ---- Persist assistant message ----
          if (hitFinalCap) {
            const cont = "Continue generating";
            if (!followups.some((f) => f.toLowerCase().includes("continue"))) {
              followups.unshift(cont);
              if (followups.length > 3) followups.length = 3;
            }
          }

          let assistantId: string | null = null;
          let assistantCreatedAt: string | null = null;
          if (visible.trim().length > 0) {
            const metadata: Record<string, unknown> = {
              model: activeModel.id,
              confidence,
              citation_ratio: citationRatio,
              tokens_in: totalInputTokens,
              tokens_out: totalOutputTokens,
            };
            if (assembled.memoriesUsed.length > 0) {
              metadata.memories_used = assembled.memoriesUsed.map((m) => ({
                id: m.id,
                type: m.type,
                content: m.content.slice(0, 150),
              }));
            }
            if (followups.length) metadata.follow_ups = followups;
            if (priorVersion) metadata.versions = [priorVersion];
            if (streamError) metadata.partial = true;
            if (hitFinalCap) metadata.truncated = true;
            const asst = await supabase
              .from("messages")
              .insert({
                conversation_id: convo.id,
                role: "assistant",
                content: visible,
                metadata,
              })
              .select("id, created_at")
              .single();
            if (asst.error) {
              console.error("[chat.stream] insert assistant message", asst.error);
            } else {
              assistantId = asst.data?.id ?? null;
              assistantCreatedAt = asst.data?.created_at ?? null;
            }

            // Record usage event (fire-and-forget; non-blocking)
            if (totalInputTokens > 0 || totalOutputTokens > 0) {
              const costUsd =
                (totalInputTokens / 1_000_000) * activeModel.costPerMTokInput +
                (totalOutputTokens / 1_000_000) * activeModel.costPerMTokOutput;
              runAfterResponse(
                Promise.resolve(
                  supabase
                    .from("usage_events")
                    .insert({
                      user_id: userId,
                      event_type: "chat",
                      model_used: activeModel.id,
                      tokens_in: totalInputTokens,
                      tokens_out: totalOutputTokens,
                      cost_usd: costUsd,
                      latency_ms: Date.now() - startTimeMs,
                    })
                    .then(() => {}),
                ),
              );
            }
          }

          await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", convo.id);

          if (streamError) {
            send("error", { message: "I ran into a problem. Please try again." });
          } else {
            send("done", {
              assistant_message_id: assistantId,
              created_at: assistantCreatedAt,
              followups,
              memories_used: assembled.memoriesUsed.length,
              tokens_in: totalInputTokens,
              tokens_out: totalOutputTokens,
            });
          }

          // ---- Async post-processing (fire and forget) ----
          if (visible.trim().length > 0) {
            runAfterResponse(
              (async () => {
                try {
                  const msgCount = history.length + 2;
                  const results = await Promise.allSettled([
                    extractConversationFacts(currentUserMessage, visible),
                    memoryEnabled
                      ? promoteConversationMemories(userId, convo.id, projectId, supabase)
                      : Promise.resolve([]),
                    maybeRegenerateSummary(convo.id, msgCount, supabase),
                  ]);
                  const facts = results[0].status === "fulfilled" ? results[0].value : [];

                  if (facts.length > 0) {
                    await updateConversationState(convo.id, facts, [], supabase);
                  }

                  const newTone = detectTone(
                    [...preloadedHistory, { role: "user", content: currentUserMessage }],
                    assembled.convState.conversationTone as ToneState,
                  );
                  await supabase
                    .from("conversation_states")
                    .update({ conversation_tone: newTone, updated_at: new Date().toISOString() })
                    .eq("conversation_id", convo.id);

                  if (memoryEnabled) {
                    // Include user message context so UKM can extract identity/style signals
                    const ukmContext = `User: ${currentUserMessage.slice(0, 500)}\nAssistant: ${visible.slice(0, 1500)}`;
                    await updateUkmFromMemory(userId, ukmContext, "episodic", supabase);
                  }
                } catch (e) {
                  console.error("[chat.stream] post-processing error", e);
                }
              })(),
            );

            // Auto-title via Haiku on first exchange
            if (!convo.title) {
              runAfterResponse(
                (async () => {
                  try {
                    const titleApiKey = getRuntimeKeys().anthropic;
                    if (!titleApiKey) return;
                    const anthropic = new Anthropic({ apiKey: titleApiKey });
                    const titleRes = await anthropic.messages.create({
                      model: HAIKU_MODEL_ID,
                      max_tokens: 32,
                      system: TITLE_PROMPT,
                      messages: [
                        {
                          role: "user",
                          content: `User: ${currentUserMessage.slice(0, 300)}\n\nAssistant: ${visible.slice(0, 400)}`,
                        },
                      ],
                    });
                    const block = titleRes.content[0];
                    const text = block?.type === "text" ? block.text.trim().slice(0, 80) : null;
                    if (text) {
                      await supabase
                        .from("conversations")
                        .update({ title: text })
                        .eq("id", convo.id);
                    }
                  } catch (e) {
                    console.error("[chat.stream] title gen", e);
                  }
                })(),
              );
            }
          }
        });
      },
    },
  },
});

// ---------- helpers ----------

type ChatAttachment = NonNullable<z.infer<typeof BodySchema>["attachments"]>[number];

function buildAttachmentContext(attachments: ChatAttachment[]): string {
  if (!attachments.length) return "";
  const parts: string[] = [];
  let remaining = MAX_ATTACHMENT_CONTEXT_CHARS;

  for (const a of attachments) {
    let part = "";
    if (a.extracted_text?.trim()) {
      const text = truncateChars(
        a.extracted_text.trim(),
        Math.min(MAX_ATTACHMENT_CHARS_PER_FILE, remaining),
      );
      part = `\n\n--- Attached: ${a.name} (${a.type || "unknown"}) ---\n${text}\n--- end of ${a.name} ---`;
    } else if (a.extraction_error) {
      part = `\n\n[Attached "${a.name}" could not be parsed: ${a.extraction_error}]`;
    } else if (a.storage_error) {
      part = `\n\n[Attached "${a.name}" could not be stored: ${a.storage_error}]`;
    } else {
      part = `\n\n[Attached: ${a.name} (${a.type || "unknown"})]`;
    }
    if (part.length > remaining) break;
    parts.push(part);
    remaining -= part.length;
  }

  if (remaining <= 0)
    parts.push("\n\n[Additional attachment text omitted to fit the prompt budget.]");
  return parts.join("");
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 120))}\n\n[…attachment truncated to fit the prompt budget.]`;
}


function uniqueModels(models: ModelConfig[]): ModelConfig[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function getRuntimeKeys(): { anthropic?: string; openai?: string } {
  const runtimeEnv = ((globalThis as Record<string, unknown>).__runtimeEnv ?? {}) as Record<
    string,
    string | undefined
  >;
  return {
    anthropic: runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    openai: runtimeEnv.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  };
}

function modelHasRuntimeKey(
  model: ModelConfig,
  runtimeKeys: { anthropic?: string; openai?: string },
): boolean {
  if (model.provider === "anthropic") return Boolean(runtimeKeys.anthropic);
  if (model.provider === "openai") return Boolean(runtimeKeys.openai);
  return false;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as { type?: string; text?: string; source?: { url?: string } };
      if (b.type === "text") return b.text ?? "";
      if (b.type === "image") return b.source?.url ? `[Image: ${b.source.url}]` : "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripOverlapPrefix(buffer: string, priorTail: string): string | null {
  if (!priorTail) return buffer;
  const MIN_OVERLAP = 24;
  const leadMatch = buffer.match(/^[\s"'`>\-*]{0,8}/);
  const leadLen = leadMatch ? leadMatch[0].length : 0;
  const body = buffer.slice(leadLen);
  const maxLen = Math.min(priorTail.length, body.length);
  for (let len = maxLen; len >= MIN_OVERLAP; len--) {
    const tailSlice = priorTail.slice(priorTail.length - len);
    if (body.startsWith(tailSlice)) {
      return body.slice(len);
    }
  }
  if (body.length >= priorTail.length + MIN_OVERLAP) return buffer;
  return null;
}

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(start: (send: (event: string, data: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        await start(send);
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function stripFollowupsTagPartial(_delta: string, accumulated: string): string {
  // Check for complete tag
  const tagStart = accumulated.indexOf("<followups>");
  if (tagStart !== -1) {
    const visibleBeforeTag = accumulated.slice(0, tagStart);
    const alreadyStreamed = accumulated.length - _delta.length;
    if (alreadyStreamed >= visibleBeforeTag.length) return "";
    return visibleBeforeTag.slice(alreadyStreamed);
  }
  // Check for partial opening tag at the end of accumulated (to suppress early chars)
  const partialTag = "<followups>";
  for (let len = Math.min(partialTag.length - 1, accumulated.length); len >= 1; len--) {
    if (accumulated.endsWith(partialTag.slice(0, len))) {
      // Suppress the last `len` chars that might be the start of the tag
      const safe = accumulated.slice(0, accumulated.length - len);
      const alreadyStreamed = accumulated.length - _delta.length;
      if (alreadyStreamed >= safe.length) return "";
      return safe.slice(alreadyStreamed);
    }
  }
  return _delta;
}

function splitFollowups(text: string): { visible: string; followups: string[] } {
  const m = text.match(/<followups>([\s\S]*?)<\/followups>/);
  if (!m) return { visible: text.trim(), followups: [] };
  const visible = (text.slice(0, m.index!) + text.slice(m.index! + m[0].length)).trim();
  let followups: string[] = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed)) {
      followups = parsed
        .filter((q) => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 200))
        .slice(0, 3);
    }
  } catch {
    /* ignore */
  }
  return { visible, followups };
}
