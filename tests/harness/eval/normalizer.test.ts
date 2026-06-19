// normalizer.test.ts — mirror of the cli-harness normalizer tests:
//   .claude/worktrees/v2-inspect/evaluator/packages/cli-harness/tests/test_normalizer.py
//
// The four Python tests (test_normalizer.py:14-95) verify the producer writes
// run-meta.yaml / run-metrics.yaml with the right field names + values. A fifth
// ROUND-TRIP test feeds a normalizeOutput()-written run folder straight into
// collect() (reporting-collector.ts) to prove the emitted key names survive the
// consumer — i.e. the producer/collector seam is field-compatible.
//
// pytest tmp_path → mkdtempSync; yaml.safe_load → Bun.YAML.parse. Temp dirs are
// removed in afterEach. generatedAt is injected ("" here) since Date is banned.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOutput } from "./normalizer.ts";
import { collect } from "./reporting-collector.ts";

const created: string[] = [];

// pytest tmp_path equivalent — a fresh temp dir per test, cleaned up afterEach.
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "aidlc-normalizer-"));
  created.push(d);
  return d;
}

// yaml.safe_load equivalent.
function loadYaml(path: string): Record<string, any> {
  return Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, any>;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// test_normalize_creates_run_meta (test_normalizer.py:14-27)
test("test_normalize_creates_run_meta", () => {
  const output = join(tmpPath(), "output");
  const workspace = join(output, "workspace");
  mkdirSync(workspace, { recursive: true });

  normalizeOutput(workspace, output, { adapterName: "test", elapsedSeconds: 120.5 });

  const meta = loadYaml(join(output, "run-meta.yaml"));
  expect(meta.status).toBe("completed");
  expect(meta.execution_time_ms).toBe(120500);
  expect(meta.config.executor_model).toBe("cli:test");
});

// test_normalize_creates_metrics_with_workspace (test_normalizer.py:30-46)
test("test_normalize_creates_metrics_with_workspace", () => {
  const output = join(tmpPath(), "output");
  const workspace = join(output, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "app.py"), "x = 1\ny = 2\n");
  mkdirSync(join(workspace, "tests"));
  writeFileSync(join(workspace, "tests", "test_app.py"), "def test_it(): pass");

  normalizeOutput(workspace, output, { adapterName: "test", elapsedSeconds: 60 });

  const metrics = loadYaml(join(output, "run-metrics.yaml"));
  expect(metrics.timing.total_wall_clock_ms).toBe(60000);
  expect(metrics.artifacts.workspace.source_files).toBe(1);
  expect(metrics.artifacts.workspace.test_files).toBe(1);
});

// test_normalize_counts_aidlc_docs (test_normalizer.py:49-65)
test("test_normalize_counts_aidlc_docs", () => {
  const output = join(tmpPath(), "output");
  const workspace = join(output, "workspace");
  mkdirSync(workspace, { recursive: true });
  // aidlc-docs already moved to output_dir by the adapter.
  mkdirSync(join(output, "aidlc-docs", "inception"), { recursive: true });
  writeFileSync(join(output, "aidlc-docs", "inception", "requirements.md"), "# Reqs");
  mkdirSync(join(output, "aidlc-docs", "construction"), { recursive: true });
  writeFileSync(join(output, "aidlc-docs", "construction", "plan.md"), "# Plan");

  normalizeOutput(workspace, output, { adapterName: "test" });

  const metrics = loadYaml(join(output, "run-metrics.yaml"));
  expect(metrics.artifacts.aidlc_docs.inception_files).toBe(1);
  expect(metrics.artifacts.aidlc_docs.construction_files).toBe(1);
  expect(metrics.artifacts.aidlc_docs.total_files).toBe(2);
});

// test_normalize_with_token_usage (test_normalizer.py:68-94)
test("test_normalize_with_token_usage", () => {
  const output = join(tmpPath(), "output");
  const workspace = join(output, "workspace");
  mkdirSync(workspace, { recursive: true });

  const tokenUsage = {
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    num_turns: 5,
    duration_api_ms: 50000,
    model: "test-model",
  };

  normalizeOutput(workspace, output, { adapterName: "test", elapsedSeconds: 60, tokenUsage });

  const metrics = loadYaml(join(output, "run-metrics.yaml"));
  expect(metrics.tokens.total.input_tokens).toBe(1000);
  expect(metrics.tokens.total.output_tokens).toBe(500);
  expect(metrics.tokens.per_agent.executor.total_tokens).toBe(1500);
  expect(metrics.handoff_patterns.per_agent.executor.turn_count).toBe(5);
  expect(metrics.model_params.executor.model_id).toBe("test-model");
});

// cost_usd is the ONE float-typed field (claude_code.py total_cost_usd) — a
// whole-dollar cost must render "2.0" not "2" (PyYAML float behaviour), matching
// python3 yaml.safe_dump({"cost_usd": 2.0}). pyFloat wrap (normalizer.ts).
test("cost_usd renders as a Python float (2.0, not 2) when integral", () => {
  const output = join(tmpPath(), "output");
  mkdirSync(join(output, "workspace"), { recursive: true });
  normalizeOutput(join(output, "workspace"), output, {
    adapterName: "test",
    tokenUsage: { total_cost_usd: 2 },
  });
  const raw = readFileSync(join(output, "run-metrics.yaml"), "utf-8");
  expect(raw).toContain("cost_usd: 2.0");
  expect(raw).not.toContain("cost_usd: 2\n");
});

// ── seam: producer → collector round-trip ────────────────────────────────────
// Build a run folder with normalizeOutput(), then collect() it and assert the
// fields survive — proving the emitted key names match what the collector reads
// (run-meta config.executor_model → meta.executor_model; run-metrics
// tokens.total.total_tokens → metrics.total_tokens.total_tokens;
// artifacts.workspace.source_files → metrics.artifacts.source_files).
describe("producer→collector seam", () => {
  test("normalizeOutput fields survive collect()", () => {
    const output = join(tmpPath(), "output");
    const workspace = join(output, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "app.py"), "x = 1\ny = 2\n");

    normalizeOutput(workspace, output, {
      adapterName: "test",
      elapsedSeconds: 60,
      tokenUsage: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        num_turns: 5,
        model: "test-model",
      },
      rulesSource: "git",
      rulesRepo: "example/rules",
      rulesRef: "main",
    });

    const report = collect(output);
    // run-meta config.executor_model → meta.executor_model (collector :277).
    expect(report.meta.executor_model).toBe("test-model (5 turns)");
    // Enrichment fold-in survives the seam (collector :280-282).
    expect(report.meta.rules_source).toBe("git");
    expect(report.meta.rules_repo).toBe("example/rules");
    expect(report.meta.rules_ref).toBe("main");
    // run-metrics tokens.total.total_tokens → metrics.total_tokens.total_tokens
    // (collector :318).
    expect(report.metrics.total_tokens.total_tokens).toBe(1500);
    // run-metrics artifacts.workspace.source_files → metrics.artifacts.source_files
    // (collector :343).
    expect(report.metrics.artifacts.source_files).toBe(1);
  });
});
