// Small fetch helper with a timeout, shared by all adapters.

// Generation timeout. Lowered from 120s (B-5.5 latency pass): a genuinely hung
// provider should fail fast rather than tie up a turn for two minutes, and a
// timeout is retried at most once (see withRetry), so the worst case is ~2x this
// rather than 4x. Slow reasoning models that legitimately need longer than this
// will fail — prefer a faster model for those seats.
const DEFAULT_TIMEOUT_MS = 90_000;

// Synthetic status for a client-side timeout, so it classifies as transient and
// withRetry can recognise it (and cap its retries) without sniffing error names.
export const TIMEOUT_STATUS = 408;

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    const aborted =
      err?.name === 'AbortError' ||
      err?.name === 'TimeoutError' ||
      /abort|timed? ?out/i.test(String(err?.message ?? ''));
    if (aborted) {
      return {
        ok: false,
        status: TIMEOUT_STATUS,
        json: { error: { message: `Request timed out after ${timeoutMs}ms` } },
        text: 'timeout',
      };
    }
    // Other network error: status 0 → transient, retried normally.
    return { ok: false, status: 0, json: null, text: String(err?.message ?? 'network error') };
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (e.g. an HTML error page). Leave json null.
  }
  return { ok: res.ok, status: res.status, json, text };
}
