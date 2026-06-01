# Testgen backend conventions (NestJS-CQRS variant)

> The conventions slowcook's testgen agent (and any agent emitting backend tests via the local-pipeline pattern) should follow when scaffolding tests for a NestJS-CQRS backend story. These are NOT a `slowcook recipe --backend` command yet (parked for 0.20, see sc#156) — they're the documented convention so agents have a reference.

## When this applies

A story is a candidate for these conventions when ALL of:

- The consumer is a NestJS-CQRS backend (controller dispatches to `CommandBus` / `QueryBus`; handlers in `commands/handlers/` and `queries/handlers/`)
- The story has non-empty `spec.api_contract`
- TestManager-style infrastructure exists at the consumer's backend entrypoint (e.g. `apps/back/src/test-manager.test.ts`) providing `beforeAll` / `beforeEach` / `afterAll` lifecycle with `dropDatabase` + `runMigration`
- The story's brew will write CQRS handlers under `apps/back/src/modules/<feature>/{commands,queries}/handlers/`

When the consumer is a different stack (Express + Prisma, Fastify, FastAPI, Go, etc.), the same shape ideas apply but the concrete file scaffold differs — re-derive from the consumer's existing handler-test pattern.

## File layout (per handler)

For each command/query handler the brew will write:

```
apps/back/src/modules/<feature>/{commands,queries}/handlers/
  <action>.handler.ts          ← @slowcook-stub (impl)
  <action>.handler.test.ts     ← real failing tests
  <action>.helper.test.ts      ← test scaffolding (per-handler)
```

`<action>` is the command/query name in kebab-case (e.g. `create-or-get-thread.handler.ts` for `CreateOrGetThreadCommand`).

## Stub-file shape

Every stub file MUST have `// @slowcook-stub` on **line 1** so brew knows what to replace:

```ts
// @slowcook-stub
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateOrGetThreadCommand } from '../impl/create-or-get-thread.command';
import { CreateOrGetThreadResponseDtoAPI } from '../../dtos';

@CommandHandler(CreateOrGetThreadCommand)
export class CreateOrGetThreadHandler
  implements ICommandHandler<CreateOrGetThreadCommand>
{
  async execute(
    _command: CreateOrGetThreadCommand,
  ): Promise<CreateOrGetThreadResponseDtoAPI> {
    throw new Error('@slowcook-stub: CreateOrGetThreadHandler');
  }
}
```

Two non-negotiable bits:

1. **`@slowcook-stub` line-1 marker.** Brew greps for this to enumerate what to replace.
2. **Throw with the handler name in the error message** (`@slowcook-stub: CreateOrGetThreadHandler`). When the test runs and the stub throws, the test failure points at the specific handler — much faster diagnosis than a generic "not implemented".

## Helper-file shape

A `*.helper.test.ts` file per handler wraps the command/query construction so the actual `*.handler.test.ts` is readable:

```ts
import { CreateOrGetThreadHandler } from './create-or-get-thread.handler';
import { CreateOrGetThreadCommand } from '../impl/create-or-get-thread.command';
import {
  CreateOrGetThreadRequestDtoAPI,
  CreateOrGetThreadResponseDtoAPI,
} from '../../dtos';
import { TestManager } from '../../../../test-manager.test';

export class PeerChatCreateOrGetThreadHelper {
  public response!: CreateOrGetThreadResponseDtoAPI;

  constructor(
    public input: {
      requesterUserId?: string;
      createOrGetThreadRequestDtoAPI?: CreateOrGetThreadRequestDtoAPI;
    } = {},
  ) {}

  async execute(commands?: { createOrGetThreadCommand?: Partial<CreateOrGetThreadCommand> }) {
    const command: CreateOrGetThreadCommand = {
      requesterUserId: this.input.requesterUserId ?? 'default-requester-id',
      createOrGetThreadRequestDtoAPI: this.input.createOrGetThreadRequestDtoAPI ?? {
        therapistId: 'default-therapist-id',
      },
      ...commands?.createOrGetThreadCommand,
    };
    this.response = await TestManager.get(CreateOrGetThreadHandler).execute(command);
    return this.response;
  }
}
```

Each helper accepts a `Partial<XCommand>` override so individual tests can shape their input narrowly without re-stating the whole command.

## Test-file shape

