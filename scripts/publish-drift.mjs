// PUBLISH DRIFT — a package whose src is newer than its npm version's publish
// date is a lie waiting for a consumer (2026-08-05: the npm cli's storyteller
// verbs imported gate functions that did not exist in the npm gates, because
// three packages carried weeks of unpublished src while every dogfooder built
// from main). Run in the daily smoke workflow: drift is a RED RUN, not an
// archaeology find.
//
//   node scripts/publish-drift.mjs            # fail on drift
//   node scripts/publish-drift.mjs --report   # print only, exit 0
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const reportOnly = process.argv.includes("--report");
const drifted = [];

// A shallow clone (CI's default checkout is depth 1) makes `git log -- path`
// attribute the single tip commit to EVERY path — its date then reads as the
// last change for every package, so untouched packages all look drifted. Under
// full history this is correct; without it, refuse rather than lie. (The daily
// workflow now checks out with fetch-depth: 0 for exactly this.)
const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" }).trim();
if (shallow === "true") {
  console.error("publish-drift: shallow checkout — per-path history is unavailable; run with full history (fetch-depth: 0). Skipping without a verdict.");
  process.exit(reportOnly ? 0 : 1);
}

for (const dir of readdirSync(join(root, "packages"))) {
  const pkgPath = join(root, "packages", dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) continue;
  let times;
  try {
    times = JSON.parse(execFileSync("npm", ["view", pkg.name, "time", "--json"], { encoding: "utf8", timeout: 30000 }));
  } catch { console.log(`  · ${pkg.name} — npm unreachable or never published; skipped`); continue; }
  const publishedAt = times[pkg.version];
  if (!publishedAt) {
    // the manifest is AHEAD of npm — a release is staged; that is fine, the
    // publish will carry the src. Only same-version-older-artifact is drift.
    console.log(`  · ${pkg.name}@${pkg.version} not on npm yet (staged release)`);
    continue;
  }
  const lastSrc = execFileSync("git", ["log", "-1", "--format=%cI", "--", `packages/${dir}/src`], { cwd: root, encoding: "utf8" }).trim();
  if (lastSrc && new Date(lastSrc) > new Date(publishedAt)) {
    drifted.push(`${pkg.name}@${pkg.version} published ${publishedAt.slice(0, 10)} but src changed ${lastSrc.slice(0, 10)} — bump and publish`);
  }
}

if (drifted.length) {
  console.error(`publish-drift: ${drifted.length} package(s) whose npm artifact lies about their source:`);
  for (const d of drifted) console.error(`  ✗ ${d}`);
  process.exit(reportOnly ? 0 : 1);
}
console.log("publish-drift: clean — every published version is at least as new as its source");
