// baseline.ts — golden baseline load + compare (reporting/baseline.py).
//
// Pure arithmetic over the flat ~31-metric BaselineMetrics. _classify and
// compare are ported 1:1, including the 0.001 tolerance and the metrics_spec
// table's higher_is_better flags. load() reads a golden.yaml as-is.
//
// NOTE (matches the evaluator's golden.yaml comment): artifact-count fields are
// intentionally zeroed in the shipped golden, so a naive diff would false-alarm.
// Callers that adopt golden.yaml for regression gating should exclude the
// Artifacts category — see README.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaselineMetrics, ComparisonResult, MetricDelta, MetricDirection } from "./types.ts";
import { collect, type ReportData } from "./reporting-collector.ts";
import { atomicYamlDump, pyFloat } from "./yaml.ts";

// reporting/baseline.py:load_baseline — read nested golden.yaml → flat metrics.
export function loadBaseline(doc: Record<string, any>): BaselineMetrics {
  const ex = doc.execution ?? {};
  const exA = ex.executor ?? {};
  const siA = ex.simulator ?? {};
  const rep = ex.repeated_context ?? {};
  const api = ex.api_total ?? {};
  const ctx = doc.context_size ?? {};
  const art = doc.artifacts ?? {};
  const ut = doc.unit_tests ?? {};
  const ct = doc.contract_tests ?? {};
  const cq = doc.code_quality ?? {};
  const ql = doc.qualitative ?? {};
  const n = (v: any, d = 0) => (v == null ? d : Number(v));
  return {
    run_folder: doc.run_folder ?? "",
    promoted_at: doc.promoted_at ?? "",
    executor_model: doc.executor_model ?? "",
    simulator_model: doc.simulator_model ?? "",
    wall_clock_ms: n(ex.wall_clock_ms),
    total_tokens: n(ex.total_tokens),
    input_tokens: n(ex.input_tokens),
    output_tokens: n(ex.output_tokens),
    handoffs: n(ex.handoffs),
    executor_input_tokens: n(exA.input_tokens),
    executor_output_tokens: n(exA.output_tokens),
    executor_total_tokens: n(exA.total_tokens),
    simulator_input_tokens: n(siA.input_tokens),
    simulator_output_tokens: n(siA.output_tokens),
    simulator_total_tokens: n(siA.total_tokens),
    repeated_context_input_tokens: n(rep.input_tokens),
    repeated_context_output_tokens: n(rep.output_tokens),
    repeated_context_total_tokens: n(rep.total_tokens),
    api_total_input_tokens: n(api.input_tokens),
    api_total_output_tokens: n(api.output_tokens),
    api_total_total_tokens: n(api.total_tokens),
    context_size_max: n(ctx.max_tokens),
    context_size_avg: n(ctx.avg_tokens),
    context_size_median: n(ctx.median_tokens),
    source_files: n(art.source_files),
    test_files: n(art.test_files),
    total_files: n(art.total_files),
    lines_of_code: n(art.lines_of_code),
    doc_files: n(art.doc_files),
    tests_passed: n(ut.passed),
    tests_failed: n(ut.failed),
    tests_total: n(ut.total),
    tests_pass_pct: n(ut.pass_pct),
    coverage_pct: ut.coverage_pct == null ? null : Number(ut.coverage_pct),
    contract_passed: n(ct.passed),
    contract_failed: n(ct.failed),
    contract_total: n(ct.total),
    lint_errors: n(cq.lint_errors),
    lint_warnings: n(cq.lint_warnings),
    lint_total: n(cq.lint_total),
    security_total: n(cq.security_total),
    security_high: n(cq.security_high),
    duplication_blocks: n(cq.duplication_blocks),
    qualitative_score: n(ql.overall_score),
    inception_score: n(ql.inception_score),
    construction_score: n(ql.construction_score),
  };
}

