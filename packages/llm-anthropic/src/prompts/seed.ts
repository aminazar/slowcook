/**
 * 0.21.x — the LLM half of the LCR seed + adaptor pass. The schema + db
 * bootstrap + DDL are deterministic (structure); these two prompts cover the
 * parts that need judgment (content) —
 *   SEED_SYSTEM    → seed.ts: dense, realistic, referentially-consistent rows
 *                    that make every surface STATE reachable by navigation.
 *   ADAPTOR_SYSTEM → queries.ts: the typed domain query layer the surfaces call
 *                    (the mock→prod swap seam), shaped by the acceptance scenarios.
 *
 * Both receive the generated Drizzle schema (exact table/column/enum names) and a
 * specs digest (personas, surfaces+states, acceptance scenarios, invariants).
 * See docs/plans/vibe-whole-mock-lcr.md.
 */

export const SEED_SYSTEM = `You write the seed for a whole-app LCR mock backed by a REAL in-browser SQLite
(sql.js) via Drizzle. You are given the generated Drizzle schema (exact table
vars, columns, enums) and a digest of the specs (personas, each surface + the
data STATES it must show, acceptance scenarios).

Emit ONE TypeScript module \`seed.ts\` with exactly:

  import type { DB } from "./db";
  import * as schema from "./schema";
  export async function seed(db: DB): Promise<void> { ... }

Rules:
- Insert via Drizzle: \`await db.insert(schema.<tableVar>).values([ ... ]);\`. Use
  the EXACT table vars + column names from the schema. Respect enum values + NOT
  NULL. timestamp columns take JS \`Date\`; boolean columns take true/false.
- REFERENTIAL INTEGRITY: insert parents before children; reuse string ids you
  defined above (declare \`const FOUNDER_ID = "mbr_founder"\` etc. and reuse them).
  Every foreign key must point at a row you actually inserted.
- COVER THE STATES. For each surface's declared states (empty / populated /
  loading / error / edge) make that state REACHABLE with real data: a populated
  project AND an empty one; a wallet near its limit (edge); a worker pending
  certification, one certified, one decertified-with-open-appeal; an epic with a
  brew-halted issue; etc. The reviewer must be able to navigate to every state.
- COVER THE PERSONAS. Seed enough that "view as <persona>" shows that persona's
  surfaces populated (a founder with projects, an operator with workers to certify,
  a worker with a portfolio, a procurer with a vault).
- Realistic, not lorem: plausible names, repos, amounts, timestamps (use fixed
  dates, NOT Date.now()). Dense enough that lists/pagination look real (10-30 rows
  where a list is shown), minimal where a detail page suffices.
- Deterministic: no random(), no Date.now(). Stable ids.

Output ONLY the file contents — no prose, no code fences, no markdown.`;

export const ADAPTOR_SYSTEM = `You write the typed domain query layer for a whole-app LCR mock backed by a real
in-browser SQLite (sql.js) via Drizzle. You are given the generated Drizzle schema
and a specs digest (personas, surfaces, acceptance scenarios, invariants).

Emit ONE TypeScript module \`queries.ts\` with:
  import { getDb, type DB } from "./db";
  import * as schema from "./schema";
  import { eq, and, desc, ... } from "drizzle-orm";   // import what you use
  // A typed DataSource the surfaces call. The mock impl below reads SQLite; the
  // SAME interface is what brew implements against the real backend (the swap).
  export interface DataSource { ... }
  export const data: DataSource = { ... }

Rules:
- One function per thing a surface needs, derived from the ACCEPTANCE SCENARIOS,
  not generic CRUD: e.g. getWalletHealth(projectId) returning AGGREGATES ONLY if an
  invariant says the operator sees aggregates only; listPendingWorkers();
  certifyWorker(id, note); getForecast(epicId). Return shapes the UI renders.
- ENFORCE THE INVARIANTS in the query shape (don't return fields an invariant
  forbids). Reads use Drizzle (\`await (await getDb()).select()...\`); mutations
  insert/update. Keep them small + typed off the schema's \$inferSelect types.
- The interface is the contract; the const is the SQLite-backed impl. Name the
  interface DataSource so prod can implement it identically.
- No business logic beyond what scenarios require. No random/Date.now().

Output ONLY the file contents — no prose, no code fences, no markdown.`;
