// trend-factories.ts — shared test-fixture builders for trend-reports.
//
// Faithful 1:1 port of trend-reports/tests/factories.py (read in full).
// Exports make_run + make_trend; later test-port waves import these.
//
// make_run (factories.py:23-71):
//   - auto-parses SemVer from `label` when run_type == RELEASE && semver is None
//     (factories.py:41-45); a ValueError from SemVer.parse is swallowed (semver
//     stays None) — mirrored by catching the throw from SemVer.parse.
//   - unit_tests.total = passed + failed (factories.py:56).
//   - contract failed = contract_total - contract_passed; pass_rate =
//     contract_passed / contract_total when contract_total else 0.0
//     (factories.py:57-62).
//   - infra_failure defaults to a fresh InfraFailure() (factories.py:70).
// make_trend (factories.py:74-81):
//   - runs = list(runs); baseline defaults to a fresh BaselineMetrics();
//     repo="test/repo", generated_at="2026-01-01T00:00:00Z".

import {
  type BaselineMetrics,
  type DocumentScore,
  type InfraFailure,
  type RunData,
  RunType,
  SemVer,
  type TrendData,
  makeBaselineMetrics,
  makeCodeQualityMetrics,
  makeContractTestResults,
  makeInfraFailure,
  makeQualitativeComparison,
  makeRunConfig,
  makeRunData,
  makeRunMeta,
  makeRunMetrics,
  makeUnitTestResults,
} from "./trend-models.ts";

/** Options mirroring make_run's keyword arguments (factories.py:23-39). */
export interface MakeRunOptions {
  label?: string;
  run_type?: RunType;
  semver?: SemVer | null;
  pr_number?: number | null;
  passed?: number;
  failed?: number;
  qualitative_score?: number;
  total_tokens?: number;
  time_seconds?: number;
  contract_passed?: number;
  contract_total?: number;
  document_scores?: DocumentScore[] | null;
  inception_score?: number;
  construction_score?: number;
  infra_failure?: InfraFailure | null;
}

/** Create a RunData instance for testing. (factories.py:23-71) */
export function make_run(options: MakeRunOptions = {}): RunData {
  const {
    label = "v0.1.0", // factories.py:24
    run_type = RunType.RELEASE, // factories.py:25
    pr_number = null, // factories.py:27
    passed = 100, // factories.py:28
    failed = 0, // factories.py:29
    qualitative_score = 0.9, // factories.py:30
    total_tokens = 1_000_000, // factories.py:31
    time_seconds = 600.0, // factories.py:32
    contract_passed = 88, // factories.py:33
    contract_total = 88, // factories.py:34
    document_scores = null, // factories.py:35
    inception_score = 0.0, // factories.py:36
    construction_score = 0.0, // factories.py:37
    infra_failure = null, // factories.py:38
  } = options;

  let semver: SemVer | null = options.semver ?? null; // factories.py:26

  // factories.py:41-45: auto-parse semver from label for RELEASE runs; a
  // ValueError from SemVer.parse is swallowed (semver remains None).
  if (semver === null && run_type === RunType.RELEASE) {
    try {
      semver = SemVer.parse(label);
    } catch {
      // pass (factories.py:44-45)
    }
  }

  return makeRunData(
    {
      label, // factories.py:47
      run_type, // factories.py:48
      semver, // factories.py:49
      pr_number, // factories.py:50
      meta: makeRunMeta("test", makeRunConfig(label)), // factories.py:51
      metrics: makeRunMetrics({
        total_tokens, // factories.py:53
        execution_time_seconds: time_seconds, // factories.py:54
      }),
      unit_tests: makeUnitTestResults({
        passed, // factories.py:56
        failed,
        total: passed + failed, // factories.py:56
      }),
      contract_tests: makeContractTestResults({
        total: contract_total, // factories.py:58
        passed: contract_passed, // factories.py:59
        failed: contract_total - contract_passed, // factories.py:60
        pass_rate: contract_total ? contract_passed / contract_total : 0.0, // factories.py:61
      }),
      code_quality: makeCodeQualityMetrics(), // factories.py:63
      qualitative: makeQualitativeComparison({
        overall_score: qualitative_score, // factories.py:65
        inception_score, // factories.py:66
        construction_score, // factories.py:67
        document_scores: document_scores ?? [], // factories.py:68
      }),
    },
    { infra_failure: infra_failure ?? makeInfraFailure() }, // factories.py:70
  );
}

/** Create a TrendData instance for testing. (factories.py:74-81) */
export function make_trend(runs: RunData[] = [], baseline?: BaselineMetrics | null): TrendData {
  return {
    runs: [...runs], // list(runs) (factories.py:77)
    baseline: baseline ?? makeBaselineMetrics(), // factories.py:78
    repo: "test/repo", // factories.py:79
    generated_at: "2026-01-01T00:00:00Z", // factories.py:80
  };
}
