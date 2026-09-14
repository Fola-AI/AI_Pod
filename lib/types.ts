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
  | 'deliberation';

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
}

export type InterjectionFrequency = 'low' | 'medium' | 'high';

export interface ModeratorConfig {
  displayName: string; // Default "Moderator"
  modelId: string;
  interjectionFrequency: InterjectionFrequency; // Default medium (~every 3rd turn)
  temperature: number; // Default 0.7
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
  maxTurns: number; // Default 24, hard cap 40
  createdAt: string;
}

// Turn roles. The PRD (§10) names four; we split the moderator's bookend turns
// out so the turn sequence can be replayed deterministically from the stored
// transcript (server-authoritative planning). For display/export, any turn whose
// speakerId is 'moderator' is simply "MODERATOR".
export type TurnType =
  | 'moderator-opening' // moderator introduces topic + participants
  | 'opening' // an agent's opening position
  | 'standard' // an agent's in-discussion response
  | 'moderator' // a mid-discussion moderator interjection
  | 'call-closings' // moderator calls for closing statements
  | 'closing' // an agent's closing statement
  | 'moderator-closing'; // moderator closes, declines a winner

export interface Turn {
  index: number;
  speakerId: string; // agent.id or 'moderator'
  speakerDisplayName: string;
  turnType: TurnType;
  text: string;
  modelId: string; // Which model actually produced this
  personaId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  wasEdited: boolean;
  isStale: boolean;
  createdAt: string;
}

export type SessionStatus = 'draft' | 'running' | 'complete' | 'aborted';

export interface Session {
  id: string;
  config: SessionConfig;
  turns: Turn[];
  status: SessionStatus;
  totalWords: number;
  totalCostUsd: number;
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
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  generate(params: GenerateParams): Promise<GenerateResult>;
}
