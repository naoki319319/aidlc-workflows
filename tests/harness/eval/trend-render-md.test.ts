// trend-render-md.test.ts — 1:1 mirror of trend-reports' test_render_md.py
// (read in full). Eight smoke tests verifying the Markdown renderer's sections
// are present and that it does not crash on various inputs. Does NOT validate
// exact Markdown formatting (the Python tests only substring/structure-check).
//
// Python source: packages/trend-reports/tests/test_render_md.py
//
// API note: the Python factories are called positionally / variadically
//   make_run("v0.1.0", qualitative_score=…) ; make_trend(r1, r2)
// while the TS ports take an options object / an array:
//   make_run({ label: "v0.1.0", qualitative_score: … }) ; make_trend([r1, r2])
// The local _make_trend helper (test_render_md.py:19-32) is ported verbatim.

import { describe, expect, test } from "bun:test";

import { make_run, make_trend } from "./trend-factories.ts";
import {
  type TrendData,
  InfraFailureReason,
  makeBaselineMetrics,
  makeInfraFailure,
} from "./trend-models.ts";
import { renderTrendMarkdown } from "./trend-render-md.ts";

// test_render_md.py:19-32 — local _make_trend. Builds runs whose qualitative
// score climbs by 0.02 per index, and a fixed baseline.
function makeTrend(...labels: string[]): TrendData {
  const runs = labels.map((label, i) =>
    make_run({ label, qualitative_score: 0.85 + i * 0.02 }),
  );
  return {
    runs,
    baseline: makeBaselineMetrics({
      unit_tests_passed: 192,
      qualitative_overall: 0.891,
      total_tokens: 9840000,
      execution_time_seconds: 1446.0,
    }),
    repo: "test/repo",
    generated_at: "2026-01-01T00:00:00Z",
  };
}

describe("TestRenderTrendMarkdown", () => {
  // test_output_is_string
  test("output is string", () => {
    const trend = makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendMarkdown(trend);
    expect(typeof result).toBe("string");
  });

  // test_contains_all_sections
  test("contains all sections", () => {
    const trend = makeTrend("v0.1.0", "v0.1.1", "v0.1.2");
    const result = renderTrendMarkdown(trend);
    for (const section of [
      "## A. Executive Summary",
      "## B. Functional Correctness",
      "## C. Qualitative Evaluation",
      "## D. Efficiency & Cost Metrics",
      "## E. Code Quality",
      "## F. Stability",
      "## G. Version-over-Version Deltas",
      "## H. Pre-Release",
    ]) {
      expect(result, `Missing ${section}`).toContain(section);
    }
  });

  // test_contains_version_labels
  test("contains version labels", () => {
    const trend = makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendMarkdown(trend);
    expect(result).toContain("v0.1.0");
    expect(result).toContain("v0.1.1");
  });

  // test_empty_runs_no_crash
  test("empty runs no crash", () => {
    const trend: TrendData = {
      runs: [],
      baseline: makeBaselineMetrics(),
      repo: "test/repo",
      generated_at: "2026-01-01T00:00:00Z",
    };
    const result = renderTrendMarkdown(trend);
    expect(typeof result).toBe("string");
  });

  // test_single_run
  test("single run", () => {
    const trend = makeTrend("v0.1.0");
    const result = renderTrendMarkdown(trend);
    expect(result).toContain("v0.1.0");
  });
});

describe("TestInfraFailureBannerMd", () => {
  // test_no_banner_when_no_infra_failure
  test("no banner when no infra failure", () => {
    const trend = makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendMarkdown(trend);
    expect(result).not.toContain("Infrastructure Failure");
  });

  // test_banner_when_infra_failure
  test("banner when infra failure", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const r2 = make_run({
      label: "v0.1.1",
      infra_failure: makeInfraFailure({
        is_infra_failure: true,
        reasons: [InfraFailureReason.THROTTLED],
        summary: "bedrock_throttled",
      }),
    });
    const trend = make_trend([r1, r2]);
    const result = renderTrendMarkdown(trend);
    expect(result).toContain("Infrastructure Failure");
    expect(result).toContain("v0.1.1");
    expect(result).toContain("bedrock_throttled");
  });

  // test_section_f_shows_infra_failure_column
  test("section f shows infra failure column", () => {
    const r1 = make_run({ label: "v0.1.0" });
    const r2 = make_run({
      label: "v0.1.1",
      infra_failure: makeInfraFailure({
        is_infra_failure: true,
        reasons: [InfraFailureReason.THROTTLED],
        summary: "test",
      }),
    });
    const trend = make_trend([r1, r2]);
    const result = renderTrendMarkdown(trend);
    expect(result).toContain("Infra Failure");
    expect(result).toContain("**YES**");
  });
});
