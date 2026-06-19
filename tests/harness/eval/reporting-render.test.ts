// reporting-render.test.ts — mirrors reporting/tests/test_render.py 1:1 (the
// TestMarkdown 6 + TestHTML 8 cases) PLUS the 3 TestReportIntegration tests from
// reporting/tests/test_baseline.py (test_markdown_includes_comparison,
// test_html_includes_comparison, test_no_comparison_when_absent) — those exercise
// the renderers, so they live here. _sample_data() mirrors test_render.py:23-124
// and _makeReportData() mirrors test_baseline.py:27-66.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown, writeMarkdown } from "./render-md.ts";
import { renderHtml, writeHtml } from "./render-html.ts";
import { compare, extractBaseline } from "./baseline.ts";
import type {
  Artifacts,
  ContractCase,
  ContractResults,
  DocScore,
  HandoffTiming,
  LintFinding,
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

// ── dataclass factories (mirror collector.py field order + defaults) ──────────

function tokenUsage(input = 0, output = 0, total = 0): TokenUsage {
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

function runMeta(o: Partial<RunMeta> = {}): RunMeta {
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
    ...o,
  };
}

function handoffTiming(handoff: number, node_id: string, duration_ms: number): HandoffTiming {
  return { handoff, node_id, duration_ms };
}

// Artifacts(source_files, test_files, config_files, total_files,
//           total_lines_of_code, inception_files, construction_files, total_doc_files)
function artifacts(
  source_files = 0,
  test_files = 0,
  config_files = 0,
  total_files = 0,
  total_lines_of_code = 0,
  inception_files = 0,
  construction_files = 0,
  total_doc_files = 0,
): Artifacts {
  return {
    source_files,
    test_files,
    config_files,
    total_files,
    total_lines_of_code,
    inception_files,
    construction_files,
    total_doc_files,
  };
}

function runMetrics(o: Partial<RunMetrics> = {}): RunMetrics {
  return {
    total_tokens: tokenUsage(),
    executor_tokens: tokenUsage(),
    simulator_tokens: tokenUsage(),
    repeated_context_tokens: tokenUsage(),
    api_total_tokens: tokenUsage(),
    wall_clock_ms: 0,
    handoffs: [],
    artifacts: artifacts(),
    errors: {},
    context_size_total: null,
    context_size_executor: null,
    context_size_simulator: null,
    ...o,
  };
}

function testResults(o: Partial<TestResults> = {}): TestResults {
  return {
    status: "",
    install_ok: false,
    test_ok: false,
    passed: 0,
    failed: 0,
    errors: 0,
    total: 0,
    pass_pct: 0.0,
    coverage_pct: null,
    ...o,
  };
}

// LintFinding(file, line, code, message, severity)
function lintFinding(file: string, line: number, code: string, message: string, severity: string): LintFinding {
  return { file, line, code, message, severity };
}

function qualityReport(o: Partial<QualityReport> = {}): QualityReport {
  return {
    project_type: "",
    lint_tool: "",
    lint_version: "",
    lint_available: false,
    lint_findings: [],
    lint_total: 0,
    lint_errors: 0,
    lint_warnings: 0,
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
    ...o,
  };
}

// ContractCase(name, path, method, passed, expected_status, actual_status,
//              failures=[], latency_ms=None, error=None)
function contractCase(
  name: string,
  path: string,
  method: string,
  passed: boolean,
  expected_status: number,
  actual_status: number | null,
  o: { failures?: string[]; latency_ms?: number | null; error?: string | null } = {},
): ContractCase {
  return {
    name,
    path,
    method,
    passed,
    expected_status,
    actual_status,
    failures: o.failures ?? [],
    latency_ms: o.latency_ms ?? null,
    error: o.error ?? null,
  };
}

function contractResults(o: Partial<ContractResults> = {}): ContractResults {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    server_started: false,
    server_error: null,
    cases: [],
    ...o,
  };
}

// DocScore(path, intent, design, completeness, overall, notes="")
function docScore(
  path: string,
  intent: number,
  design: number,
  completeness: number,
  overall: number,
  notes = "",
): DocScore {
  return { path, intent, design, completeness, overall, notes };
}

// PhaseScore(phase, avg_intent, avg_design, avg_completeness, avg_overall, documents=[])
function phaseScore(
  phase: string,
  avg_intent = 0,
  avg_design = 0,
  avg_completeness = 0,
  avg_overall = 0,
  documents: DocScore[] = [],
): PhaseScore {
  return { phase, avg_intent, avg_design, avg_completeness, avg_overall, documents };
}

