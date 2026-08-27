/**
 * `slowcook taste` pure logic — context-aware review of agent-authored PRs.
 *
 * Taste is the reviewer stage of the worker pipeline: for a spec or tests
 * PR it reads the whole LINEAGE — source issue and its PM Q&A, the spec,
 * the diff — and returns a structured verdict. The IO wrapper posts the
 * review as the agent identity and, when the operator granted authority
 * (--merge), merges on approve.
 *
 * NOTE: GitHub refuses APPROVE/REQUEST_CHANGES reviews on one's own PR,
 * and taste usually reviews PRs authored by the same App identity — so
 * the review is posted as a COMMENT review carrying an explicit verdict,
 * and merge authority is exercised directly. The verdict line in stdout
 * is the worker's mapping contract.
 */

export type PrKind = "spec" | "tests" | "brew";

export interface TasteContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  headBranch: string;
  kind: PrKind;
  storyId: string;
  /** Unified diff, truncated by the caller. */
  diff: string;
  /** The story's spec YAML (post-merge for tests PRs; the PR's for spec PRs). */
  specYaml: string | null;
  sourceIssueTitle: string | null;
  sourceIssueBody: string | null;
  /** Trimmed PM Q&A thread from the source issue. */
  issueThread: string | null;
  /** Trimmed PR discussion thread (taste's own findings excluded) — the
   *  venue where PM rulings and relays land during review rounds. */
  prThread: string | null;
  /** The story's test manifest (brew reviews: the frozen contract the
   *  implementation must satisfy). */
  manifestJson: string | null;
  /** CURRENT contents of key story files at the PR head (2026-08-23):
   *  the diff shows deltas and the thread shows history — neither is the
   *  present. Reviews must judge these, not recalled thread claims. */
  headFiles: Array<{ path: string; content: string }> | null;
  /** Recent commit subjects on the PR branch — PM-arbitration commits
   *  ("human gate", "PM arbitration") are visible here, so authorized
   *  test edits are distinguishable from agent goalpost-moving. */
  commitSubjects: string[] | null;
  /** S1 (#526): the project constitution prompt block ("" when the
   *  repo has none). Law over precedent — findings must cite ticked
   *  slots and stay silent on deliberately-blank ones. */
  constitution: string;
  /** S3 (#528): deterministic `slowcook analyze` findings for spec
   *  reviews ("" when clean or not a spec PR). Machine evidence, not
   *  opinion — a conflict here is blocking unless the PM has ruled. */
  analyzeFindings: string;
}

export interface TasteFinding {
  severity: "blocking" | "important" | "nit";
  note: string;
}

export interface TasteVerdict {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: TasteFinding[];
}

