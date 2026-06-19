// gate.test.ts — 1:1 port of trend-reports/tests/test_gate.py (17 tests).
//
// Mirrors the three Python test classes (TestCheckRegressions,
// TestFindLatestAndPrevious, TestCheckRegressionsInfraFailure) using the
// trend-factories make_run/make_trend builders. Pure logic — no binary, model,
// or network. Python's identity asserts (`is r1`) become reference equality
// (toBe), since make_run returns distinct objects.

import { describe, expect, test } from "bun:test";
import { checkRegressions, findLatestAndPrevious } from "./gate.ts";
import { make_run, make_trend } from "./trend-factories.ts";
import { InfraFailureReason, RunType, makeInfraFailure } from "./trend-models.ts";

// test_gate.py:10-59 — class TestCheckRegressions
describe("TestCheckRegressions", () => {
  // test_gate.py:11-16
  test("test_no_regressions_passes", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.85 });
    const r2 = make_run({ label: "v0.1.1", qualitative_score: 0.9 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  // test_gate.py:18-23
  test("test_contract_test_regression", () => {
    const r1 = make_run({ label: "v0.1.0", contract_passed: 88, contract_total: 88 });
    const r2 = make_run({ label: "v0.1.1", contract_passed: 85, contract_total: 88 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(false);
    expect(result.regressions.some((r) => r.toLowerCase().includes("contract"))).toBe(true);
  });

  // test_gate.py:25-30
  test("test_unit_test_failures_regression", () => {
    const r1 = make_run({ label: "v0.1.0", passed: 100, failed: 0 });
    const r2 = make_run({ label: "v0.1.1", passed: 95, failed: 5 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(false);
    expect(
      result.regressions.some(
        (r) => r.toLowerCase().includes("unit") || r.toLowerCase().includes("test"),
      ),
    ).toBe(true);
  });

  // test_gate.py:32-37
  test("test_qualitative_regression", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.9 });
    const r2 = make_run({ label: "v0.1.1", qualitative_score: 0.85 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(false);
    expect(result.regressions.some((r) => r.toLowerCase().includes("qualitative"))).toBe(true);
  });

  // test_gate.py:39-43
  test("test_small_qualitative_drop_not_regression", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.9 });
    const r2 = make_run({ label: "v0.1.1", qualitative_score: 0.885 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(true);
  });

  // test_gate.py:45-48
  test("test_fewer_than_two_runs_passes", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const result = checkRegressions(make_trend([r1]));
    expect(result.passed).toBe(true);
  });

  // test_gate.py:50-52
  test("test_empty_runs_passes", () => {
    const result = checkRegressions(make_trend([]));
    expect(result.passed).toBe(true);
  });

  // test_gate.py:54-59
  test("test_labels_set", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const r2 = make_run({ label: "v0.1.1" });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.latest_label).toBe("v0.1.1");
    expect(result.comparison_label).toBe("v0.1.0");
  });
});

// test_gate.py:62-95 — class TestFindLatestAndPrevious
describe("TestFindLatestAndPrevious", () => {
  // test_gate.py:63-67
  test("test_empty_runs", () => {
    const trend = make_trend([]);
    const [latest, prev] = findLatestAndPrevious(trend);
    expect(latest).toBeNull();
    expect(prev).toBeNull();
  });

  // test_gate.py:69-73
  test("test_single_run", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const [latest, prev] = findLatestAndPrevious(make_trend([r1]));
    expect(latest).toBe(r1);
    expect(prev).toBeNull();
  });

  // test_gate.py:75-80
  test("test_two_releases", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const r2 = make_run({ label: "v0.1.1" });
    const [latest, prev] = findLatestAndPrevious(make_trend([r1, r2]));
    expect(latest).toBe(r2);
    expect(prev).toBe(r1);
  });

  // test_gate.py:82-88
  test("test_latest_is_main", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const r2 = make_run({ label: "v0.1.1" });
    const rMain = make_run({ label: "main", run_type: RunType.MAIN, semver: null });
    const [latest, prev] = findLatestAndPrevious(make_trend([r1, r2, rMain]));
    expect(latest).toBe(rMain);
    expect(prev).toBe(r2);
  });

  // test_gate.py:90-95
  test("test_latest_is_pr", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const rPr = make_run({ label: "PR #42", run_type: RunType.PR, semver: null, pr_number: 42 });
    const [latest, prev] = findLatestAndPrevious(make_trend([r1, rPr]));
    expect(latest).toBe(rPr);
    expect(prev).toBe(r1);
  });
});

// test_gate.py:98-156 — class TestCheckRegressionsInfraFailure
describe("TestCheckRegressionsInfraFailure", () => {
  // test_gate.py:99-117
  test("test_latest_infra_failure_skips_regression", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.9 });
    const r2 = make_run({
      label: "v0.1.1",
      qualitative_score: 0.0,
      contract_passed: 0,
      contract_total: 88,
      infra_failure: makeInfraFailure({
        is_infra_failure: true,
        reasons: [InfraFailureReason.THROTTLED],
        summary: "Infrastructure failure detected: bedrock_throttled",
      }),
    });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(true);
    expect(result.infra_failure_detected).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.infra_failure_summary.toLowerCase()).toContain("infrastructure");
  });

  // test_gate.py:119-134
  test("test_previous_infra_failure_finds_older_comparison", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.9 });
    const r2 = make_run({
      label: "v0.1.1",
      qualitative_score: 0.0,
      infra_failure: makeInfraFailure({
        is_infra_failure: true,
        reasons: [InfraFailureReason.SERVICE_UNAVAILABLE],
        summary: "test",
      }),
    });
    const r3 = make_run({ label: "v0.1.2", qualitative_score: 0.91 });
    const result = checkRegressions(make_trend([r1, r2, r3]));
    expect(result.passed).toBe(true);
    expect(result.comparison_label).toBe("v0.1.0");
  });

  // test_gate.py:136-142
  test("test_non_infra_failure_still_detects_regression", () => {
    const r1 = make_run({ label: "v0.1.0", qualitative_score: 0.9 });
    const r2 = make_run({ label: "v0.1.1", qualitative_score: 0.85 });
    const result = checkRegressions(make_trend([r1, r2]));
    expect(result.passed).toBe(false);
    expect(result.infra_failure_detected).toBe(false);
  });

  // test_gate.py:144-156
  test("test_all_runs_infra_failure_gate_passes", () => {
    const infra = makeInfraFailure({
      is_infra_failure: true,
      reasons: [InfraFailureReason.THROTTLED],
      summary: "test",
    });
    const r1 = make_run({ label: "v0.1.0", infra_failure: infra });
    const r2 = make_run({ label: "v0.1.1", qualitative_score: 0.9 });
    const result = checkRegressions(make_trend([r1, r2]));
    // Latest is not infra, but comparison is; should skip with annotation
    expect(result.passed).toBe(true);
    expect(result.infra_failure_detected).toBe(true);
  });
});
