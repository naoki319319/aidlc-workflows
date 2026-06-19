// reporting-collector.test.ts — mirrors reporting/tests/test_collector.py 1:1.
// Builds a minimal run folder with all six YAML artifacts and asserts the parse.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dumpYaml, pyFloat } from "./yaml.ts";
import { collect } from "./reporting-collector.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "collector-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(path: string, data: unknown): void {
  writeFileSync(path, dumpYaml(data));
}

// test_collector.py:15-178 _minimal_run
function minimalRun(): string {
  const run = join(tmp, "run-001");
  mkdirSync(run, { recursive: true });

  write(join(run, "run-meta.yaml"), {
    run_folder: run,
    started_at: "2026-02-18T12:00:00Z",
    completed_at: "2026-02-18T13:00:00Z",
    status: "Status.COMPLETED",
    execution_time_ms: 3600000,
    total_handoffs: 3,
    node_history: ["executor", "simulator", "executor"],
    config: {
      executor_model: "claude-opus",
      simulator_model: "claude-sonnet",
      aws_region: "us-west-2",
    },
  });

  write(join(run, "run-metrics.yaml"), {
    tokens: {
      total: { input_tokens: 1000000, output_tokens: 50000, total_tokens: 1050000 },
      per_agent: {
        executor: { input_tokens: 800000, output_tokens: 40000, total_tokens: 840000 },
        simulator: { input_tokens: 200000, output_tokens: 10000, total_tokens: 210000 },
      },
    },
    timing: {
      total_wall_clock_ms: 3600000,
      handoffs: [
        { handoff: 1, node_id: "executor", duration_ms: 2000000 },
        { handoff: 2, node_id: "simulator", duration_ms: 600000 },
        { handoff: 3, node_id: "executor", duration_ms: 1000000 },
      ],
    },
    artifacts: {
      workspace: { source_files: 10, test_files: 5, config_files: 2, total_files: 17, total_lines_of_code: 1500 },
      aidlc_docs: { inception_files: 8, construction_files: 5, total_files: 13 },
    },
    errors: { throttle_events: 0, timeout_events: 0 },
  });

  write(join(run, "test-results.yaml"), {
    status: "completed",
    install: { success: true },
    test: {
      success: true,
      output: "Total coverage: 91.3%\n192 passed in 0.87s",
      parsed_results: { passed: 192, failed: 0, errors: 0, total: 192 },
    },
  });

  write(join(run, "quality-report.yaml"), {
    project_type: "python",
    lint: {
      tool: "ruff",
      version: "0.15.1",
      available: true,
      findings: [
        { file: "app.py", line: 3, code: "I001", message: "Unsorted imports", severity: "warning" },
        { file: "routes.py", line: 65, code: "E501", message: "Line too long", severity: "error" },
      ],
    },
    security: { tool: "bandit", available: false },
    summary: { lint_total: 2, lint_errors: 1, lint_warnings: 1 },
  });

  write(join(run, "contract-test-results.yaml"), {
    total: 10,
    passed: 9,
    failed: 1,
    errors: 0,
    server_started: true,
    cases: [
      { name: "health", path: "/health", method: "GET", passed: true, expected_status: 200, actual_status: 200, latency_ms: pyFloat(5.2) },
      { name: "add", path: "/api/v1/arithmetic/add", method: "POST", passed: false, expected_status: 200, actual_status: 500, failures: ["status mismatch"] },
    ],
  });

  write(join(run, "qualitative-comparison.yaml"), {
    overall_score: pyFloat(0.89),
    phases: [
      {
        phase: "inception",
        avg_intent: pyFloat(0.95),
        avg_design: pyFloat(0.9),
        avg_completeness: pyFloat(0.85),
        avg_overall: pyFloat(0.9),
        documents: [
          {
            path: "inception/component-dependency.md",
            intent_similarity: pyFloat(0.95),
            design_similarity: pyFloat(0.9),
            completeness: pyFloat(0.85),
            overall: pyFloat(0.9),
            notes: "Good alignment overall.",
          },
        ],
      },
    ],
  });

  return run;
}

test("test_collect_all_artifacts", () => {
  const run = minimalRun();
  const data = collect(run);

  expect(data.meta.status).toBe("Status.COMPLETED");
  expect(data.meta.executor_model).toBe("claude-opus");
  expect(data.meta.total_handoffs).toBe(3);

  expect(data.metrics.total_tokens.total_tokens).toBe(1050000);
  expect(data.metrics.wall_clock_ms).toBe(3600000);
  expect(data.metrics.handoffs.length).toBe(3);
  expect(data.metrics.artifacts.source_files).toBe(10);

  expect(data.tests).not.toBeNull();
  expect(data.tests!.passed).toBe(192);
  expect(data.tests!.test_ok).toBe(true);
  expect(data.tests!.coverage_pct).toBe(91.3);

  expect(data.quality).not.toBeNull();
  expect(data.quality!.lint_total).toBe(2);
  expect(data.quality!.lint_errors).toBe(1);

  expect(data.contracts).not.toBeNull();
  expect(data.contracts!.passed).toBe(9);
  expect(data.contracts!.failed).toBe(1);

  expect(data.qualitative).not.toBeNull();
  expect(data.qualitative!.overall_score).toBe(0.89);
  expect(data.qualitative!.phases.length).toBe(1);
  expect(data.qualitative!.phases[0]!.documents[0]!.intent).toBe(0.95);
});

test("test_collect_missing_artifacts", () => {
  const run = join(tmp, "empty-run");
  mkdirSync(run, { recursive: true });
  const data = collect(run);

  expect(data.meta.status).toBe("");
  expect(data.tests).toBeNull();
  expect(data.quality).toBeNull();
  expect(data.contracts).toBeNull();
  expect(data.qualitative).toBeNull();
});

// test_collect_real_run (collector.py:225-242) — ⏭FIXTURE: self-skips when the
// real run folder is absent (it is not shipped in the spike).
test("test_collect_real_run", () => {
  // Repo-relative: tests/harness/eval/ → 3 up → repo root → the read-only Python
  // evaluator worktree (gitignored + machine-local), so this self-skips when absent.
  const realRun = join(
    dirname(dirname(dirname(import.meta.dir))),
    ".claude/worktrees/v2-inspect/evaluator",
    "runs",
    "20260218T125810-b84d042dff254a72b4ffec926fe5ea99",
  );
  if (!existsSync(realRun)) return; // fixture absent → skip
  const data = collect(realRun);
  expect(data.meta.total_handoffs).toBe(3);
  expect(data.tests).not.toBeNull();
  expect(data.tests!.passed).toBe(192);
  expect(data.contracts).not.toBeNull();
  expect(data.contracts!.passed).toBe(88);
  expect(data.qualitative).not.toBeNull();
  expect(data.qualitative!.overall_score).toBeGreaterThan(0.8);
});
