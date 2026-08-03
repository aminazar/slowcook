/**
 * The screentime ledger (0.28.4) — the shared review-time bank the overlay's
 * panel points at ("point screentimeBase at a relay to count every device").
 *
 * Why it exists (delgoosh field report): the overlay's local bank lives in
 * localStorage, which is per-ORIGIN — a monorepo's three review surfaces are
 * three origins, so one reviewer saw three disjoint ledgers. This store is
 * the ONE book: keyed reviewer login → project → day, file-backed on the box
 * the reviewer-auth helper already runs on.
 *
 * Identity comes from the same Bearer token the overlay already holds: the
 * helper resolves it to a GitHub login via /user (cached), so nobody can
 * write into another reviewer's ledger without their token.
 *
 * Everything decision-shaped is pure and tested; fs and fetch are injected.
 */

export interface DayEntry {
  s: number;
  c: number;
  /** 0.28.5 — the journal: each attention chunk as it landed, with the routes
   *  it spanned. Totals above stay scalar so summing per repo (and later per
   *  PROJECT across repos) is a fold, never a parse. */
  chunks?: { at: string; s: number; routes?: string[]; pins?: number }[];
}
/** login → project → ISO date → { seconds, comments } */
export type ScreentimeBank = Record<string, Record<string, Record<string, DayEntry>>>;

/** Dash's lines-moved mechanism, ported whole: commits that NAME a pin
 *  number are that pin's footprint — git is the ground truth, no crediting
 *  protocol. The grep matches the repo's citation habits (#886, no.886,
 *  (886)) without swallowing 8860. */
export function pinGrep(n: number): string {
  return `(no\\.|#|\\()${n}([^0-9]|$)`;
}

/** Sum added+deleted from `git log --numstat` output. Pure. */
export function movedLines(numstatOut: string): number {
  let moved = 0;
  for (const line of numstatOut.split("\n")) {
    const m = line.match(/^(\d+)\t(\d+)\t/);
    if (m) moved += Number(m[1]) + Number(m[2]);
  }
  return moved;
}

export interface LinesConfig {
  /** The checkout the commits live in (the box's clone). */
  repoPath: string;
  /** owner/repo for the pin search. */
  repoFull: string;
  /** The label the review shell files under (scope label). */
  reviewLabel: string;
  /** Injected in tests. */
  runGit?: (args: string[]) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Per-day pins filed (GitHub search, the caller's own token) and lines
 *  those pins moved (git). Failures degrade to empty maps — a report with
 *  no lines is still a report. */
export async function pinsAndLines(cfg: LinesConfig, login: string, token: string): Promise<{ pinsPerDay: Map<string, number>; linesPerDay: Map<string, number> }> {
  const f = cfg.fetchImpl ?? globalThis.fetch;
  const pinsPerDay = new Map<string, number>();
  const numbers: { n: number; day: string }[] = [];
  try {
    const q = `repo:${cfg.repoFull} author:${login} label:${cfg.reviewLabel}`;
    const r = await f(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "slowcook-reviewer-auth", accept: "application/vnd.github+json" },
    });
    if (r.ok) {
      const j = (await r.json()) as { items?: { number: number; created_at?: string }[] };
      for (const it of j.items ?? []) {
        const day = String(it.created_at ?? "").slice(0, 10);
        if (!day) continue;
        pinsPerDay.set(day, (pinsPerDay.get(day) ?? 0) + 1);
        numbers.push({ n: it.number, day });
      }
    }
  } catch { /* GitHub unreachable — pins simply unknown */ }

  const linesPerDay = new Map<string, number>();
  const runGit = cfg.runGit ?? (async (args: string[]) => {
    const { execFile } = await import("node:child_process");
    return await new Promise<string>((resolve) => {
      execFile("git", args, { cwd: cfg.repoPath, maxBuffer: 8 * 1024 * 1024 }, (e, out) => resolve(e ? "" : String(out)));
    });
  });
  try {
    for (const { n, day } of numbers) {
      const out = await runGit(["log", "--all", "--numstat", "--format=%H", "-E", `--grep=${pinGrep(n)}`]);
      const moved = movedLines(out);
      if (moved > 0) linesPerDay.set(day, (linesPerDay.get(day) ?? 0) + moved);
    }
  } catch { /* no repo here — lines simply unknown */ }
  return { pinsPerDay, linesPerDay };
}

