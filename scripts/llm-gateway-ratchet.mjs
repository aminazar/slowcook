// ONE GATEWAY, ENFORCED (dovizir handover R1).
//
// "Every incident in this run traces to command code bypassing shared rails:
//  brew constructs its own Anthropic client, runs its own turn loop, keeps its
//  own pricing table, does its own budget math, writes no ledger entries.
//  Delete the pattern, not the instances."
//
// R1's end-state is a single `LlmSession` in llm-anthropic that owns client
// construction, the tool loop, usage capture, pricing, ledger writes and budget
// enforcement — with `@anthropic-ai/sdk` importable ONLY inside that package.
// That refactor is not done. This gate is the RATCHET that holds the line
// meanwhile: the known violators are listed, and the count may only go DOWN.
//
// Why a ratchet rather than a clean ban: a ban that fails on day one gets
// disabled, and then nothing is enforced at all. A ratchet fails only on NEW
// violations, so the pattern cannot regrow while the refactor lands.
//
//   node scripts/llm-gateway-ratchet.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

/**
 * Files outside packages/llm-anthropic that still import the Anthropic SDK
 * directly. Every one of these is a command that can bypass shared pricing,
 * ledger and budget rails. REMOVE entries as R1/R4 land; never add.
 */
const SDK_ALLOWLIST = new Set([
  "packages/cli/src/commands/brew/agent.ts",
  "packages/cli/src/commands/brew/index.ts",
  "packages/cli/src/commands/brew/pair-navigator.ts",
  "packages/cli/src/commands/sift/agent.ts",
  "packages/cli/src/commands/recipe-regression/agent.ts",
  "packages/cli/src/commands/investigate/agent.ts",
  "packages/cli/src/commands/plate/agent.ts",
  "packages/cli/src/commands/vibe/agent.ts",
  "packages/cli/src/commands/brand/index.ts",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(root, "packages"));
const sdkOffenders = [];
const pricingOffenders = [];

for (const abs of files) {
  const rel = relative(root, abs);
  if (rel.startsWith("packages/llm-anthropic/")) continue; // the gateway itself
  const src = readFileSync(abs, "utf8");
  if (/from ["']@anthropic-ai\/sdk["']/.test(src) && !SDK_ALLOWLIST.has(rel)) sdkOffenders.push(rel);
  // A second pricing table is how "fix the bug" silently fixes only one of five.
  if (/PRICING_PER_M_TOKENS\s*:\s*Record</.test(src)) pricingOffenders.push(rel);
}

// Allowlist entries that no longer violate: the ratchet must tighten itself,
// or it rots into a list of things nobody re-checks.
const healed = [...SDK_ALLOWLIST].filter((rel) => {
  try { return !/from ["']@anthropic-ai\/sdk["']/.test(readFileSync(join(root, rel), "utf8")); }
  catch { return true; } // deleted file — also healed
});

let bad = false;

if (pricingOffenders.length) {
  bad = true;
  console.error(`llm-gateway: ${pricingOffenders.length} file(s) declare their OWN pricing table:`);
  for (const f of pricingOffenders) console.error(`  ✗ ${f}`);
  console.error(`  There is one table, in @slowcook-ai/llm-anthropic. Five copies existed once, each with`);
  console.error(`  its own silent-zero — fixing one changed nothing about what the system actually spent.`);
}

if (sdkOffenders.length) {
  bad = true;
  console.error(`llm-gateway: ${sdkOffenders.length} NEW file(s) import @anthropic-ai/sdk outside the gateway:`);
  for (const f of sdkOffenders) console.error(`  ✗ ${f}`);
  console.error(`  Commands declare tools + prompts; they do not construct clients. A command that owns its`);
  console.error(`  own client also owns its own pricing, budget math and ledger writes — which is how spend`);
  console.error(`  became unenforceable. Route through @slowcook-ai/llm-anthropic.`);
}

if (healed.length) {
  console.log(`llm-gateway: ${healed.length} allowlist entr${healed.length === 1 ? "y is" : "ies are"} clean — delete from SDK_ALLOWLIST to lock the gain in:`);
  for (const f of healed) console.log(`  · ${f}`);
}

if (bad) process.exit(1);
console.log(
  `llm-gateway: clean — no new SDK importers, no duplicate pricing tables ` +
  `(${SDK_ALLOWLIST.size} known violator${SDK_ALLOWLIST.size === 1 ? "" : "s"} awaiting R1/R4).`
);
