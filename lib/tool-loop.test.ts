import { describe, it, expect } from 'vitest';
import { runSharedSearchLoop } from '@/lib/tool-loop';
import type { GenerateParams, GenerateResult, ProviderAdapter } from '@/lib/types';
import type { RunSearchOutcome } from '@/lib/search';

// A scripted adapter that returns queued results and records the params it saw.
function scriptedAdapter(queue: Partial<GenerateResult>[]): {
  adapter: ProviderAdapter;
  calls: GenerateParams[];
} {
  const calls: GenerateParams[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    id: 'openai',
    async generate(params) {
      calls.push(params);
      const r = queue[Math.min(i, queue.length - 1)];
      i++;
      return {
        text: r.text ?? '',
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_calls' : 'complete'),
        rawStopReason: '',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        toolCalls: r.toolCalls,
      };
    },
  };
  return { adapter, calls };
}

const base = {
  apiModelString: 'm',
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'go' }],
  temperature: 0.8,
  maxTokens: 500,
};

const okSearch = async (): Promise<RunSearchOutcome> => ({
  results: [{ title: 'T', url: 'https://a.com', snippet: 's', fetchedAt: 'now' }],
  latencyMs: 5,
  provider: 'brave',
});

describe('runSharedSearchLoop', () => {
  it('runs one search then produces the final spoken turn', async () => {
    const { adapter, calls } = scriptedAdapter([
      { text: '', toolCalls: [{ id: 'c1', query: 'solar 2025 GW' }] },
      { text: 'Solar hit records last year.', stopReason: 'complete' },
    ]);
    const out = await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 2, resultsPerSearch: 5, sessionRemaining: 25 },
      okSearch,
    );
    expect(out.result.text).toBe('Solar hit records last year.');
    expect(out.searches).toHaveLength(1);
    expect(out.searches[0]).toMatchObject({ mode: 'shared', query: 'solar 2025 GW', provider: 'brave' });
    expect(out.degraded).toBe(false);
    // Second call replays the assistant tool-call turn + the tool result.
    const roles = calls[1].messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
  });

  it('flags degraded when a search fails but still finishes the turn', async () => {
    const { adapter } = scriptedAdapter([
      { text: '', toolCalls: [{ id: 'c1', query: 'q' }] },
      { text: 'Ungrounded but complete.', stopReason: 'complete' },
    ]);
    const failing = async (): Promise<RunSearchOutcome> => ({
      results: [],
      latencyMs: 1,
      provider: 'brave',
      note: 'Search failed: boom',
      failed: true,
    });
    const out = await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 2, resultsPerSearch: 5, sessionRemaining: 25 },
      failing,
    );
    expect(out.degraded).toBe(true);
    expect(out.result.text).toBe('Ungrounded but complete.');
  });

  it('enforces the per-turn cap: extra calls get a limit note, not a search', async () => {
    let searchCount = 0;
    const counting = async (): Promise<RunSearchOutcome> => {
      searchCount++;
      return { results: [{ title: 'T', url: 'https://a.com', snippet: 's', fetchedAt: 'now' }], latencyMs: 1, provider: 'brave' };
    };
    // First step asks for 3 searches at once; perTurn cap is 2.
    const { adapter } = scriptedAdapter([
      {
        text: '',
        toolCalls: [
          { id: 'c1', query: 'a' },
          { id: 'c2', query: 'b' },
          { id: 'c3', query: 'c' },
        ],
      },
      { text: 'Done.', stopReason: 'complete' },
    ]);
    const out = await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 2, resultsPerSearch: 5, sessionRemaining: 25 },
      counting,
    );
    expect(searchCount).toBe(2); // third call short-circuited
    expect(out.searches).toHaveLength(2);
  });

  it('respects the session budget', async () => {
    let searchCount = 0;
    const counting = async (): Promise<RunSearchOutcome> => {
      searchCount++;
      return { results: [], latencyMs: 1, provider: 'brave', note: 'No results.' };
    };
    const { adapter } = scriptedAdapter([
      { text: '', toolCalls: [{ id: 'c1', query: 'a' }, { id: 'c2', query: 'b' }] },
      { text: 'Done.', stopReason: 'complete' },
    ]);
    const out = await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 3, resultsPerSearch: 5, sessionRemaining: 1 }, // only 1 left
      counting,
    );
    expect(searchCount).toBe(1);
    expect(out.searches).toHaveLength(1);
  });

  it('forces a search on the first step when forceFirst is set', async () => {
    const { adapter, calls } = scriptedAdapter([
      { text: '', toolCalls: [{ id: 'c1', query: 'q' }] },
      { text: 'Grounded answer.', stopReason: 'complete' },
    ]);
    await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 2, resultsPerSearch: 5, sessionRemaining: 25, forceFirst: true },
      okSearch,
    );
    expect(calls[0].toolChoice).toBe('required'); // first step forced
    expect(calls[1].toolChoice).not.toBe('required'); // later steps free
  });

  it('never issues a search when the model asks for none', async () => {
    const { adapter } = scriptedAdapter([{ text: 'Straight answer.', stopReason: 'complete' }]);
    const out = await runSharedSearchLoop(
      adapter,
      base,
      { perTurn: 2, resultsPerSearch: 5, sessionRemaining: 25 },
      okSearch,
    );
    expect(out.searches).toHaveLength(0);
    expect(out.result.text).toBe('Straight answer.');
  });
});
