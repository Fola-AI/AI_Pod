// Model registry — the single source of truth for available models.
//
// MODEL IDs AND PRICES CHANGE FREQUENTLY. This file is expected to be edited by
// hand (PRD §6, D5). Adding a model requires NO code changes beyond this file —
// as long as an adapter exists for its provider (see lib/providers/index.ts).
//
// Seed data accurate as of 8 September 2026 — verify before first run.

import type { ModelEntry, ModelRoute, ModelTier, ProviderId } from '@/lib/types';

// Which env var holds each provider's API key. Used to compute availability.
export const PROVIDER_ENV_KEY: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  meta: 'META_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  groq: 'GROQ_API_KEY',
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral',
  alibaba: 'Alibaba',
  groq: 'Groq',
};

// Env var for the single OpenRouter gateway key (route: 'openrouter' models).
export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';

// Tier ordering and labels for grouping/sorting in the UI (best → cheapest).
export const TIER_ORDER: ModelTier[] = ['frontier', 'professional', 'fast'];
export const TIER_LABEL: Record<ModelTier, string> = {
  frontier: 'Frontier',
  professional: 'Professional',
  fast: 'Fast',
};
const TIER_RANK: Record<ModelTier, number> = {
  frontier: 0,
  professional: 1,
  fast: 2,
};
/** Distance between two tiers: 0 same, 1 adjacent, 2 frontier↔fast (a real gap). */
export function tierGap(a: ModelTier, b: ModelTier): number {
  return Math.abs(TIER_RANK[a] - TIER_RANK[b]);
}

/** A model's transport, defaulting undefined → 'direct'. */
export function modelRoute(model: ModelEntry): ModelRoute {
  return model.route ?? 'direct';
}
/** Short transport label for the picker/registry ("OpenRouter" vs "Direct"). */
export function routeLabel(model: ModelEntry): string {
  return modelRoute(model) === 'openrouter' ? 'OpenRouter' : 'Direct';
}

