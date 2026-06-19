// baseline.test.ts — ports reporting/tests/test_baseline.py.
//
// Mirrors the pure-logic baseline tests 1:1: TestExtractBaseline (2),
// TestWriteAndLoad (2), TestCompare (7), TestPromote (1), TestRealBaseline (1) =
// 13. The 3 TestReportIntegration cases (test_markdown/html_includes_comparison,
// test_no_comparison_when_absent) exercise render_md/render_html, which are
// SEPARATE port modules (render-md.ts / render-html.ts, not yet built) — they
// belong to those modules' obligations per the PORT-PLAN "Type-namespacing per
// Python package" rule, and this file may only touch baseline.ts. They are
// intentionally not duplicated here.
//
// Collector-backed fixtures build a reporting-collector ReportData (its OWN
// shapes, not the spike's). The Python test reads coverage_pct=88.5 from the
// TestResults it constructs directly; the round-trip + promote tests round-trip
// through Bun.YAML.parse to assert the nested golden.yaml shape.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  compare,
  compareRunToBaseline,
  extractBaseline,
  loadBaseline,
  promote,
  writeBaseline,
} from "./baseline.ts";
import { atomicYamlDump } from "./yaml.ts";
import type {
  Artifacts,
  ContractResults,
  PhaseScore,
  QualitativeResults,
  QualityReport,
  ReportData,
  RunMeta,
  RunMetrics,
  TestResults,
  TokenUsage,
} from "./reporting-collector.ts";
import type { BaselineMetrics } from "./types.ts";

// ── collector dataclass constructors (mirror collector.py field defaults) ────
function tok(input = 0, output = 0, total = 0): TokenUsage {
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

function emptyArtifacts(over: Partial<Artifacts> = {}): Artifacts {
  return {
    source_files: 0,
    test_files: 0,
    config_files: 0,
    total_files: 0,
    total_lines_of_code: 0,
    inception_files: 0,
    construction_files: 0,
    total_doc_files: 0,
    ...over,
  };
}

function makeMeta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    run_folder: "",
    started_at: "",
    completed_at: "",
    status: "",
    execution_time_ms: 0,
    total_handoffs: 0,
    node_history: [],
    executor_model: "",
    simulator_model: "",
    aws_region: "",
    rules_source: "",
    rules_repo: "",
    rules_ref: "",
    rules_local_path: "",
    vision_file: "",
    tech_env_file: "",
    ...over,
  };
}

function makeMetrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    total_tokens: tok(),
    executor_tokens: tok(),
    simulator_tokens: tok(),
    repeated_context_tokens: tok(),
    api_total_tokens: tok(),
    wall_clock_ms: 0,
    handoffs: [],
    artifacts: emptyArtifacts(),
    errors: {},
    context_size_total: null,
    context_size_executor: null,
    context_size_simulator: null,
    ...over,
  };
}

function makeReportData(over: Partial<ReportData> = {}): ReportData {
  return {
    meta: makeMeta(),
    metrics: makeMetrics(),
    tests: null,
    quality: null,
    contracts: null,
    qualitative: null,
    comparison: null,
    generated_at: "",
    ...over,
  };
}

// _make_report_data() — test_baseline.py:27-66.
function _makeReportData(): ReportData {
  const tests: TestResults = {
    status: "completed",
    install_ok: true,
    test_ok: true,
    passed: 100,
    failed: 2,
    errors: 0,
    total: 102,
    pass_pct: (100 / 102) * 100,
    coverage_pct: 88.5,
  };
  const contracts: ContractResults = {
    total: 50,
    passed: 48,
    failed: 2,
    errors: 0,
    server_started: false,
    server_error: null,
    cases: [],
  };
  // QualityReport(lint_errors=3, lint_warnings=7, lint_total=10) — the Python
  // dataclass leaves every other field at its default (0/"").
  const quality: QualityReport = {
    project_type: "",
    lint_tool: "",
    lint_version: "",
    lint_available: false,
    lint_findings: [],
    lint_total: 10,
    lint_errors: 3,
    lint_warnings: 7,
    security_tool: "",
    security_available: false,
    security_total: 0,
    security_high: 0,
    semgrep_tool: "",
    semgrep_available: false,
    semgrep_total: 0,
    semgrep_high: 0,
    duplication_tool: "",
    duplication_available: false,
    duplication_blocks: 0,
    duplication_lines: 0,
  };
  const phaseInception: PhaseScore = {
    phase: "inception",
    avg_intent: 0,
    avg_design: 0,
    avg_completeness: 0,
    avg_overall: 0.88,
    documents: [],
  };
  const phaseConstruction: PhaseScore = {
    phase: "construction",
    avg_intent: 0,
    avg_design: 0,
    avg_completeness: 0,
    avg_overall: 0.82,
    documents: [],
  };
  const qualitative: QualitativeResults = {
    overall_score: 0.85,
    phases: [phaseInception, phaseConstruction],
    unmatched_reference: [],
    unmatched_candidate: [],
  };

  return makeReportData({
    meta: makeMeta({
      run_folder: "runs/test-run-001",
      executor_model: "claude-opus",
      simulator_model: "claude-sonnet",
      total_handoffs: 3,
    }),
    metrics: makeMetrics({
      total_tokens: tok(1000000, 50000, 1050000),
      wall_clock_ms: 600000,
      artifacts: emptyArtifacts({
        source_files: 10,
        test_files: 5,
        total_files: 20,
        total_lines_of_code: 2000,
        total_doc_files: 12,
      }),
    }),
    tests,
    contracts,
    quality,
    qualitative,
  });
}

