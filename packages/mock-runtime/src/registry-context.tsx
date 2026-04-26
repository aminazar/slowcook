"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ScenarioRegistry } from "./types.js";

/**
 * React context that holds the consumer's ScenarioRegistry. Mounted
 * at the root layout via `<ScenarioRegistryProvider>`; read by hooks
 * (`useScenario`, `useScenarioFixture`) and the `<ScenarioPicker />`
 * component.
 *
 * Consumer's mock/src/app/layout.tsx looks like:
 *
 * ```tsx
 * import { ScenarioRegistryProvider } from "@slowcook-ai/mock-runtime";
 * import { registry } from "@/lib/scenario-registry";
 *
 * export default function RootLayout({ children }: { children: ReactNode }) {
 *   return (
 *     <html>
 *       <body>
 *         <ScenarioRegistryProvider registry={registry}>
 *           {children}
 *         </ScenarioRegistryProvider>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export const ScenarioRegistryContext = createContext<ScenarioRegistry | null>(
  null
);

export interface ScenarioRegistryProviderProps {
  registry: ScenarioRegistry;
  children: ReactNode;
}

export function ScenarioRegistryProvider({
  registry,
  children,
}: ScenarioRegistryProviderProps) {
  return (
    <ScenarioRegistryContext.Provider value={registry}>
      {children}
    </ScenarioRegistryContext.Provider>
  );
}

export function useScenarioRegistry(): ScenarioRegistry {
  const reg = useContext(ScenarioRegistryContext);
  if (reg === null) {
    throw new Error(
      "useScenarioRegistry: no <ScenarioRegistryProvider> found in the tree. Wrap your root layout with one."
    );
  }
  return reg;
}
