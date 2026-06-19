// shared-scenario.test.ts — focused smoke + synthetic tests for the scenario
// loader. No direct Python test file exists in the port-map for scenario.py, so
// these tests exercise the behaviours the Python source guarantees:
//
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/src/shared/scenario.py
//
//   - loadScenario over the REAL sci-calc-v2 fixture: name + resolved *_path
//     parity (self-skips if the fixture is absent).
//   - Synthetic tmp-dir scenarios for: field-default remapping, the 5 *_path
//     resolvers, listScenarios sort-by-DIR-name + non-dir/manifest-less skip +
//     malformed-skip, resolveScenario two-stage lookup, the draft warning in
//     BOTH branches, and the HARD-fail cases (missing scenario.yaml, missing
//     `name`).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadScenario,
  listScenarios,
  resolveScenario,
  Scenario,
  ScenarioFileNotFoundError,
  ScenarioValueError,
} from "./shared-scenario";

// Resolve the real fixture relative to the repo root (this file lives under
// tests/harness/eval/, three levels below the repo root).
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const FIXTURE_DIR = join(
  REPO_ROOT,
  ".claude/worktrees/v2-inspect/evaluator/test_cases/sci-calc-v2",
);
const FIXTURE_PRESENT =
  existsSync(join(FIXTURE_DIR, "scenario.yaml")) &&
  statSync(FIXTURE_DIR).isDirectory();

// ── console.warn capture (assert warn-only paths fire / stay silent) ──────────
let warnings: string[] = [];
const origWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});
afterEach(() => {
  console.warn = origWarn;
});
afterAll(() => {
  console.warn = origWarn;
});

// ── tmp scratch dirs ──────────────────────────────────────────────────────────
const scratchDirs: string[] = [];
function mkScratch(): string {
  const d = mkdtempSync(join(tmpdir(), "aidlc-scenario-"));
  scratchDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratchDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// Build a scenario directory with a manifest + optional companion files.
function makeScenarioDir(
  root: string,
  dirName: string,
  manifest: Record<string, unknown> | string | null,
  opts: { withVision?: boolean; withGoldenDocs?: boolean } = {},
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    const body =
      typeof manifest === "string"
        ? manifest
        : Object.entries(manifest)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n") + "\n";
    writeFileSync(join(dir, "scenario.yaml"), body, "utf-8");
  }
  if (opts.withVision) writeFileSync(join(dir, "vision.md"), "# Vision\n", "utf-8");
  if (opts.withGoldenDocs) mkdirSync(join(dir, "golden-aidlc-docs"), { recursive: true });
  return dir;
}

// ── REAL fixture smoke ────────────────────────────────────────────────────────
describe("loadScenario — real sci-calc-v2 fixture", () => {
  test.skipIf(!FIXTURE_PRESENT)("loads name + resolves paths", () => {
    const s = loadScenario(FIXTURE_DIR);
    expect(s.name).toBe("sci-calc-v2");
    expect(s.description).toBe("Scientific calculator — standard AIDLC benchmark");
    expect(s.status).toBe("active");
    expect(s.tags).toEqual(["standard", "benchmark"]);

    // path is resolved (absolute) — scenario.py:95.
    expect(s.path).toBe(resolve(FIXTURE_DIR));

    // Resolved *_path getters — scenario.py:39-57.
    expect(s.vision_path).toBe(join(s.path, "vision.md"));
    expect(s.tech_env_path).toBe(join(s.path, "tech-env.md"));
    expect(s.openapi_path).toBe(join(s.path, "openapi.yaml"));
    expect(s.golden_baseline_path).toBe(join(s.path, "golden.yaml"));
    // Trailing slash dropped (pathlib), even though the manifest value is
    // "golden-aidlc-docs/".
    expect(s.golden_aidlc_docs_path).toBe(join(s.path, "golden-aidlc-docs"));
    expect(s.golden_aidlc_docs_path.endsWith("/")).toBe(false);

    // The fixture ships vision.md + golden-aidlc-docs/ → no warn-only messages.
    expect(warnings).toEqual([]);
  });
});

