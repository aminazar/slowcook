import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEntitiesDiagram, buildEntitiesArtifact } from "./index.js";
import { __testOnly__ } from "./emit-typeorm.js";

const { parseEntityFile, entitiesToMermaidErd } = __testOnly__;

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-emit-typeorm-"));
}

const PATIENT_ENTITY = `import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * TABLE-NAME: patients
 * TABLE-DESCRIPTION: Stores patient profile information
 * TABLE-IMPORTANT-CONSTRAINTS:
 *   - user_id is FK to users
 */
@Entity('patients')
export class Patient extends BaseEntity {
  /**
   * COLUMN-DESCRIPTION: Patient's date of birth
   */
  @Column({ type: 'date', name: 'birth_of_date', nullable: true })
  public birthOfDate: Date | null;

  @Column({ type: 'text', name: 'bio', nullable: true })
  public bio: string | null;

  @Column({ type: 'uuid', name: 'user_id' })
  public userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  public user: User;
}
`;

const USER_ENTITY = `import { Column, Entity, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Patient } from './patient.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ type: 'varchar', name: 'email' })
  public email: string;

  @OneToOne(() => Patient, (p) => p.user)
  public patient: Patient;
}
`;

describe("parseEntityFile", () => {
  it("extracts class + table + extends BaseEntity", () => {
    const e = parseEntityFile(PATIENT_ENTITY, "packages/postgres/src/entities/patient.entity.ts");
    expect(e).not.toBeNull();
    expect(e!.className).toBe("Patient");
    expect(e!.tableName).toBe("patients");
    expect(e!.extendsBaseEntity).toBe(true);
  });

  it("captures TABLE-DESCRIPTION from JSDoc above class", () => {
    const e = parseEntityFile(PATIENT_ENTITY, "x.ts");
    expect(e!.description).toBe("Stores patient profile information");
  });

  it("parses @Column properties with name, type, nullable", () => {
    const e = parseEntityFile(PATIENT_ENTITY, "x.ts");
    const birth = e!.columns.find((c) => c.property === "birthOfDate");
    expect(birth).toBeDefined();
    expect(birth!.columnName).toBe("birth_of_date");
    expect(birth!.columnType).toBe("date");
    expect(birth!.nullable).toBe(true);

    const userId = e!.columns.find((c) => c.property === "userId");
    expect(userId).toBeDefined();
    expect(userId!.columnName).toBe("user_id");
    expect(userId!.columnType).toBe("uuid");
    expect(userId!.nullable).toBeFalsy();
  });

  it("parses @ManyToOne relations with join column", () => {
    const e = parseEntityFile(PATIENT_ENTITY, "x.ts");
    const userRel = e!.relations.find((r) => r.property === "user");
    expect(userRel).toBeDefined();
    expect(userRel!.kind).toBe("ManyToOne");
    expect(userRel!.target).toBe("User");
    expect(userRel!.joinColumn).toBe("user_id");
  });

  it("parses @OneToOne relations", () => {
    const e = parseEntityFile(USER_ENTITY, "x.ts");
    const patientRel = e!.relations.find((r) => r.property === "patient");
    expect(patientRel).toBeDefined();
    expect(patientRel!.kind).toBe("OneToOne");
    expect(patientRel!.target).toBe("Patient");
  });

  it("returns null if no exported class", () => {
    expect(parseEntityFile("// just a comment", "x.ts")).toBeNull();
  });

  it("falls back to className-snake_case when @Entity has no string arg", () => {
    const src = `@Entity()
export class TherapistAvailabilitySlot extends BaseEntity {}
`;
    const e = parseEntityFile(src, "x.ts");
    expect(e!.tableName).toBe("therapist_availability_slot");
  });
});

