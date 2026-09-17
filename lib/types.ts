// Shared domain types for AI Pod (AI Debate Arena).
// Mirrors the data model in docs/AI_DEBATE_ARENA_PRD.md (§4, §10).

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'meta'
  | 'mistral'
  | 'alibaba'
  | 'groq';

export type SessionFormat =
  | 'debate'
  | 'panel'
  | 'postmortem'
  | 'scenario'
  | 'hot-seat'
  | 'deliberation'
  // Non-adversarial formats (A-6)
  | 'shared-curiosity'
  | 'quickfire'
  | 'story-swap';

export type InterjectionRate = 'off' | 'low' | 'medium' | 'high';

// Web search grounding (P1-2). Only Anthropic, OpenAI, and Google have native
// search; every other provider is forced off with a visible reason.
export interface WebSearchConfig {
  enabled: boolean; // Session master switch, default true
  maxSearchesPerTurn: number; // Default 2, hard cap 3
  maxSearchesPerSession: number; // Default 20
}

export interface TurnSearch {
  query: string;
  sources: { url: string; title?: string }[];
}

export type ModelTier = 'frontier' | 'mid' | 'fast';

export interface ModelEntry {
  id: string; // Internal key
  provider: ProviderId;
  apiModelString: string; // What actually goes in the API call
  displayName: string;
  tier: ModelTier;
  contextWindow: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  supportsSystemPrompt: boolean;
  enabled: boolean;
}

export interface Persona {
  id: string;
  name: string;
  shortDescription: string; // Shown in the picker
  systemPromptFragment: string; // Injected into the agent's system prompt
  speakingStyle: string; // Voice/register guidance
  isBuiltIn: boolean;
}

export interface AgentConfig {
  id: string;
  displayName: string; // Operator's character name, e.g. "Lara"
  personaId: string; // FK into persona library
  modelId: string; // FK into model registry
  stance?: string; // Debate / hot-seat only
  temperature: number; // Default 0.85
  maxWordsPerTurn: number; // Default 160
  referenceImage?: string; // Optional filename/URL, carried to the manifest
  voiceId?: string; // Optional ElevenLabs voice id (B-4)
  webSearchEnabled?: boolean; // Per-agent search, default true where supported (P1-2)
}

export type InterjectionFrequency = 'low' | 'medium' | 'high';

export interface ModeratorConfig {
  displayName: string; // Default "Moderator"
  modelId: string;
  interjectionFrequency: InterjectionFrequency; // Default medium (~every 3rd turn)
  temperature: number; // Default 0.7
  voiceId?: string; // Optional ElevenLabs voice id (B-4)
}

export interface SourceDoc {
  id: string;
  title: string;
  content: string;
}

export interface SessionConfig {
  id: string;
  title: string;
  topic: string; // Full framing given to all agents
  format: SessionFormat;
  domain: string;
  sourceMaterial?: SourceDoc[];
  agentCount: number; // Min 3, max 6, default 3
  agents: AgentConfig[];
  moderator: ModeratorConfig;
  targetWordCount: number; // Default 2600
  maxTurns: number; // Default 24, hard cap 40 (counts full turns, not interjections)
  budgetCapUsd?: number; // Optional. Jump to closings once actual cost exceeds it
  interjectionRate?: InterjectionRate; // Agent reaction interjections. Default 'medium'
  openingBanter?: boolean; // Light chat before the topic. Default true
  webSearch?: WebSearchConfig; // Web search grounding (P1-2)
  createdAt: string;
}

// Turn roles. The PRD (§10) names four; we split the moderator's bookend turns
// out so the turn sequence can be replayed deterministically from the stored
// transcript (server-authoritative planning). For display/export, any turn whose
// speakerId is 'moderator' is simply "MODERATOR".
export type TurnType =
  | 'moderator-banter' // moderator's light opening chat (before the topic)
  | 'banter' // an agent's short banter reply
  | 'moderator-opening' // moderator introduces topic + participants
  | 'opening' // an agent's opening position
  | 'standard' // an agent's in-discussion response
  | 'moderator' // a mid-discussion moderator interjection
  | 'call-closings' // moderator calls for closing statements
  | 'closing' // an agent's closing statement
  | 'moderator-closing'; // moderator closes, declines a winner

// A full turn is a substantive contribution; an interjection is a 3–15 word
// off-rotation reaction (A-1).
export type TurnClass = 'full' | 'interjection';

export interface Turn {
  index: number;
  speakerId: string; // agent.id or 'moderator'
  speakerDisplayName: string;
  turnType: TurnType;
  turnClass: TurnClass; // 'full' | 'interjection'
  text: string;
  taggedText?: string; // Voice-pass output with ElevenLabs tags (B-1); never overwrites text
  searches?: TurnSearch[]; // Web searches this turn issued (P1-2); never in spoken exports
  modelId: string; // Which model actually produced this
  personaId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  wasEdited: boolean;
  isStale: boolean;
  wasTruncated: boolean; // Retry still hit the token ceiling; flag for the UI/export
  createdAt: string;
}

export type SessionStatus = 'draft' | 'running' | 'complete' | 'aborted';

// Claims checklist (PRD accuracy requirement). Extracted post-session for the
// operator to verify before publishing.
export interface Claim {
  type: 'statistic' | 'date' | 'study' | 'person' | 'quote' | 'other';
  claim: string;
  speaker?: string;
  turnIndex?: number;
}

export interface Session {
  id: string;
  config: SessionConfig;
  turns: Turn[];
  status: SessionStatus;
  totalWords: number;
  totalCostUsd: number;
  claims?: Claim[]; // Persisted after extraction; included in the JSON export
  createdAt: string;
  completedAt?: string;
}

// --- Provider adapter contract (PRD §6.2) ---

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateParams {
  apiModelString: string;
  systemPrompt: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  // When set, enable the provider's native web search with this many max uses.
  webSearchMaxUses?: number;
}

// Normalised finish reason across providers.
export type ProviderStopReason = 'complete' | 'max_tokens' | 'refusal' | 'other';

export interface GenerateResult {
  text: string;
  stopReason: ProviderStopReason;
  rawStopReason: string; // Provider's original value, for logging
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  rawModel?: string; // Model string the provider reports having used
  searches?: TurnSearch[]; // Native web searches the model issued this call
}

// Alias requested in the P0 brief; same shape as GenerateResult.
export type ProviderResponse = GenerateResult;

export interface ProviderAdapter {
  id: ProviderId;
  generate(params: GenerateParams): Promise<GenerateResult>;
}
