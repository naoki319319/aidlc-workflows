// types.ts — shared data models for the JS evaluator port.
//
// Mirrors the Python evaluator's per-package dataclasses so the YAML each stage
// writes/reads is byte-compatible with the Python pipeline. Field names match
// the Python exactly (snake_case in YAML payloads, camelCase in TS where it's
// internal-only). Citations point at the Python source each type ports.

// ── Stage 2: post-run tests (post_run.py / collector TestResults) ──────────
export interface ParsedTestResults {
  passed: number | null;
  failed: number | null;
  errors: number | null;
  skipped: number | null;
  total: number | null;
}

export interface TestResults {
  status: string; // "completed" | "skipped" | "install_failed" | "*_timeout"
  install_ok: boolean;
  test_ok: boolean;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  pass_pct: number;
  coverage_pct: number | null;
}

// ── Stage 3: quantitative (quantitative/models.py) ─────────────────────────
export interface LintFinding {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface SecurityFinding {
  file: string;
  line: number;
  code: string;
  message: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  cwe: string | null;
}

export interface DuplicationFinding {
  files: Array<{ file: string; line: number; endline: number }>;
  tokens: number;
  lines: number;
  codefragment: string;
}

export interface ToolResult<F = unknown> {
  tool: string;
  version: string | null;
  available: boolean;
  exit_code: number | null;
  error: string | null;
  findings: F[];
}

export interface QualityReport {
  project_type: string;
  project_root: string;
  lint: ToolResult<LintFinding> | null;
  security: ToolResult<SecurityFinding> | null;
  semgrep: ToolResult<SecurityFinding> | null;
  duplication: ToolResult<DuplicationFinding> | null;
  summary: Record<string, number>;
}

// ── Stage 4: contract tests (contracttest/runner.py + spec.py) ─────────────
export interface AppConfig {
  module: string;
  framework: string;
  startup_timeout: number;
  port: number;
}

export interface TestCase {
  name: string;
  method: string;
  path: string;
  expected_status: number;
  body: Record<string, unknown> | null;
  expected_body: Record<string, unknown> | null;
  operation_id: string | null;
  skip: boolean;
}

export interface ContractSpec {
  app: AppConfig;
  test_cases: TestCase[];
  title: string;
  version: string;
}

export interface CaseResult {
  name: string;
  path: string;
  method: string;
  passed: boolean;
  expected_status: number;
  actual_status: number | null;
  failures: string[];
  latency_ms: number | null;
  error: string | null;
  skipped: boolean;
}

export interface ContractTestResults {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: CaseResult[];
  server_started: boolean;
  server_error: string | null;
}

// ── Stage 5: qualitative (qualitative/models.py) ───────────────────────────
export interface DocumentScore {
  relative_path: string;
  phase: string;
  intent_similarity: number;
  design_similarity: number;
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
  documents: DocumentScore[];
}

export interface QualitativeResult {
  reference_path: string;
  candidate_path: string;
  overall_score: number;
  phases: PhaseScore[];
  unmatched_reference: string[];
  unmatched_candidate: string[];
}

// ── Stage 6: golden baseline (reporting/baseline.py) ───────────────────────
// Flat ~31-metric snapshot. Field names match BaselineMetrics exactly.
export interface BaselineMetrics {
  run_folder: string;
  promoted_at: string;
  executor_model: string;
  simulator_model: string;
  wall_clock_ms: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  handoffs: number;
  executor_input_tokens: number;
  executor_output_tokens: number;
  executor_total_tokens: number;
  simulator_input_tokens: number;
  simulator_output_tokens: number;
  simulator_total_tokens: number;
  repeated_context_input_tokens: number;
  repeated_context_output_tokens: number;
  repeated_context_total_tokens: number;
  api_total_input_tokens: number;
  api_total_output_tokens: number;
  api_total_total_tokens: number;
  context_size_max: number;
  context_size_avg: number;
  context_size_median: number;
  source_files: number;
  test_files: number;
  total_files: number;
  lines_of_code: number;
  doc_files: number;
  tests_passed: number;
  tests_failed: number;
  tests_total: number;
  tests_pass_pct: number;
  coverage_pct: number | null;
  contract_passed: number;
  contract_failed: number;
  contract_total: number;
  lint_errors: number;
  lint_warnings: number;
  lint_total: number;
  security_total: number;
  security_high: number;
  duplication_blocks: number;
  qualitative_score: number;
  inception_score: number;
  construction_score: number;
}

export type MetricDirection = "improved" | "regressed" | "unchanged" | "new";

export interface MetricDelta {
  name: string;
  category: string;
  current: number | null;
  golden: number | null;
  delta: number | null;
  pct_change: number | null;
  direction: MetricDirection;
  higher_is_better: boolean;
}

export interface ComparisonResult {
  golden_run: string;
  golden_promoted_at: string;
  current_run: string;
  improved: number;
  regressed: number;
  unchanged: number;
  deltas: MetricDelta[];
}
