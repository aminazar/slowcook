"use client";

import Link from "next/link";
import { useScenarioRegistry } from "./registry-context.js";

/**
 * Default homepage for a slowcook mock app. Lists every registered
 * scenario; each row links to that scenario's `initialPath` with
 * `?scenario=<id>` set so client components resolve correctly.
 *
 * When the registry is empty (just-bootstrapped mock with no vibe
 * runs) shows a placeholder with pointers to add the first scenario.
 *
 * Consumer's mock/src/app/page.tsx is just:
 *
 * ```tsx
 * import { ScenarioPicker } from "@slowcook-ai/mock-runtime";
 * export default function Page() {
 *   return <ScenarioPicker />;
 * }
 * ```
 *
 * Consumers can replace this with their own picker if they want to
 * surface scenarios differently (group by status, search, etc.) — the
 * registry + hooks API is stable; the UI is replaceable.
 */
export function ScenarioPicker() {
  const registry = useScenarioRegistry();
  const scenarios = registry.list;

  if (scenarios.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-bold mb-4">mock</h1>
        <div className="rounded-lg border border-card-border bg-card-bg p-6 space-y-3">
          <p className="text-foreground/80">
            No scenarios registered yet. The mock is bootstrapped but empty.
          </p>
          <p className="text-foreground/60 text-sm">
            Scenarios are added by the <code className="bg-foreground/5 px-1 py-0.5 rounded">vibe</code> agent
            when it runs against a story spec, OR you can hand-author one for testing:
          </p>
          <ol className="list-decimal list-inside text-sm text-foreground/60 space-y-1">
            <li>Create <code className="bg-foreground/5 px-1 py-0.5 rounded">mock/scenarios/story-N.ts</code> exporting a default <code>Scenario</code></li>
            <li>Add an import + entry to <code className="bg-foreground/5 px-1 py-0.5 rounded">mock/src/lib/scenario-registry.ts</code></li>
            <li>Refresh — your scenario appears here</li>
          </ol>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-bold mb-2">mock</h1>
      <p className="text-foreground/60 mb-8 text-sm">
        Pick a scenario to render the UI with that story&apos;s fixture data.
      </p>
      <ul className="space-y-3">
        {scenarios.map((s) => (
          <li
            key={s.id}
            className="rounded-lg border border-card-border bg-card-bg p-4 hover:border-coral/40 transition-colors"
          >
            <Link
              href={`${s.initialPath}?scenario=${encodeURIComponent(s.id)}`}
              className="block"
            >
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="text-xs text-foreground/40">
                  story-{s.id} · {s.user ? `as ${s.user.handle}` : "anonymous"}
                </span>
              </div>
              <div className="text-xs text-foreground/60 font-mono">
                {s.initialPath}
              </div>
              {s.expectedInteractions && s.expectedInteractions.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-foreground/60">
                  {s.expectedInteractions.map((i, idx) => (
                    <li key={idx} className="pl-3 border-l-2 border-card-border">
                      {i}
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