// ── Scenario model defaults + path resolution ────────────────────────────────
describe("Scenario model", () => {
  test("defaults match the dataclass (scenario.py:24-36)", () => {
    const s = new Scenario({ name: "x" });
    expect(s.description).toBe("");
    expect(s.status).toBe("active");
    expect(s.path).toBe(".");
    expect(s.vision).toBe("vision.md");
    expect(s.tech_env).toBe("tech-env.md");
    expect(s.openapi).toBe("openapi.yaml");
    expect(s.golden_baseline).toBe("golden.yaml");
    expect(s.golden_aidlc_docs).toBe("golden-aidlc-docs/");
    expect(s.tags).toEqual([]);
  });

  test("each instance gets a fresh tags list (default_factory)", () => {
    const a = new Scenario({ name: "a" });
    const b = new Scenario({ name: "b" });
    a.tags.push("dirty");
    expect(b.tags).toEqual([]);
  });

  test("the 5 *_path resolvers join against path", () => {
    const s = new Scenario({ name: "x", path: "/abs/case" });
    expect(s.vision_path).toBe("/abs/case/vision.md");
    expect(s.tech_env_path).toBe("/abs/case/tech-env.md");
    expect(s.openapi_path).toBe("/abs/case/openapi.yaml");
    expect(s.golden_baseline_path).toBe("/abs/case/golden.yaml");
    expect(s.golden_aidlc_docs_path).toBe("/abs/case/golden-aidlc-docs");
  });

  test("path resolvers honour remapped filename fields", () => {
    const s = new Scenario({
      name: "x",
      path: "/abs/case",
      vision: "VISION.markdown",
      openapi: "spec/api.yaml",
      golden_aidlc_docs: "gold/",
    });
    expect(s.vision_path).toBe("/abs/case/VISION.markdown");
    expect(s.openapi_path).toBe("/abs/case/spec/api.yaml");
    expect(s.golden_aidlc_docs_path).toBe("/abs/case/gold");
  });
});

// ── loadScenario synthetic ──────────────────────────────────────────────────
describe("loadScenario — synthetic", () => {
  test("remaps overridable manifest keys (scenario.py:30-34,96-100)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "remap",
      {
        name: "remap-case",
        description: "remapped",
        status: "active",
        vision: "v.md",
        tech_env: "env.md",
        openapi: "api.yaml",
        golden_baseline: "base.yaml",
        golden_aidlc_docs: "docs/",
        tags: "[a, b]",
      },
      { withVision: false },
    );
    // Hand-write the tags as a real YAML list so Bun.YAML parses it.
    writeFileSync(
      join(dir, "scenario.yaml"),
      [
        "name: remap-case",
        "description: remapped",
        "vision: v.md",
        "tech_env: env.md",
        "openapi: api.yaml",
        "golden_baseline: base.yaml",
        "golden_aidlc_docs: docs/",
        "tags: [a, b]",
      ].join("\n") + "\n",
      "utf-8",
    );
    const s = loadScenario(dir);
    expect(s.name).toBe("remap-case");
    expect(s.vision).toBe("v.md");
    expect(s.tech_env).toBe("env.md");
    expect(s.openapi).toBe("api.yaml");
    expect(s.golden_baseline).toBe("base.yaml");
    expect(s.golden_aidlc_docs).toBe("docs/");
    expect(s.tags).toEqual(["a", "b"]);
    expect(s.vision_path).toBe(join(resolve(dir), "v.md"));
    expect(s.golden_aidlc_docs_path).toBe(join(resolve(dir), "docs"));
  });

  test("warns (no throw) when vision file is missing (scenario.py:106-107)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "no-vision",
      { name: "no-vision" },
      { withVision: false, withGoldenDocs: true },
    );
    const s = loadScenario(dir);
    expect(s.name).toBe("no-vision");
    expect(warnings.some((w) => w.includes("vision file missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("'no-vision'"))).toBe(true);
  });

  test("warns (no throw) when golden-aidlc-docs dir is missing (scenario.py:108-114)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "no-docs",
      { name: "no-docs" },
      { withVision: true, withGoldenDocs: false },
    );
    const s = loadScenario(dir);
    expect(s.name).toBe("no-docs");
    expect(
      warnings.some(
        (w) =>
          w.includes("golden aidlc-docs directory missing") &&
          w.includes("qualitative evaluation will fail"),
      ),
    ).toBe(true);
  });

  test("no warnings when both vision + golden-docs present", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "complete",
      { name: "complete" },
      { withVision: true, withGoldenDocs: true },
    );
    loadScenario(dir);
    expect(warnings).toEqual([]);
  });

  test("HARD-fails (throws) when scenario.yaml is absent (scenario.py:81-82)", () => {
    const root = mkScratch();
    const dir = join(root, "empty-dir");
    mkdirSync(dir, { recursive: true });
    expect(() => loadScenario(dir)).toThrow(ScenarioFileNotFoundError);
    expect(() => loadScenario(dir)).toThrow("scenario.yaml not found");
  });

  test("HARD-fails (throws) when 'name' key is missing (scenario.py:87-89)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(root, "no-name", { description: "orphan" });
    expect(() => loadScenario(dir)).toThrow(ScenarioValueError);
    expect(() => loadScenario(dir)).toThrow("missing 'name'");
  });

  test("HARD-fails when 'name' is empty (Python `not name`, scenario.py:88)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(root, "blank-name", `name: ""\n`);
    expect(() => loadScenario(dir)).toThrow(ScenarioValueError);
  });

  test("empty manifest document → {} → missing-name throw (scenario.py:85-89)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(root, "empty-doc", "");
    expect(() => loadScenario(dir)).toThrow(ScenarioValueError);
  });
});

