// trend-models.ts — trend-reports' OWN data models, distinct from reporting's.
//
// Faithful 1:1 port of trend_reports/models.py (read in full). Ports the
// exceptions, enums, value types (InfraFailure, SemVer), per-YAML-file models
// (RunConfig/RunMeta/AgentTokens/HandoffMetrics/RunMetrics/UnitTestResults/
// ContractTestFailure/ContractTestResults/CodeQualityMetrics/DocumentScore/
// QualitativeComparison), and composite models (RunData/BaselineMetrics/TrendData/
// VersionDelta/GateResult).
//
// Python dataclasses become TS interfaces + factory functions: each factory takes
// the required-positional fields plus an `over` patch and fills the dataclass
// defaults verbatim. EVERY list/dict default is a fresh [] / {} per call (the
// Python default_factory, models.py:54,139-140,181,196,218-219,242,257) — never a
// shared module-level constant.
//
// Source-of-truth citations are at models.py:<line> on each construct.

// ---------------------------------------------------------------------------
// Exceptions (models.py:14-23)
// ---------------------------------------------------------------------------

/** Base exception for all trend report errors. (models.py:14) */
export class TrendReportError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "TrendReportError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a gh CLI fetch operation fails. (models.py:18) */
export class FetchError extends TrendReportError {
  constructor(message?: string) {
    super(message);
    this.name = "FetchError";
    Object.setPrototypeOf(this, FetchError.prototype);
  }
}

/** Raised when data collection or parsing fails. (models.py:22) */
export class CollectorError extends TrendReportError {
  constructor(message?: string) {
    super(message);
    this.name = "CollectorError";
    Object.setPrototypeOf(this, CollectorError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Enums and value types (models.py:31-75)
// ---------------------------------------------------------------------------

/** models.py:31-34 */
export enum RunType {
  RELEASE = "release",
  MAIN = "main",
  PR = "pr",
}

/**
 * Reasons why a run is classified as an infrastructure failure. (models.py:37-46)
 * The 7 string values are load-bearing — render_yaml emits `.value`.
 */
export enum InfraFailureReason {
  THROTTLED = "bedrock_throttled",
  SERVICE_UNAVAILABLE = "bedrock_service_unavailable",
  MODEL_ERROR = "bedrock_model_error",
  RUN_FAILED = "run_failed",
  RUN_CRASHED = "run_crashed",
  SERVER_START_FAILED = "server_start_failed",
  METRICS_MISSING = "metrics_missing",
}

/** Details about an infrastructure failure detected in a run. (models.py:49-55) */
export interface InfraFailure {
  is_infra_failure: boolean;
  reasons: InfraFailureReason[];
  summary: string;
}

/** Defaults: is_infra_failure=False, reasons=[] (fresh), summary="". (models.py:53-55) */
export function makeInfraFailure(over: Partial<InfraFailure> = {}): InfraFailure {
  return {
    is_infra_failure: false,
    reasons: [], // fresh list per instance (default_factory, models.py:54)
    summary: "",
    ...over,
  };
}

/**
 * Semantic version, comparable via tuple ordering. (models.py:58-75)
 *
 * Python's @dataclass(frozen=True, order=True): we port `order` as explicit
 * compare()/lessThan()/equals() (no operator overloading) and `frozen` by
 * Object.freeze-ing the instance so a mutation-attempt throws (ESM strict mode).
 */
export class SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;

  constructor(major: number, minor: number, patch: number) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    Object.freeze(this); // frozen=True → mutation throws (models.py:58)
  }

  /**
   * Parse 'v0.1.3' or '0.1.3' into SemVer. (models.py:66-72)
   *
   * Regex is START-anchored ONLY: /^v?(\d+)\.(\d+)\.(\d+)/ with NO `$`, so
   * 'v1.2.3rc' parses (trailing junk ignored) but '1.2' raises. Python uses
   * re.match, which is implicitly anchored at the start — mirrored with `^`.
   */
  static parse(tag: string): SemVer {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
    if (!m) {
      throw new Error(`Cannot parse semver from '${tag}'`);
    }
    return new SemVer(
      Number.parseInt(m[1]!, 10),
      Number.parseInt(m[2]!, 10),
      Number.parseInt(m[3]!, 10),
    );
  }

  /** Tuple value equality, mirroring dataclass __eq__. */
  equals(other: SemVer): boolean {
    return this.major === other.major && this.minor === other.minor && this.patch === other.patch;
  }

  /**
   * Tuple ordering, mirroring order=True (compares (major, minor, patch)).
   * Returns -1 if this < other, 0 if equal, 1 if this > other.
   */
  compare(other: SemVer): number {
    if (this.major !== other.major) return this.major < other.major ? -1 : 1;
    if (this.minor !== other.minor) return this.minor < other.minor ? -1 : 1;
    if (this.patch !== other.patch) return this.patch < other.patch ? -1 : 1;
    return 0;
  }

  lessThan(other: SemVer): boolean {
    return this.compare(other) < 0;
  }

  /** __str__ → 'vMAJOR.MINOR.PATCH'. (models.py:74-75) */
  toString(): string {
    return `v${this.major}.${this.minor}.${this.patch}`;
  }
}

// ---------------------------------------------------------------------------
// Per-YAML-file models (models.py:83-220)
// ---------------------------------------------------------------------------

/** Subset of run-meta.yaml -> config. (models.py:83-89) */
export interface RunConfig {
  rules_ref: string; // required (no default), models.py:87
  model: string;
  target_project: string;
}

/** Defaults: model="", target_project="". (models.py:88-89) */
export function makeRunConfig(rules_ref: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    rules_ref,
    model: "",
    target_project: "",
    ...over,
  };
}

