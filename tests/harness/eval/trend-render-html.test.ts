// trend-render-html.test.ts — 1:1 mirror of trend-reports' test_render_html.py
// (read in full). Eight smoke tests verifying the output is valid HTML with the
// expected sections, anchors, version labels, embedded CSS, and infra banner.
//
// Python source: packages/trend-reports/tests/test_render_html.py
// Each TS test maps to the like-named Python method:
//   TestRenderTrendHtml:
//     test_output_is_html              → "output is html"
//     test_contains_section_anchors    → "contains section anchors"
//     test_contains_version_labels     → "contains version labels"
//     test_empty_runs_no_crash         → "empty runs no crash"
//     test_self_contained              → "self contained"
//   TestInfraFailureBannerHtml:
//     test_no_banner_when_no_infra_failure → "no banner when no infra failure"
//     test_banner_when_infra_failure       → "banner when infra failure"
//     test_section_f_shows_infra_badge     → "section f shows infra badge"
//
// The Python test defines a LOCAL _make_trend (test_render_html.py:18-32); it is
// ported below. The Python factory calls (make_run / make_trend) are keyword/
// positional in Python but options-object/array in the TS port (factories.py
// port), so the calls are adapted accordingly while preserving the same values.

import { describe, expect, test } from "bun:test";

import { make_run, make_trend } from "./trend-factories.ts";
import {
  InfraFailureReason,
  makeBaselineMetrics,
  makeInfraFailure,
  makeTrendData,
  type TrendData,
} from "./trend-models.ts";
import { renderTrendHtml } from "./trend-render-html.ts";

// Mirrors test_render_html.py:_make_trend (lines 18-32).
function _makeTrend(...labels: string[]): TrendData {
  const runs = labels.map((label, i) =>
    make_run({ label, qualitative_score: 0.85 + i * 0.02 }),
  );
  return makeTrendData(
    runs,
    makeBaselineMetrics({
      unit_tests_passed: 192,
      qualitative_overall: 0.891,
      total_tokens: 9840000,
      execution_time_seconds: 1446.0,
    }),
    {
      repo: "test/repo",
      generated_at: "2026-01-01T00:00:00Z",
    },
  );
}

describe("TestRenderTrendHtml", () => {
  test("test_output_is_html", () => {
    const trend = _makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendHtml(trend);
    expect(result).toContain("<html");
    expect(result).toContain("</html>");
  });

  test("test_contains_section_anchors", () => {
    const trend = _makeTrend("v0.1.0", "v0.1.1", "v0.1.2");
    const result = renderTrendHtml(trend);
    for (const sectionId of [
      "a-executive-summary",
      "b-functional-correctness",
      "c-qualitative-evaluation",
      "d-efficiency-cost-metrics",
      "e-code-quality",
      "f-stability-reliability",
      "g-version-over-version-deltas",
      "h-pre-release-data-points",
    ]) {
      expect(result, `Missing anchor ${sectionId}`).toContain(sectionId);
    }
  });

  test("test_contains_version_labels", () => {
    const trend = _makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendHtml(trend);
    expect(result).toContain("v0.1.0");
    expect(result).toContain("v0.1.1");
  });

  test("test_empty_runs_no_crash", () => {
    const trend = makeTrendData([], makeBaselineMetrics(), {
      repo: "test/repo",
      generated_at: "2026-01-01T00:00:00Z",
    });
    const result = renderTrendHtml(trend);
    expect(result).toContain("<html");
  });

  test("test_self_contained", () => {
    // Output should have embedded CSS, no external references.
    const trend = _makeTrend("v0.1.0");
    const result = renderTrendHtml(trend);
    expect(result).toContain("<style>");
  });
});

describe("TestInfraFailureBannerHtml", () => {
  test("test_no_banner_when_no_infra_failure", () => {
    const trend = _makeTrend("v0.1.0", "v0.1.1");
    const result = renderTrendHtml(trend);
    expect(result).not.toContain('<div class="infra-banner">');
  });

  test("test_banner_when_infra_failure", () => {
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
    const result = renderTrendHtml(trend);
    expect(result).toContain("infra-banner");
    expect(result).toContain("v0.1.1");
  });

  test("test_section_f_shows_infra_badge", () => {
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
    const result = renderTrendHtml(trend);
    expect(result).toContain("badge-infra");
    expect(result).toContain("INFRA FAIL");
  });
});