// ── listScenarios synthetic ──────────────────────────────────────────────────
describe("listScenarios — synthetic", () => {
  test("returns [] for a non-existent test_cases dir (scenario.py:126-127)", () => {
    expect(listScenarios(join(mkScratch(), "does-not-exist"))).toEqual([]);
  });

  test("sorts by DIRECTORY name, not Scenario.name (scenario.py:129)", () => {
    const root = mkScratch();
    // Dir name 'alpha' carries Scenario.name 'zzz'; dir 'zebra' carries 'aaa'.
    // If sorting were by Scenario.name we'd get [aaa, zzz]; by DIR name → [zzz, aaa].
    makeScenarioDir(root, "alpha", { name: "zzz" }, { withVision: true, withGoldenDocs: true });
    makeScenarioDir(root, "zebra", { name: "aaa" }, { withVision: true, withGoldenDocs: true });
    const names = listScenarios(root).map((s) => s.name);
    expect(names).toEqual(["zzz", "aaa"]);
  });

  test("skips non-directory children and dirs without scenario.yaml", () => {
    const root = mkScratch();
    makeScenarioDir(root, "good", { name: "good" }, { withVision: true, withGoldenDocs: true });
    // a plain file (not a dir) — must be skipped (scenario.py:130-131)
    writeFileSync(join(root, "stray.txt"), "hi", "utf-8");
    // a dir with no manifest — must be skipped (scenario.py:132-133)
    mkdirSync(join(root, "no-manifest"), { recursive: true });
    const names = listScenarios(root).map((s) => s.name);
    expect(names).toEqual(["good"]);
  });

  test("warns-and-skips a malformed (missing-name) manifest (scenario.py:136-140)", () => {
    const root = mkScratch();
    makeScenarioDir(root, "aaa-good", { name: "good" }, { withVision: true, withGoldenDocs: true });
    makeScenarioDir(root, "bbb-bad", { description: "no name here" });
    const names = listScenarios(root).map((s) => s.name);
    // The malformed dir is skipped; only the valid one survives.
    expect(names).toEqual(["good"]);
  });
});

// ── resolveScenario synthetic ────────────────────────────────────────────────
describe("resolveScenario — synthetic", () => {
  test("stage 1: resolves an existing directory path directly (scenario.py:173)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "direct",
      { name: "direct-case" },
      { withVision: true, withGoldenDocs: true },
    );
    const s = resolveScenario(dir, join(root, "other-cases"));
    expect(s.name).toBe("direct-case");
  });

  test("stage 2: resolves a short name under test_cases_dir (scenario.py:184-185)", () => {
    const root = mkScratch();
    makeScenarioDir(
      root,
      "by-name-case",
      { name: "by-name-scenario" },
      { withVision: true, withGoldenDocs: true },
    );
    const s = resolveScenario("by-name-case", root);
    expect(s.name).toBe("by-name-scenario");
  });

  test("draft warning fires in the DIRECT-path branch (scenario.py:175-180)", () => {
    const root = mkScratch();
    const dir = makeScenarioDir(
      root,
      "draft-direct",
      { name: "draft-d", status: "draft" },
      { withVision: true, withGoldenDocs: true },
    );
    resolveScenario(dir, join(root, "nope"));
    expect(warnings.some((w) => w.includes("marked as draft"))).toBe(true);
    expect(warnings.some((w) => w.includes("'draft-d'"))).toBe(true);
  });

  test("draft warning fires in the BY-NAME branch (scenario.py:187-193)", () => {
    const root = mkScratch();
    makeScenarioDir(
      root,
      "draft-named",
      { name: "draft-n", status: "draft" },
      { withVision: true, withGoldenDocs: true },
    );
    resolveScenario("draft-named", root);
    expect(warnings.some((w) => w.includes("marked as draft"))).toBe(true);
    expect(warnings.some((w) => w.includes("'draft-n'"))).toBe(true);
  });

  test("no draft warning for an active scenario", () => {
    const root = mkScratch();
    makeScenarioDir(
      root,
      "active-case",
      { name: "active-s", status: "active" },
      { withVision: true, withGoldenDocs: true },
    );
    resolveScenario("active-case", root);
    expect(warnings.some((w) => w.includes("marked as draft"))).toBe(false);
  });

  test("throws with the available-scenario list when unresolved (scenario.py:195-200)", () => {
    const root = mkScratch();
    makeScenarioDir(root, "exists", { name: "exists-s" }, { withVision: true, withGoldenDocs: true });
    let err: unknown;
    try {
      resolveScenario("ghost", root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScenarioFileNotFoundError);
    const msg = (err as Error).message;
    expect(msg).toContain("Scenario 'ghost' not found");
    expect(msg).toContain("Available scenarios:");
    expect(msg).toContain("exists-s");
  });
});