// baseline.py:extract_baseline (91-155) — flat BaselineMetrics from a fully
// collected ReportData. `promotedAt` is INJECTED (default '') rather than read
// from datetime.now(UTC) (baseline.py:95) — the port stays deterministic and
// resume-safe (Date.now unavailable in this seam), matching collect()'s
// generatedAt convention in reporting-collector.ts.
export function extractBaseline(data: ReportData, promotedAt = ""): BaselineMetrics {
  // baseline.py:93-120 — identity + aggregate/per-agent/repeated/api + artifacts.
  const b: BaselineMetrics = {
    run_folder: data.meta.run_folder,
    promoted_at: promotedAt,
    executor_model: data.meta.executor_model,
    simulator_model: data.meta.simulator_model,
    wall_clock_ms: data.metrics.wall_clock_ms,
    total_tokens: data.metrics.total_tokens.total_tokens,
    input_tokens: data.metrics.total_tokens.input_tokens,
    output_tokens: data.metrics.total_tokens.output_tokens,
    handoffs: data.meta.total_handoffs,
    executor_input_tokens: data.metrics.executor_tokens.input_tokens,
    executor_output_tokens: data.metrics.executor_tokens.output_tokens,
    executor_total_tokens: data.metrics.executor_tokens.total_tokens,
    simulator_input_tokens: data.metrics.simulator_tokens.input_tokens,
    simulator_output_tokens: data.metrics.simulator_tokens.output_tokens,
    simulator_total_tokens: data.metrics.simulator_tokens.total_tokens,
    repeated_context_input_tokens: data.metrics.repeated_context_tokens.input_tokens,
    repeated_context_output_tokens: data.metrics.repeated_context_tokens.output_tokens,
    repeated_context_total_tokens: data.metrics.repeated_context_tokens.total_tokens,
    api_total_input_tokens: data.metrics.api_total_tokens.input_tokens,
    api_total_output_tokens: data.metrics.api_total_tokens.output_tokens,
    api_total_total_tokens: data.metrics.api_total_tokens.total_tokens,
    source_files: data.metrics.artifacts.source_files,
    test_files: data.metrics.artifacts.test_files,
    total_files: data.metrics.artifacts.total_files,
    lines_of_code: data.metrics.artifacts.total_lines_of_code,
    doc_files: data.metrics.artifacts.total_doc_files,
    // The remaining fields carry the dataclass defaults (baseline.py:54-88) and
    // are overwritten only when the corresponding section is present below.
    context_size_max: 0,
    context_size_avg: 0,
    context_size_median: 0,
    tests_passed: 0,
    tests_failed: 0,
    tests_total: 0,
    tests_pass_pct: 0.0,
    coverage_pct: null, // baseline.py:70 — coverage_pct default is None, not 0.
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
  };

  // baseline.py:122-125
  if (data.metrics.context_size_total) {
    b.context_size_max = data.metrics.context_size_total.max_tokens;
    b.context_size_avg = data.metrics.context_size_total.avg_tokens;
    b.context_size_median = data.metrics.context_size_total.median_tokens;
  }

  // baseline.py:127-132
  if (data.tests) {
    b.tests_passed = data.tests.passed;
    b.tests_failed = data.tests.failed;
    b.tests_total = data.tests.total;
    b.tests_pass_pct = data.tests.pass_pct;
    b.coverage_pct = data.tests.coverage_pct;
  }

  // baseline.py:134-137
  if (data.contracts) {
    b.contract_passed = data.contracts.passed;
    b.contract_failed = data.contracts.failed;
    b.contract_total = data.contracts.total;
  }

  // baseline.py:139-145
  if (data.quality) {
    b.lint_errors = data.quality.lint_errors;
    b.lint_warnings = data.quality.lint_warnings;
    b.lint_total = data.quality.lint_total;
    b.security_total = data.quality.security_total;
    b.security_high = data.quality.security_high;
    b.duplication_blocks = data.quality.duplication_blocks;
  }

  // baseline.py:147-153 — phase routing: inception/construction from avg_overall.
  if (data.qualitative) {
    b.qualitative_score = data.qualitative.overall_score;
    for (const phase of data.qualitative.phases) {
      if (phase.phase === "inception") b.inception_score = phase.avg_overall;
      else if (phase.phase === "construction") b.construction_score = phase.avg_overall;
    }
  }

  return b;
}

