// t155-extension-delta: the Layer 2/3 extension-mechanism keystone.
//
// covers: file:scripts/package.ts, file:scripts/extension-types.ts
//
// WHAT. An extension (bundle) lives in extensions/<name>/ with an extension.ts
// manifest and core-shaped subtrees. The packager projects it as a COMMITTED
// DELTA under dist/<name>/extensions/<bundle>/ — the files a base+bundle build
// produces that are NEW or DIFFER vs the base build. The base trees stay
// byte-identical (so the 32-stage / 13-agent base pins are untouched), and the
// delta is byte-pinned by `package.ts --check`.
//
// This test asserts: (1) the committed ops-min delta exists and contains the
// bundle stage + recompiled graph; (2) the bundle stage is ABSENT from the base
// compiled graph (separation); (3) the base operation phase is still 7 stages;
// (4) `package.ts --check` is clean as committed; (5) a hand-edited delta byte is
// caught as DIFFERS. The fixture is extensions/ops-min/ (one operation stage,
// number 4.50, scope-gated enterprise, reuses aidlc-operations-agent).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const CHECK_TIMEOUT_MS = 60_000;

const CLAUDE_DELTA = join(REPO_ROOT, "dist", "claude", "extensions", "ops-min");
const CLAUDE_BASE_GRAPH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json");
const CLAUDE_BASE_OPS = join(REPO_ROOT, "dist", "claude", ".claude", "aidlc-common", "stages", "operation");
const DELTA_STAGE = join(CLAUDE_DELTA, ".claude", "aidlc-common", "stages", "operation", "ops-min-deploy.md");
const DELTA_GRAPH = join(CLAUDE_DELTA, ".claude", "tools", "data", "stage-graph.json");
const DELTA_SCOPE_GRID = join(CLAUDE_DELTA, ".claude", "tools", "data", "scope-grid.json");

describe("t155 extension delta — Layer 2/3", () => {
  test("the ops-min fixture is discoverable", () => {
    expect(existsSync(join(REPO_ROOT, "extensions", "ops-min", "extension.ts"))).toBe(true);
  });

  test("the committed claude delta carries the bundle stage + recompiled graph", () => {
    expect(existsSync(DELTA_STAGE)).toBe(true);
    expect(existsSync(DELTA_GRAPH)).toBe(true);
    const graph = JSON.parse(readFileSync(DELTA_GRAPH, "utf-8")) as Array<{ slug: string; bundle?: string }>;
    const row = graph.find((s) => s.slug === "ops-min-deploy");
    expect(row).toBeDefined();
    expect(row?.bundle).toBe("ops-min");
  });

  test("the bundle stage is ABSENT from the base graph (separation)", () => {
    const base = JSON.parse(readFileSync(CLAUDE_BASE_GRAPH, "utf-8")) as Array<{ slug: string }>;
    expect(base.some((s) => s.slug === "ops-min-deploy")).toBe(false);
  });

  test("the base operation phase is still exactly 7 stages", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const ops = readdirSync(CLAUDE_BASE_OPS).filter((f: string) => f.endsWith(".md"));
    expect(ops.length).toBe(7);
  });

  test("package.ts --check is clean as committed (base parity + delta byte-pin)", () => {
    const r = spawnSync("bun", [PACKAGE_TS, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: CHECK_TIMEOUT_MS,
    });
    expect(r.status).toBe(0);
  });

  test("--check catches a hand-edited delta byte (DIFFERS)", () => {
    const backup = mkdtempSync(join(tmpdir(), "t155-"));
    const saved = join(backup, "ops-min-deploy.md");
    cpSync(DELTA_STAGE, saved);
    try {
      writeFileSync(DELTA_STAGE, readFileSync(DELTA_STAGE, "utf-8") + "\n<!-- drift -->\n");
      const r = spawnSync("bun", [PACKAGE_TS, "claude", "--check"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: CHECK_TIMEOUT_MS,
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DIFFERS");
    } finally {
      cpSync(saved, DELTA_STAGE);
      rmSync(backup, { recursive: true, force: true });
    }
  });

  // Layer 4: ops-min-verify carries when:{producer-in-plan: ops-min-deploy-record}
  // and lists both enterprise + feature in scopes. ops-min-deploy (the producer)
  // is enterprise-only, so the predicate keeps verify EXECUTE under enterprise and
  // flips it to SKIP under feature — the headline producer-in-plan behavior.
  test("when:{producer-in-plan} gates ops-min-verify per scope", () => {
    const grid = JSON.parse(readFileSync(DELTA_SCOPE_GRID, "utf-8")) as Record<
      string,
      { stages: Record<string, "EXECUTE" | "SKIP"> }
    >;
    expect(grid.enterprise.stages["ops-min-verify"]).toBe("EXECUTE");
    expect(grid.feature.stages["ops-min-verify"]).toBe("SKIP");
    // sanity: the producer itself is enterprise-only.
    expect(grid.enterprise.stages["ops-min-deploy"]).toBe("EXECUTE");
    expect(grid.feature.stages["ops-min-deploy"]).toBe("SKIP");
  });
});