export function buildTastePrompt(ctx: TasteContext): { system: string; user: string } {
  const system = `You are slowcook's reviewer agent ("taste") for pipeline PRs on a software project.
You review the ${
    ctx.kind === "tests"
      ? "generated TEST SUITE"
      : ctx.kind === "brew"
        ? "agent-written IMPLEMENTATION"
        : "generated SPEC"
  } for one story against its full lineage.

Judge:
${
  ctx.kind === "tests"
    ? `- Do the tests faithfully cover the spec's invariants and scenarios? Name any invariant with no test.
- Are the tests honest (no auto-pass, no tautologies, no testing of mocks-of-mocks)?
- Would they be red before implementation and green after a correct one?
- Quality: determinism, isolation, clear naming. Style nits are nits, not blockers.
- WHAT THE TESTS MOCK IS AN ARCHITECTURAL CLAIM: the mocked seam must match the
  runtime context the spec implies. A background job/crawler must mock the
  service-role (admin) client, never the request-scoped/cookie client; a
  request handler the reverse. Twice, suites mocked the WRONG module and their
  green enforced a defect the reviewer praised. Name any mock whose seam
  contradicts the spec's runtime context — that is blocking, not a nit.
- Fixtures must return the shapes the real dependency returns (e.g. PostgREST
  returns ARRAYS for multi-row selects — a fixture handing back a bare object
  forces the implementation to grow normalization hacks for the mock's sake).`
    : ctx.kind === "brew"
      ? `- Does the diff implement the spec's invariants — nothing missing, nothing invented beyond the spec?
- TEST TAMPERING: the tests are the frozen contract; a change under tests/ in an implementation diff normally means the agent moved the goalposts — BLOCKING. Exception: when the PR thread or a commit subject records an explicit PM arbitration/ruling ("PM arbitration", "human gate", "ruling") covering those edits, they are AUTHORIZED — judge whether the edits faithfully implement the recorded ruling instead of flagging tampering.
- Scope discipline: only files this story needs; flag drive-by edits.
- Migrations/schema changes must match the spec's approved proposals exactly.
- Does the code handle the spec's failure scenarios (not just the happy path)?
- NOTE: your verdict here is ADVISORY — implementation merges are a human gate; write findings as briefing notes for the human reviewer.`
      : `- Does the spec faithfully capture the source issue and the PM's answers? Name contradictions.
- Are invariants testable and unambiguous? Are scenarios concrete?
- Scope: nothing invented beyond the issue + answers; nothing load-bearing missing.`
}

Evidence rules:
- The diff, the spec, and the "Current state" file sections are the PRESENT.
- The PR thread and any errors it mentions are HISTORY — earlier rounds may
  have been fixed since. NEVER report a defect as current on the strength of
  a thread comment alone; verify it against the current file contents or the
  diff, and if you cannot, phrase it as a question, not a finding.

Verdict rules — fail closed:
- "approve" ONLY when there are no blocking findings.
- Anything that would make the story's definition-of-done wrong is blocking.
- Unsure = "request_changes" with the question as a finding.

Respond with ONLY a JSON object:
{"verdict": "approve" | "request_changes", "summary": "<2-4 sentences>", "findings": [{"severity": "blocking"|"important"|"nit", "note": "<specific, actionable>"}]}`;

  const parts: string[] = [];
  parts.push(`## PR #${ctx.prNumber}: ${ctx.prTitle}\nBranch: ${ctx.headBranch}\n\n${ctx.prBody || "(no body)"}`);
  if (ctx.sourceIssueTitle) {
    parts.push(`## Source issue: ${ctx.sourceIssueTitle}\n\n${ctx.sourceIssueBody ?? ""}`);
  }
  if (ctx.issueThread) {
    parts.push(`## PM Q&A thread (trimmed)\n\n${ctx.issueThread}`);
  }
  if (ctx.prThread) {
    parts.push(
      `## PR discussion thread (trimmed)\n\nRulings and PM relays posted here are part of the lineage — a later comment supersedes an earlier one.\n\n${ctx.prThread}`
    );
  }
  if (ctx.specYaml) {
    parts.push(`## Spec (story-${ctx.storyId})\n\n\`\`\`yaml\n${ctx.specYaml}\n\`\`\``);
  }
  if (ctx.manifestJson) {
    parts.push(
      `## Test manifest (the frozen contract this implementation must satisfy)\n\n\`\`\`json\n${ctx.manifestJson}\n\`\`\``
    );
  }
  if (ctx.commitSubjects && ctx.commitSubjects.length > 0) {
    parts.push(`## Commits on this PR branch (newest last)\n\n${ctx.commitSubjects.map((c) => `- ${c}`).join("\n")}`);
  }
  if (ctx.headFiles && ctx.headFiles.length > 0) {
    parts.push(
      `## Current state of key files at the PR head (authoritative over any historical claims in the thread)\n\n` +
        ctx.headFiles
          .map((f) => `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")
    );
  }
  if (ctx.analyzeFindings) {
    parts.push(
      `## Deterministic consistency findings (\`slowcook analyze\`)\n\n` +
        `These are machine-checked against the other ACTIVE specs and the as-built migrations — ` +
        `treat each as a blocking finding unless the thread shows a PM ruling that resolves it:\n\n` +
        "```\n" + ctx.analyzeFindings + "\n```"
    );
  }
  parts.push(`## Diff under review\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
  return { system: system + ctx.constitution, user: parts.join("\n\n---\n\n") };
}

/** Extract the first balanced JSON object from model text. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced && fenced[1]) return fenced[1];
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the model's verdict. Null = unparseable — the caller must fail
 *  closed (never merge on a verdict it could not read). */
export function parseTasteVerdict(text: string): TasteVerdict | null {
  const blob = extractJson(text);
  if (!blob) return null;
  try {
    const d = JSON.parse(blob) as Partial<TasteVerdict>;
    if (d.verdict !== "approve" && d.verdict !== "request_changes") return null;
    const findings: TasteFinding[] = Array.isArray(d.findings)
      ? d.findings
          .filter((f): f is TasteFinding => typeof (f as TasteFinding)?.note === "string")
          .map((f) => ({
            severity: f.severity === "blocking" || f.severity === "important" ? f.severity : "nit",
            note: f.note,
          }))
      : [];
    // Defense-in-depth: a blocking finding can never ride an approve.
    const verdict =
      d.verdict === "approve" && findings.some((f) => f.severity === "blocking")
        ? "request_changes"
        : d.verdict;
    return { verdict, summary: typeof d.summary === "string" ? d.summary : "", findings };
  } catch {
    return null;
  }
}

/** Render the review body posted to the PR. */
export function renderReviewBody(
  v: TasteVerdict,
  opts: { header: string; merged: boolean; mergeAuthority: boolean }
): string {
  const lines: string[] = [opts.header, ""];
  lines.push(
    v.verdict === "approve"
      ? `✅ **taste: approve**${opts.merged ? " — merged." : opts.mergeAuthority ? "" : " (merge left to a human)"}`
      : `🔶 **taste: changes requested**`
  );
  lines.push("", v.summary);
  if (v.findings.length > 0) {
    lines.push("");
    for (const f of v.findings) {
      const badge = f.severity === "blocking" ? "🛑" : f.severity === "important" ? "⚠️" : "💅";
      lines.push(`- ${badge} **${f.severity}**: ${f.note}`);
    }
  }
  return lines.join("\n");
}
