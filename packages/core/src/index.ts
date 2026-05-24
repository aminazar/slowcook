export * from "./frozen-paths.js";
export * from "./manifest.js";
export * from "./forge.js";
export * from "./spec.js";
export * from "./llm.js";
// 0.13.0 — Scenario types for the 0.16 mock-app pipeline.
export * from "./scenario.js";
// sc#82 follow-up — single source-of-truth for the slowcook logo. The
// SVG file lives at `packages/core/assets/slowcook-logo.svg`; this
// module reads it at module load + re-exports as a string so
// `mock-runtime` + `cli` consumers don't inline copies.
export * from "./branding.js";
