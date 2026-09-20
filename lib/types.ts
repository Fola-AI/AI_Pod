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

// Grounding mode is session-level and never mixed across agents (B-5.5).
//   'none'   — no grounding.
//   'shared' — every agent uses the internal Brave-backed web_search tool
//              (the default); equal footing across providers.
//   'native' — provider-native search, Anthropic/OpenAI/Google only (Batch 5).
export type SearchMode = 'none' | 'shared' | 'native';

// A single normalised search result. In native mode providers expose the URL
// (and often a title) but no snippet, so `snippet` may be empty there.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string; // The text actually fed to the model (empty for native)
  publishedDate?: string;
  fetchedAt: string;
}

export interface WebSearchConfig {
  mode: SearchMode; // Default 'shared'
  maxSearchesPerTurn: number; // Default 2, hard cap 3
  maxSearchesPerSession: number; // Default 25
  resultsPerSearch: number; // Shared mode, default 5
  // Force one search on each agent's first substantive turn so tool-shy models
  // still ground (equal footing). Default true; off to let propensity vary and
  // to keep opening position-statements plain. Shared mode only. (B-5.5)
  forceFirstSearch?: boolean;
  researchPack?: boolean; // Optional pre-turn topic brief (B-5.5)
}

// One search a turn issued. Both modes write this shape (B-5.5).
export interface TurnSearch {
  mode: 'shared' | 'native';
  query: string;
  results: SearchResult[]; // Snippets in shared mode; URL/title only in native
  provider: string; // 'brave' | 'anthropic' | 'openai' | 'google'
  latencyMs: number;
}

export type ModelTier = 'frontier' | 'professional' | 'fast';

// How a model's API call is transported. 'direct' hits the vendor's own endpoint
// (Anthropic, OpenAI, Google — plus Groq, a deliberate exception; see README).
// 'openrouter' routes through OpenRouter's OpenAI-compatible gateway with one key.
// The `provider` field always names the VENDOR (for grouping/labels/pricing);
// `route` names the transport. Defaults to 'direct' so existing entries and any
// saved sessions keep working unchanged.
export type ModelRoute = 'direct' | 'openrouter';

