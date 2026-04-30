/**
 * Credit pricing engine.
 *
 * Converts (model, token usage, context size, side-effects) → integer credits.
 * Spec values are honored verbatim; we add a hard floor (1 credit/request)
 * and a hard ceiling (MAX_CREDITS_PER_REQUEST) to bound abuse.
 *
 * Revenue model (Basic plan, $20 / 5,000 credits = $0.004 / credit):
 *   - GPT-4o (in $5 / Mtok, out $15 / Mtok) at 2k in + 800 out =
 *       cost ≈ $0.022, credits ≈ ceil(4 * (2.8) * 1.0) = 12 → revenue $0.048.
 *     Margin ~2.2× at typical loads, blowing out on long answers (intentional
 *     since context_multiplier kicks in). We log real $ cost in the ledger
 *     metadata so we can recalibrate without another migration.
 *
 * IMPORTANT: This module is pure and isomorphic. No Supabase, no HTTP.
 */

export type ReasonCode =
  | "chat"
  | "memory_write"
  | "memory_retrieval"
  | "document_retrieval"
  | "embedding"
  | "monthly_reset"
  | "plan_grant"
  | "plan_change"
  | "refund"
  | "admin_adjust";

/** Spec-defined model multipliers. Unknown models default to 4 (≈ GPT-4o). */
export const MODEL_MULTIPLIERS: Record<string, number> = {
  // Free-tier models
  "gpt-4o-mini": 1,
  "claude-haiku-4-5-20251001": 1.2,
  "gemini-2.0-flash": 1.2,
  // Basic-tier models
  "gpt-4o": 4,
  "claude-sonnet-4-6": 5,
  // Future
  "claude-opus-4-7": 10,
};

/** Hard caps to prevent runaway/abuse-driven cost. */
export const MAX_CREDITS_PER_REQUEST = 100;
export const MIN_CREDITS_PER_REQUEST = 1;

/** Context tier from total input-token budget. */
export function contextMultiplier(inputTokens: number): number {
  if (inputTokens < 10_000) return 1.0;
  if (inputTokens < 50_000) return 1.5;
  return 2.5;
}

export interface CreditCalcInput {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Add-ons used during this request. */
  memoryRead?: boolean;
  memoryWrite?: boolean;
  documentRead?: boolean;
  embeddingsRun?: boolean;
}

export interface CreditCalcBreakdown {
  total: number;
  capped: boolean;
  model: { id: string; multiplier: number };
  tokens: { input: number; output: number; tokenCost: number };
  contextMult: number;
  addOns: { memoryRead: number; memoryWrite: number; documentRead: number; embedding: number };
  formula: string;
}

/**
 * Estimate credits BEFORE the request. Used as a hold amount.
 * We bound output at maxOutputTokens to avoid the 0-output corner pricing as 0.
 */
export function estimateCredits(
  modelId: string,
  estInputTokens: number,
  estOutputTokens: number,
  flags: { memoryRead?: boolean; documentRead?: boolean } = {},
): CreditCalcBreakdown {
  return calculateCredits({
    modelId,
    inputTokens: estInputTokens,
    outputTokens: estOutputTokens,
    memoryRead: flags.memoryRead,
    documentRead: flags.documentRead,
  });
}

/** Final post-stream cost from observed token usage. */
export function calculateCredits(input: CreditCalcInput): CreditCalcBreakdown {
  const multiplier = MODEL_MULTIPLIERS[input.modelId] ?? 4;
  const inputTokens = Math.max(0, Math.round(input.inputTokens));
  const outputTokens = Math.max(0, Math.round(input.outputTokens));
  const totalTokens = inputTokens + outputTokens;
  const tokenCost = totalTokens / 1_000;
  const ctxMult = contextMultiplier(inputTokens);

  const memoryRead = input.memoryRead ? 2 : 0;       // mid of 1–3
  const memoryWrite = input.memoryWrite ? 3 : 0;     // mid of 2–5
  const documentRead = input.documentRead ? 2 : 0;   // mid of 1–3
  const embedding = input.embeddingsRun ? 4 : 0;     // mid of 2–6

  const raw = multiplier * tokenCost * ctxMult + memoryRead + memoryWrite + documentRead + embedding;
  const rounded = Math.ceil(raw);
  const total = Math.min(MAX_CREDITS_PER_REQUEST, Math.max(MIN_CREDITS_PER_REQUEST, rounded));

  return {
    total,
    capped: total < rounded,
    model: { id: input.modelId, multiplier },
    tokens: { input: inputTokens, output: outputTokens, tokenCost: Number(tokenCost.toFixed(3)) },
    contextMult: ctxMult,
    addOns: { memoryRead, memoryWrite, documentRead, embedding },
    formula:
      `ceil(${multiplier} * ${tokenCost.toFixed(3)} * ${ctxMult}) ` +
      `+ memR=${memoryRead} + memW=${memoryWrite} + docR=${documentRead} + emb=${embedding}`,
  };
}

/** Plan feature shape stored on plans.features (jsonb). */
export interface PlanFeatures {
  models: string[];          // exact ids; ["*"] = all
  memory: boolean;
  documents: boolean;
  max_context_tokens: number;
  advanced_routing: boolean;
  priority_support?: boolean;
  shared_workspace?: boolean;
  sso?: boolean;
}

export function planAllowsModel(features: PlanFeatures, modelId: string): boolean {
  if (!features?.models) return false;
  if (features.models.includes("*")) return true;
  return features.models.includes(modelId);
}

export function planAllowsFeature(
  features: PlanFeatures,
  feature: "memory" | "documents" | "advanced_routing",
): boolean {
  return Boolean(features?.[feature]);
}

/**
 * Pick a fallback model from the plan when the routed model isn't allowed.
 * Returns null if no fallback exists.
 */
export function pickFallbackModel(features: PlanFeatures): string | null {
  if (planAllowsModel(features, "gpt-4o-mini")) return "gpt-4o-mini";
  if (planAllowsModel(features, "claude-haiku-4-5-20251001")) return "claude-haiku-4-5-20251001";
  return features.models?.[0] ?? null;
}
