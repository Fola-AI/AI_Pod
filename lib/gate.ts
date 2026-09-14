// Access gate helpers (PRD §12). A single shared password. The cookie stores a
// SHA-256 of the password so the proxy can verify statelessly. If
// APP_ACCESS_PASSWORD is unset, the gate is disabled (local dev).

export const GATE_COOKIE = 'ai_pod_gate';

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function gateEnabled(): boolean {
  return Boolean(process.env.APP_ACCESS_PASSWORD?.trim());
}

export async function expectedToken(): Promise<string> {
  return sha256Hex(process.env.APP_ACCESS_PASSWORD ?? '');
}