describe("entitiesToMermaidErd", () => {
  it("renders an erDiagram block with relations + entity boxes", () => {
    const patient = parseEntityFile(PATIENT_ENTITY, "x.ts")!;
    const user = parseEntityFile(USER_ENTITY, "x.ts")!;
    const md = entitiesToMermaidErd([patient, user]);
    expect(md).toContain("erDiagram");
    expect(md).toContain("Patient }o--|| User");  // ManyToOne shape
    expect(md).toContain("User ||--o| Patient");  // OneToOne shape
    expect(md).toContain("Patient {");
    expect(md).toContain("User {");
  });

  it("skips relations whose target isn't a known entity", () => {
    const patient = parseEntityFile(PATIENT_ENTITY, "x.ts")!;
    // User is missing from the list — `user` relation should be skipped.
    const md = entitiesToMermaidErd([patient]);
    expect(md).not.toContain("}o--||");
    expect(md).toContain("Patient {");
  });

  it("handles empty input with an explanatory comment", () => {
    const md = entitiesToMermaidErd([]);
    expect(md).toContain("No @Entity decorators found");
  });
});

describe("emitEntitiesDiagram", () => {
  it("skips silently when no *.entity.ts files exist", () => {
    const repo = mkRepo();
    try {
      const r = emitEntitiesDiagram(repo);
      expect(r.written).toBe(false);
      expect(r.skippedReason).toContain("no `*.entity.ts`");
      expect(existsSync(join(repo, ".brewing/diagrams/entities.md"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes entities.md when @Entity decorators are found", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "packages/postgres/src/entities"), { recursive: true });
      writeFileSync(
        join(repo, "packages/postgres/src/entities/patient.entity.ts"),
        PATIENT_ENTITY,
        "utf8"
      );
      writeFileSync(
        join(repo, "packages/postgres/src/entities/user.entity.ts"),
        USER_ENTITY,
        "utf8"
      );
      const r = emitEntitiesDiagram(repo);
      expect(r.written).toBe(true);
      expect(r.entityCount).toBe(2);
      expect(r.relationCount).toBe(2);

      const out = readFileSync(join(repo, ".brewing/diagrams/entities.md"), "utf8");
      expect(out).toContain("Entity graph");
      expect(out).toContain("2 entities");
      expect(out).toContain("Patient");
      expect(out).toContain("User");
      expect(out).toContain("`patients`");
      expect(out).toContain("Stores patient profile information");
      // Convention header drawn from inspection
      expect(out).toContain("BaseEntity");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("excludes node_modules / dist / .next / coverage from the walk", () => {
    const repo = mkRepo();
    try {
      // Real entity in src/
      mkdirSync(join(repo, "src/entities"), { recursive: true });
      writeFileSync(join(repo, "src/entities/patient.entity.ts"), PATIENT_ENTITY, "utf8");

      // Fake entities in dirs that MUST be skipped
      for (const dir of ["node_modules", "dist", ".next", "coverage", "build"]) {
        mkdirSync(join(repo, dir, "src", "entities"), { recursive: true });
        writeFileSync(
          join(repo, dir, "src/entities/fake.entity.ts"),
          USER_ENTITY,
          "utf8"
        );
      }

      const r = emitEntitiesDiagram(repo);
      expect(r.written).toBe(true);
      expect(r.entityCount).toBe(1); // only patient.entity.ts
      expect(r.fileCount).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not include files that lack @Entity decorator (e.g. base.entity.ts abstract)", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/entities"), { recursive: true });
      // Abstract base — typed `.entity.ts` extension but no @Entity decorator
      writeFileSync(
        join(repo, "src/entities/base.entity.ts"),
        `export abstract class BaseEntity {
  id: string;
}
`,
        "utf8"
      );
      writeFileSync(
        join(repo, "src/entities/patient.entity.ts"),
        PATIENT_ENTITY,
        "utf8"
      );
      const r = buildEntitiesArtifact(repo);
      expect(r.written).toBe(true);
      expect(r.entityCount).toBe(1); // base.entity.ts not counted
      expect(r.fileCount).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
