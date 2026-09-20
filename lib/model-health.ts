// Last per-model test/preflight result, so availability reflects what actually
// happened on the last real call — not just whether a key is present (a key can
// be present but out of credits, as Google's depleted 402 showed). Single-
// operator app on one server, so an in-memory cache is adequate; it resets on
// restart, which just means "re-test", never a wrong "available".

export interface ModelTestResult {
  ok: boolean;
  message?: string;
  at: number; // epoch ms
}

const cache = new Map<string, ModelTestResult>();

export function recordModelTest(modelId: string, ok: boolean, message?: string): void {
  cache.set(modelId, { ok, message, at: Date.now() });
}

export function getModelTest(modelId: string): ModelTestResult | undefined {
  return cache.get(modelId);
}

export function allModelTests(): Record<string, ModelTestResult> {
  return Object.fromEntries(cache);
}