export interface ModelEntry {
  id: string; // Internal key
  provider: ProviderId; // The VENDOR (labels, grouping, pricing) — not the transport
  apiModelString: string; // What actually goes in the API call
  displayName: string;
  tier: ModelTier;
  route?: ModelRoute; // Transport; defaults to 'direct'
  contextWindow: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  supportsSystemPrompt: boolean;
  // Whether the model supports function/tool calling — needed for shared-mode
  // web search (B-5.5). Defaults to true; set false for models that can't call
  // tools, which route to the research-pack fallback instead.
  supportsFunctionCalling?: boolean;
  // Whether the model reliably calls the search tool when it should. Low-propensity
  // models (they state figures from memory) get forced first-turn search by
  // default (B-5.5). Undefined → provider default.
  lowToolPropensity?: boolean;
  // Reasoning models that spend tokens thinking before they can emit a tool call
  // and then use its result. Verified to go silent (empty output, or refusing to
  // call the tool) when given a small budget on a search-expected turn. The tool
  // loop must never hand these a sub-500-token budget where search may run.
  needsTokenHeadroomForTools?: boolean;
  // Per-model calibration for the stated word budget. Some models systematically
  // overrun the word target; a factor < 1 tells them a lower number so actual
  // output lands near maxWordsPerTurn. Defaults to the provider factor, else 1.
  wordBudgetFactor?: number;
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

// A persona's content captured at session-creation time (B-6). Stored on the
// agent ALONGSIDE personaId, so a session replays from exactly the text it was
// given and edits to the live persona never rewrite past transcripts — and the
// operator can still see which persona was used and how it has since drifted.
export interface PersonaSnapshot {
  name: string;
  shortDescription: string;
  systemPromptFragment: string;
  speakingStyle: string;
}

// Show-bible recurring character (B-6, A-4). A fourth, optional continuity slot,
// independent of persona and model. runningNotes/catchphrases are injected into
// the prompt — but ship EMPTY: they earn content after several episodes.
export interface Character {
  id: string;
  displayName: string;
  defaultPersonaId: string;
  voiceId?: string;
  runningNotes: string; // empty until the operator fills it in
  catchphrases: string[]; // empty until the operator fills it in
  createdAt: string;
}

// The character content used by an agent, captured at session creation — same
// snapshot-for-provenance reasoning as PersonaSnapshot (B-6).
export interface CharacterSnapshot {
  runningNotes: string;
  catchphrases: string[];
}

// A relationship between two agents in a session (B-6, A-3). Injected into both
// agents' prompts. Session-level, stored in the config; default is none.
export interface Relationship {
  agentA: string; // agent id
  agentB: string; // agent id
  dynamic: string; // e.g. "Old friends who disagree about everything and enjoy it"
}

// Cold-open candidate (B-6, A-7): the best 15-30 seconds of a completed session,
// identified by a post-session frontier call. Shown on the transcript, in JSON.
export interface ColdOpen {
  speaker: string; // speaker display name
  text: string; // the exact spoken span
  turnIndex?: number;
  reason?: string; // why it's compelling
}

export interface AgentConfig {
  id: string;
  displayName: string; // Operator's character name, e.g. "Lara"
  personaId: string; // FK into persona library (which persona was chosen)
  personaSnapshot?: PersonaSnapshot; // Persona content at creation (B-6); replay/provenance
  characterId?: string; // Optional show-bible character (B-6, A-4)
  characterSnapshot?: CharacterSnapshot; // Character content at creation (B-6)
  modelId: string; // FK into model registry
  stance?: string; // Debate / hot-seat only
  temperature: number; // Default 0.85
  maxWordsPerTurn: number; // Default 160
  referenceImage?: string; // Optional filename/URL, carried to the manifest
  voiceId?: string; // Optional ElevenLabs voice id (B-4)
  webSearchEnabled?: boolean; // Per-agent search, default true where supported (P1-2)
  // Force a search on this agent's first substantive turn (shared mode, B-5.5).
  // Undefined → default by model tool-propensity (on for low-propensity models).
  forceFirstSearch?: boolean;
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
  webSearch?: WebSearchConfig; // Web search grounding (P1-2 / B-5.5)
  researchPack?: string; // Pre-computed topic brief injected into agent prompts (B-5.5)
  relationships?: Relationship[]; // Agent-pair dynamics (B-6, A-3); default none
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
  searches?: TurnSearch[]; // Web searches this turn issued (P1-2/B-5.5); never in spoken exports
  searchDegraded?: boolean; // A search failed this turn; agent spoke ungrounded (B-5.5)
  modelId: string; // Which model actually produced this
  personaId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  wasEdited: boolean;
  isStale: boolean;
  wasTruncated: boolean; // Retry still hit the token ceiling; flag for the UI/export
  // How many empty returns preceded this (successful) turn. >0 means the model
  // blanked and was retried; a model doing this on >half its turns is a roster
  // problem, flagged on the transcript screen (bug 2). Undefined on older rows.
  emptyRetries?: number;
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

// Two or more claims that give different values for the same quantity — the most
// dangerous thing to publish unnoticed. The checklist flags these with both (or
// all) conflicting values and their turn indices.
export interface ClaimConflict {
  // 'value' = sources genuinely disagree; 'unit' = a wrong unit / order-of-
  // magnitude error, which is always wrong, never a legitimate difference (B-6).
  kind?: 'value' | 'unit';
  quantity: string; // What the values are measuring, e.g. "solar capacity added in 2024"
  values: { value: string; speaker?: string; turnIndex?: number }[];
  note?: string; // For a unit error: what the conversion should have been
}

// A blocking, publish-stopping problem surfaced above the claims list (B-6): a
// figure the episode leaned on (cited by 2+ speakers) that was retracted or
// corrected in a closing turn, with nothing after it to absorb the change.
export interface BlockingWarning {
  message: string;
  figure?: string;
  turnIndex?: number; // where it was retracted/corrected
  citedBy?: string[]; // speakers who cited it earlier
}

export interface Session {
  id: string;
  config: SessionConfig;
  turns: Turn[];
  status: SessionStatus;
  totalWords: number;
  totalCostUsd: number;
  claims?: Claim[]; // Persisted after extraction; included in the JSON export
  claimConflicts?: ClaimConflict[]; // Conflicting values + unit errors (B-6)
  blockingWarnings?: BlockingWarning[]; // Publish-stopping problems (B-6)
  coldOpen?: ColdOpen; // Best 15-30s clip candidate (B-6, A-7)
  createdAt: string;
  completedAt?: string;
}

// --- Provider adapter contract (PRD §6.2) ---

// A web_search call the model emitted (shared mode, B-5.5). One tool only, so
// the only argument we carry is the query.
export interface ToolCall {
  id: string; // Provider's tool-call id, echoed back with the result
  query: string;
}

// A message in the turn exchange. The tool variants appear only in shared-mode
// function-calling loops: an assistant turn that requested searches, and the
// tool result we feed back.
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface GenerateParams {
  apiModelString: string;
  systemPrompt: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  // When set, enable the provider's native web search with this many max uses.
  webSearchMaxUses?: number;
  // When true, advertise the internal web_search function tool (shared mode).
  searchTool?: boolean;
  // Steer tool use while the tool stays advertised. 'none' finalises the loop
  // (some models compulsively call tools and 400 if the array is just dropped);
  // 'required' forces a call (used to guarantee each agent grounds once).
  toolChoice?: 'auto' | 'none' | 'required';
}

// Normalised finish reason across providers.
export type ProviderStopReason =
  | 'complete'
  | 'max_tokens'
  | 'refusal'
  | 'tool_calls' // model wants to call the search tool (shared mode)
  | 'other';

export interface GenerateResult {
  text: string;
  stopReason: ProviderStopReason;
  rawStopReason: string; // Provider's original value, for logging
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  rawModel?: string; // Model string the provider reports having used
  searches?: TurnSearch[]; // Native web searches the model issued this call
  toolCalls?: ToolCall[]; // web_search calls emitted this step (shared mode)
}

// Alias requested in the P0 brief; same shape as GenerateResult.
export type ProviderResponse = GenerateResult;

export interface ProviderAdapter {
  id: ProviderId;
  generate(params: GenerateParams): Promise<GenerateResult>;
}