// baseline.py:write_baseline (158-232) — flat metrics → NESTED golden.yaml dict
// in EXACT key order, written atomically (yaml.safe_dump default_flow_style=False,
// sort_keys=False → our atomicYamlDump). Float fields (pass_pct, coverage_pct,
// the qualitative scores) are wrapped with pyFloat so an integral value renders
// "100.0" not "100" (PyYAML float behaviour); the nesting is the lockstep inverse
// of loadBaseline above. coverage_pct may be null → pyFloat(null) === null, which
// dumpYaml renders as the YAML `null` Python's None also emits.
export function writeBaseline(baseline: BaselineMetrics, path: string): void {
  const d: Record<string, unknown> = {
    run_folder: baseline.run_folder,
    promoted_at: baseline.promoted_at,
    executor_model: baseline.executor_model,
    simulator_model: baseline.simulator_model,
    execution: {
      wall_clock_ms: baseline.wall_clock_ms,
      total_tokens: baseline.total_tokens,
      input_tokens: baseline.input_tokens,
      output_tokens: baseline.output_tokens,
      handoffs: baseline.handoffs,
      executor: {
        input_tokens: baseline.executor_input_tokens,
        output_tokens: baseline.executor_output_tokens,
        total_tokens: baseline.executor_total_tokens,
      },
      simulator: {
        input_tokens: baseline.simulator_input_tokens,
        output_tokens: baseline.simulator_output_tokens,
        total_tokens: baseline.simulator_total_tokens,
      },
      repeated_context: {
        input_tokens: baseline.repeated_context_input_tokens,
        output_tokens: baseline.repeated_context_output_tokens,
        total_tokens: baseline.repeated_context_total_tokens,
      },
      api_total: {
        input_tokens: baseline.api_total_input_tokens,
        output_tokens: baseline.api_total_output_tokens,
        total_tokens: baseline.api_total_total_tokens,
      },
    },
    context_size: {
      max_tokens: baseline.context_size_max,
      avg_tokens: baseline.context_size_avg,
      median_tokens: baseline.context_size_median,
    },
    artifacts: {
      source_files: baseline.source_files,
      test_files: baseline.test_files,
      total_files: baseline.total_files,
      lines_of_code: baseline.lines_of_code,
      doc_files: baseline.doc_files,
    },
    unit_tests: {
      passed: baseline.tests_passed,
      failed: baseline.tests_failed,
      total: baseline.tests_total,
      // pass_pct is a Python float (baseline.py:69) → render trailing ".0".
      pass_pct: pyFloat(baseline.tests_pass_pct),
      // coverage_pct is float | None (baseline.py:70); pyFloat(null) → null.
      coverage_pct: pyFloat(baseline.coverage_pct),
    },
    contract_tests: {
      passed: baseline.contract_passed,
      failed: baseline.contract_failed,
      total: baseline.contract_total,
    },
    code_quality: {
      lint_errors: baseline.lint_errors,
      lint_warnings: baseline.lint_warnings,
      lint_total: baseline.lint_total,
      security_total: baseline.security_total,
      security_high: baseline.security_high,
      duplication_blocks: baseline.duplication_blocks,
    },
    qualitative: {
      // All three are Python floats (baseline.py:86-88) → render trailing ".0".
      overall_score: pyFloat(baseline.qualitative_score),
      inception_score: pyFloat(baseline.inception_score),
      construction_score: pyFloat(baseline.construction_score),
    },
  };
  // baseline.py:230-232 — path.parent.mkdir(parents=True, exist_ok=True) then
  // yaml.safe_dump. atomicYamlDump renames a temp file in the target dir into
  // place, so the parent must exist first — mirror Python's mkdir here.
  mkdirSync(dirname(path), { recursive: true });
  atomicYamlDump(d, path);
}

// baseline.py:promote (300-305) — collect a run's data and write it as a golden
// baseline. generatedAt threads through collect()'s deterministic seam.
export function promote(runFolder: string, goldenPath: string, generatedAt = ""): BaselineMetrics {
  const data = collect(runFolder, generatedAt);
  const baseline = extractBaseline(data);
  writeBaseline(baseline, goldenPath);
  return baseline;
}

// baseline.py:compare_run_to_baseline (508-513) — collect a run, load a baseline,
// and compare. loadBaseline here takes the parsed doc (Bun.YAML.parse), so the
// caller reads goldenPath; this convenience reads it via Bun.YAML.parse to mirror
// Python's load_baseline(path) which opens+parses internally.
export function compareRunToBaseline(runFolder: string, goldenPath: string): ComparisonResult {
  const data = collect(runFolder);
  const current = extractBaseline(data);
  const doc = (Bun.YAML.parse(readFileSync(goldenPath, "utf-8")) ?? {}) as Record<string, any>;
  const golden = loadBaseline(doc);
  return compare(current, golden);
}