function qualitativeResults(o: Partial<QualitativeResults> = {}): QualitativeResults {
  return {
    overall_score: 0,
    phases: [],
    unmatched_reference: [],
    unmatched_candidate: [],
    ...o,
  };
}

function reportData(o: Partial<ReportData> = {}): ReportData {
  return {
    meta: runMeta(),
    metrics: runMetrics(),
    tests: null,
    quality: null,
    contracts: null,
    qualitative: null,
    comparison: null,
    generated_at: "",
    ...o,
  };
}

// Full BaselineMetrics with all-default fields; pass overrides to mirror Python's
// BaselineMetrics(field=...) keyword construction (test_baseline.py:135-205).
function baselineMetrics(o: Partial<BaselineMetrics> = {}): BaselineMetrics {
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
    tests_pass_pct: 0,
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
    qualitative_score: 0,
    inception_score: 0,
    construction_score: 0,
    ...o,
  };
}

// ── _sample_data() — mirrors test_render.py:23-124 ───────────────────────────
function sampleData(): ReportData {
  return reportData({
    meta: runMeta({
      run_folder: "runs/20260218T125810-test",
      started_at: "2026-02-18T12:58:13Z",
      completed_at: "2026-02-18T13:22:44Z",
      status: "Status.COMPLETED",
      execution_time_ms: 1445460,
      total_handoffs: 3,
      node_history: ["executor", "simulator", "executor"],
      executor_model: "claude-opus-4-6-v1",
      simulator_model: "claude-sonnet-4-5",
      aws_region: "us-west-2",
    }),
    metrics: runMetrics({
      total_tokens: tokenUsage(9695968, 139967, 9835935),
      executor_tokens: tokenUsage(5671179, 76651, 5747830),
      simulator_tokens: tokenUsage(179972, 2412, 182384),
      wall_clock_ms: 1445460,
      handoffs: [
        handoffTiming(1, "executor", 975455),
        handoffTiming(2, "simulator", 67876),
        handoffTiming(3, "executor", 402145),
      ],
      artifacts: artifacts(17, 18, 4, 72, 3522, 8, 5, 15),
    }),
    tests: testResults({
      status: "completed",
      install_ok: true,
      test_ok: true,
      passed: 192,
      failed: 0,
      errors: 0,
      total: 192,
      coverage_pct: 91.3,
    }),
    quality: qualityReport({
      project_type: "python",
      lint_tool: "ruff",
      lint_version: "0.15.1",
      lint_available: true,
      lint_findings: [
        lintFinding("app.py", 3, "I001", "Unsorted imports", "warning"),
        lintFinding("routes.py", 65, "E501", "Line too long", "error"),
      ],
      lint_total: 2,
      lint_errors: 1,
      lint_warnings: 1,
    }),
    contracts: contractResults({
      total: 88,
      passed: 88,
      failed: 0,
      errors: 0,
      server_started: true,
      cases: [
        contractCase("health", "/health", "GET", true, 200, 200, { latency_ms: 4.5 }),
        contractCase("add positive", "/api/v1/arithmetic/add", "POST", true, 200, 200, { latency_ms: 8.1 }),
      ],
    }),
    qualitative: qualitativeResults({
      overall_score: 0.891,
      phases: [
        phaseScore("inception", 0.9, 0.8875, 0.875, 0.89, [
          docScore("inception/component-dependency.md", 1.0, 0.95, 0.9, 0.96, "Highly aligned."),
          docScore("inception/component-methods.md", 1.0, 0.95, 0.85, 0.95, "Same methods."),
        ]),
        phaseScore("construction", 0.88, 0.87, 0.86, 0.87, [
          docScore("construction/test-plan.md", 0.9, 0.85, 0.8, 0.85, "Good coverage."),
        ]),
      ],
    }),
    generated_at: "2026-02-18T14:00:00Z",
  });
}

