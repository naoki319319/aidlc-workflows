// trend-render-html.ts — self-contained HTML trend report renderer (tables only,
// no JavaScript).
//
// Faithful 1:1 port of
// /Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/
//   packages/trend-reports/src/trend_reports/render_html.py (read in full, 1026 lines).
//
// Ports render_trend_html(trend) + _CSS (verbatim AWS Cloudscape palette) +
// _html_header/_html_footer/hero/nav + sections A-H + _score_class/_delta_class/
// _html_table/_build_heatmap/_bl/_fmt_int_delta/_fmt_time_delta/
// _fmt_token_delta_html/_fmt_signed_number.
//
// TRAPS (each verified against render_html.py:<line>):
//   - delta coloring recognizes '+', '-', and '−' U+2212 (:377-393).
//   - bar width = value/max*100 with max(...,default=1) and ':.0f' (:649-655,680-685).
//   - _bl returns '0' for a zero baseline (ONLY None→'—') — DIFFERENT from md's
//     truthy '—'-on-falsy; do NOT unify (:989-993).
//   - html.escape parity: escape(s) with quote=True maps & < > " ' →
//     &amp; &lt; &gt; &quot; &#x27; ('&' first) (:5,199,218,247…).
//   - embedded entities &mdash;/&ndash;/&rsquo;/&amp;/&rarr;/&minus;/&ge;/&lt;
//     are written verbatim in the prose and MUST survive byte-for-byte.
//
// Python f-string fixed-point ('{:.3f}', '{:+.3f}', '{:.0f}', '{:+.1f}',
// '{:+.1f}%', '{:+d}') goes through pyFixed/pySignedFixed/pyPercent (CPython
// round-half-to-even), never JS toFixed.

import { pyFixed, pySignedFixed } from "./pyutil.ts";
import { computeDeltas } from "./trend-collector.ts";
import { RunType, type TrendData, type VersionDelta } from "./trend-models.ts";
import {
  formatDelta,
  formatNumber,
  formatPct,
  formatSecondsAsMinutes,
} from "./trend-sparkline.ts";
import { PyFloat } from "./yaml.ts";