```ts
import { TestManager } from '../../../../test-manager.test';
import { PeerChatCreateOrGetThreadHelper } from './create-or-get-thread.helper.test';

describe('CreateOrGetThreadHandler', () => {
  beforeAll(async () => { await TestManager.beforeAll(); });
  beforeEach(async () => { await TestManager.beforeEach(); });
  afterAll(async () => { await TestManager.afterAll(); });

  it('creates a thread when patient has a prior RESERVED appointment', async () => {
    // Arrange: seed user + therapist + appointment INLINE (no shared helpers).
    // Act: helper.execute({ overrides }).
    // Assert: helper.response + DB read-back.
  });

  // One it() per spec acceptance scenario for this handler.
});
```

## Seed helpers stay INLINE per test file

NestJS-CQRS handler tests own their DB transaction (`TestManager.beforeEach` runs `dropDatabase` + `runMigration`). Sharing seed helpers across files works in pure-function languages, but here each helper is implicitly stateful (writes to the test DB) and a shared helper would either:

- Be called from a different transactional context than the test it's seeding for (breaks `@Transactional()` semantics)
- Or get re-imported across files that need different overrides, leading to lowest-common-denominator helper signatures that don't fit anyone

**Rule:** inline `createPatientUser`, `createTherapistUser`, `seedReservedAppointment`, etc., per test file. Yes, it duplicates ~30 lines across N files. Worth it for test isolation.

Counter-pattern that DOES work: PURE-DATA factories (no DB writes) shared in a `*.fixtures.ts` file. The test imports the data shape, then calls its own inline writer. But the DB-writer itself stays per-file.

## Lifecycle order

```
TestManager.beforeAll()    ← spins up the Nest module, initialises DataSource
  TestManager.beforeEach() ← dropDatabase + runMigration + clearMocks
    it(...)                ← single test
  TestManager.afterAll()   ← module.close + dataSource.destroy
```

Don't shortcut `beforeEach` with a truncate-tables-only optimisation. The dropDatabase + runMigration cycle catches migration-shape regressions; a faster `TRUNCATE` loop hides them.

## What testgen scaffolds (in one PR) vs. what brew fills

**Testgen PR ships:**
- Entities + migration (brew needs them to exist before tests can run; the schema is part of the contract)
- Shared DTOs (in `packages/dtos/`)
- API DTOs (in `apps/back/src/modules/<feature>/dtos/`)
- CQRS scaffolding (controller, module, commands, queries, handler shells) — **all stubs with `// @slowcook-stub` line 1**
- Service shell (stub) in `packages/backend-modules/postgres/src/services/`
- Real tests + helpers (per-handler)
- Module registered in `app.module.ts`

**Brew PR fills:**
- Service method bodies
- Handler bodies (replaces `@slowcook-stub` throws)
- Any cross-cutting wiring brew discovers during impl (a missing repository, etc.)
- Per [sc#148 dual-path lift](https://github.com/aminazar/slowcook/pull/148), the canonical AND apps-shell page wrappers if the story has a UI

## Self-applying the conventions

If you're driving this via the [local-pipeline pattern](./local-pipeline-role.md), after the brew PR lands, run:

```bash
slowcook knowledge add testgen \
  "NestJS-CQRS handler tests use TestManager with per-test inlined seed helpers + @slowcook-stub line-1 markers. See slowcook docs/testgen-backend-conventions.md." \
  --evidence-pr <consumer-brew-PR> \
  --evidence-file apps/back/src/modules/<feature>/commands/handlers/<action>.handler.test.ts
```

This stamps the convention into the consumer's `.brewing/repo-knowledge/curated/test-patterns.md` so the next agent (slowcook bot, another local-pipeline session, a non-slowcook IDE agent) finds it before re-deriving the pattern.

## Dogfood evidence

This convention was distilled from delgoosh PRs #726 (testgen-mimic) + #727 (brew) for story-006 (peer-chat backend) and #728 (combined testgen+brew, mirror story-017). The pattern emerged from following `apps/back/src/modules/appointment/commands/handlers/*.handler.test.ts` as the existing repo template; the conventions above are explicit so future agents don't have to re-derive them from one example.

## See also

- [`docs/local-pipeline-role.md`](./local-pipeline-role.md) — the pattern these conventions support
- `slowcook knowledge add` — `packages/cli/src/commands/knowledge-add.ts`
- sc#151 finding 1 — the umbrella issue that motivated this doc
- sc#156 — RFC for the future `slowcook recipe --backend` mode (0.20+) that would emit this scaffold deterministically

Refs: sc#151 finding 1a.
