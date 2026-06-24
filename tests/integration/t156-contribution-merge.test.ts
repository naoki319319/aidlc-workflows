// t156-contribution-merge: the §4 per-stage contribution seam keystone.
//
// covers: file:scripts/contribution-schema.ts, file:scripts/package.ts
//
// WHAT. A bundle additively MODIFIES an existing core stage via a contribution
// file (extensions/<bundle>/contributions/<phase>/<slug>.md) — adding
// produces/consumes/sensors/required_sections and appending prose fragments —
// WITHOUT editing the core stage. The packager's mergeContributions pass splices
// the contribution into the copied core stage in the bundle-variant temp tree
// before compile, so the merged stage .md + recompiled graph land in the bundle's
// committed delta. The base trees stay byte-identical (merge runs only in the
// variant build). The required-sections sensor machine-enforces contributed
// required_sections.
//
// This test asserts: (1) the contribution parser/validator behave; (2) the
// committed ops-min delta's nfr-requirements node has the unioned produces +
// required_sections; (3) the delta body has the contributed step; (4) the BASE
// nfr-requirements is unchanged (node + body); (5) package.ts --check is clean;
// (6) the required-sections sensor enforces the contributed section.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseContribution,
  validateContribution,
} from "../../scripts/contribution-schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const SENSOR = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-sensor-required-sections.ts");
const CHECK_TIMEOUT_MS = 60_000;

const DELTA = join(REPO_ROOT, "dist", "claude", "extensions", "ops-min", ".claude");
const DELTA_STAGE = join(DELTA, "aidlc-common", "stages", "construction", "nfr-requirements.md");
const DELTA_GRAPH = join(DELTA, "tools", "data", "stage-graph.json");
const BASE = join(REPO_ROOT, "dist", "claude", ".claude");
const BASE_STAGE = join(BASE, "aidlc-common", "stages", "construction", "nfr-requirements.md");
const BASE_GRAPH = join(BASE, "tools", "data", "stage-graph.json");

type Node = { slug: string; produces?: string[]; required_sections?: string[] };

describe("t156 §4 contribution seam", () => {
  test("contribution parses + validates (good)", () => {
    const raw = readFileSync(
      join(REPO_ROOT, "extensions", "ops-min", "contributions", "construction", "nfr-requirements.md"),
      "utf-8",
    );
    const c = parseContribution(raw);
    expect(c.target).toBe("nfr-requirements");
    expect(c.bundle).toBe("ops-min");
    expect(c.adds.produces).toContain("ops-min-operational-nfr-requirements");
    expect(c.adds.required_sections).toContain("Operational NFRs");
    expect(c.fragments.length).toBeGreaterThan(0);
    expect(validateContribution(c, { coreSlugs: new Set(["nfr-requirements"]), bundle: "ops-min" })).toEqual([]);
  });

  test("validator rejects bad cases", () => {
    const c = parseContribution(
      `---\ntarget: nfr-requirements\nbundle: ops-min\nadds:\n  produces:\n    - bad-no-prefix\nfragments:\n  - anchor: sideways\n    order: 1\n---\n`,
    );
    const errs = validateContribution(c, { coreSlugs: new Set(["nfr-requirements"]), bundle: "ops-min" });
    expect(errs.some((e) => e.includes('must be prefixed "ops-min-"'))).toBe(true);
    expect(errs.some((e) => e.includes("anchor"))).toBe(true);
    // unknown target
    const e2 = validateContribution(c, { coreSlugs: new Set(["other"]), bundle: "ops-min" });
    expect(e2.some((e) => e.includes("not a known core stage slug"))).toBe(true);
  });

  test("delta node has unioned produces + required_sections", () => {
    const graph = JSON.parse(readFileSync(DELTA_GRAPH, "utf-8")) as Node[];
    const n = graph.find((s) => s.slug === "nfr-requirements")!;
    expect(n.produces).toContain("ops-min-operational-nfr-requirements");
    // core artifacts still present (union, not replace)
    expect(n.produces).toContain("performance-requirements");
    expect(n.required_sections).toEqual(["Operational NFRs"]);
  });

  test("delta body has the contributed step spliced in", () => {
    const body = readFileSync(DELTA_STAGE, "utf-8");
    expect(body).toContain("### Step 6b (ops-min): Capture operational NFRs");
    // spliced after Step 6, before Step 7
    expect(body.indexOf("Step 6b (ops-min)")).toBeGreaterThan(body.indexOf("### Step 6:"));
    expect(body.indexOf("Step 6b (ops-min)")).toBeLessThan(body.indexOf("### Step 7:"));
  });

  test("BASE nfr-requirements is unchanged (byte-clean guardrail)", () => {
    const baseBody = readFileSync(BASE_STAGE, "utf-8");
    expect(baseBody).not.toContain("ops-min");
    expect(baseBody).not.toContain("required_sections");
    const graph = JSON.parse(readFileSync(BASE_GRAPH, "utf-8")) as Node[];
    const n = graph.find((s) => s.slug === "nfr-requirements")!;
    expect(n.produces).not.toContain("ops-min-operational-nfr-requirements");
    expect(n.required_sections ?? []).toEqual([]);
  });

  test("package.ts --check is clean (base parity + delta byte-pin)", () => {
    const r = spawnSync("bun", [PACKAGE_TS, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: CHECK_TIMEOUT_MS,
    });
    expect(r.status).toBe(0);
  });

  test("required-sections sensor enforces the contributed section", () => {
    const tmp = mkdtempSync(join(tmpdir(), "t156-"));
    try {
      // doc WITHOUT the section -> fail when required.
      const missing = join(tmp, "missing.md");
      writeFileSync(missing, "# D\n\n## Summary\n\nx\n\n## Other\n\ny\n");
      const rMiss = spawnSync("bun", [SENSOR, "--stage", "x", "--output-path", missing, "--required-sections", "Operational NFRs"], { encoding: "utf-8" });
      expect(JSON.parse(rMiss.stdout).pass).toBe(false);
      // doc WITH the section -> pass.
      const ok = join(tmp, "ok.md");
      writeFileSync(ok, "# D\n\n## Summary\n\nx\n\n## Operational NFRs\n\ny\n");
      const rOk = spawnSync("bun", [SENSOR, "--stage", "x", "--output-path", ok, "--required-sections", "Operational NFRs"], { encoding: "utf-8" });
      expect(JSON.parse(rOk.stdout).pass).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Workstream B (#5): the richer fragment anchors are accepted by the validator.
  test("richer anchors validate (after-questions, in:Compartment) and bad ones reject", () => {
    const mk = (anchor: string) =>
      parseContribution(
        `---\ntarget: nfr-requirements\nbundle: ops-min\nfragments:\n  - anchor: ${anchor}\n    order: 1\n---\n\n## fragment: ${anchor}\n\nbody\n`,
      );
    const ctx = { coreSlugs: new Set(["nfr-requirements"]), bundle: "ops-min" };
    for (const ok of ["after-questions", "in:Sensors", "in:Learn", "after-step:6", "before-step:2", "end-of-steps"]) {
      expect(validateContribution(mk(ok), ctx)).toEqual([]);
    }
    for (const bad of ["sideways", "in:", "after-step:x", "in:bad/name"]) {
      expect(validateContribution(mk(bad), ctx).some((e) => e.includes("anchor"))).toBe(true);
    }
  });
});
