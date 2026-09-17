// Shared-search function-calling loop (B-5.5). Drives the single-shot adapter
// through tool round-trips: the model emits web_search calls, we run them via
// the internal search service, feed results back, and let the model continue to
// its spoken turn. Works for every provider whose adapter reports toolCalls.

import type {
  ChatMessage,
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  TurnSearch,
} from '@/lib/types';
import { runSearch, type RunSearchOutcome } from '@/lib/search';

// Absolute ceiling on model round-trips per turn, regardless of search budget.
const MAX_STEPS = 5;

export interface SharedSearchBudget {
  perTurn: number; // per-turn search cap (already clamped to <= 3)
  resultsPerSearch: number;
  sessionRemaining: number; // searches left in the session budget
  // Force a search on the first step (tool_choice 'required'). Used to guarantee
  // each agent grounds at least once — models vary widely in tool-use propensity,
  // and equal footing across characters is the point of shared mode.
  forceFirst?: boolean;
}

export interface ToolLoopOutcome {
  result: GenerateResult;
  searches: TurnSearch[];
  degraded: boolean; // a search actually failed (not merely "no results")
}

// The tool result string handed back to the model. Trimmed already by the
// search service; we just shape it as compact JSON.
function formatToolContent(outcome: RunSearchOutcome): string {
  if (outcome.results.length === 0) {
    return JSON.stringify({ note: outcome.note ?? 'No results.' });
  }
  return JSON.stringify({
    results: outcome.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      publishedDate: r.publishedDate,
    })),
  });
}

/**
 * Run the shared-search loop. `base` carries the normal generate params; this
 * function owns `searchTool` and the message accumulation. Never throws for a
 * search failure — the agent speaks ungrounded and the turn is flagged.
 */
export async function runSharedSearchLoop(
  adapter: ProviderAdapter,
  base: Omit<GenerateParams, 'searchTool' | 'webSearchMaxUses'>,
  budget: SharedSearchBudget,
  // Test seam: inject a fake search runner.
  search: typeof runSearch = runSearch,
): Promise<ToolLoopOutcome> {
  let messages: ChatMessage[] = [...base.messages];
  const searches: TurnSearch[] = [];
  let searchesThisTurn = 0;
  let sessionRemaining = budget.sessionRemaining;
  let degraded = false;
  let exhausted = false; // search budget used up this turn
  let result: GenerateResult | null = null;

  // Bound round-trips to the search budget (searches + one forced finalize +
  // slack), capped by the absolute ceiling. Keeps a compulsive caller from
  // stacking many slow model calls into one turn.
  const maxSteps = Math.min(MAX_STEPS, budget.perTurn + 2);
  for (let step = 0; step < maxSteps; step++) {
    // Once the budget is spent, force a final answer: keep the tool advertised
    // but set toolChoice 'none' (some models — e.g. Groq's gpt-oss — compulsively
    // call the tool and 400 if it's simply dropped) with an explicit directive.
    if (exhausted) {
      result = await adapter.generate({
        ...base,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Do not call any tools now. Give your spoken answer using what you already found.',
          },
        ],
        searchTool: true,
        toolChoice: 'none',
      });
      break;
    }

    // Force a call on the very first step when asked, so every agent grounds
    // at least once; afterwards the model decides. Some models ignore a
    // 'required' choice and providers may 400 on that — fall back to 'auto'
    // rather than fataling the turn.
    const forceThis = budget.forceFirst && step === 0 && searchesThisTurn === 0;
    try {
      result = await adapter.generate({
        ...base,
        messages,
        searchTool: true,
        ...(forceThis ? { toolChoice: 'required' as const } : {}),
      });
    } catch (err) {
      if (!forceThis) throw err;
      result = await adapter.generate({ ...base, messages, searchTool: true });
    }
    const calls = result.toolCalls ?? [];
    if (calls.length === 0) break;

    // Record the assistant's tool-call turn, then answer each call. Every call
    // must get a result, even after the cap (providers require it).
    messages = [...messages, { role: 'assistant', content: result.text, toolCalls: calls }];
    for (const tc of calls) {
      if (searchesThisTurn >= budget.perTurn || sessionRemaining <= 0) {
        exhausted = true;
        messages.push({
          role: 'tool',
          toolCallId: tc.id,
          content: JSON.stringify({
            note: 'Search limit reached for this turn. Answer with what you have.',
          }),
        });
        continue;
      }
      const outcome = await search(tc.query, { maxResults: budget.resultsPerSearch });
      searchesThisTurn++;
      sessionRemaining--;
      if (outcome.failed) degraded = true;
      searches.push({
        mode: 'shared',
        query: tc.query,
        results: outcome.results,
        provider: outcome.provider,
        latencyMs: outcome.latencyMs,
      });
      messages.push({ role: 'tool', toolCallId: tc.id, content: formatToolContent(outcome) });
    }
  }

  // Last resort: if the model still returned tool calls on the forced step,
  // fall back to whatever text it produced (may be empty; caller validates).

  return { result: result as GenerateResult, searches, degraded };
}