// ── _make_report_data() — mirrors test_baseline.py:27-66 ──────────────────────
function makeReportData(): ReportData {
  return reportData({
    meta: runMeta({
      run_folder: "runs/test-run-001",
      executor_model: "claude-opus",
      simulator_model: "claude-sonnet",
      total_handoffs: 3,
    }),
    metrics: runMetrics({
      total_tokens: tokenUsage(1000000, 50000, 1050000),
      wall_clock_ms: 600000,
      artifacts: artifacts(10, 5, 0, 20, 2000, 0, 0, 12),
    }),
    tests: testResults({
      status: "completed",
      install_ok: true,
      test_ok: true,
      passed: 100,
      failed: 2,
      total: 102,
      coverage_pct: 88.5,
    }),
    contracts: contractResults({ total: 50, passed: 48, failed: 2 }),
    quality: qualityReport({ lint_errors: 3, lint_warnings: 7, lint_total: 10 }),
    qualitative: qualitativeResults({
      overall_score: 0.85,
      phases: [phaseScore("inception", 0, 0, 0, 0.88), phaseScore("construction", 0, 0, 0, 0.82)],
    }),
  });
}

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "render-test-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ── TestMarkdown (test_render.py:126-159) ─────────────────────────────────────
describe("TestMarkdown", () => {
  test("test_contains_header", () => {
    const md = renderMarkdown(sampleData());
    expect(md).toContain("# AIDLC Evaluation Report");
  });

  test("test_contains_verdict_table", () => {
    const md = renderMarkdown(sampleData());
    expect(md).toContain("## Verdict");
    expect(md).toContain("192/192");
    expect(md).toContain("88/88");
  });

  test("test_contains_token_usage", () => {
    const md = renderMarkdown(sampleData());
    expect(md).toContain("## Token Usage");
    expect(md).toContain("Executor");
  });

  test("test_contains_qualitative_score", () => {
    const md = renderMarkdown(sampleData());
    expect(md).toContain("0.891");
    expect(md).toContain("Inception");
  });

  test("test_contains_lint_findings", () => {
    const md = renderMarkdown(sampleData());
    expect(md).toContain("`E501`");
    expect(md).toContain("`I001`");
  });

  test("test_write_to_file", () => {
    const path = join(mkTmp(), "report.md");
    writeMarkdown(sampleData(), path);
    const text = readFileSync(path, "utf-8");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain("# AIDLC Evaluation Report");
  });
});

// ── TestHTML (test_render.py:162-206) ─────────────────────────────────────────
describe("TestHTML", () => {
  test("test_contains_doctype", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("test_contains_verdict_cards", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("192/192");
    expect(html).toContain("88/88");
    expect(html).toContain("badge-pass");
  });

  test("test_contains_score_ring", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("ring-container");
    expect(html).toContain("89%");
  });

  test("test_contains_handoff_timeline", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("Handoff Timeline");
    expect(html.toLowerCase()).toContain("executor");
  });

  test("test_contains_qualitative_bars", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("phase-bars");
    expect(html.toLowerCase()).toContain("inception");
  });

  test("test_contains_lint_findings", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("E501");
    expect(html).toContain("I001");
  });

  test("test_self_contained", () => {
    const html = renderHtml(sampleData());
    expect(html).toContain("<style>");
    expect(html).toContain("Inter");
  });

  test("test_write_to_file", () => {
    const path = join(mkTmp(), "report.html");
    writeHtml(sampleData(), path);
    const text = readFileSync(path, "utf-8");
    expect(text.length).toBeGreaterThan(2000);
    expect(text).toContain("<!DOCTYPE html>");
  });
});

// ── TestReportIntegration (test_baseline.py:230-272) ─────────────────────────
describe("TestReportIntegration", () => {
  test("test_markdown_includes_comparison", () => {
    const data = makeReportData();
    const golden = baselineMetrics({
      tests_passed: 90,
      tests_total: 100,
      lint_errors: 5,
      qualitative_score: 0.8,
    });
    const current = extractBaseline(data);
    data.comparison = compare(current, golden);

    const md = renderMarkdown(data);
    expect(md).toContain("Baseline Comparison");
    expect(md).toContain("Improved");
    expect(md).toContain("Regressed");
  });

  test("test_html_includes_comparison", () => {
    const data = makeReportData();
    const golden = baselineMetrics({
      tests_passed: 90,
      tests_total: 100,
      lint_errors: 5,
      qualitative_score: 0.8,
    });
    const current = extractBaseline(data);
    data.comparison = compare(current, golden);

    const html = renderHtml(data);
    expect(html).toContain("Baseline Comparison");
    expect(html).toContain("delta-improved");
    expect(html).toContain("delta-regressed");
  });

  test("test_no_comparison_when_absent", () => {
    const data = makeReportData();
    const md = renderMarkdown(data);
    expect(md).not.toContain("Baseline Comparison");
  });
});
