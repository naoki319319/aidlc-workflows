// reporting-collector.ts — read a run folder's six YAML artifacts into a unified
// ReportData. Ports reporting/collector.py:1-451 (the keystone of the reporting
// cluster — baseline.ts, render-md.ts, render-html.ts all consume these shapes).
//
// This module CLOSES gaps G3 + G7: evaluate-only/compare can now read a real
// run's run-metrics.yaml (token/wall-clock/handoff numbers) instead of zeros, so
// lower-is-better execution-cost metrics stop false-positively reading "improved".
//
// Types are DELIBERATELY collector's own shapes (not the spike's stage
// interfaces): collector's QualityReport is FLATTENED (lint_total/security_total/…
// vs the stage's nested ToolResult+summary); its DocScore uses `path` not
// `relative_path`; its ContractCase/CaseResult omit `skipped`; its LintFinding
// omits `column`. Reusing the stage types would break the renderers'
// field-access. See PORT-PLAN "Type-namespacing per Python package".

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

// ── dataclasses (collector.py:13-197) ──────────────────────────────────────
export interface RunMeta {
  run_folder: string;
  started_at: string;
  completed_at: string;
  status: string;
  execution_time_ms: number;
  total_handoffs: number;
  node_history: string[];
  executor_model: string;
  simulator_model: string;
  aws_region: string;
  rules_source: string;
  rules_repo: string;
  rules_ref: string;
  rules_local_path: string;
  vision_file: string;
  tech_env_file: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface HandoffTiming {
  handoff: number;
  node_id: string;
  duration_ms: number;
}

export interface Artifacts {
  source_files: number;
  test_files: number;
  config_files: number;
  total_files: number;
  total_lines_of_code: number;
  inception_files: number;
  construction_files: number;
  total_doc_files: number;
}

export interface ContextSizeStats {
  min_tokens: number;
  max_tokens: number;
  avg_tokens: number;
  median_tokens: number;
  sample_count: number;
}

export interface RunMetrics {
  total_tokens: TokenUsage;
  executor_tokens: TokenUsage;
  simulator_tokens: TokenUsage;
  repeated_context_tokens: TokenUsage;
  api_total_tokens: TokenUsage;
  wall_clock_ms: number;
  handoffs: HandoffTiming[];
  artifacts: Artifacts;
  errors: Record<string, number>;
  context_size_total: ContextSizeStats | null;
  context_size_executor: ContextSizeStats | null;
  context_size_simulator: ContextSizeStats | null;
}

export interface TestResults {
  status: string;
  install_ok: boolean;
  test_ok: boolean;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  pass_pct: number;
  coverage_pct: number | null;
}

export interface LintFinding {
  file: string;
  line: number;
  code: string;
  message: string;
  severity: string;
}

export interface QualityReport {
  project_type: string;
  lint_tool: string;
  lint_version: string;
  lint_available: boolean;
  lint_findings: LintFinding[];
  lint_total: number;
  lint_errors: number;
  lint_warnings: number;
  security_tool: string;
  security_available: boolean;
  security_total: number;
  security_high: number;
  semgrep_tool: string;
  semgrep_available: boolean;
  semgrep_total: number;
  semgrep_high: number;
  duplication_tool: string;
  duplication_available: boolean;
  duplication_blocks: number;
  duplication_lines: number;
}

export interface ContractCase {
  name: string;
  path: string;
  method: string;
  passed: boolean;
  expected_status: number;
  actual_status: number | null;
  failures: string[];
  latency_ms: number | null;
  error: string | null;
}

export interface ContractResults {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  server_started: boolean;
  server_error: string | null;
  cases: ContractCase[];
}

export interface DocScore {
  path: string;
  intent: number;
  design: number;
  completeness: number;
  overall: number;
  notes: string;
}

export interface PhaseScore {
  phase: string;
  avg_intent: number;
  avg_design: number;
  avg_completeness: number;
  avg_overall: number;
  documents: DocScore[];
}

export interface QualitativeResults {
  overall_score: number;
  phases: PhaseScore[];
  unmatched_reference: string[];
  unmatched_candidate: string[];
}

export interface ReportData {
  meta: RunMeta;
  metrics: RunMetrics;
  tests: TestResults | null;
  quality: QualityReport | null;
  contracts: ContractResults | null;
  qualitative: QualitativeResults | null;
  comparison: unknown | null; // ComparisonResult when a baseline exists
  generated_at: string;
}

// ── default constructors (mirror the dataclass field defaults) ──────────────
function emptyTokenUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}
function emptyRunMeta(): RunMeta {
  return {
    run_folder: "", started_at: "", completed_at: "", status: "",
    execution_time_ms: 0, total_handoffs: 0, node_history: [],
    executor_model: "", simulator_model: "", aws_region: "",
    rules_source: "", rules_repo: "", rules_ref: "", rules_local_path: "",
    vision_file: "", tech_env_file: "",
  };
}
function emptyArtifacts(): Artifacts {
  return {
    source_files: 0, test_files: 0, config_files: 0, total_files: 0,
    total_lines_of_code: 0, inception_files: 0, construction_files: 0, total_doc_files: 0,
  };
}
function emptyRunMetrics(): RunMetrics {
  return {
    total_tokens: emptyTokenUsage(), executor_tokens: emptyTokenUsage(),
    simulator_tokens: emptyTokenUsage(), repeated_context_tokens: emptyTokenUsage(),
    api_total_tokens: emptyTokenUsage(), wall_clock_ms: 0, handoffs: [],
    artifacts: emptyArtifacts(), errors: {},
    context_size_total: null, context_size_executor: null, context_size_simulator: null,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
// collector.py:199-203 — return null when the file is absent.
function loadYaml(path: string): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const parsed = Bun.YAML.parse(text);
  return (parsed ?? null) as Record<string, any> | null;
}

// collector.py:206-216 — two-regex coverage extraction.
function parseCoverage(testOutput: string): number | null {
  let m = testOutput.match(/Total coverage:\s*([\d.]+)%/);
  if (m) return Number(m[1]);
  m = testOutput.match(/TOTAL\s+\d+\s+\d+\s+(\d+)%/);
  if (m) return Number(m[1]);
  return null;
}

// collector.py:219-227
function parseContextStats(d: Record<string, any>): ContextSizeStats {
  return {
    min_tokens: d.min_tokens ?? 0,
    max_tokens: d.max_tokens ?? 0,
    avg_tokens: d.avg_tokens ?? 0,
    median_tokens: d.median_tokens ?? 0,
    sample_count: d.sample_count ?? 0,
  };
}

const num = (v: any, d = 0): number => (v == null ? d : v);

// ── collect (collector.py:230-451) ──────────────────────────────────────────
export function collect(runFolder: string, generatedAt = ""): ReportData {
  const report: ReportData = {
    meta: emptyRunMeta(),
    metrics: emptyRunMetrics(),
    tests: null,
    quality: null,
    contracts: null,
    qualitative: null,
    comparison: null,
    // collector.py:232 — datetime.now(UTC).isoformat(timespec='seconds'). Passed
    // in so the module stays deterministic/resume-safe (Date.now is unavailable).
    generated_at: generatedAt,
  };

  // ── run-meta.yaml (collector.py:234-255) ──
  let raw = loadYaml(join(runFolder, "run-meta.yaml"));
  if (raw) {
    const cfg = raw.config ?? {};
    report.meta = {
      run_folder: raw.run_folder ?? runFolder,
      started_at: raw.started_at ?? "",
      completed_at: raw.completed_at ?? "",
      status: raw.status ?? "",
      execution_time_ms: raw.execution_time_ms ?? 0,
      total_handoffs: raw.total_handoffs ?? 0,
      node_history: raw.node_history ?? [],
      executor_model: cfg.executor_model ?? "",
      simulator_model: cfg.simulator_model ?? "",
      aws_region: cfg.aws_region ?? "",
      rules_source: cfg.rules_source ?? "",
      rules_repo: cfg.rules_repo || "",
      rules_ref: cfg.rules_ref || "",
      rules_local_path: cfg.rules_local_path || "",
      vision_file: raw.vision_file ?? "",
      tech_env_file: raw.tech_env_file ?? "",
    };
  }

  // ── run-metrics.yaml (collector.py:257-326) ──
  raw = loadYaml(join(runFolder, "run-metrics.yaml"));
  if (raw) {
    const tok = raw.tokens ?? {};
    const tot = tok.total ?? {};
    const pa = tok.per_agent ?? {};
    // collector.py:263 — executor‖orchestrator fallback.
    const ex = pa.executor ?? pa.orchestrator ?? {};
    const si = pa.simulator ?? {};
    const repeated = tok.repeated_context ?? {};
    const apiTot = tok.api_total ?? {};
    const timing = raw.timing ?? {};
    const artWs = (raw.artifacts ?? {}).workspace ?? {};
    const artDoc = (raw.artifacts ?? {}).aidlc_docs ?? {};
    const errs: Record<string, any> = raw.errors ?? {};

    const handoffs: HandoffTiming[] = [];
    for (const h of timing.handoffs ?? []) {
      handoffs.push({
        handoff: h.handoff ?? 0,
        node_id: h.node_id ?? "",
        duration_ms: h.duration_ms ?? 0,
      });
    }

    report.metrics = {
      total_tokens: {
        input_tokens: num(tot.input_tokens),
        output_tokens: num(tot.output_tokens),
        total_tokens: num(tot.total_tokens),
      },
      executor_tokens: {
        input_tokens: num(ex.input_tokens),
        output_tokens: num(ex.output_tokens),
        total_tokens: num(ex.total_tokens),
      },
      simulator_tokens: {
        input_tokens: num(si.input_tokens),
        output_tokens: num(si.output_tokens),
        total_tokens: num(si.total_tokens),
      },
      repeated_context_tokens: {
        input_tokens: num(repeated.input_tokens),
        output_tokens: num(repeated.output_tokens),
        total_tokens: num(repeated.total_tokens),
      },
      api_total_tokens: {
        input_tokens: num(apiTot.input_tokens),
        output_tokens: num(apiTot.output_tokens),
        total_tokens: num(apiTot.total_tokens),
      },
      wall_clock_ms: timing.total_wall_clock_ms ?? 0,
      handoffs,
      artifacts: {
        source_files: artWs.source_files ?? 0,
        test_files: artWs.test_files ?? 0,
        config_files: artWs.config_files ?? 0,
        total_files: artWs.total_files ?? 0,
        total_lines_of_code: artWs.total_lines_of_code ?? 0,
        inception_files: artDoc.inception_files ?? 0,
        construction_files: artDoc.construction_files ?? 0,
        total_doc_files: artDoc.total_files ?? 0,
      },
      // collector.py:314 — keep only int-valued keys, dropping "details".
      errors: Object.fromEntries(
        Object.entries(errs).filter(([k, v]) => k !== "details" && typeof v === "number"),
      ),
      context_size_total: null,
      context_size_executor: null,
      context_size_simulator: null,
    };

    // Context size stats (collector.py:317-326) — may be absent in older runs.
    const ctx = raw.context_size ?? {};
    if (ctx && Object.keys(ctx).length > 0) {
      report.metrics.context_size_total = parseContextStats(ctx.total ?? {});
      const ctxPa = ctx.per_agent ?? {};
      const executorCtx = ctxPa.executor ?? ctxPa.orchestrator;
      if (executorCtx) report.metrics.context_size_executor = parseContextStats(executorCtx);
      if ("simulator" in ctxPa) report.metrics.context_size_simulator = parseContextStats(ctxPa.simulator);
    }
  }

  // ── test-results.yaml (collector.py:328-345) ──
  raw = loadYaml(join(runFolder, "test-results.yaml"));
  if (raw) {
    const parsed = (raw.test ?? {}).parsed_results ?? {};
    const testOutput = (raw.test ?? {}).output ?? "";
    const _passed = parsed.passed || 0;
    const _total = parsed.total || 0;
    report.tests = {
      status: raw.status ?? "",
      install_ok: (raw.install ?? {}).success ?? false,
      test_ok: (raw.test ?? {}).success ?? false,
      passed: _passed,
      failed: parsed.failed || 0,
      errors: parsed.errors || 0,
      total: _total,
      pass_pct: _total > 0 ? (_passed / _total) * 100 : 0.0,
      coverage_pct: parseCoverage(testOutput),
    };
  }

  // ── quality-report.yaml (collector.py:347-387) ──
  raw = loadYaml(join(runFolder, "quality-report.yaml"));
  if (raw) {
    const lint = raw.lint ?? {};
    const sec = raw.security ?? {};
    const sem = raw.semgrep ?? {};
    const dup = raw.duplication ?? {};
    const summary = raw.summary ?? {};
    const findings: LintFinding[] = [];
    for (const f of lint.findings ?? []) {
      findings.push({
        file: basename(f.file ?? ""), // collector.py:359 — Path(...).name
        line: f.line ?? 0,
        code: f.code ?? "",
        message: f.message ?? "",
        severity: f.severity ?? "",
      });
    }
    report.quality = {
      project_type: raw.project_type ?? "",
      lint_tool: lint.tool ?? "",
      lint_version: lint.version || "",
      lint_available: lint.available ?? false,
      lint_findings: findings,
      lint_total: summary.lint_total ?? 0,
      lint_errors: summary.lint_errors ?? 0,
      lint_warnings: summary.lint_warnings ?? 0,
      security_tool: sec.tool ?? "",
      security_available: sec.available ?? false,
      security_total: summary.security_total ?? 0,
      security_high: summary.security_high ?? 0,
      semgrep_tool: sem.tool ?? "",
      semgrep_available: sem.available ?? false,
      // collector.py:381-382 — COMPUTED from findings, not summary.
      semgrep_total: (sem.findings ?? []).length,
      semgrep_high: (sem.findings ?? []).filter((f: any) => f.severity === "high").length,
      duplication_tool: dup.tool ?? "",
      duplication_available: dup.available ?? false,
      duplication_blocks: summary.duplication_blocks ?? 0,
      duplication_lines: summary.duplication_lines ?? 0,
    };
  }

  // ── contract-test-results.yaml (collector.py:389-415) ──
  raw = loadYaml(join(runFolder, "contract-test-results.yaml"));
  if (raw) {
    const cases: ContractCase[] = [];
    for (const c of raw.cases ?? []) {
      cases.push({
        name: c.name ?? "",
        path: c.path ?? "",
        method: c.method ?? "",
        passed: c.passed ?? false,
        expected_status: c.expected_status ?? 0,
        actual_status: c.actual_status ?? null,
        failures: c.failures ?? [],
        latency_ms: c.latency_ms ?? null,
        error: c.error ?? null,
      });
    }
    report.contracts = {
      total: raw.total ?? 0,
      passed: raw.passed ?? 0,
      failed: raw.failed ?? 0,
      errors: raw.errors ?? 0,
      server_started: raw.server_started ?? false,
      server_error: raw.server_error ?? null,
      cases,
    };
  }

  // ── qualitative-comparison.yaml (collector.py:417-449) ──
  raw = loadYaml(join(runFolder, "qualitative-comparison.yaml"));
  if (raw) {
    const phases: PhaseScore[] = [];
    for (const p of raw.phases ?? []) {
      const docs: DocScore[] = [];
      for (const d of p.documents ?? []) {
        docs.push({
          path: d.path ?? "",
          intent: d.intent_similarity ?? 0,
          design: d.design_similarity ?? 0,
          completeness: d.completeness ?? 0,
          overall: d.overall ?? 0,
          notes: d.notes ?? "",
        });
      }
      phases.push({
        phase: p.phase ?? "",
        avg_intent: p.avg_intent ?? 0,
        avg_design: p.avg_design ?? 0,
        avg_completeness: p.avg_completeness ?? 0,
        avg_overall: p.avg_overall ?? 0,
        documents: docs,
      });
    }
    report.qualitative = {
      overall_score: raw.overall_score ?? 0,
      phases,
      unmatched_reference: raw.unmatched_reference ?? [],
      unmatched_candidate: raw.unmatched_candidate ?? [],
    };
  }

  return report;
}