export interface ScreentimeReport {
  todaySeconds: number;
  weekSeconds: number;
  dailyAverageSeconds: number;
  todayComments: number;
  weekComments: number;
  todayDiffLines?: number;
  weekDiffLines?: number;
  daysCounted: number;
  days: { date: string; seconds: number; comments: number; diffLines?: number }[];
}

/** Fold a deposit into the bank (pure — returns the same bank, mutated). */
export function deposit(bank: ScreentimeBank, login: string, project: string, date: string, seconds: number, comments: number, chunk?: { at?: string; routes?: string[] }): ScreentimeBank {
  const byProject = (bank[login] ??= {});
  const byDay = (byProject[project] ??= {});
  const day = (byDay[date] ??= { s: 0, c: 0 });
  const s = Math.max(0, seconds), c = Math.max(0, comments);
  day.s += s;
  day.c += c;
  if (s > 0 || c > 0) {
    (day.chunks ??= []).push({ at: chunk?.at ?? "", s, ...(chunk?.routes?.length ? { routes: chunk.routes } : {}), ...(c ? { pins: c } : {}) });
  }
  return bank;
}

/** The report the overlay's panel renders — same shape as its local bank's,
 *  so the panel needs no idea which book it is reading. */
export function report(bank: ScreentimeBank, login: string, project: string, today: string, extras?: { pinsPerDay?: Map<string, number>; linesPerDay?: Map<string, number> }): ScreentimeReport {
  const byDay = bank[login]?.[project] ?? {};
  const days = Object.entries(byDay)
    .sort(([a], [z]) => z.localeCompare(a))
    .slice(0, 7)
    .map(([date, v]) => ({
      date, seconds: v.s,
      // GitHub's own count of filed pins outranks the deposit counter when
      // available (dash's rule) — the deposit is the offline approximation
      comments: extras?.pinsPerDay?.get(date) ?? v.c,
      ...(extras?.linesPerDay?.has(date) ? { diffLines: extras.linesPerDay.get(date) } : {}),
    }));
  const weekSeconds = days.reduce((n, d) => n + d.seconds, 0);
  const counted = days.filter((d) => d.seconds > 0).length || 1;
  const lines = days.reduce((n, d) => n + (d.diffLines ?? 0), 0);
  return {
    todaySeconds: byDay[today]?.s ?? 0,
    weekSeconds,
    dailyAverageSeconds: Math.round(weekSeconds / counted),
    todayComments: extras?.pinsPerDay?.get(today) ?? byDay[today]?.c ?? 0,
    weekComments: days.reduce((n, d) => n + d.comments, 0),
    ...(extras?.linesPerDay ? { todayDiffLines: extras.linesPerDay.get(today) ?? 0, weekDiffLines: lines } : {}),
    daysCounted: counted,
    days,
  };
}

/** Token → login, with an in-memory cache so a chatty panel doesn't hammer
 *  GitHub. A token GitHub rejects resolves to null (the caller 401s). */
export function makeIdentityResolver(fetchImpl: typeof fetch = globalThis.fetch): (token: string) => Promise<string | null> {
  const cache = new Map<string, { login: string | null; at: number }>();
  const TTL = 10 * 60_000;
  return async (token: string) => {
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < TTL) return hit.login;
    const r = await fetchImpl("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }).catch(() => null);
    const login = r?.ok ? ((await r.json()) as { login?: string }).login ?? null : null;
    cache.set(token, { login, at: Date.now() });
    return login;
  };
}

/** File-backed persistence, injected fs so tests run on a Map-of-strings. */
export interface StoreIo {
  read(): string | null;
  write(text: string): void;
}

export function loadBank(io: StoreIo): ScreentimeBank {
  try { return JSON.parse(io.read() ?? "{}") as ScreentimeBank; } catch { return {}; }
}

export function saveBank(io: StoreIo, bank: ScreentimeBank): void {
  io.write(JSON.stringify(bank));
}
