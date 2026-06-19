// trend-models.test.ts — 1:1 port of trend_reports/tests/test_models.py (18 pure).
//
// Mirrors the 6 Python test classes (TestSemVer, TestRunType, TestExceptions,
// TestDataclassDefaults, TestInfraFailure, TestInfraFailureReason). Each Python
// `def test_*` → one TS `test(...)`. Faithful cases, faithful assertions.

import { describe, expect, test } from "bun:test";
import {
  CollectorError,
  FetchError,
  InfraFailureReason,
  makeBaselineMetrics,
  makeGateResult,
  makeInfraFailure,
  RunType,
  SemVer,
  TrendReportError,
} from "./trend-models.ts";

// test_models.py:19-60 — class TestSemVer
describe("TestSemVer", () => {
  // :20-22
  test("test_parse_with_v_prefix", () => {
    const sv = SemVer.parse("v1.2.3");
    expect(sv.equals(new SemVer(1, 2, 3))).toBe(true);
  });

  // :24-26
  test("test_parse_without_v_prefix", () => {
    const sv = SemVer.parse("0.1.5");
    expect(sv.equals(new SemVer(0, 1, 5))).toBe(true);
  });

  // :28-30
  test("test_parse_large_numbers", () => {
    const sv = SemVer.parse("v999.888.777");
    expect(sv.equals(new SemVer(999, 888, 777))).toBe(true);
  });

  // :32-34
  test("test_parse_invalid_empty", () => {
    expect(() => SemVer.parse("")).toThrow("Cannot parse semver");
  });

  // :36-38
  test("test_parse_invalid_text", () => {
    expect(() => SemVer.parse("abc")).toThrow("Cannot parse semver");
  });

  // :40-42
  test("test_parse_invalid_two_parts", () => {
    expect(() => SemVer.parse("1.2")).toThrow("Cannot parse semver");
  });

  // :44-45
  test("test_str", () => {
    expect(String(new SemVer(0, 1, 5))).toBe("v0.1.5");
  });

  // :47-50
  test("test_ordering", () => {
    expect(new SemVer(0, 1, 0).lessThan(new SemVer(0, 2, 0))).toBe(true);
    expect(new SemVer(0, 1, 5).lessThan(new SemVer(0, 1, 6))).toBe(true);
    expect(new SemVer(0, 1, 9).lessThan(new SemVer(1, 0, 0))).toBe(true);
  });

  // :52-55
  test("test_equality", () => {
    expect(new SemVer(1, 2, 3).equals(new SemVer(1, 2, 3))).toBe(true);
  });

  // :57-60 — frozen dataclass: assigning a field raises (AttributeError in Python;
  // Object.freeze in ESM strict mode throws a TypeError on the assignment).
  test("test_frozen", () => {
    const sv = new SemVer(1, 2, 3);
    expect(() => {
      // @ts-expect-error — readonly + frozen; the mutation attempt must throw
      sv.major = 5;
    }).toThrow();
  });
});

// test_models.py:63-67 — class TestRunType
describe("TestRunType", () => {
  // :64-67
  test("test_values", () => {
    expect(RunType.RELEASE).toBe("release" as RunType);
    expect(RunType.MAIN).toBe("main" as RunType);
    expect(RunType.PR).toBe("pr" as RunType);
  });
});

// test_models.py:70-75 — class TestExceptions
describe("TestExceptions", () => {
  // :71-72 — issubclass(FetchError, TrendReportError)
  test("test_fetch_error_is_trend_report_error", () => {
    expect(FetchError.prototype instanceof TrendReportError).toBe(true);
    // instance check too: a FetchError IS-A TrendReportError
    expect(new FetchError("x") instanceof TrendReportError).toBe(true);
  });

  // :74-75 — issubclass(CollectorError, TrendReportError)
  test("test_collector_error_is_trend_report_error", () => {
    expect(CollectorError.prototype instanceof TrendReportError).toBe(true);
    expect(new CollectorError("x") instanceof TrendReportError).toBe(true);
  });
});

// test_models.py:78-90 — class TestDataclassDefaults
describe("TestDataclassDefaults", () => {
  // :79-83
  test("test_baseline_metrics_defaults", () => {
    const bl = makeBaselineMetrics();
    expect(bl.unit_tests_passed).toBe(0);
    expect(bl.qualitative_overall).toBe(0.0);
    expect(bl.document_scores).toEqual({});
  });

  // :85-90
  test("test_gate_result_defaults", () => {
    const gr = makeGateResult(true);
    expect(gr.regressions).toEqual([]);
    expect(gr.latest_label).toBe("");
    expect(gr.infra_failure_detected).toBe(false);
    expect(gr.infra_failure_summary).toBe("");
  });
});

// test_models.py:93-107 — class TestInfraFailure
describe("TestInfraFailure", () => {
  // :94-98
  test("test_defaults_no_failure", () => {
    const inf = makeInfraFailure();
    expect(inf.is_infra_failure).toBeFalsy();
    expect(inf.reasons).toEqual([]);
    expect(inf.summary).toBe("");
  });

  // :100-107
  test("test_with_reasons", () => {
    const inf = makeInfraFailure({
      is_infra_failure: true,
      reasons: [InfraFailureReason.THROTTLED, InfraFailureReason.SERVICE_UNAVAILABLE],
      summary: "test summary",
    });
    expect(inf.is_infra_failure).toBe(true);
    expect(inf.reasons.length).toBe(2);
  });
});

// test_models.py:110-118 — class TestInfraFailureReason
describe("TestInfraFailureReason", () => {
  // :111-118 — all 7 string values are load-bearing
  test("test_values", () => {
    expect(InfraFailureReason.THROTTLED).toBe("bedrock_throttled" as InfraFailureReason);
    expect(InfraFailureReason.SERVICE_UNAVAILABLE).toBe(
      "bedrock_service_unavailable" as InfraFailureReason,
    );
    expect(InfraFailureReason.MODEL_ERROR).toBe("bedrock_model_error" as InfraFailureReason);
    expect(InfraFailureReason.RUN_FAILED).toBe("run_failed" as InfraFailureReason);
    expect(InfraFailureReason.RUN_CRASHED).toBe("run_crashed" as InfraFailureReason);
    expect(InfraFailureReason.SERVER_START_FAILED).toBe(
      "server_start_failed" as InfraFailureReason,
    );
    expect(InfraFailureReason.METRICS_MISSING).toBe("metrics_missing" as InfraFailureReason);
  });
});