// ---------------------------------------------------------------------------
// html.escape parity (render_html.py:5 `from html import escape`)
//
// Python's html.escape(s, quote=True) — the default — escapes, IN ORDER:
//   & → &amp;  (must be first so later replacements don't double-escape)
//   < → &lt;   > → &gt;   " → &quot;   ' → &#x27;
// ---------------------------------------------------------------------------
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function renderTrendHtml(trend: TrendData): string {
  // render_html.py:17-34
  const parts = [
    _htmlHeader("AIDLC Rules Trend Report"),
    _renderHtmlHero(trend),
    _renderInfraFailureBannerHtml(trend),
    _renderNav(),
    _renderHtmlSectionA(trend),
    _renderHtmlSectionB(trend),
    _renderHtmlSectionC(trend),
    _renderHtmlSectionD(trend),
    _renderHtmlSectionE(trend),
    _renderHtmlSectionF(trend),
    _renderHtmlSectionG(trend),
    _renderHtmlSectionH(trend),
    _htmlFooter(),
  ];
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// HTML chrome (render_html.py:37-256)
// ---------------------------------------------------------------------------

// render_html.py:41-190 — verbatim AWS Cloudscape-aligned palette + layout CSS.
const _CSS = `\
:root {
    /* AWS Cloudscape-aligned palette */
    --aws-squid-ink: #000716;
    --aws-orange: #ec7211;
    --aws-blue-600: #0972d3;

    /* Status colors */
    --green-bg: #f2fcf3; --green-text: #037f0c; --green-border: #29ad32;
    --yellow-bg: #fff8e1; --yellow-text: #8d6605; --yellow-border: #d4a017;
    --red-bg: #fff3f0; --red-text: #d91515; --red-border: #eb5f5f;
    --blue-bg: #f0f6ff; --blue-text: #0972d3;

    /* Neutral grays */
    --gray-50: #fafafa; --gray-100: #f2f3f3; --gray-200: #e9ebed;
    --gray-300: #d1d5db; --gray-500: #5f6b7a; --gray-700: #414d5c;
    --gray-900: #000716;

    --radius: 8px;
}
* { box-sizing: border-box; }
body {
    font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    max-width: 1200px; margin: 0 auto; padding: 24px;
    color: var(--gray-900); background: #fff; line-height: 1.6;
}
h1 { font-size: 28px; margin: 0 0 4px 0; }
h2 {
    font-size: 20px; margin: 40px 0 12px 0; padding-bottom: 8px;
    border-bottom: 2px solid var(--gray-200); color: var(--gray-900);
}
h3 { font-size: 16px; margin: 24px 0 8px 0; color: var(--gray-700); }

/* Hero header */
.hero {
    margin-bottom: 32px; padding: 20px 24px;
    background: var(--aws-squid-ink); color: #fff; border-radius: var(--radius);
}
.hero h1 { font-size: 28px; color: #fff; }
.hero .meta { color: #a8b4c4; font-size: 14px; margin-top: 4px; }

/* Navigation */
.nav {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 28px;
    padding: 12px 16px; background: var(--aws-squid-ink); border-radius: var(--radius);
    border: none;
}
.nav a {
    font-size: 13px; color: #d5dbdb; text-decoration: none;
    padding: 4px 10px; border-radius: 4px; transition: background 0.15s;
}
.nav a:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }

/* Summary cards */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0 24px 0; }
.card {
    padding: 14px 16px; border-radius: var(--radius);
    border: 1px solid var(--gray-200); background: #fff;
}
.card .label { font-size: 12px; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; }
.card .value { font-size: 24px; font-weight: 700; margin: 4px 0 2px 0; }
.card .detail { font-size: 12px; color: var(--gray-500); }
.card.good { border-left: 4px solid var(--green-border); }
.card.warn { border-left: 4px solid var(--yellow-border); }
.card.bad  { border-left: 4px solid #d91515; }

/* Tables */
table {
    border-collapse: collapse; width: 100%; margin: 12px 0 24px 0;
    font-size: 14px; border-radius: var(--radius); overflow: hidden;
    border: 1px solid var(--gray-200);
}
th {
    background: var(--gray-100); font-weight: 600; text-align: left;
    padding: 10px 14px; border-bottom: 2px solid var(--gray-200);
    font-size: 13px; color: var(--gray-700); text-transform: uppercase;
    letter-spacing: 0.3px;
}
td { padding: 9px 14px; border-bottom: 1px solid var(--gray-100); }
tr:hover td { background: var(--gray-50); }
td:first-child { font-weight: 500; }

/* Score cells */
.s-green  { background: var(--green-bg); color: var(--green-text); font-weight: 600; }
.s-yellow { background: var(--yellow-bg); color: var(--yellow-text); font-weight: 500; }
.s-red    { background: var(--red-bg); color: var(--red-text); font-weight: 600; }
.d-pos    { color: var(--green-text); font-weight: 500; }
.d-neg    { color: var(--red-text); font-weight: 500; }
.na       { color: var(--gray-500); font-style: italic; }

/* Badges */
.badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
}
.badge-pass { background: var(--green-bg); color: var(--green-text); }
.badge-fail { background: var(--red-bg); color: var(--red-text); }
.badge-warn { background: var(--yellow-bg); color: var(--yellow-text); }

/* Mini bar chart (CSS only) */
.bar-cell { position: relative; }
.bar {
    display: inline-block; height: 16px; border-radius: 2px;
    background: linear-gradient(90deg, #ec7211, #ff9900);
    vertical-align: middle; margin-right: 6px;
    min-width: 2px;
}

/* Two-column split layout */
.split {
    display: grid; grid-template-columns: 1fr 2fr;
    gap: 24px; align-items: start; margin: 4px 0 24px 0;
}
.split-desc {
    font-size: 14px; color: var(--gray-500); line-height: 1.7;
    padding-top: 4px;
}
.split-desc p { margin: 0 0 8px 0; }
.split table { margin-top: 0; }

/* Blockquote callouts */
.callout {
    padding: 12px 16px; margin: 12px 0;
    border-left: 4px solid var(--yellow-border); background: var(--yellow-bg);
    border-radius: 0 var(--radius) var(--radius) 0; font-size: 14px;
}
.callout.info { border-left-color: var(--aws-blue-600); background: var(--blue-bg); }

/* Section description */
.section-desc { color: var(--gray-500); font-size: 14px; margin: 0 0 12px 0; }

/* Infra failure banner */
.infra-banner {
    padding: 16px 20px; margin: 0 0 24px 0;
    background: var(--red-bg); border: 2px solid var(--red-border);
    border-radius: var(--radius); color: var(--red-text);
}
.infra-banner h3 { margin: 0 0 8px 0; color: var(--red-text); font-size: 16px; }
.infra-banner ul { margin: 4px 0 0 0; padding-left: 20px; }
.badge-infra { background: var(--red-bg); color: var(--red-text); border: 1px solid var(--red-border); }

/* Responsive */
@media (max-width: 768px) {
    body { padding: 12px; }
    .cards { grid-template-columns: repeat(2, 1fr); }
    .split { grid-template-columns: 1fr; }
    table { font-size: 13px; }
    th, td { padding: 6px 8px; }
}
`;

// render_html.py:193-203
function _htmlHeader(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${_CSS}</style>
</head>
<body>
`;
}

// render_html.py:206-207
function _htmlFooter(): string {
  return "</body>\n</html>";
}

// render_html.py:210-220
function _renderHtmlHero(trend: TrendData): string {
  const n = trend.runs.length;
  const first = trend.runs.length ? trend.runs[0]!.label : "—";
  const last = trend.runs.length ? trend.runs[trend.runs.length - 1]!.label : "—";
  return (
    '<div class="hero">\n' +
    "  <h1>AIDLC Rules Trend Report</h1>\n" +
    `  <div class="meta">${n} releases (${first} through ${last}) · ` +
    `${escape(trend.repo)} · ${escape(trend.generated_at)}</div>\n` +
    "</div>\n"
  );
}

// render_html.py:223-235
function _renderNav(): string {
  const links: [string, string][] = [
    ["A. Summary", "a-executive-summary"],
    ["B. Correctness", "b-functional-correctness"],
    ["C. Qualitative", "c-qualitative-evaluation"],
    ["D. Efficiency", "d-efficiency-cost-metrics"],
    ["E. Quality", "e-code-quality"],
    ["F. Stability", "f-stability-reliability"],
    ["G. Deltas", "g-version-over-version-deltas"],
    ["H. Pre-Release", "h-pre-release-data-points"],
  ];
  const items = links.map(([label, anchor]) => `<a href="#${anchor}">${label}</a>`).join(" ");
  return `<nav class="nav">${items}</nav>\n`;
}

// render_html.py:238-256 — prominent warning banner if any runs have infra failures.
function _renderInfraFailureBannerHtml(trend: TrendData): string {
  const infraRuns = trend.runs.filter((r) => r.infra_failure.is_infra_failure);
  if (infraRuns.length === 0) {
    return "";
  }

  const items: string[] = [];
  for (const r of infraRuns) {
    const reasons = r.infra_failure.reasons.map((reason) => reason as string).join(", ");
    items.push(`<li><strong>${escape(r.label)}</strong>: ${escape(reasons)}</li>`);
  }

  return (
    '<div class="infra-banner">\n' +
    "  <h3>Infrastructure Failure Detected</h3>\n" +
    "  <p>The following runs experienced infrastructure failures. " +
    "Their results are unreliable and have been excluded from regression checks.</p>\n" +
    `  <ul>${items.join("")}</ul>\n` +
    "</div>\n"
  );
}

// ---------------------------------------------------------------------------
// Section A — Executive Summary (render_html.py:264-418)
// ---------------------------------------------------------------------------

function _renderHtmlSectionA(trend: TrendData): string {
  const runs = trend.runs;
  const bl = trend.baseline;
  const latest = runs.length ? runs[runs.length - 1]! : null;
  if (!latest) {
    return '<h2 id="a-executive-summary">A. Executive Summary</h2>\n<p>No data available.</p>\n';
  }

  // Summary cards (render_html.py:272-318)
  const qualStatus =
    latest.qualitative.overall_score >= 0.9
      ? "good"
      : latest.qualitative.overall_score >= 0.8
        ? "warn"
        : "bad";
  const contractStatus =
    latest.contract_tests.pass_rate >= 1.0
      ? "good"
      : latest.contract_tests.pass_rate >= 0.95
        ? "warn"
        : "bad";
  const unitPassRate =
    latest.unit_tests.total > 0 ? latest.unit_tests.passed / latest.unit_tests.total : 0.0;
  const blUnitPassRate =
    bl.unit_tests_total > 0 ? bl.unit_tests_passed / bl.unit_tests_total : 0.0;
  const testStatus = unitPassRate >= 1.0 ? "good" : unitPassRate >= 0.95 ? "warn" : "bad";
  const lintStatus = latest.code_quality.lint_findings === 0 ? "good" : "warn";

  const cards =
    '<div class="cards">\n' +
    `  <div class="card ${qualStatus}">` +
    '<div class="label">Qualitative Score</div>' +
    `<div class="value">${pyFixed(latest.qualitative.overall_score, 3)}</div>` +
    `<div class="detail">Golden: ${pyFixed(bl.qualitative_overall, 3)}</div></div>\n` +
    `  <div class="card ${contractStatus}">` +
    '<div class="label">Contract Tests</div>' +
    `<div class="value">${latest.contract_tests.passed}/${latest.contract_tests.total}</div>` +
    `<div class="detail">${formatPct(latest.contract_tests.pass_rate)} pass rate</div></div>\n` +
    `  <div class="card ${testStatus}">` +
    '<div class="label">Unit Tests</div>' +
    `<div class="value">${formatPct(unitPassRate)}</div>` +
    `<div class="detail">${latest.unit_tests.passed}/${latest.unit_tests.total} passed</div></div>\n` +
    `  <div class="card ${lintStatus}">` +
    '<div class="label">Lint Findings</div>' +
    `<div class="value">${latest.code_quality.lint_findings}</div>` +
    `<div class="detail">Golden: ${bl.lint_findings}</div></div>\n` +
    '  <div class="card good">' +
    '<div class="label">Execution Time</div>' +
    `<div class="value">${formatSecondsAsMinutes(latest.metrics.execution_time_seconds)}</div>` +
    `<div class="detail">Golden: ${bl.execution_time_seconds ? formatSecondsAsMinutes(bl.execution_time_seconds) : "—"}</div></div>\n` +
    '  <div class="card good">' +
    '<div class="label">Total Tokens</div>' +
    `<div class="value">${formatNumber(latest.metrics.total_tokens)}</div>` +
    `<div class="detail">Golden: ${bl.total_tokens ? formatNumber(bl.total_tokens) : "—"}</div></div>\n` +
    "</div>\n";

  // Detail table (render_html.py:321-374)
  const rows: [string, string, string, string][] = [
    [
      "Unit test pass rate",
      bl.unit_tests_total
        ? `${formatPct(bl.unit_tests_passed / bl.unit_tests_total)} (${bl.unit_tests_passed}/${bl.unit_tests_total})`
        : _bl(bl.unit_tests_passed),
      latest.unit_tests.total
        ? `${formatPct(unitPassRate)} (${latest.unit_tests.passed}/${latest.unit_tests.total})`
        : "0",
      bl.unit_tests_total && unitPassRate === blUnitPassRate
        ? "="
        : bl.unit_tests_total
          ? `${pySignedFixed((unitPassRate - blUnitPassRate) * 100, 1)}%`
          : "—",
    ],
    [
      "Contract tests",
      bl.contract_tests_total ? `${bl.contract_tests_passed}/${bl.contract_tests_total}` : "—",
      `${latest.contract_tests.passed}/${latest.contract_tests.total}`,
      _fmtIntDelta(latest.contract_tests.passed, bl.contract_tests_passed),
    ],
    [
      "Lint findings",
      String(bl.lint_findings),
      String(latest.code_quality.lint_findings),
      _fmtIntDelta(latest.code_quality.lint_findings, bl.lint_findings),
    ],
    [
      "Qualitative score",
      bl.qualitative_overall ? pyFixed(bl.qualitative_overall, 3) : "—",
      pyFixed(latest.qualitative.overall_score, 3),
      bl.qualitative_overall
        ? pySignedFixed(latest.qualitative.overall_score - bl.qualitative_overall, 3)
        : "—",
    ],
    [
      "Execution time",
      bl.execution_time_seconds ? formatSecondsAsMinutes(bl.execution_time_seconds) : "—",
      formatSecondsAsMinutes(latest.metrics.execution_time_seconds),
      _fmtTimeDelta(latest.metrics.execution_time_seconds, bl.execution_time_seconds),
    ],
    [
      "Total tokens",
      bl.total_tokens ? formatNumber(bl.total_tokens) : "—",
      formatNumber(latest.metrics.total_tokens),
      _fmtTokenDeltaHtml(latest.metrics.total_tokens, bl.total_tokens),
    ],
  ];

  // Metrics where lower values are better — a negative delta is good (green).
  // (render_html.py:377)
  const lowerIsBetter = new Set(["lint findings", "execution time", "total tokens"]);

  const tableRows: string[][] = [];
  const tableStyles: string[][] = [];
  for (const [label, golden, latestVal, vs] of rows) {
    tableRows.push([label, golden, latestVal, vs]);
    // Color the delta column based on metric direction (render_html.py:383-393).
    // U+2212 is the MINUS SIGN '−' (distinct from ASCII hyphen-minus '-').
    let deltaCls = "";
    if (
      vs !== "=" &&
      vs !== "—" &&
      (vs.startsWith("+") || vs.startsWith("-") || vs.startsWith("−"))
    ) {
      const isNegative = vs.startsWith("-") || vs.startsWith("−");
      if (lowerIsBetter.has(label.toLowerCase())) {
        deltaCls = isNegative ? "d-pos" : "d-neg";
      } else {
        deltaCls = isNegative ? "d-neg" : "d-pos";
      }
    }
    tableStyles.push(["", "", "", deltaCls]);
  }

  // render_html.py:395-406
  const metricGuide =
    '<p class="section-desc">High-level snapshot comparing the latest release against the ' +
    "golden baseline (the reference evaluation used as the quality target).</p>\n" +
    "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n" +
    "<tr><td><strong>Unit test pass rate</strong></td><td>Percentage of generated unit tests that pass. Higher means more reliable code generation.</td></tr>\n" +
    "<tr><td><strong>Contract tests</strong></td><td>API compliance checks against the OpenAPI spec (passed/total). 88/88 = full compliance.</td></tr>\n" +
    "<tr><td><strong>Lint findings</strong></td><td>Static analysis warnings in generated code. Lower is better &mdash; 0 means clean code.</td></tr>\n" +
    "<tr><td><strong>Qualitative score</strong></td><td>AI-graded documentation quality on a 0&ndash;1 scale (higher is better).</td></tr>\n" +
    "<tr><td><strong>Execution time</strong></td><td>Wall-clock time for the full evaluation run. Lower means faster generation.</td></tr>\n" +
    "<tr><td><strong>Total tokens</strong></td><td>Total LLM tokens consumed (input + output). Lower means more cost-efficient.</td></tr>\n" +
    "</tbody>\n</table>\n";

  // render_html.py:408-417
  const html =
    '<h2 id="a-executive-summary">A. Executive Summary</h2>\n' +
    cards +
    metricGuide +
    _htmlTable(
      ["Metric", "Golden", `Latest (${escape(latest.label)})`, "vs Golden"],
      tableRows,
      tableStyles,
    );
  return html;
}

// ---------------------------------------------------------------------------
// Section B (render_html.py:426-506)
// ---------------------------------------------------------------------------

function _renderHtmlSectionB(trend: TrendData): string {
  const parts: string[] = ['<h2 id="b-functional-correctness">B. Functional Correctness</h2>\n'];
  parts.push(
    '<p class="section-desc">Measures whether the code generated by each rules version actually works correctly. ' +
      "This is the most fundamental quality gate &mdash; code that doesn&rsquo;t pass its own tests is broken.</p>\n",
  );

  // B.1 Unit tests with bar chart
  parts.push("<h3>B.1 Unit Tests</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Unit tests validate individual functions and components in isolation. " +
      "The AIDLC rules instruct the AI to generate both source code and test suites.</p>\n" +
      "<p><strong>Pass/Total</strong> = tests that passed out of total generated. " +
      "<strong>Rate</strong> = pass percentage (100% = all tests passing). " +
      "<strong>Failures</strong> = tests that ran but produced wrong results.</p>\n",
  );
  parts.push("</div>\n<div>\n");

  let rows: string[][] = [];
  let styles: string[][] = [];
  for (const r of trend.runs) {
    const rate = r.unit_tests.total > 0 ? r.unit_tests.passed / r.unit_tests.total : 0.0;
    const cls = _scoreClass(rate);
    const failCls = r.unit_tests.failed > 0 ? "d-neg" : "";
    rows.push([
      r.label,
      `${r.unit_tests.passed}/${r.unit_tests.total}`,
      formatPct(rate),
      String(r.unit_tests.failed),
    ]);
    styles.push(["", "", cls, failCls]);
  }
  parts.push(_htmlTable(["Version", "Pass/Total", "Rate", "Failures"], rows, styles));
  parts.push("</div>\n</div>\n");

  // B.2 Contract tests
  parts.push("<h3>B.2 Contract Tests (API Compliance)</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Contract tests verify that the generated API implementation matches its " +
      "OpenAPI specification. Each test sends a request to an endpoint and checks that " +
      "the HTTP status code and response shape match the spec.</p>\n" +
      "<p>88 endpoints are tested per version. " +
      "<strong>Pass/Total</strong> = endpoints that returned the expected status code. " +
      "<strong>Rate</strong> = pass percentage (100% = full spec compliance).</p>\n" +
      "<p><strong>Failures</strong> lists the specific endpoints that deviated from the spec.</p>\n",
  );
  parts.push("</div>\n<div>\n");

  rows = [];
  styles = [];
  for (const r of trend.runs) {
    const rate = r.contract_tests.pass_rate;
    const cls = _scoreClass(rate);
    const failCls = r.contract_tests.failed > 0 ? "d-neg" : "";
    rows.push([
      r.label,
      `${r.contract_tests.passed}/${r.contract_tests.total}`,
      formatPct(rate),
      String(r.contract_tests.failed),
    ]);
    styles.push(["", "", cls, failCls]);
  }
  parts.push(_htmlTable(["Version", "Pass/Total", "Rate", "Failures"], rows, styles));
  parts.push("</div>\n</div>\n");

  for (const r of trend.runs) {
    if (r.contract_tests.failures.length) {
      parts.push(`<div class="callout"><strong>${escape(r.label)} failures:</strong><ul>\n`);
      for (const f of r.contract_tests.failures) {
        parts.push(
          `<li><code>${escape(f.method)} ${escape(f.endpoint)}</code> — ` +
            `expected ${f.expected_status}, got ${f.actual_status} ` +
            `(${escape(f.description)})</li>\n`,
        );
      }
      parts.push("</ul></div>\n");
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section C (render_html.py:514-621)
// ---------------------------------------------------------------------------

function _renderHtmlSectionC(trend: TrendData): string {
  const parts: string[] = ['<h2 id="c-qualitative-evaluation">C. Qualitative Evaluation</h2>\n'];
  parts.push(
    '<p class="section-desc">Measures the quality of generated documentation by comparing it against ' +
      "human-authored reference documents. An AI evaluator scores each document on completeness, accuracy, " +
      "and clarity, producing a 0&ndash;1 score (1.0 = perfect match to reference quality).</p>\n",
  );

  // C.1 Overall
  parts.push("<h3>C.1 Overall Score</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>The weighted average across all evaluated documents. " +
      "This is the single best indicator of how well the rules produce documentation.</p>\n" +
      "<p>Scores above 0.90 are considered strong; below 0.70 signals significant gaps.</p>\n",
  );
  const blScore = trend.baseline.qualitative_overall;
  if (blScore) {
    parts.push(`<p>Golden baseline: <strong>${pyFixed(blScore, 3)}</strong></p>\n`);
  }
  parts.push("</div>\n<div>\n");

  let rows: string[][] = [];
  let styles: string[][] = [];
  for (const r of trend.runs) {
    const s = r.qualitative.overall_score;
    const delta = blScore ? s - blScore : 0;
    rows.push([r.label, pyFixed(s, 3), blScore ? pySignedFixed(delta, 3) : "—"]);
    styles.push(["", _scoreClass(s), _deltaClass(delta)]);
  }
  parts.push(_htmlTable(["Version", "Overall", "vs Golden"], rows, styles));
  parts.push("</div>\n</div>\n");

  // C.2 Phase breakdown
  parts.push("<h3>C.2 Phase Breakdown</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Documents are grouped by SDLC phase. " +
      "<strong>Inception</strong> covers early-stage design artifacts (requirements, architecture plans, " +
      "component designs) &mdash; these are generated first and set the foundation.</p>\n" +
      "<p><strong>Construction</strong> covers build-time artifacts (build instructions, test instructions, " +
      "build-and-test summaries) &mdash; these depend on inception outputs being correct.</p>\n" +
      "<p>A drop in inception quality often cascades into construction.</p>\n",
  );
  parts.push("</div>\n<div>\n");
  rows = [];
  styles = [];
  for (const r of trend.runs) {
    const inc = r.qualitative.inception_score;
    const con = r.qualitative.construction_score;
    rows.push([r.label, pyFixed(inc, 3), pyFixed(con, 3)]);
    styles.push(["", _scoreClass(inc), _scoreClass(con)]);
  }
  parts.push(_htmlTable(["Version", "Inception", "Construction"], rows, styles));
  parts.push("</div>\n</div>\n");

  // C.3 Per-document heatmap
  parts.push("<h3>C.3 Per-Document Heatmap</h3>\n");
  parts.push(
    '<p class="section-desc">Individual quality scores for each generated document across all versions. ' +
      "This reveals which specific documents are consistently strong, improving, or problematic. " +
      "Documents scoring below 0.70 (red) are the top candidates for rules improvements.</p>\n",
  );
  const [allDocs, labels, matrix] = _buildHeatmap(trend);
  const header = ["Document", ...labels];
  rows = [];
  styles = [];
  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i]!;
    const row: string[] = [`<code>${escape(doc)}</code>`];
    const rowStyles: string[] = [""];
    for (const score of matrix[i]!) {
      if (score < 0) {
        row.push('<span class="na">—</span>');
        rowStyles.push("");
      } else {
        row.push(pyFixed(score, 2));
        rowStyles.push(_scoreClass(score));
      }
    }
    rows.push(row);
    styles.push(rowStyles);
  }
  parts.push(_htmlTable(header, rows, styles));
  parts.push(
    '<p class="section-desc">' +
      '<span class="badge badge-pass">green &ge; 0.90</span> ' +
      '<span class="badge badge-warn">yellow 0.70–0.89</span> ' +
      '<span class="badge badge-fail">red &lt; 0.70</span></p>\n',
  );

  // C.4 Coverage
  parts.push("<h3>C.4 Document Coverage</h3>\n");
  parts.push(
    '<p class="section-desc">Tracks whether the generated output includes the same set of documents as the reference. ' +
      "<strong>Unmatched Ref</strong> = reference documents the AI failed to generate (missing output). " +
      "<strong>Unmatched Candidate</strong> = extra documents the AI generated that don&rsquo;t exist in the reference " +
      "(unexpected output). Ideally both columns are 0, meaning the AI produced exactly the expected set of documents.</p>\n",
  );
  rows = [];
  styles = [];
  for (const r of trend.runs) {
    const refN = r.qualitative.unmatched_reference_docs.length;
    const candN = r.qualitative.unmatched_candidate_docs.length;
    rows.push([r.label, String(refN), String(candN)]);
    styles.push(["", refN > 0 ? "d-neg" : "", candN > 0 ? "d-neg" : ""]);
  }
  parts.push(_htmlTable(["Version", "Unmatched Ref", "Unmatched Candidate"], rows, styles));

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section D (render_html.py:629-726)
// ---------------------------------------------------------------------------

function _renderHtmlSectionD(trend: TrendData): string {
  const parts: string[] = ['<h2 id="d-efficiency-cost-metrics">D. Efficiency &amp; Cost Metrics</h2>\n'];
  parts.push(
    '<p class="section-desc">Tracks the computational resources consumed by each evaluation run. ' +
      "These metrics directly affect cost (tokens) and developer wait time (execution time). " +
      "Lower values are generally better, as long as quality metrics remain stable.</p>\n",
  );

  // D.1 Token consumption with bars
  parts.push("<h3>D.1 Token Consumption</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Total LLM tokens consumed during the run, broken down by agent. " +
      "<strong>Total</strong> = all tokens across all agents (input + output).</p>\n" +
      "<p><strong>Executor</strong> = the agent that generates code and documents. " +
      "<strong>Simulator</strong> = the agent that simulates user interactions for testing.</p>\n" +
      "<p>Token count is the primary cost driver &mdash; each token represents a unit of " +
      "LLM usage billed by the provider.</p>\n",
  );
  parts.push("</div>\n<div>\n");
  // max(..., default=1): when there are no runs, default to 1 (render_html.py:649).
  const maxTok = trend.runs.length
    ? Math.max(...trend.runs.map((r) => r.metrics.total_tokens))
    : 1;
  let rows: string[][] = [];
  let styles: string[][] = [];
  for (const r of trend.runs) {
    const pct = maxTok ? (r.metrics.total_tokens / maxTok) * 100 : 0;
    const agentMap: Record<string, string> = {};
    for (const a of r.metrics.agent_tokens) {
      agentMap[a.agent_name] = formatNumber(a.total_tokens);
    }
    const barHtml = `<span class="bar" style="width:${pyFixed(pct, 0)}%"></span>`;
    rows.push([
      r.label,
      barHtml,
      formatNumber(r.metrics.total_tokens),
      agentMap.executor ?? "—",
      agentMap.simulator ?? "—",
    ]);
    styles.push(["", "bar-cell", "", "", ""]);
  }
  parts.push(_htmlTable(["Version", "", "Total", "Executor", "Simulator"], rows, styles));
  parts.push("</div>\n</div>\n");

  // D.2 Execution time with bars
  parts.push("<h3>D.2 Execution Time</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Wall-clock duration of the full evaluation pipeline, broken down by handoff. " +
      "Each <strong>handoff</strong> (H1, H2, H3) represents a sequential phase.</p>\n" +
      "<p>H1 is typically code generation (the longest phase), H2 is build/test execution, " +
      "and H3 is result collection and reporting.</p>\n" +
      "<p><strong>Wall Clock</strong> is the total end-to-end time.</p>\n",
  );
  parts.push("</div>\n<div>\n");
  const maxTime = trend.runs.length
    ? Math.max(...trend.runs.map((r) => r.metrics.execution_time_seconds))
    : 1;
  rows = [];
  styles = [];
  for (const r of trend.runs) {
    const pct = maxTime ? (r.metrics.execution_time_seconds / maxTime) * 100 : 0;
    const barHtml = `<span class="bar" style="width:${pyFixed(pct, 0)}%"></span>`;
    const handoffStrs = r.metrics.handoffs.map(
      (h) => `H${h.handoff_number}: ${formatSecondsAsMinutes(h.duration_seconds)}`,
    );
    rows.push([
      r.label,
      barHtml,
      formatSecondsAsMinutes(r.metrics.execution_time_seconds),
      handoffStrs.length ? handoffStrs.join(" · ") : "—",
    ]);
    styles.push(["", "bar-cell", "", ""]);
  }
  parts.push(_htmlTable(["Version", "", "Wall Clock", "Handoff Breakdown"], rows, styles));
  parts.push("</div>\n</div>\n");

  // D.3 Context window
  parts.push("<h3>D.3 Context Window Pressure</h3>\n");
  parts.push('<div class="split">\n<div class="split-desc">\n');
  parts.push(
    "<p>Measures how much of the LLM&rsquo;s context window is being used across API calls. " +
      "<strong>Max</strong> = the largest single context seen during the run (approaching the " +
      "model&rsquo;s limit risks truncation or degraded output).</p>\n" +
      "<p><strong>Avg</strong> = the mean context size across all API calls. " +
      "<strong>Median</strong> = the midpoint context size (less affected by outliers than avg).</p>\n" +
      "<p>High context pressure can indicate overly verbose prompts or accumulated conversation history.</p>\n",
  );
  parts.push("</div>\n<div>\n");
  const ctxRows: string[][] = trend.runs.map((r) => [
    r.label,
    formatNumber(r.metrics.max_context_tokens),
    // avg/median context are Python floats — wrap so format_number routes
    // through the float branches (render_html.py:719-720).
    formatNumber(new PyFloat(r.metrics.avg_context_tokens)),
    formatNumber(new PyFloat(r.metrics.median_context_tokens)),
  ]);
  parts.push(_htmlTable(["Version", "Max", "Avg", "Median"], ctxRows));
  parts.push("</div>\n</div>\n");

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section E (render_html.py:734-761)
// ---------------------------------------------------------------------------

function _renderHtmlSectionE(trend: TrendData): string {
  const parts: string[] = ['<h2 id="e-code-quality">E. Code Quality</h2>\n'];
  parts.push(
    '<p class="section-desc">Static analysis of the generated codebase. These metrics reflect the cleanliness and ' +
      "maintainability of the AI-generated code, independent of whether it passes tests.</p>\n" +
      "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n" +
      "<tr><td><strong>Lint Findings</strong></td><td>Warnings from static analysis (style violations, unused variables, etc.). 0 = clean.</td></tr>\n" +
      "<tr><td><strong>Security Findings</strong></td><td>Vulnerabilities detected by security scanners (SQL injection, XSS, etc.). N/A if no scanner was configured.</td></tr>\n" +
      "<tr><td><strong>Source Files</strong></td><td>Number of non-test source files in the generated project.</td></tr>\n" +
      "<tr><td><strong>LOC</strong></td><td>Total lines of code across all source files. Large swings may indicate generated boilerplate or missing modules.</td></tr>\n" +
      "</tbody>\n</table>\n",
  );
  const rows: string[][] = trend.runs.map((r) => [
    r.label,
    String(r.code_quality.lint_findings),
    r.code_quality.security_scanner_available
      ? String(r.code_quality.security_findings)
      : '<span class="na">N/A</span>',
    String(r.code_quality.source_file_count),
    formatNumber(r.code_quality.total_lines_of_code),
  ]);
  parts.push(
    _htmlTable(["Version", "Lint Findings", "Security Findings", "Source Files", "LOC"], rows),
  );
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section F (render_html.py:769-830)
// ---------------------------------------------------------------------------

function _renderHtmlSectionF(trend: TrendData): string {
  const parts: string[] = ['<h2 id="f-stability-reliability">F. Stability &amp; Reliability</h2>\n'];
  parts.push(
    '<p class="section-desc">Tracks whether the evaluation pipeline itself ran smoothly, independent of output quality.</p>\n' +
      "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n" +
      "<tr><td><strong>Infra Failure</strong></td><td>Whether infrastructure issues (Bedrock outage, throttling) invalidated the run.</td></tr>\n" +
      "<tr><td><strong>Total Errors</strong></td><td>Sum of all runtime error events. 0 = clean run.</td></tr>\n" +
      "<tr><td><strong>Throttle</strong></td><td>Bedrock API throttle (rate limit) events.</td></tr>\n" +
      "<tr><td><strong>Svc Unavail</strong></td><td>Bedrock service unavailable events.</td></tr>\n" +
      "<tr><td><strong>Model Error</strong></td><td>Bedrock model error events.</td></tr>\n" +
      "<tr><td><strong>Handoffs</strong></td><td>Number of sequential pipeline phases completed. Typically 3.</td></tr>\n" +
      "<tr><td><strong>Server Startup</strong></td><td>Whether the generated application server started successfully.</td></tr>\n" +
      "</tbody>\n</table>\n",
  );
  const rows: string[][] = [];
  const styles: string[][] = [];
  for (const r of trend.runs) {
    const ok = r.metrics.server_startup_success;
    const infraHtml = r.infra_failure.is_infra_failure
      ? '<span class="badge badge-infra">INFRA FAIL</span>'
      : '<span class="badge badge-pass">OK</span>';
    const errCls = r.metrics.error_count > 0 ? "d-neg" : "";
    const throttleCls = r.metrics.throttle_events > 0 ? "d-neg" : "";
    const svcCls = r.metrics.service_unavailable_events > 0 ? "d-neg" : "";
    const modelCls = r.metrics.model_error_events > 0 ? "d-neg" : "";
    const okHtml = ok
      ? '<span class="badge badge-pass">PASS</span>'
      : '<span class="badge badge-fail">FAIL</span>';
    rows.push([
      r.label,
      infraHtml,
      String(r.metrics.error_count),
      String(r.metrics.throttle_events),
      String(r.metrics.service_unavailable_events),
      String(r.metrics.model_error_events),
      String(r.metrics.num_handoffs),
      okHtml,
    ]);
    styles.push(["", "", errCls, throttleCls, svcCls, modelCls, "", ""]);
  }
  parts.push(
    _htmlTable(
      [
        "Version",
        "Infra Status",
        "Total Errors",
        "Throttle",
        "Svc Unavail",
        "Model Error",
        "Handoffs",
        "Server Startup",
      ],
      rows,
      styles,
    ),
  );
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section G (render_html.py:838-886)
// ---------------------------------------------------------------------------

function _renderHtmlSectionG(trend: TrendData): string {
  const parts: string[] = [
    '<h2 id="g-version-over-version-deltas">G. Version-over-Version Deltas</h2>\n',
  ];
  const deltas: VersionDelta[] = computeDeltas(trend.runs);
  if (deltas.length === 0) {
    parts.push("<p>Not enough data points.</p>\n");
    return parts.join("");
  }

  parts.push(
    '<p class="section-desc">Each row shows the change from one release to the next, making it easy to spot ' +
      "which specific version introduced an improvement or regression. " +
      "Positive values (+) indicate an increase; negative (&minus;) indicate a decrease. " +
      "For <strong>Unit Tests</strong> and <strong>Contract</strong>, positive is better (more tests passing). " +
      "For <strong>Qualitative</strong>, positive is better (higher quality score). " +
      "For <strong>Tokens</strong> and <strong>Time</strong>, negative is better (more efficient).</p>\n",
  );

  const rows: string[][] = [];
  const styles: string[][] = [];
  for (const d of deltas) {
    const tokStr = _fmtSignedNumber(d.token_delta);
    // format_delta(time_delta_seconds, precision=0) — time_delta is a Python
    // float, so wrap to route through the float branch ("{:+.0f}").
    const timeStr = `${formatDelta(new PyFloat(d.time_delta_seconds), 0)}s`;
    rows.push([
      `${d.from_label} &rarr; ${d.to_label}`,
      // unit/contract deltas are Python ints → format_delta "{:+d}".
      formatDelta(d.unit_tests_delta),
      formatDelta(d.contract_tests_delta),
      // qualitative delta is a Python float → "{:+.3f}".
      formatDelta(new PyFloat(d.qualitative_delta), 3),
      tokStr,
      timeStr,
    ]);
    styles.push([
      "",
      _deltaClass(d.unit_tests_delta),
      _deltaClass(d.contract_tests_delta),
      _deltaClass(d.qualitative_delta),
      _deltaClass(-d.token_delta),
      _deltaClass(-d.time_delta_seconds),
    ]);
  }
  parts.push(
    _htmlTable(
      ["Transition", "Unit Tests", "Contract", "Qualitative", "Tokens", "Time"],
      rows,
      styles,
    ),
  );
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Section H (render_html.py:894-918)
// ---------------------------------------------------------------------------

function _renderHtmlSectionH(trend: TrendData): string {
  const preRelease = trend.runs.filter(
    (r) => r.run_type === RunType.MAIN || r.run_type === RunType.PR,
  );

  const html =
    '<h2 id="h-pre-release-data-points">H. Pre-Release Data Points</h2>\n' +
    '<p class="section-desc">Evaluation results from non-release sources &mdash; the <code>main</code> branch ' +
    "and open pull requests. These represent in-progress work that hasn&rsquo;t been tagged as a release yet. " +
    "Use this data to preview whether upcoming changes will improve or regress metrics before they ship.</p>\n";
  if (preRelease.length === 0) {
    return html + '<p class="section-desc">No pre-release data available.</p>\n';
  }

  const rows: string[][] = preRelease.map((r) => [
    r.label,
    r.unit_tests.total > 0
      ? `${formatPct(r.unit_tests.passed / r.unit_tests.total)} (${r.unit_tests.passed}/${r.unit_tests.total})`
      : "0",
    `${r.contract_tests.passed}/${r.contract_tests.total}`,
    pyFixed(r.qualitative.overall_score, 3),
    formatNumber(r.metrics.total_tokens),
  ]);
  return (
    html + _htmlTable(["Source", "Unit Tests", "Contract", "Qualitative", "Tokens"], rows)
  );
}

// ---------------------------------------------------------------------------
// Utilities (render_html.py:926-1026)
// ---------------------------------------------------------------------------

// render_html.py:926-931
function _scoreClass(score: number): string {
  if (score >= 0.9) return "s-green";
  if (score >= 0.7) return "s-yellow";
  return "s-red";
}

// render_html.py:934-939
function _deltaClass(delta: number): string {
  if (delta > 0) return "d-pos";
  if (delta < 0) return "d-neg";
  return "";
}

// render_html.py:942-962
function _htmlTable(
  headers: string[],
  rows: string[][],
  cellStyles?: string[][],
): string {
  const lines: string[] = ["<table>\n<thead>\n<tr>"];
  for (const h of headers) {
    lines.push(`  <th>${h}</th>`);
  }
  lines.push("</tr>\n</thead>\n<tbody>");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    lines.push("<tr>");
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]!;
      let cls = "";
      if (cellStyles && i < cellStyles.length && j < cellStyles[i]!.length) {
        const clsName = cellStyles[i]![j]!;
        if (clsName) {
          cls = ` class="${clsName}"`;
        }
      }
      lines.push(`  <td${cls}>${cell}</td>`);
    }
    lines.push("</tr>");
  }
  lines.push("</tbody>\n</table>\n");
  return lines.join("\n");
}

// render_html.py:965-986
function _buildHeatmap(trend: TrendData): [string[], string[], number[][]] {
  // sorted({...}) — unique document names, then sorted ascending (Python str sort
  // is by Unicode code point, matching default JS Array.sort on strings for ASCII;
  // use a code-unit comparator to mirror Python's bytewise ordering).
  const docSet = new Set<string>();
  for (const run of trend.runs) {
    for (const ds of run.qualitative.document_scores) {
      docSet.add(ds.document_name);
    }
  }
  const allDocs = [...docSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = trend.runs.map((r) => r.label);
  const matrix: number[][] = [];
  for (const doc of allDocs) {
    const row: number[] = [];
    for (const run of trend.runs) {
      // next((ds.overall_score ... if name matches), -1.0)
      let score = -1.0;
      for (const ds of run.qualitative.document_scores) {
        if (ds.document_name === doc) {
          score = ds.overall_score;
          break;
        }
      }
      row.push(score);
    }
    matrix.push(row);
  }
  return [allDocs, labels, matrix];
}

// render_html.py:989-993 — format a baseline value, returning '—' ONLY when
// truly None. A zero baseline yields '0' (DIFFERENT from md). val is never
// null/undefined in the TS port's BaselineMetrics (all numeric), but mirror the
// None guard for faithfulness.
function _bl(val: number | null | undefined): string {
  if (val === null || val === undefined) {
    return "—";
  }
  return String(val);
}

// render_html.py:996-1002
function _fmtIntDelta(current: number, baseline: number | null | undefined): string {
  if (baseline === null || baseline === undefined) {
    return "—";
  }
  const delta = current - baseline;
  if (delta === 0) {
    return "=";
  }
  // "{:+d}" — always-signed integer.
  return delta >= 0 ? `+${delta}` : String(delta);
}

// render_html.py:1005-1009
function _fmtTimeDelta(currentS: number, baselineS: number): string {
  // `if not baseline_s` — 0/falsy → '—'.
  if (!baselineS) {
    return "—";
  }
  const deltaM = (currentS - baselineS) / 60;
  return `${pySignedFixed(deltaM, 1)}m`;
}

// render_html.py:1012-1016
function _fmtTokenDeltaHtml(current: number, baseline: number): string {
  if (!baseline) {
    return "—";
  }
  const delta = current - baseline;
  return _fmtSignedNumber(delta);
}

// render_html.py:1019-1026 — sign is '+' for n >= 0 (incl 0), else '' (the value
// already carries '-'). M/K formatting via pyFixed (round-half-to-even).
function _fmtSignedNumber(n: number): string {
  const sign = n >= 0 ? "+" : "";
  const absN = Math.abs(n);
  if (absN >= 1_000_000) {
    return `${sign}${pyFixed(n / 1_000_000, 2)}M`;
  }
  if (absN >= 1_000) {
    return `${sign}${pyFixed(n / 1_000, 1)}K`;
  }
  return `${sign}${n}`;
}
