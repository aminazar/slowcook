import { describe, it, expect } from "vitest";
import { validatePlateDtoColumns } from "./dto-columns.js";

describe("validatePlateDtoColumns — sc#151 #4", () => {
  it("returns no findings when every DTO field matches a migration column", () => {
    const dtos = [
      {
        path: "packages/dtos/src/back/peer-chat/list-threads.response.dto.ts",
        contents: `
export class ThreadDto {
  threadId: string;
  patientId: string;
  therapistId: string;
}
`,
      },
    ];
    const migrations = [
      {
        path: "packages/postgres/src/migrations/1772100000000-create-peer-chat-tables.ts",
        contents: `
await DatabaseCreateTable(queryRunner, 'threads', [
  { name: 'thread_id', type: 'uuid' },
  { name: 'patient_id', type: 'uuid' },
  { name: 'therapist_id', type: 'uuid' },
]);
`,
      },
    ];
    expect(validatePlateDtoColumns(dtos, migrations)).toEqual([]);
  });

  it("flags a DTO field that has no backing column", () => {
    const dtos = [
      {
        path: "packages/dtos/src/back/peer-chat/list-threads.response.dto.ts",
        contents: `
export class ThreadDto {
  threadId: string;
  lastMessagePreview: string | null;
}
`,
      },
    ];
    const migrations = [
      {
        path: "packages/postgres/src/migrations/1772100000000-create-peer-chat-tables.ts",
        contents: `
await DatabaseCreateTable(queryRunner, 'threads', [
  { name: 'thread_id', type: 'uuid' },
]);
`,
      },
    ];
    const findings = validatePlateDtoColumns(dtos, migrations);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fieldName).toBe("lastMessagePreview");
    expect(findings[0]!.dtoLine).toBe(4);
    expect(findings[0]!.action).toBe("flagged");
    expect(findings[0]!.message).toMatch(/lastMessagePreview/);
    expect(findings[0]!.message).toMatch(/computed/);
  });

  it("accepts a field tagged with a `// computed:` comment", () => {
    const dtos = [
      {
        path: "packages/dtos/src/back/peer-chat/list-threads.response.dto.ts",
        contents: `
export class ThreadDto {
  threadId: string;
  // computed: SUBQUERY against messages.body ORDER BY sent_at DESC LIMIT 1
  lastMessagePreview: string | null;
}
`,
      },
    ];
    const migrations = [
      {
        path: "packages/postgres/src/migrations/1772100000000-create-peer-chat-tables.ts",
        contents: `
await DatabaseCreateTable(queryRunner, 'threads', [
  { name: 'thread_id', type: 'uuid' },
]);
`,
      },
    ];
    expect(validatePlateDtoColumns(dtos, migrations)).toEqual([]);
  });

  it("also accepts a field tagged with `// @computed`", () => {
    const dtos = [
      {
        path: "x.dto.ts",
        contents: `
export class X {
  // @computed
  derived: number;
}
`,
      },
    ];
    expect(validatePlateDtoColumns(dtos, [])).toEqual([]);
  });

  it("skips standard primary-key / audit columns (id, createdAt, etc.)", () => {
    const dtos = [
      {
        path: "x.dto.ts",
        contents: `
export class X {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  payload: string;
}
`,
      },
    ];
    const migrations = [
      {
        path: "m.ts",
        contents: `await x.addColumn('x', { name: 'payload' });`,
      },
    ];
    expect(validatePlateDtoColumns(dtos, migrations)).toEqual([]);
  });

  it("matches camelCase DTO fields against snake_case migration columns", () => {
    const dtos = [
      {
        path: "x.dto.ts",
        contents: `
export class X {
  unreadCountForPatient: number;
}
`,
      },
    ];
    const migrations = [
      {
        path: "m.ts",
        contents: `addColumn('threads', { name: 'unread_count_for_patient' })`,
      },
    ];
    expect(validatePlateDtoColumns(dtos, migrations)).toEqual([]);
  });

  it("flags multiple drift fields across multiple DTOs", () => {
    const dtos = [
      {
        path: "a.dto.ts",
        contents: `
export class A {
  foo: string;
  bar: string;
}
`,
      },
      {
        path: "b.dto.ts",
        contents: `
export class B {
  baz: string;
  qux: string;
}
`,
      },
    ];
    const migrations = [
      {
        path: "m.ts",
        contents: `name: 'foo', name: 'baz'`,
      },
    ];
    const findings = validatePlateDtoColumns(dtos, migrations);
    expect(findings.map((f) => f.fieldName).sort()).toEqual(["bar", "qux"]);
  });

  it("does NOT flag jsdoc-commented fields without computed marker", () => {
    // A vanilla jsdoc shouldn't count as a `// computed:` opt-out.
    const dtos = [
      {
        path: "x.dto.ts",
        contents: `
export class X {
  /** Just some description */
  driftedField: string;
}
`,
      },
    ];
    const findings = validatePlateDtoColumns(dtos, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fieldName).toBe("driftedField");
  });

  it("computed marker is consumed once (doesn't shadow the next field)", () => {
    const dtos = [
      {
        path: "x.dto.ts",
        contents: `
export class X {
  // computed: from JOIN
  firstDrift: string;
  secondDrift: string;
}
`,
      },
    ];
    const findings = validatePlateDtoColumns(dtos, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fieldName).toBe("secondDrift");
  });
});