// baseline.py:_classify — (direction, delta, pct), 0.001 tolerance.
function classify(
  current: number | null,
  golden: number | null,
  higherIsBetter: boolean,
  tolerance = 0.001,
): { direction: MetricDirection; delta: number | null; pct: number | null } {
  if (current == null || golden == null) {
    return { direction: golden == null ? "new" : "unchanged", delta: null, pct: null };
  }
  const delta = Number(current) - Number(golden);
  const pct = golden !== 0 ? (delta / Number(golden)) * 100 : delta !== 0 ? 100 : 0;
  if (Math.abs(delta) <= tolerance) return { direction: "unchanged", delta, pct };
  if (higherIsBetter) return { direction: delta > 0 ? "improved" : "regressed", delta, pct };
  return { direction: delta < 0 ? "improved" : "regressed", delta, pct };
}

// baseline.py:compare metrics_spec (365-482): (name, category, sel, higher_is_better)
type Sel = (b: BaselineMetrics) => number | null;
const METRICS_SPEC: Array<[string, string, Sel, boolean]> = [
  ["Tests Pass %", "Unit Tests", (b) => b.tests_pass_pct, true],
  ["Tests Failed", "Unit Tests", (b) => b.tests_failed, false],
  ["Coverage %", "Unit Tests", (b) => b.coverage_pct, true],
  ["Contract Passed", "Contract Tests", (b) => b.contract_passed, true],
  ["Contract Failed", "Contract Tests", (b) => b.contract_failed, false],
  ["Contract Total", "Contract Tests", (b) => b.contract_total, true],
  ["Lint Errors", "Code Quality", (b) => b.lint_errors, false],
  ["Lint Warnings", "Code Quality", (b) => b.lint_warnings, false],
  ["Lint Total", "Code Quality", (b) => b.lint_total, false],
  ["Security Findings", "Code Quality", (b) => b.security_total, false],
  ["Security High", "Code Quality", (b) => b.security_high, false],
  ["Duplication Blocks", "Code Quality", (b) => b.duplication_blocks, false],
  ["Qualitative Score", "Qualitative", (b) => b.qualitative_score, true],
  ["Inception Score", "Qualitative", (b) => b.inception_score, true],
  ["Construction Score", "Qualitative", (b) => b.construction_score, true],
  ["Source Files", "Artifacts", (b) => b.source_files, true],
  ["Test Files", "Artifacts", (b) => b.test_files, true],
  ["Lines of Code", "Artifacts", (b) => b.lines_of_code, true],
  ["Doc Files", "Artifacts", (b) => b.doc_files, true],
  ["Total Tokens", "Execution", (b) => b.total_tokens, false],
  ["Executor Input Tokens", "Execution", (b) => b.executor_input_tokens, false],
  ["Executor Total Tokens", "Execution", (b) => b.executor_total_tokens, false],
  ["Simulator Input Tokens", "Execution", (b) => b.simulator_input_tokens, false],
  ["Simulator Total Tokens", "Execution", (b) => b.simulator_total_tokens, false],
  ["Repeated Context Tokens", "Execution", (b) => b.repeated_context_total_tokens, false],
  ["API Total Tokens", "Execution", (b) => b.api_total_total_tokens, false],
  ["Wall Clock (ms)", "Execution", (b) => b.wall_clock_ms, false],
  ["Handoffs", "Execution", (b) => b.handoffs, false],
  ["Context Size Max", "Context Size", (b) => b.context_size_max, false],
  ["Context Size Avg", "Context Size", (b) => b.context_size_avg, false],
  ["Context Size Median", "Context Size", (b) => b.context_size_median, false],
];

export function compare(current: BaselineMetrics, golden: BaselineMetrics): ComparisonResult {
  const result: ComparisonResult = {
    golden_run: golden.run_folder,
    golden_promoted_at: golden.promoted_at,
    current_run: current.run_folder,
    improved: 0,
    regressed: 0,
    unchanged: 0,
    deltas: [],
  };
  for (const [name, category, sel, hib] of METRICS_SPEC) {
    const cur = sel(current);
    const gld = sel(golden);
    const { direction, delta, pct } = classify(cur, gld, hib);
    const md: MetricDelta = {
      name,
      category,
      current: cur,
      golden: gld,
      delta,
      pct_change: pct,
      direction,
      higher_is_better: hib,
    };
    result.deltas.push(md);
    if (direction === "improved") result.improved++;
    else if (direction === "regressed") result.regressed++;
    else result.unchanged++;
  }
  return result;
}