// ─────────────────────────────────────────────────────────────────────────────
// TIERING RULE — assign every model's `tier` by the VENDOR'S OWN POSITIONING,
// not by price and not by generation:
//   • frontier     — a model the vendor still sells as flagship-class, EVEN IF a
//                     newer generation has superseded it (a prev-gen flagship is
//                     still flagship-class, e.g. Grok 4.5, Qwen3.7 Max).
//   • professional — a workhorse: the vendor's mid/general model, or an
//                     open-weight line that doesn't compete with the frontier
//                     flagships (e.g. Llama 4 Maverick, Mistral Medium).
//   • fast         — small and cheap, built for latency/volume.
// Do NOT promote a workhorse to fill an empty frontier slot. Thin tiers are
// correct: a vendor may have no model at a given tier (see README — Meta and
// Mistral have no frontier seat, Alibaba has no professional seat, xAI has no
// fast seat). An unfair matchup is exactly what the tiering exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
export const MODELS: ModelEntry[] = [
  // --- Anthropic ---
  {
    id: 'claude-fable-5-1',
    provider: 'anthropic',
    apiModelString: 'claude-fable-5-1',
    displayName: 'Claude Fable 5.1',
    tier: 'frontier',
    contextWindow: 1_000_000,
    inputPricePerMTok: 10.0,
    outputPricePerMTok: 50.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    apiModelString: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    tier: 'frontier',
    contextWindow: 1_000_000,
    inputPricePerMTok: 5.0,
    outputPricePerMTok: 25.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    apiModelString: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    tier: 'professional',
    contextWindow: 1_000_000,
    inputPricePerMTok: 3.0,
    outputPricePerMTok: 15.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    apiModelString: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    tier: 'fast',
    contextWindow: 200_000,
    inputPricePerMTok: 1.0,
    outputPricePerMTok: 5.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- OpenAI ---
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    apiModelString: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    tier: 'frontier',
    contextWindow: 1_050_000,
    inputPricePerMTok: 10.0,
    outputPricePerMTok: 50.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'gpt-5-6-sol',
    provider: 'openai',
    apiModelString: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    tier: 'frontier',
    contextWindow: 1_050_000,
    inputPricePerMTok: 4.0,
    outputPricePerMTok: 20.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'gpt-5-6-terra',
    provider: 'openai',
    apiModelString: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    tier: 'professional',
    contextWindow: 1_050_000,
    inputPricePerMTok: 2.0,
    outputPricePerMTok: 12.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'gpt-5-6-luna',
    provider: 'openai',
    apiModelString: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    tier: 'fast',
    contextWindow: 1_050_000,
    inputPricePerMTok: 0.2,
    outputPricePerMTok: 1.2,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- Google ---
  {
    id: 'gemini-3-8-flash',
    provider: 'google',
    apiModelString: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    tier: 'frontier',
    contextWindow: 1_050_000,
    inputPricePerMTok: 0.75,
    outputPricePerMTok: 3.75,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'gemini-3-1-pro-preview',
    provider: 'google',
    apiModelString: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro (Preview)',
    tier: 'frontier',
    contextWindow: 1_000_000,
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // OpenRouter-routed models (route: 'openrouter'). One key, one adapter; the
  // `provider` field still names the vendor for grouping/pricing. Every row below
  // was verified live (2026-09) against OpenRouter: a 10-token generation call
  // AND a strict tool check (emits web_search → uses the result → final text
  // reflects it). Candidates that generated but wouldn't call the tool, or called
  // it and returned empty text, were EXCLUDED — see the verification notes in the
  // batch log. Prices are OpenRouter pass-through ($/Mtok). Prefer clean aliases
  // over datestamped snapshots.
  // ═══════════════════════════════════════════════════════════════════════════
  // --- xAI (via OpenRouter) — no fast seat ---
  {
    id: 'grok-4-6',
    provider: 'xai',
    apiModelString: 'x-ai/grok-4.6',
    displayName: 'Grok 4.6',
    tier: 'frontier',
    route: 'openrouter',
    contextWindow: 500_000,
    inputPricePerMTok: 2.0,
    outputPricePerMTok: 6.0,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'grok-4-5',
    provider: 'xai',
    apiModelString: 'x-ai/grok-4.5',
    displayName: 'Grok 4.5',
    tier: 'frontier', // prev-gen flagship — still flagship-class (tiering rule)
    route: 'openrouter',
    contextWindow: 500_000,
    inputPricePerMTok: 2.0,
    outputPricePerMTok: 6.0,
    supportsSystemPrompt: true,
    // Verified to refuse the tool at small budgets, call it with headroom.
    lowToolPropensity: true,
    needsTokenHeadroomForTools: true,
    enabled: true,
  },
  {
    id: 'grok-4-3',
    provider: 'xai',
    apiModelString: 'x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    tier: 'professional',
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 1.25,
    outputPricePerMTok: 2.5,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- DeepSeek (via OpenRouter) ---
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    apiModelString: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    tier: 'frontier',
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 0.42,
    outputPricePerMTok: 0.84,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'deepseek-v3-2',
    provider: 'deepseek',
    apiModelString: 'deepseek/deepseek-v3.2',
    displayName: 'DeepSeek V3.2',
    tier: 'professional',
    route: 'openrouter',
    contextWindow: 163_840,
    inputPricePerMTok: 0.27,
    outputPricePerMTok: 0.4,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    apiModelString: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'fast',
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 0.04,
    outputPricePerMTok: 0.07,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- Meta (via OpenRouter) — no frontier seat (open-weight line) ---
  {
    id: 'llama-4-maverick',
    provider: 'meta',
    apiModelString: 'meta-llama/llama-4-maverick',
    displayName: 'Llama 4 Maverick',
    tier: 'professional',
    route: 'openrouter',
    contextWindow: 1_048_576,
    inputPricePerMTok: 0.19,
    outputPricePerMTok: 0.65,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'llama-3-1-8b',
    provider: 'meta',
    apiModelString: 'meta-llama/llama-3.1-8b-instruct',
    displayName: 'Llama 3.1 8B',
    tier: 'fast',
    route: 'openrouter',
    contextWindow: 131_072,
    inputPricePerMTok: 0.05,
    outputPricePerMTok: 0.08,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- Alibaba (via OpenRouter) — no professional seat ---
  {
    id: 'qwen-3-8-max',
    provider: 'alibaba',
    apiModelString: 'qwen/qwen3.8-max',
    displayName: 'Qwen3.8 Max',
    tier: 'frontier',
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 2.0,
    outputPricePerMTok: 6.0,
    supportsSystemPrompt: true,
    needsTokenHeadroomForTools: true, // reasoning model — verified
    enabled: true,
  },
  {
    id: 'qwen-3-7-max',
    provider: 'alibaba',
    apiModelString: 'qwen/qwen3.7-max',
    displayName: 'Qwen3.7 Max',
    tier: 'frontier', // prev-gen flagship — still flagship-class (tiering rule)
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 1.48,
    outputPricePerMTok: 4.42,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'qwen-3-8-flash',
    provider: 'alibaba',
    apiModelString: 'qwen/qwen3.8-flash',
    displayName: 'Qwen3.8 Flash',
    tier: 'fast',
    route: 'openrouter',
    contextWindow: 1_000_000,
    inputPricePerMTok: 0.15,
    outputPricePerMTok: 0.47,
    supportsSystemPrompt: true,
    needsTokenHeadroomForTools: true, // reasoning model — verified
    enabled: true,
  },
  // --- Mistral (via OpenRouter) — no frontier seat (Large has no live endpoint) ---
  {
    id: 'mistral-medium-3-5',
    provider: 'mistral',
    apiModelString: 'mistralai/mistral-medium-3-5',
    displayName: 'Mistral Medium 3.5',
    tier: 'professional',
    route: 'openrouter',
    contextWindow: 262_144,
    inputPricePerMTok: 1.5,
    outputPricePerMTok: 7.5,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'ministral-8b',
    provider: 'mistral',
    apiModelString: 'mistralai/ministral-8b-2512',
    displayName: 'Ministral 8B',
    tier: 'fast',
    route: 'openrouter',
    contextWindow: 262_144,
    inputPricePerMTok: 0.15,
    outputPricePerMTok: 0.15,
    supportsSystemPrompt: true,
    enabled: true,
  },
  // --- Groq (DIRECT — deliberate exception; see README. ids verified live 2026-09) ---
  {
    id: 'groq-gpt-oss-120b',
    provider: 'groq',
    apiModelString: 'openai/gpt-oss-120b',
    displayName: 'GPT-OSS 120B (Groq)',
    tier: 'frontier',
    contextWindow: 131_072,
    inputPricePerMTok: 0.15,
    outputPricePerMTok: 0.75,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'groq-qwen3-8-27b',
    provider: 'groq',
    apiModelString: 'qwen/qwen3.8-27b',
    displayName: 'Qwen3.8 27B (Groq)',
    tier: 'professional',
    contextWindow: 131_072,
    inputPricePerMTok: 0.2,
    outputPricePerMTok: 0.6,
    supportsSystemPrompt: true,
    enabled: true,
  },
  {
    id: 'groq-gpt-oss-20b',
    provider: 'groq',
    apiModelString: 'openai/gpt-oss-20b',
    displayName: 'GPT-OSS 20B (Groq)',
    tier: 'fast',
    contextWindow: 131_072,
    inputPricePerMTok: 0.1,
    outputPricePerMTok: 0.5,
    supportsSystemPrompt: true,
    enabled: true,
  },
];

export function getModel(modelId: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === modelId);
}

// Per-provider word-budget calibration (B-5.5): Anthropic models run ~2x over the
// stated word target, so we tell them a lower number. Per-model overrides win.
const PROVIDER_WORD_FACTOR: Partial<Record<ProviderId, number>> = {
  anthropic: 0.55,
};

/** Calibrate a word target for the model, so actual output lands near `words`. */
export function calibratedWordBudget(modelId: string, words: number): number {
  const model = getModel(modelId);
  const factor =
    model?.wordBudgetFactor ??
    (model ? PROVIDER_WORD_FACTOR[model.provider] : undefined) ??
    1;
  return Math.max(20, Math.round(words * factor));
}

// Native web search is scoped to these providers (P1-2). Every other provider is
// force-off with a visible reason — we do not build tool-use loops for them.
export const WEB_SEARCH_PROVIDERS = new Set<ProviderId>([
  'anthropic',
  'openai',
  'google',
]);

export function providerSupportsWebSearch(provider: ProviderId): boolean {
  return WEB_SEARCH_PROVIDERS.has(provider);
}

// Function/tool calling — needed for the shared web_search tool (B-5.5). Almost
// every current model supports it; a model that doesn't routes to the research
// pack. Defaults to true unless the registry entry says otherwise.
export function modelSupportsFunctionCalling(modelId: string): boolean {
  const model = getModel(modelId);
  if (!model) return false;
  return model.supportsFunctionCalling ?? true;
}

// Providers whose models reliably CAN call the search tool but often DON'T when
// they should — they state figures from memory (observed for DeepSeek and Groq's
// gpt-oss in B-5.5 full runs). These get forced first-turn search by default.
// OpenAI, xAI and Anthropic search readily and are not forced.
const LOW_TOOL_PROPENSITY_PROVIDERS = new Set<ProviderId>(['deepseek', 'groq']);

export function modelHasLowToolPropensity(modelId: string): boolean {
  const model = getModel(modelId);
  if (!model) return false;
  return model.lowToolPropensity ?? LOW_TOOL_PROPENSITY_PROVIDERS.has(model.provider);
}

// Whether an agent on this model can be grounded in the given mode (B-5.5).
// shared: needs function calling. native: needs a native-search provider.
export function modelSupportsMode(
  modelId: string,
  mode: 'none' | 'shared' | 'native',
): boolean {
  if (mode === 'none') return true;
  const model = getModel(modelId);
  if (!model) return false;
  if (mode === 'native') return providerSupportsWebSearch(model.provider);
  return modelSupportsFunctionCalling(modelId); // shared
}

/** Whether a given model can use web search, and why not if it can't. */
export function modelSearchSupport(modelId: string): {
  supported: boolean;
  reason?: string;
} {
  const model = getModel(modelId);
  if (!model) return { supported: false, reason: 'unknown model' };
  if (!providerSupportsWebSearch(model.provider)) {
    return {
      supported: false,
      reason: `${PROVIDER_LABEL[model.provider]} has no native web search`,
    };
  }
  return { supported: true };
}
