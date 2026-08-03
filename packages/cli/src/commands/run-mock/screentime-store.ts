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

export interface DayEntry { s: number; c: number }
/** login → project → ISO date → { seconds, comments } */
export type ScreentimeBank = Record<string, Record<string, Record<string, DayEntry>>>;

export interface ScreentimeReport {
  todaySeconds: number;
  weekSeconds: number;
  dailyAverageSeconds: number;
  todayComments: number;
  weekComments: number;
  daysCounted: number;
  days: { date: string; seconds: number; comments: number }[];
}

/** Fold a deposit into the bank (pure — returns the same bank, mutated). */
export function deposit(bank: ScreentimeBank, login: string, project: string, date: string, seconds: number, comments: number): ScreentimeBank {
  const byProject = (bank[login] ??= {});
  const byDay = (byProject[project] ??= {});
  const day = (byDay[date] ??= { s: 0, c: 0 });
  day.s += Math.max(0, seconds);
  day.c += Math.max(0, comments);
  return bank;
}

/** The report the overlay's panel renders — same shape as its local bank's,
 *  so the panel needs no idea which book it is reading. */
export function report(bank: ScreentimeBank, login: string, project: string, today: string): ScreentimeReport {
  const byDay = bank[login]?.[project] ?? {};
  const days = Object.entries(byDay)
    .sort(([a], [z]) => z.localeCompare(a))
    .slice(0, 7)
    .map(([date, v]) => ({ date, seconds: v.s, comments: v.c }));
  const weekSeconds = days.reduce((n, d) => n + d.seconds, 0);
  const counted = days.filter((d) => d.seconds > 0).length || 1;
  return {
    todaySeconds: byDay[today]?.s ?? 0,
    weekSeconds,
    dailyAverageSeconds: Math.round(weekSeconds / counted),
    todayComments: byDay[today]?.c ?? 0,
    weekComments: days.reduce((n, d) => n + d.comments, 0),
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