/** Parsed from run-meta.yaml. (models.py:92-100) */
export interface RunMeta {
  run_id: string; // required (no default), models.py:96
  config: RunConfig; // required (no default), models.py:97
  start_time: string;
  end_time: string;
  status: string;
}

/** Defaults: start_time="", end_time="", status="". (models.py:98-100) */
export function makeRunMeta(
  run_id: string,
  config: RunConfig,
  over: Partial<RunMeta> = {},
): RunMeta {
  return {
    run_id,
    config,
    start_time: "",
    end_time: "",
    status: "",
    ...over,
  };
}

/** Token breakdown for a single agent. (models.py:103-112) */
export interface AgentTokens {
  agent_name: string; // required (no default), models.py:107
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Defaults: all token counts 0. (models.py:108-112) */
export function makeAgentTokens(
  agent_name: string,
  over: Partial<AgentTokens> = {},
): AgentTokens {
  return {
    agent_name,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...over,
  };
}

/** Metrics for a single handoff segment. (models.py:115-123) */
export interface HandoffMetrics {
  handoff_number: number; // required (no default), models.py:119
  agent: string;
  duration_seconds: number;
  tokens: number;
}

/** Defaults: agent="", duration_seconds=0.0, tokens=0. (models.py:120-123) */
export function makeHandoffMetrics(
  handoff_number: number,
  over: Partial<HandoffMetrics> = {},
): HandoffMetrics {
  return {
    handoff_number,
    agent: "",
    duration_seconds: 0.0,
    tokens: 0,
    ...over,
  };
}

/** Parsed from run-metrics.yaml. (models.py:125-148) */
export interface RunMetrics {
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  execution_time_seconds: number;
  num_handoffs: number;
  max_context_tokens: number;
  avg_context_tokens: number;
  median_context_tokens: number;
  agent_tokens: AgentTokens[];
  handoffs: HandoffMetrics[];
  server_startup_success: boolean;
  error_count: number;
  throttle_events: number;
  service_unavailable_events: number;
  model_error_events: number;
  timeout_events: number;
  failed_tool_calls: number;
  validation_error_events: number;
}

/**
 * All fields default; agent_tokens/handoffs are fresh lists (default_factory,
 * models.py:139-140); server_startup_success defaults True (models.py:141).
 */
export function makeRunMetrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    total_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    execution_time_seconds: 0.0,
    num_handoffs: 0,
    max_context_tokens: 0,
    avg_context_tokens: 0.0,
    median_context_tokens: 0.0,
    agent_tokens: [], // fresh list (models.py:139)
    handoffs: [], // fresh list (models.py:140)
    server_startup_success: true, // models.py:141
    error_count: 0,
    throttle_events: 0,
    service_unavailable_events: 0,
    model_error_events: 0,
    timeout_events: 0,
    failed_tool_calls: 0,
    validation_error_events: 0,
    ...over,
  };
}

