// Model Registry screen (P1-4). Read-only view of config/models.ts, grouped by
// provider, with per-provider key status and a Test-connection button. Key
// values are never sent to the client — only presence.

import type { ProviderId } from '@/lib/types';
import { MODELS, PROVIDER_ENV_KEY, PROVIDER_LABEL } from '@/config/models';
import { hasProviderKey, isProviderImplemented } from '@/lib/providers';
import { Badge } from '@/components/ui/badge';
import { TestConnectionButton } from '@/components/test-connection-button';

export const dynamic = 'force-dynamic';

export default function RegistryPage() {
  const providers = Array.from(new Set(MODELS.map((m) => m.provider)));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Model registry</h1>
        <p className="text-sm text-muted-foreground">
          The models available to sessions. Edit{' '}
          <code className="font-mono text-xs">config/models.ts</code> to add or
          change them — see the README below.
        </p>
      </div>

      <div className="space-y-4">
        {providers.map((provider) => {
          const implemented = isProviderImplemented(provider);
          const keyPresent = hasProviderKey(provider);
          const usable = implemented && keyPresent;
          const models = MODELS.filter((m) => m.provider === provider);
          return (
            <div key={provider} className="rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {PROVIDER_LABEL[provider]}
                  </span>
                  <Badge variant={keyPresent ? 'secondary' : 'outline'}>
                    {keyPresent ? 'key present' : 'no key'}
                  </Badge>
                  {!implemented && (
                    <Badge variant="outline">adapter pending</Badge>
                  )}
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {PROVIDER_ENV_KEY[provider]}
                  </span>
                </div>
                <TestConnectionButton provider={provider} disabled={!usable} />
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left font-normal p-2 pl-4">Model</th>
                    <th className="text-left font-normal p-2 hidden sm:table-cell">
                      API string
                    </th>
                    <th className="text-left font-normal p-2">Tier</th>
                    <th className="text-right font-normal p-2 hidden sm:table-cell">
                      $/M in · out
                    </th>
                    <th className="text-right font-normal p-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="p-2 pl-4">{m.displayName}</td>
                      <td className="p-2 font-mono text-xs text-muted-foreground hidden sm:table-cell">
                        {m.apiModelString}
                      </td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-[10px]">
                          {m.tier}
                        </Badge>
                      </td>
                      <td className="p-2 text-right text-xs text-muted-foreground hidden sm:table-cell">
                        {m.inputPricePerMTok == null
                          ? '—'
                          : `${m.inputPricePerMTok} · ${m.outputPricePerMTok}`}
                      </td>
                      <td className="p-2 pr-4 text-right">
                        {usable ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-500">
                            available
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {!implemented ? 'no adapter' : 'no key'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <RegistryReadme />
    </div>
  );
}

function RegistryReadme() {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
      <h2 className="font-medium">Adding models</h2>
      <div>
        <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          Existing provider, new model
        </p>
        <p className="text-muted-foreground">
          Add an entry to{' '}
          <code className="font-mono text-xs">config/models.ts</code> and
          redeploy. No code changes. It becomes selectable immediately.
        </p>
      </div>
      <div>
        <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          New provider
        </p>
        <p className="text-muted-foreground">
          Add its API-key env var, write an adapter implementing the{' '}
          <code className="font-mono text-xs">ProviderAdapter</code> interface in{' '}
          <code className="font-mono text-xs">lib/providers/</code>, register it
          in <code className="font-mono text-xs">lib/providers/index.ts</code>,
          and add registry rows. For OpenAI-compatible endpoints, copy the base
          adapter usage in{' '}
          <code className="font-mono text-xs">lib/providers/index.ts</code>{' '}
          (xAI/DeepSeek/Groq etc. differ only by base URL); Anthropic and Google
          have bespoke adapters to copy otherwise.
        </p>
      </div>
    </div>
  );
}
