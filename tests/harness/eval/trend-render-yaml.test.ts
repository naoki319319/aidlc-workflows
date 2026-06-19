// trend-render-yaml.test.ts — 1:1 mirror of trend-reports' test_render_yaml.py
// (read in full). Six tests for YAML data export + serialization roundtrip.
//
// Python source: packages/trend-reports/tests/test_render_yaml.py
// Each TS test maps to the like-named Python method:
//   test_roundtrip                            → "roundtrip"
//   test_run_type_serialized_as_value         → "run_type serialized as value"
//   test_empty_runs                           → "empty runs"
//   test_output_is_string                     → "output is string"
//   test_infra_failure_serialized             → "infra_failure serialized"
//   test_infra_failure_reason_serialized_as_value
//                                             → "infra_failure reason serialized as value"
//
// Python uses yaml.safe_load on the rendered string; we roundtrip via
// Bun.YAML.parse (NOT a byte compare) and assert field names, enum .value
// strings, the SemVer 'v'-string, and nested-order survival.

import { describe, expect, test } from "bun:test";

import { renderTrendYaml } from "./trend-render-yaml.ts";
import {
  type RunData,
  type TrendData,
  InfraFailureReason,
  RunType,
  SemVer,
  makeBaselineMetrics,
  makeCodeQualityMetrics,
  makeContractTestResults,
  makeInfraFailure,
  makeQualitativeComparison,
  makeRunConfig,
  makeRunData,
  makeRunMeta,
  makeRunMetrics,
  makeTrendData,
  makeUnitTestResults,
} from "./trend-models.ts";

// Mirrors test_render_yaml.py:_make_trend (lines 25-43).
function makeTrend(): TrendData {
  const run: RunData = makeRunData({
    label: "v0.1.0",
    run_type: RunType.RELEASE,
    semver: new SemVer(0, 1, 0),
    pr_number: null,
    meta: makeRunMeta("run-001", makeRunConfig("v0.1.0")),
    metrics: makeRunMetrics({ total_tokens: 9000000 }),
    unit_tests: makeUnitTestResults({ passed: 175, total: 175 }),
    contract_tests: makeContractTestResults({ total: 88, passed: 88 }),
    code_quality: makeCodeQualityMetrics(),
    qualitative: makeQualitativeComparison({ overall_score: 0.898 }),
  });
  return makeTrendData([run], makeBaselineMetrics({ unit_tests_passed: 192, qualitative_overall: 0.891 }), {
    repo: "test/repo",
    generated_at: "2026-01-01T00:00:00Z",
  });
}

describe("TestRenderTrendYaml", () => {
  // test_render_yaml.py:47-54
  test("roundtrip", () => {
    const trend = makeTrend();
    const yamlStr = renderTrendYaml(trend);
    const parsed = Bun.YAML.parse(yamlStr) as Record<string, any>;
    expect(parsed.repo).toBe("test/repo");
    expect(parsed.runs.length).toBe(1);
    expect(parsed.runs[0].label).toBe("v0.1.0");
    expect(parsed.runs[0].unit_tests.passed).toBe(175);
  });

  // test_render_yaml.py:56-60
  test("run_type serialized as value", () => {
    const trend = makeTrend();
    const yamlStr = renderTrendYaml(trend);
    const parsed = Bun.YAML.parse(yamlStr) as Record<string, any>;
    expect(parsed.runs[0].run_type).toBe("release");
  });

  // test_render_yaml.py:62-71
  test("empty runs", () => {
    const trend = makeTrendData([], makeBaselineMetrics(), {
      repo: "test/repo",
      generated_at: "2026-01-01T00:00:00Z",
    });
    const yamlStr = renderTrendYaml(trend);
    const parsed = Bun.YAML.parse(yamlStr) as Record<string, any>;
    expect(parsed.runs).toEqual([]);
  });

  // test_render_yaml.py:73-76
  test("output is string", () => {
    const trend = makeTrend();
    const result = renderTrendYaml(trend);
    expect(typeof result).toBe("string");
  });

  // test_render_yaml.py:78-90
  test("infra_failure serialized", () => {
    const trend = makeTrend();
    trend.runs[0]!.infra_failure = makeInfraFailure({
      is_infra_failure: true,
      reasons: [InfraFailureReason.THROTTLED],
      summary: "test",
    });
    const yamlStr = renderTrendYaml(trend);
    const parsed = Bun.YAML.parse(yamlStr) as Record<string, any>;
    const infra = parsed.runs[0].infra_failure;
    expect(infra.is_infra_failure).toBe(true);
    expect(infra.reasons).toContain("bedrock_throttled");
    expect(infra.summary).toBe("test");
  });

  // test_render_yaml.py:92-102
  test("infra_failure reason serialized as value", () => {
    const trend = makeTrend();
    trend.runs[0]!.infra_failure = makeInfraFailure({
      is_infra_failure: true,
      reasons: [InfraFailureReason.SERVICE_UNAVAILABLE, InfraFailureReason.RUN_FAILED],
      summary: "test",
    });
    const yamlStr = renderTrendYaml(trend);
    const parsed = Bun.YAML.parse(yamlStr) as Record<string, any>;
    const reasons = parsed.runs[0].infra_failure.reasons;
    expect(reasons).toEqual(["bedrock_service_unavailable", "run_failed"]);
  });
});