/** Parsed from test-results.yaml. (models.py:151-159) */
export interface UnitTestResults {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  total: number;
}

/** Defaults: all 0. (models.py:155-159) */
export function makeUnitTestResults(over: Partial<UnitTestResults> = {}): UnitTestResults {
  return {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    total: 0,
    ...over,
  };
}

/** A single contract test failure. (models.py:162-170) */
export interface ContractTestFailure {
  endpoint: string;
  method: string;
  expected_status: number;
  actual_status: number;
  description: string;
}

/** Defaults: endpoint="", method="", statuses 0, description="". (models.py:166-170) */
export function makeContractTestFailure(
  over: Partial<ContractTestFailure> = {},
): ContractTestFailure {
  return {
    endpoint: "",
    method: "",
    expected_status: 0,
    actual_status: 0,
    description: "",
    ...over,
  };
}

/** Parsed from contract-test-results.yaml. (models.py:173-183) */
export interface ContractTestResults {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  failures: ContractTestFailure[];
  server_started: boolean;
  server_error: string;
}

/**
 * Defaults: totals 0, pass_rate=0.0, failures=[] fresh (models.py:181),
 * server_started=True (models.py:182), server_error="".
 */
export function makeContractTestResults(
  over: Partial<ContractTestResults> = {},
): ContractTestResults {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    pass_rate: 0.0,
    failures: [], // fresh list (models.py:181)
    server_started: true, // models.py:182
    server_error: "",
    ...over,
  };
}

/** Parsed from quality-report.yaml. (models.py:186-196) */
export interface CodeQualityMetrics {
  lint_findings: number;
  security_findings: number;
  security_scanner_available: boolean;
  source_file_count: number;
  test_file_count: number;
  total_lines_of_code: number;
  artifact_counts: Record<string, number>;
}

/**
 * Defaults: lint_findings=0; security_findings=-1 (SENTINEL for "scanner
 * unavailable", models.py:191-192); security_scanner_available=False; counts 0;
 * artifact_counts={} fresh (models.py:196).
 */
export function makeCodeQualityMetrics(
  over: Partial<CodeQualityMetrics> = {},
): CodeQualityMetrics {
  return {
    lint_findings: 0,
    security_findings: -1, // sentinel: scanner unavailable (models.py:191)
    security_scanner_available: false,
    source_file_count: 0,
    test_file_count: 0,
    total_lines_of_code: 0,
    artifact_counts: {}, // fresh dict (models.py:196)
    ...over,
  };
}

/** Score for a single document in qualitative comparison. (models.py:199-209) */
export interface DocumentScore {
  document_name: string; // required (no default), models.py:203
  overall_score: number;
  phase: string;
  completeness: number;
  accuracy: number;
  clarity: number;
}

/** Defaults: overall_score=0.0, phase="", completeness/accuracy/clarity=0.0. (models.py:204-208) */
export function makeDocumentScore(
  document_name: string,
  over: Partial<DocumentScore> = {},
): DocumentScore {
  return {
    document_name,
    overall_score: 0.0,
    phase: "",
    completeness: 0.0,
    accuracy: 0.0,
    clarity: 0.0,
    ...over,
  };
}

/** Parsed from qualitative-comparison.yaml. (models.py:211-220) */
export interface QualitativeComparison {
  overall_score: number;
  inception_score: number;
  construction_score: number;
  document_scores: DocumentScore[];
  unmatched_reference_docs: string[];
  unmatched_candidate_docs: string[];
}

/**
 * Defaults: scores 0.0; document_scores=[] (models.py:218),
 * unmatched_reference_docs=[] and unmatched_candidate_docs=[] (models.py:219) all
 * fresh lists.
 */