// A fully-zeroed BaselineMetrics carrying the dataclass defaults (baseline.py:
// 24-88) — coverage_pct defaults to None, everything else to 0/"". Tests pass
// overrides exactly as the Python BaselineMetrics(...) kwargs do.
function makeBaseline(over: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    run_folder: "",
    promoted_at: "",
    executor_model: "",
    simulator_model: "",
    wall_clock_ms: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    handoffs: 0,
    executor_input_tokens: 0,
    executor_output_tokens: 0,
    executor_total_tokens: 0,
    simulator_input_tokens: 0,
    simulator_output_tokens: 0,
    simulator_total_tokens: 0,
    repeated_context_input_tokens: 0,
    repeated_context_output_tokens: 0,
    repeated_context_total_tokens: 0,
    api_total_input_tokens: 0,
    api_total_output_tokens: 0,
    api_total_total_tokens: 0,
    context_size_max: 0,
    context_size_avg: 0,
    context_size_median: 0,
    source_files: 0,
    test_files: 0,
    total_files: 0,
    lines_of_code: 0,
    doc_files: 0,
    tests_passed: 0,
    tests_failed: 0,
    tests_total: 0,
    tests_pass_pct: 0.0,
    coverage_pct: null,
    contract_passed: 0,
    contract_failed: 0,
    contract_total: 0,
    lint_errors: 0,
    lint_warnings: 0,
    lint_total: 0,
    security_total: 0,
    security_high: 0,
    duplication_blocks: 0,
    qualitative_score: 0.0,
    inception_score: 0.0,
    construction_score: 0.0,
    ...over,
  };
}

// ── TestExtractBaseline (test_baseline.py:69-89) ─────────────────────────────
describe("TestExtractBaseline", () => {
  test("test_extracts_all_fields", () => {
    const data = _makeReportData();
    const b = extractBaseline(data);
    expect(b.run_folder).toBe("runs/test-run-001");
    expect(b.tests_passed).toBe(100);
    expect(b.tests_failed).toBe(2);
    expect(b.contract_passed).toBe(48);
    expect(b.lint_errors).toBe(3);
    expect(b.qualitative_score).toBe(0.85);
    expect(b.inception_score).toBe(0.88);
    expect(b.construction_score).toBe(0.82);
    expect(b.lines_of_code).toBe(2000);
    expect(b.total_tokens).toBe(1050000);
  });

  test("test_handles_missing_sections", () => {
    const data = makeReportData({ meta: makeMeta({ run_folder: "runs/empty" }) });
    const b = extractBaseline(data);
    expect(b.tests_passed).toBe(0);
    expect(b.contract_passed).toBe(0);
    expect(b.qualitative_score).toBe(0.0);
  });
});

