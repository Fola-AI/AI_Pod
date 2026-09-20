// Model Registry screen (P1-4). Read-only view of config/models.ts, grouped by
// TIER (frontier → professional → fast), then provider, with each model's route
// (direct vs OpenRouter), tier, price, and a PER-MODEL Test-connection button.
// Key values are never sent to the client — only presence.

import {
  MODELS,
  PROVIDER_LABEL,
  TIER_LABEL,
  TIER_ORDER,
  routeLabel,
} from '@/config/models';
import { isModelAvailable } from '@/lib/providers';
import type { ModelEntry, ProviderId } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { TestConnectionButton } from '@/components/test-connection-button';

export const dynamic = 'force-dynamic';

export default function RegistryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Model registry</h1>
        <p className="text-sm text-muted-foreground">
          The models available to sessions, grouped by tier. Edit{' '}
          <code className="font-mono text-xs">config/models.ts</code> to add or
          change them — see the README below. Test each model individually.
        </p>
      </div>

      <div className="space-y-6">
        {TIER_ORDER.map((tier) => {
          const tierModels = MODELS.filter((m) => m.tier === tier);
          if (!tierModels.length) return null;
          const providers = Array.from(
            new Set(tierModels.map((m) => m.provider)),
          ) as ProviderId[];
          return (
            <section key={tier} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight">
                  {TIER_LABEL[tier]}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {tierModels.length} {tierModels.length === 1 ? 'model' : 'models'} ·{' '}
                  {providers.length} {providers.length === 1 ? 'vendor' : 'vendors'}
                </span>
              </div>
              <div className="rounded-lg border divide-y">
                {providers.map((provider) => (
                  <ProviderBlock
                    key={provider}
                    provider={provider}
                    models={tierModels.filter((m) => m.provider === provider)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <RegistryReadme />
    </div>
  );
}

function ProviderBlock({
  provider,
  models,
}: {
  provider: ProviderId;
  models: ModelEntry[];
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-sm font-medium">{PROVIDER_LABEL[provider]}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="text-left font-normal p-2 pl-1">Model</th>
            <th className="text-left font-normal p-2 hidden md:table-cell">
              API string
            </th>
            <th className="text-left font-normal p-2">Route</th>
            <th className="text-right font-normal p-2 hidden sm:table-cell">
              $/M in · out
            </th>
            <th className="text-right font-normal p-2 pr-1">Test</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const available = isModelAvailable(m);
            return (
              <tr key={m.id} className="border-b last:border-0 align-middle">
                <td className="p-2 pl-1">
                  <div className="flex items-center gap-2">
                    <span>{m.displayName}</span>
                    {!available && (
                      <Badge variant="outline" className="text-[10px]">
                        {m.route === 'openrouter' ? 'no OpenRouter key' : 'no key'}
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="p-2 font-mono text-xs text-muted-foreground hidden md:table-cell">
                  {m.apiModelString}
                </td>
                <td className="p-2">
                  <Badge
                    variant={m.route === 'openrouter' ? 'outline' : 'secondary'}
                    className="text-[10px]"
                  >
                    {routeLabel(m)}
                  </Badge>
                </td>
                <td className="p-2 text-right text-xs text-muted-foreground hidden sm:table-cell">
                  {m.inputPricePerMTok == null
                    ? '—'
                    : `${m.inputPricePerMTok} · ${m.outputPricePerMTok}`}
                </td>
                <td className="p-2 pr-1 text-right">
                  <div className="flex justify-end">
                    <TestConnectionButton
                      modelId={m.id}
                      label="Test"
                      disabled={!available}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RegistryReadme() {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
      <h2 className="font-medium">Adding models</h2>
      <div>
        <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          Existing route, new model
        </p>
        <p className="text-muted-foreground">
          Add an entry to{' '}
          <code className="font-mono text-xs">config/models.ts</code> and
          redeploy. No code changes. For a non-direct vendor set{' '}
          <code className="font-mono text-xs">route: &apos;openrouter&apos;</code>{' '}
          and use the OpenRouter <code className="font-mono text-xs">vendor/model</code>{' '}
          slug — it becomes selectable immediately.
        </p>
      </div>
      <div>
        <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          New direct provider
        </p>
        <p className="text-muted-foreground">
          Anthropic, OpenAI, Google and Groq are direct. To add another direct
          vendor, add its API-key env var, write an adapter implementing{' '}
          <code className="font-mono text-xs">ProviderAdapter</code> in{' '}
          <code className="font-mono text-xs">lib/providers/</code>, and register
          it in{' '}
          <code className="font-mono text-xs">lib/providers/index.ts</code>.
          Otherwise, prefer routing through OpenRouter (one key, no new adapter).
        </p>
      </div>
    </div>
  );
}