export function makeQualitativeComparison(
  over: Partial<QualitativeComparison> = {},
): QualitativeComparison {
  return {
    overall_score: 0.0,
    inception_score: 0.0,
    construction_score: 0.0,
    document_scores: [], // fresh list (models.py:218)
    unmatched_reference_docs: [], // fresh list (models.py:219)
    unmatched_candidate_docs: [], // fresh list (models.py:219)
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Composite models (models.py:228-292)
// ---------------------------------------------------------------------------

/** All data for a single evaluation run (one zip bundle). (models.py:228-242) */
export interface RunData {
  label: string; // required (no default), models.py:232
  run_type: RunType; // required, models.py:233
  semver: SemVer | null; // required, models.py:234
  pr_number: number | null; // required, models.py:235
  meta: RunMeta; // required, models.py:236
  metrics: RunMetrics; // required, models.py:237
  unit_tests: UnitTestResults; // required, models.py:238
  contract_tests: ContractTestResults; // required, models.py:239
  code_quality: CodeQualityMetrics; // required, models.py:240
  qualitative: QualitativeComparison; // required, models.py:241
  infra_failure: InfraFailure; // default_factory=InfraFailure (models.py:242)
}

/**
 * The 10 fields with no Python default are required positional args; infra_failure
 * defaults to a fresh InfraFailure() (default_factory, models.py:242).
 */
export function makeRunData(
  fields: {
    label: string;
    run_type: RunType;
    semver: SemVer | null;
    pr_number: number | null;
    meta: RunMeta;
    metrics: RunMetrics;
    unit_tests: UnitTestResults;
    contract_tests: ContractTestResults;
    code_quality: CodeQualityMetrics;
    qualitative: QualitativeComparison;
  },
  over: Partial<Pick<RunData, "infra_failure">> = {},
): RunData {
  return {
    ...fields,
    infra_failure: makeInfraFailure(), // fresh InfraFailure (models.py:242)
    ...over,
  };
}

/** Golden baseline reference values. (models.py:245-257) — trend's 9-field one. */
export interface BaselineMetrics {
  unit_tests_passed: number;
  unit_tests_total: number;
  contract_tests_passed: number;
  contract_tests_total: number;
  lint_findings: number;
  qualitative_overall: number;
  execution_time_seconds: number;
  total_tokens: number;
  document_scores: Record<string, number>;
}

/**
 * Defaults: all numeric 0/0.0; document_scores={} fresh dict (models.py:257).
 */
export function makeBaselineMetrics(over: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    unit_tests_passed: 0,
    unit_tests_total: 0,
    contract_tests_passed: 0,
    contract_tests_total: 0,
    lint_findings: 0,
    qualitative_overall: 0.0,
    execution_time_seconds: 0.0,
    total_tokens: 0,
    document_scores: {}, // fresh dict (models.py:257)
    ...over,
  };
}

/** Complete assembled dataset for trend rendering. (models.py:260-267) */
export interface TrendData {
  runs: RunData[]; // required (no default), models.py:264
  baseline: BaselineMetrics; // required, models.py:265
  repo: string;
  generated_at: string;
}

/** Defaults: repo="", generated_at="". (models.py:266-267) */
export function makeTrendData(
  runs: RunData[],
  baseline: BaselineMetrics,
  over: Partial<TrendData> = {},
): TrendData {
  return {
    runs,
    baseline,
    repo: "",
    generated_at: "",
    ...over,
  };
}

/** Computed delta between two consecutive runs. (models.py:270-280) */
export interface VersionDelta {
  from_label: string; // required (no default), models.py:274
  to_label: string; // required, models.py:275
  unit_tests_delta: number;
  contract_tests_delta: number;
  qualitative_delta: number;
  token_delta: number;
  time_delta_seconds: number;
}

/** Defaults: deltas 0/0.0. (models.py:276-280) */
export function makeVersionDelta(
  from_label: string,
  to_label: string,
  over: Partial<VersionDelta> = {},
): VersionDelta {
  return {
    from_label,
    to_label,
    unit_tests_delta: 0,
    contract_tests_delta: 0,
    qualitative_delta: 0.0,
    token_delta: 0,
    time_delta_seconds: 0.0,
    ...over,
  };
}

/** Result of regression gate check. (models.py:283-292) */
export interface GateResult {
  passed: boolean; // required (no default), models.py:287
  regressions: string[];
  latest_label: string;
  comparison_label: string;
  infra_failure_detected: boolean;
  infra_failure_summary: string;
}

/**
 * Defaults: regressions=[] fresh (models.py:288), labels="",
 * infra_failure_detected=False, infra_failure_summary="".
 */
export function makeGateResult(passed: boolean, over: Partial<GateResult> = {}): GateResult {
  return {
    passed,
    regressions: [], // fresh list (models.py:288)
    latest_label: "",
    comparison_label: "",
    infra_failure_detected: false,
    infra_failure_summary: "",
    ...over,
  };
}