// ── TestWriteAndLoad (test_baseline.py:92-132) ───────────────────────────────
describe("TestWriteAndLoad", () => {
  test("test_roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-roundtrip-"));
    try {
      const b = makeBaseline({
        run_folder: "runs/golden-run",
        promoted_at: "2026-02-18T12:00:00+00:00",
        executor_model: "claude-opus",
        tests_passed: 192,
        tests_total: 192,
        contract_passed: 88,
        contract_total: 88,
        lint_errors: 5,
        lint_warnings: 13,
        lint_total: 18,
        qualitative_score: 0.891,
        inception_score: 0.89,
        construction_score: 0.892,
        lines_of_code: 3522,
        total_tokens: 9835935,
      });
      const path = join(dir, "golden.yaml");
      writeBaseline(b, path);

      const doc = Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, any>;
      const loaded = loadBaseline(doc);
      expect(loaded.run_folder).toBe("runs/golden-run");
      expect(loaded.tests_passed).toBe(192);
      expect(loaded.contract_passed).toBe(88);
      expect(loaded.lint_errors).toBe(5);
      expect(loaded.qualitative_score).toBe(0.891);
      expect(loaded.inception_score).toBe(0.89);
      expect(loaded.lines_of_code).toBe(3522);
      expect(loaded.total_tokens).toBe(9835935);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("test_yaml_is_readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-readable-"));
    try {
      const b = makeBaseline({ run_folder: "runs/test", tests_passed: 10, tests_total: 10 });
      const path = join(dir, "golden.yaml");
      writeBaseline(b, path);

      const raw = Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, any>;
      expect(raw.unit_tests.passed).toBe(10);
      expect("qualitative" in raw).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── TestCompare (test_baseline.py:135-204) ───────────────────────────────────
describe("TestCompare", () => {
  test("test_identical_runs", () => {
    const a = makeBaseline({
      tests_passed: 100,
      tests_total: 100,
      contract_passed: 50,
      contract_total: 50,
      lint_errors: 0,
      qualitative_score: 0.9,
    });
    const result = compare(a, a);
    expect(result.improved).toBe(0);
    expect(result.regressed).toBe(0);
    // 29 + 2 new token metrics (repeated_context, api_total) = 31.
    expect(result.unchanged).toBe(31);
  });

  test("test_improved_tests", () => {
    const golden = makeBaseline({ tests_passed: 90, tests_total: 100, tests_pass_pct: 90.0 });
    const current = makeBaseline({ tests_passed: 95, tests_total: 100, tests_pass_pct: 95.0 });
    const result = compare(current, golden);
    const improved = result.deltas.filter((d) => d.name === "Tests Pass %");
    expect(improved.length).toBe(1);
    expect(improved[0]!.direction).toBe("improved");
    expect(improved[0]!.delta).toBe(5.0);
  });

  test("test_regressed_quality", () => {
    const golden = makeBaseline({ qualitative_score: 0.9 });
    const current = makeBaseline({ qualitative_score: 0.7 });
    const result = compare(current, golden);
    const qual = result.deltas.filter((d) => d.name === "Qualitative Score");
    expect(qual.length).toBe(1);
    expect(qual[0]!.direction).toBe("regressed");
    expect(result.regressed).toBeGreaterThanOrEqual(1);
  });

  test("test_fewer_lint_errors_is_improvement", () => {
    const golden = makeBaseline({ lint_errors: 10 });
    const current = makeBaseline({ lint_errors: 3 });
    const result = compare(current, golden);
    const lint = result.deltas.filter((d) => d.name === "Lint Errors");
    expect(lint[0]!.direction).toBe("improved");
  });

  test("test_more_lint_errors_is_regression", () => {
    const golden = makeBaseline({ lint_errors: 3 });
    const current = makeBaseline({ lint_errors: 10 });
    const result = compare(current, golden);
    const lint = result.deltas.filter((d) => d.name === "Lint Errors");
    expect(lint[0]!.direction).toBe("regressed");
  });

  test("test_fewer_tokens_is_improvement", () => {
    const golden = makeBaseline({ total_tokens: 10000000 });
    const current = makeBaseline({ total_tokens: 8000000 });
    const result = compare(current, golden);
    const tokDelta = result.deltas.filter((d) => d.name === "Total Tokens");
    expect(tokDelta[0]!.direction).toBe("improved");
  });

  test("test_mixed_results", () => {
    const golden = makeBaseline({
      tests_passed: 100,
      tests_total: 100,
      lint_errors: 5,
      qualitative_score: 0.85,
    });
    const current = makeBaseline({
      tests_passed: 105,
      tests_total: 105,
      lint_errors: 10,
      qualitative_score: 0.9,
    });
    const result = compare(current, golden);
    expect(result.improved).toBeGreaterThan(0);
    expect(result.regressed).toBeGreaterThan(0);
  });
});

// ── TestPromote (test_baseline.py:207-227) ───────────────────────────────────
describe("TestPromote", () => {
  test("test_promote_creates_file", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-promote-"));
    try {
      const run = join(dir, "run-001");
      mkdirSync(run, { recursive: true }); // Python: run.mkdir()
      // The Python test writes run-meta.yaml with run_folder/status/config; the
      // collector reads config.executor_model. Use atomicYamlDump so the file
      // round-trips through the same emitter the rest of the port uses.
      atomicYamlDump(
        {
          run_folder: run,
          status: "COMPLETED",
          config: { executor_model: "opus" },
        },
        join(run, "run-meta.yaml"),
      );

      const goldenPath = join(dir, "golden.yaml");
      const baseline = promote(run, goldenPath);
      expect(existsSync(goldenPath)).toBe(true);
      expect(baseline.executor_model).toBe("opus");

      const doc = Bun.YAML.parse(readFileSync(goldenPath, "utf-8")) as Record<string, any>;
      const loaded = loadBaseline(doc);
      expect(loaded.executor_model).toBe("opus");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── TestRealBaseline (test_baseline.py:275-286) — ⏭ self-skips if absent ──────
describe("TestRealBaseline", () => {
  test("test_load_real_golden", () => {
    // Python: Path(__file__).resolve().parents[3] / "test_cases" / "sci-calc-v2"
    // / "golden.yaml". This port reads the Python source-of-truth tree directly.
    // Repo-relative: tests/harness/eval/ → 3 up → repo root → the read-only Python
    // evaluator worktree. .claude/worktrees/ is gitignored + machine-local, so this
    // self-skips when absent (CI / another checkout), matching the Python early return.
    const path = join(
      dirname(dirname(dirname(import.meta.dir))),
      ".claude/worktrees/v2-inspect/evaluator/test_cases/sci-calc-v2/golden.yaml",
    );
    if (!existsSync(path)) return; // fixture absent → skip (matches Python early return)
    const doc = Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    const b = loadBaseline(doc);
    // Structural facts (medians may shift if the baseline is regenerated):
    expect(b.contract_passed).toBe(88);
    expect(b.contract_total).toBe(88);
    expect(b.tests_passed).toBe(b.tests_total); // 100% unit pass in conforming runs
    expect(b.qualitative_score).toBeGreaterThan(0.0);
    expect(b.qualitative_score).toBeLessThanOrEqual(1.0);
  });
});

// Touch compareRunToBaseline so the export is type-checked even though
// test_baseline.py has no direct unit for it (it is exercised through run.ts /
// the report integration path). A pure smoke: a run folder with no artifacts
// collects to a zeroed current, compares against a zeroed golden → all
// unchanged. This guards the collect→extract→loadBaseline→compare wiring
// (baseline.py:508-513) without needing live fixtures.
describe("compareRunToBaseline (wiring smoke)", () => {
  test("zeroed run vs zeroed golden → 31 unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-cmp-"));
    try {
      const run = join(dir, "run-empty");
      // No run-meta etc. → collector returns a fully-zeroed ReportData.
      atomicYamlDump(makeBaselineYamlDict(), join(dir, "golden.yaml"));
      const result = compareRunToBaseline(run, join(dir, "golden.yaml"));
      expect(result.improved).toBe(0);
      expect(result.regressed).toBe(0);
      expect(result.unchanged).toBe(31);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A zeroed golden.yaml nested dict (the inverse of loadBaseline) — coverage_pct
// is null so the compared "Coverage %" current(null) vs golden(null) classifies
// as "unchanged" (new only when golden is None AND current is set), matching the
// zeroed-current collector run.
function makeBaselineYamlDict(): Record<string, unknown> {
  return {
    run_folder: "",
    promoted_at: "",
    executor_model: "",
    simulator_model: "",
    execution: {
      wall_clock_ms: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      handoffs: 0,
      executor: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      simulator: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      repeated_context: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      api_total: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    context_size: { max_tokens: 0, avg_tokens: 0, median_tokens: 0 },
    artifacts: { source_files: 0, test_files: 0, total_files: 0, lines_of_code: 0, doc_files: 0 },
    // coverage_pct omitted → loadBaseline reads null (key absent), matching the
    // zeroed collector current (extractBaseline default coverage_pct = null).
    unit_tests: { passed: 0, failed: 0, total: 0, pass_pct: 0 },
    contract_tests: { passed: 0, failed: 0, total: 0 },
    code_quality: {
      lint_errors: 0,
      lint_warnings: 0,
      lint_total: 0,
      security_total: 0,
      security_high: 0,
      duplication_blocks: 0,
    },
    qualitative: { overall_score: 0, inception_score: 0, construction_score: 0 },
  };
}
