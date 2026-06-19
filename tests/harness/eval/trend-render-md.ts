// trend-render-md.ts — Markdown trend report renderer.
//
// Faithful 1:1 port of
// /Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/
//   packages/trend-reports/src/trend_reports/render_md.py (read in full, 694 lines).
//
// render_trend_markdown(trend) → string, assembled from a header, optional infra
// banner, a TOC, and sections A–H, joined by "\n" with a trailing "\n"
// (render_md.py:17-32).
//
// Numeric formatting goes through the shared substrate:
//   - f-string `{:.3f}` / `{:+.3f}` → pyFixed / pySignedFixed (CPython
//     round-half-to-even), never JS toFixed.
//   - format_delta / format_number / format_pct / format_seconds_as_minutes /
//     sparkline / trend_arrow come from trend-sparkline.ts.
//   - compute_deltas comes from trend-collector.ts (exported as computeDeltas).
//
// _md_table uses Python str.ljust → JS String.prototype.padEnd. Both pad to a
// width measured in code units; the only non-ASCII glyphs that flow through a
// table cell are the sparkline ramp (▁▂▃▄▅▆▇█) and trend arrows (↑↗→↘↓) in
// Section A's Trend column — all BMP single-code-unit characters, so JS .length
// equals Python len() and the alignment matches. (render_md.py:606-630)
//
// Source-of-truth citations are at render_md.py:<line> on each construct.

import { pyFixed, pySignedFixed } from "./pyutil.ts";
import { computeDeltas } from "./trend-collector.ts";
import { type RunData, RunType, type TrendData } from "./trend-models.ts";
import {
  formatDelta,
  formatNumber,
  formatPct,
  formatSecondsAsMinutes,
  type PyNum,
  sparkline,
  trendArrow,
} from "./trend-sparkline.ts";
import { PyFloat } from "./yaml.ts";

/** Render the full trend report as Markdown. (render_md.py:17-32) */
export function renderTrendMarkdown(trend: TrendData): string {
  const sections = [
    renderHeader(trend),
    renderInfraFailureBanner(trend),
    renderToc(),
    renderSectionA(trend),
    renderSectionB(trend),
    renderSectionC(trend),
    renderSectionD(trend),
    renderSectionE(trend),
    renderSectionF(trend),
    renderSectionG(trend),
    renderSectionH(trend),
  ];
  return `${sections.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Header & TOC
// ---------------------------------------------------------------------------

/** render_md.py:40-49 */
function renderHeader(trend: TrendData): string {
  const n = trend.runs.length;
  const first = trend.runs.length ? trend.runs[0]!.label : "—";
  const last = trend.runs.length ? trend.runs[trend.runs.length - 1]!.label : "—";
  return (
    "# AIDLC Rules Trend Report\n\n" +
    `> **${n} releases** compared (${first} through ${last})  \n` +
    `> **Repository:** \`${trend.repo}\`  \n` +
    `> **Generated:** ${trend.generated_at}\n`
  );
}

/** Render a prominent warning banner if any runs have infra failures. (render_md.py:52-71) */
function renderInfraFailureBanner(trend: TrendData): string {
  const infraRuns = trend.runs.filter((r) => r.infra_failure.is_infra_failure);
  if (infraRuns.length === 0) {
    return "";
  }

  const lines = [
    "> **WARNING: Infrastructure Failure Detected**",
    ">",
    "> The following runs experienced infrastructure failures. " +
      "Their results are unreliable and have been excluded from regression checks.",
    ">",
  ];
  for (const r of infraRuns) {
    const reasons = r.infra_failure.reasons.map((reason) => reason as string).join(", ");
    lines.push(`> - **${r.label}**: ${reasons}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** render_md.py:74-85 */
function renderToc(): string {
  return (
    "## Contents\n\n" +
    "- [A. Executive Summary](#a-executive-summary)\n" +
    "- [B. Functional Correctness](#b-functional-correctness)\n" +
    "- [C. Qualitative Evaluation](#c-qualitative-evaluation)\n" +
    "- [D. Efficiency & Cost](#d-efficiency--cost-metrics)\n" +
    "- [E. Code Quality](#e-code-quality)\n" +
    "- [F. Stability & Reliability](#f-stability--reliability)\n" +
    "- [G. Version-over-Version Deltas](#g-version-over-version-deltas)\n" +
    "- [H. Pre-Release Data Points](#h-pre-release-data-points)\n"
  );
}

// ---------------------------------------------------------------------------
// Section A — Executive Summary
// ---------------------------------------------------------------------------

/** render_md.py:93-176 */
function renderSectionA(trend: TrendData): string {
  const runs = trend.runs;
  const bl = trend.baseline;
  const latest = runs.length ? runs[runs.length - 1]! : null;
  if (latest === null) {
    return "---\n\n## A. Executive Summary\n\nNo data available.\n";
  }

  // render_md.py:100-102 — `\`{sparkline}\` {arrow}`.
  const spark = (extractor: (r: RunData) => number): string => {
    const vals = runs.map((r) => extractor(r));
    return `\`${sparkline(vals)}\` ${trendArrow(vals)}`;
  };

  // render_md.py:104-105 — falsy baseline (0) renders "—"; the formatter is
  // `str` by default (here every call site uses str).
  const blStr = (val: number): string => (val ? String(val) : "—");

  const rows: string[][] = [
    [
      "Unit tests passed",
      blStr(bl.unit_tests_passed),
      String(latest.unit_tests.passed),
      fmtVs(latest.unit_tests.passed, bl.unit_tests_passed),
      spark((r) => r.unit_tests.passed),
    ],
    [
      "Contract tests",
      bl.contract_tests_total
        ? `${bl.contract_tests_passed}/${bl.contract_tests_total}`
        : "—",
      `${latest.contract_tests.passed}/${latest.contract_tests.total}`,
      fmtVs(latest.contract_tests.passed, bl.contract_tests_passed),
      spark((r) => r.contract_tests.passed),
    ],
    [
      "Lint findings",
      String(bl.lint_findings),
      String(latest.code_quality.lint_findings),
      fmtVs(latest.code_quality.lint_findings, bl.lint_findings, true),
      spark((r) => r.code_quality.lint_findings),
    ],
    [
      "Qualitative score",
      // render_md.py:133 — `{bl.qualitative_overall:.3f}` if truthy else "—".
      bl.qualitative_overall ? pyFixed(bl.qualitative_overall, 3) : "—",
      pyFixed(latest.qualitative.overall_score, 3),
      // render_md.py:135-137 — signed 3dp diff if baseline truthy else "—".
      bl.qualitative_overall
        ? pySignedFixed(latest.qualitative.overall_score - bl.qualitative_overall, 3)
        : "—",
      spark((r) => r.qualitative.overall_score),
    ],
    [
      "Execution time",
      bl.execution_time_seconds ? formatSecondsAsMinutes(bl.execution_time_seconds) : "—",
      formatSecondsAsMinutes(latest.metrics.execution_time_seconds),
      fmtTimeVs(latest.metrics.execution_time_seconds, bl.execution_time_seconds),
      spark((r) => r.metrics.execution_time_seconds),
    ],
    [
      "Total tokens",
      bl.total_tokens ? formatNumber(bl.total_tokens) : "—",
      formatNumber(latest.metrics.total_tokens),
      fmtTokenVs(latest.metrics.total_tokens, bl.total_tokens),
      spark((r) => r.metrics.total_tokens),
    ],
  ];

  return (
    "---\n\n" +
    "## A. Executive Summary\n\n" +
    `Latest release: **${latest.label}**\n\n` +
    "High-level snapshot comparing the latest release against the golden baseline " +
    "(the reference evaluation used as the quality target).\n\n" +
    "| Metric | What it measures |\n" +
    "| --- | --- |\n" +
    "| **Unit tests passed** | Number of generated unit tests that pass. Higher means the rules produce broader, more complete test suites. |\n" +
    "| **Contract tests** | API compliance checks against the OpenAPI spec (passed/total). 88/88 = full compliance. |\n" +
    "| **Lint findings** | Static analysis warnings in generated code. Lower is better — 0 means clean code. |\n" +
    "| **Qualitative score** | AI-graded quality of generated documentation on a 0–1 scale (higher is better). |\n" +
    "| **Execution time** | Wall-clock time for the full evaluation run. Lower means faster generation. |\n" +
    "| **Total tokens** | Total LLM tokens consumed (input + output). Lower means more cost-efficient. |\n\n" +
    mdTable(["Metric", "Golden", `Latest (${latest.label})`, "vs Golden", "Trend"], rows)
  );
}

// ---------------------------------------------------------------------------
// Section B — Functional Correctness
// ---------------------------------------------------------------------------

/** render_md.py:184-239 */
function renderSectionB(trend: TrendData): string {
  const parts: string[] = ["---\n\n## B. Functional Correctness\n"];

  parts.push(
    "Measures whether the code generated by each rules version actually works correctly. " +
      "This is the most fundamental quality gate — code that doesn't pass its own tests is broken.\n",
  );

  // B.1 Unit tests
  parts.push("### B.1 Unit Tests\n");
  parts.push(
    "Unit tests validate individual functions and components in isolation. " +
      "The AIDLC rules instruct the AI to generate both source code and test suites. " +
      "**Passed** = tests that ran and succeeded. " +
      "**Failed** = tests that ran but produced wrong results. " +
      "**Total** = passed + failed + errors + skipped. " +
      "All versions currently show 0 failures — the variance is in how many " +
      "tests the rules produce, which reflects test suite breadth and coverage.\n\n",
  );
  let rows: string[][] = trend.runs.map((r) => [
    r.label,
    String(r.unit_tests.passed),
    String(r.unit_tests.failed),
    String(r.unit_tests.total),
  ]);
  parts.push(mdTable(["Version", "Passed", "Failed", "Total"], rows));

  // B.2 Contract tests
  parts.push("\n### B.2 Contract Tests (API Compliance)\n");
  parts.push(
    "Contract tests verify that the generated API implementation matches its OpenAPI specification. " +
      "Each test sends a request to an endpoint and checks that the HTTP status code and response " +
      "shape match the spec. 88 endpoints are tested per version. " +
      "**Pass/Total** = endpoints that returned the expected status code. " +
      "**Rate** = pass percentage (100% = full spec compliance). " +
      "**Failures** lists the specific endpoints that deviated from the spec.\n\n",
  );
  rows = trend.runs.map((r) => [
    r.label,
    `${r.contract_tests.passed}/${r.contract_tests.total}`,
    formatPct(r.contract_tests.pass_rate),
    String(r.contract_tests.failed),
  ]);
  parts.push(mdTable(["Version", "Pass/Total", "Rate", "Failures"], rows));

  for (const r of trend.runs) {
    if (r.contract_tests.failures.length) {
      parts.push(`\n> **${r.label} failures:**\n`);
      for (const f of r.contract_tests.failures) {
        parts.push(
          `> - \`${f.method} ${f.endpoint}\` — expected ${f.expected_status}, ` +
            `got ${f.actual_status} (${f.description})\n`,
        );
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section C — Qualitative Evaluation
// ---------------------------------------------------------------------------

/** render_md.py:247-340 */
function renderSectionC(trend: TrendData): string {
  const parts: string[] = ["---\n\n## C. Qualitative Evaluation\n"];

  parts.push(
    "Measures the quality of generated documentation by comparing it against " +
      "human-authored reference documents. An AI evaluator scores each document on " +
      "completeness, accuracy, and clarity, producing a 0–1 score (1.0 = perfect match " +
      "to reference quality).\n",
  );

  // C.1 Overall
  parts.push("### C.1 Overall Score\n");
  parts.push(
    "The weighted average across all evaluated documents. " +
      "This is the single best indicator of how well the rules produce documentation. " +
      "Scores above 0.90 are considered strong; below 0.70 signals significant gaps.\n\n",
  );
  const blScore = trend.baseline.qualitative_overall;
  if (blScore) {
    parts.push(`Golden baseline: **${pyFixed(blScore, 3)}**\n\n`);
  }
  let rows: string[][] = trend.runs.map((r) => [
    r.label,
    pyFixed(r.qualitative.overall_score, 3),
    blScore ? pySignedFixed(r.qualitative.overall_score - blScore, 3) : "—",
  ]);
  parts.push(mdTable(["Version", "Overall", "vs Golden"], rows));

  // C.2 Phase breakdown
  parts.push("\n### C.2 Phase Breakdown\n");
  parts.push(
    "Documents are grouped by SDLC phase. " +
      "**Inception** covers early-stage design artifacts (requirements, architecture plans, " +
      "component designs) — these are generated first and set the foundation. " +
      "**Construction** covers build-time artifacts (build instructions, test instructions, " +
      "build-and-test summaries) — these depend on inception outputs being correct. " +
      "A drop in inception quality often cascades into construction.\n\n",
  );
  rows = trend.runs.map((r) => [
    r.label,
    pyFixed(r.qualitative.inception_score, 3),
    pyFixed(r.qualitative.construction_score, 3),
  ]);
  parts.push(mdTable(["Version", "Inception", "Construction"], rows));

  // C.3 Per-document heatmap
  parts.push("\n### C.3 Per-Document Heatmap\n");
  parts.push(
    "Individual quality scores for each generated document across all versions. " +
      "This reveals which specific documents are consistently strong, improving, or " +
      "problematic. Documents scoring below 0.70 (bold/red) are the top candidates for " +
      "rules improvements.\n\n",
  );
  const [allDocs, labels, matrix] = buildHeatmapMatrix(trend);
  const header = ["Document", ...labels];
  const heatRows: string[][] = [];
  for (let i = 0; i < allDocs.length; i++) {
    const row: string[] = [`\`${allDocs[i]}\``];
    for (const score of matrix[i]!) {
      // render_md.py:307-314 — thresholds: <0 dash · >=.90 plain · >=.70 italic
      // · else bold. Checks are ordered, so the negative case wins first.
      if (score < 0) {
        row.push("—");
      } else if (score >= 0.9) {
        row.push(pyFixed(score, 2));
      } else if (score >= 0.7) {
        row.push(`*${pyFixed(score, 2)}*`);
      } else {
        row.push(`**${pyFixed(score, 2)}**`);
      }
    }
    heatRows.push(row);
  }
  parts.push(mdTable(header, heatRows));
  parts.push(
    "\n> **Legend:** plain = green (>= 0.90) · *italic* = yellow (0.70–0.89) · **bold** = red (< 0.70)\n",
  );

  // C.4 Document coverage
  parts.push("\n### C.4 Document Coverage\n");
  parts.push(
    "Tracks whether the generated output includes the same set of documents as the reference. " +
      "**Unmatched Ref** = reference documents the AI failed to generate (missing output). " +
      "**Unmatched Candidate** = extra documents the AI generated that don't exist in the reference " +
      "(unexpected output). Ideally both columns are 0, meaning the AI produced exactly the expected " +
      "set of documents.\n\n",
  );
  rows = trend.runs.map((r) => [
    r.label,
    String(r.qualitative.unmatched_reference_docs.length),
    String(r.qualitative.unmatched_candidate_docs.length),
  ]);
  parts.push(mdTable(["Version", "Unmatched Ref", "Unmatched Candidate"], rows));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section D — Efficiency & Cost
// ---------------------------------------------------------------------------

/** render_md.py:348-423 */
function renderSectionD(trend: TrendData): string {
  const parts: string[] = ["---\n\n## D. Efficiency & Cost Metrics\n"];
  parts.push(
    "Tracks the computational resources consumed by each evaluation run. " +
      "These metrics directly affect cost (tokens) and developer wait time (execution time). " +
      "Lower values are generally better, as long as quality metrics remain stable.\n",
  );

  // D.1 Token consumption
  parts.push("### D.1 Token Consumption\n");
  parts.push(
    "Total LLM tokens consumed during the run, broken down by agent. " +
      "**Total** = all tokens across all agents (input + output). " +
      "**Executor** = the agent that generates code and documents. " +
      "**Simulator** = the agent that simulates user interactions for testing. " +
      "Token count is the primary cost driver — each token represents a unit of LLM usage billed by the provider.\n\n",
  );
  let rows: string[][] = [];
  for (const r of trend.runs) {
    const agentCols: Record<string, string> = {};
    for (const a of r.metrics.agent_tokens) {
      agentCols[a.agent_name] = formatNumber(a.total_tokens);
    }
    rows.push([
      r.label,
      formatNumber(r.metrics.total_tokens),
      agentCols.executor ?? "—",
      agentCols.simulator ?? "—",
    ]);
  }
  parts.push(mdTable(["Version", "Total", "Executor", "Simulator"], rows));

  // D.2 Execution time
  parts.push("\n### D.2 Execution Time\n");
  parts.push(
    "Wall-clock duration of the full evaluation pipeline, broken down by handoff. " +
      "Each **handoff** (H1, H2, H3) represents a sequential phase of the pipeline: " +
      "H1 is typically code generation (the longest phase), H2 is build/test execution, " +
      "and H3 is result collection and reporting. " +
      "**Wall Clock** is the total end-to-end time.\n\n",
  );
  rows = [];
  for (const r of trend.runs) {
    const handoffStrs = r.metrics.handoffs.map(
      (h) => `H${h.handoff_number}: ${formatSecondsAsMinutes(h.duration_seconds)}`,
    );
    rows.push([
      r.label,
      formatSecondsAsMinutes(r.metrics.execution_time_seconds),
      handoffStrs.length ? handoffStrs.join(" · ") : "—",
    ]);
  }
  parts.push(mdTable(["Version", "Wall Clock", "Handoff Breakdown"], rows));

  // D.3 Context window
  parts.push("\n### D.3 Context Window Pressure\n");
  parts.push(
    "Measures how much of the LLM's context window is being used across API calls. " +
      "**Max** = the largest single context seen during the run (approaching the model's limit " +
      "risks truncation or degraded output). " +
      "**Avg** = the mean context size across all API calls. " +
      "**Median** = the midpoint context size (less affected by outliers than avg). " +
      "High context pressure can indicate overly verbose prompts or accumulated conversation history.\n\n",
  );
  rows = trend.runs.map((r) => [
    r.label,
    formatNumber(r.metrics.max_context_tokens),
    // avg/median are Python floats; preserve float intent via PyFloat-like wrap.
    formatNumber(asPyNum(r.metrics.avg_context_tokens, true)),
    formatNumber(asPyNum(r.metrics.median_context_tokens, true)),
  ]);
  parts.push(mdTable(["Version", "Max", "Avg", "Median"], rows));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section E — Code Quality
// ---------------------------------------------------------------------------

/** render_md.py:431-461 */
function renderSectionE(trend: TrendData): string {
  const parts: string[] = ["---\n\n## E. Code Quality\n"];
  parts.push(
    "Static analysis of the generated codebase. These metrics reflect the cleanliness and " +
      "maintainability of the AI-generated code, independent of whether it passes tests.\n\n" +
      "| Metric | What it measures |\n" +
      "| --- | --- |\n" +
      "| **Lint Findings** | Warnings from static analysis (style violations, unused variables, etc.). 0 = clean. |\n" +
      "| **Security Findings** | Vulnerabilities detected by security scanners (SQL injection, XSS, etc.). N/A if no scanner was configured. |\n" +
      "| **Source Files** | Number of non-test source files in the generated project. |\n" +
      "| **LOC** | Total lines of code across all source files. Large swings may indicate generated boilerplate or missing modules. |\n\n",
  );
  const rows: string[][] = trend.runs.map((r) => [
    r.label,
    String(r.code_quality.lint_findings),
    r.code_quality.security_scanner_available
      ? String(r.code_quality.security_findings)
      : "N/A",
    String(r.code_quality.source_file_count),
    formatNumber(r.code_quality.total_lines_of_code),
  ]);
  parts.push(
    mdTable(["Version", "Lint Findings", "Security Findings", "Source Files", "LOC"], rows),
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section F — Stability & Reliability
// ---------------------------------------------------------------------------

/** render_md.py:469-511 */
function renderSectionF(trend: TrendData): string {
  const parts: string[] = ["---\n\n## F. Stability & Reliability\n"];
  parts.push(
    "Tracks whether the evaluation pipeline itself ran smoothly, independent of output quality.\n\n" +
      "| Metric | What it measures |\n" +
      "| --- | --- |\n" +
      "| **Infra Failure** | Whether infrastructure issues (Bedrock outage, throttling) invalidated the run. |\n" +
      "| **Total Errors** | Sum of all runtime error events. |\n" +
      "| **Throttle** | Bedrock API throttle (rate limit) events. |\n" +
      "| **Svc Unavail** | Bedrock service unavailable events. |\n" +
      "| **Model Error** | Bedrock model error events. |\n" +
      "| **Handoffs** | Number of sequential pipeline phases completed. Typically 3 (generate, build/test, report). A different count may indicate an early abort or retry. |\n" +
      "| **Server Startup** | Whether the generated application server started successfully. A failure here means the generated code couldn't even boot, preventing contract tests from running. |\n\n",
  );
  const rows: string[][] = trend.runs.map((r) => [
    r.label,
    r.infra_failure.is_infra_failure ? "**YES**" : "No",
    String(r.metrics.error_count),
    String(r.metrics.throttle_events),
    String(r.metrics.service_unavailable_events),
    String(r.metrics.model_error_events),
    String(r.metrics.num_handoffs),
    r.metrics.server_startup_success ? "Yes" : "**No**",
  ]);
  parts.push(
    mdTable(
      [
        "Version",
        "Infra Failure",
        "Total Errors",
        "Throttle",
        "Svc Unavail",
        "Model Error",
        "Handoffs",
        "Server Startup",
      ],
      rows,
    ),
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section G — Version-over-Version Deltas
// ---------------------------------------------------------------------------

/** render_md.py:519-554 */
function renderSectionG(trend: TrendData): string {
  const parts: string[] = ["---\n\n## G. Version-over-Version Deltas\n"];
  const deltas = computeDeltas(trend.runs);
  if (deltas.length === 0) {
    parts.push("Not enough data points to compute deltas.\n");
    return parts.join("\n");
  }

  parts.push(
    "Each row shows the change from one release to the next, making it easy to spot " +
      "which specific version introduced an improvement or regression. " +
      "Positive values (+) indicate an increase; negative (-) indicate a decrease. " +
      "For **Unit Tests** and **Contract**, positive is better (more tests passing). " +
      "For **Qualitative**, positive is better (higher quality score). " +
      "For **Tokens** and **Time**, negative is better (more efficient).\n\n",
  );

  const rows: string[][] = deltas.map((d) => [
    `${d.from_label} -> ${d.to_label}`,
    // unit/contract deltas are Python ints → format_delta("{:+d}").
    formatDelta(d.unit_tests_delta),
    formatDelta(d.contract_tests_delta),
    // qualitative delta is a Python float → format_delta precision=3 ("{:+.3f}").
    formatDelta(asPyNum(d.qualitative_delta, true), 3),
    // render_md.py:541-543 — token delta uses format_delta only when |Δ|<1000;
    // otherwise _fmt_token_delta (K/M units).
    Math.abs(d.token_delta) < 1000
      ? formatDelta(d.token_delta)
      : fmtTokenDelta(d.token_delta),
    // time delta is a Python float, precision=0, with a trailing 's'.
    `${formatDelta(asPyNum(d.time_delta_seconds, true), 0)}s`,
  ]);
  parts.push(
    mdTable(["Transition", "Unit Tests", "Contract", "Qualitative", "Tokens", "Time"], rows),
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section H — Pre-Release Data Points
// ---------------------------------------------------------------------------

/** render_md.py:562-598 */
function renderSectionH(trend: TrendData): string {
  const preRelease = trend.runs.filter(
    (r) => r.run_type === RunType.MAIN || r.run_type === RunType.PR,
  );

  const parts: string[] = ["---\n\n## H. Pre-Release Data Points\n"];
  parts.push(
    "Evaluation results from non-release sources — the `main` branch and open pull requests. " +
      "These represent in-progress work that hasn't been tagged as a release yet. " +
      "Use this data to preview whether upcoming changes will improve or regress metrics " +
      "before they ship.\n",
  );

  if (preRelease.length === 0) {
    parts.push(
      "\nNo pre-release data available. Data from `main` and " +
        "pull request evaluations will appear here when available.\n",
    );
    return parts.join("\n");
  }

  const rows: string[][] = preRelease.map((r) => [
    r.label,
    String(r.unit_tests.passed),
    `${r.contract_tests.passed}/${r.contract_tests.total}`,
    pyFixed(r.qualitative.overall_score, 3),
    formatNumber(r.metrics.total_tokens),
  ]);
  parts.push(mdTable(["Source", "Unit Tests", "Contract", "Qualitative", "Tokens"], rows));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Render a Markdown table with right-aligned (ljust-padded) columns.
 * (render_md.py:606-630)
 */
function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  // Compute column widths for alignment (render_md.py:612-616).
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (i < widths.length) {
        widths[i] = Math.max(widths[i]!, row[i]!.length);
      }
    }
  }

  // Build header (render_md.py:619-620).
  const headerLine =
    "| " + headers.map((h, i) => h.padEnd(widths[i]!)).join(" | ") + " |";
  const sepLine = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";

  const lines = [headerLine, sepLine];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const w = i < widths.length ? widths[i]! : row[i]!.length;
      cells.push(row[i]!.padEnd(w));
    }
    lines.push("| " + cells.join(" | ") + " |");
  }

  return `${lines.join("\n")}\n`;
}

/** Build a document x version score matrix for the heatmap. (render_md.py:633-657) */
function buildHeatmapMatrix(trend: TrendData): [string[], string[], number[][]] {
  // sorted({doc names}) — unique document names, ascending.
  const docSet = new Set<string>();
  for (const run of trend.runs) {
    for (const ds of run.qualitative.document_scores) {
      docSet.add(ds.document_name);
    }
  }
  // Python sorted() on str uses code-point ordering; JS default sort on strings
  // sorts by UTF-16 code unit, which agrees for the BMP document names here.
  const allDocs = [...docSet].sort();
  const labels = trend.runs.map((r) => r.label);

  const matrix: number[][] = [];
  for (const doc of allDocs) {
    const row: number[] = [];
    for (const run of trend.runs) {
      // next((... ), -1.0) — first matching document's score, else -1.0.
      const match = run.qualitative.document_scores.find((ds) => ds.document_name === doc);
      row.push(match ? match.overall_score : -1.0);
    }
    matrix.push(row);
  }

  return [allDocs, labels, matrix];
}

/** Format a current vs baseline comparison. (render_md.py:660-668) */
function fmtVs(current: number, baseline: number, lowerIsBetter = false): string {
  if (!baseline) {
    return "—";
  }
  const delta = current - baseline;
  if (delta === 0) {
    return "=";
  }
  // lower_is_better flips the sign so a decrease reads as a positive delta.
  const displayDelta = lowerIsBetter ? -delta : delta;
  return formatDelta(displayDelta);
}

/** render_md.py:671-676 — minute-delta with a single signed decimal + 'm'. */
function fmtTimeVs(currentS: number, baselineS: number): string {
  if (!baselineS) {
    return "—";
  }
  const deltaS = currentS - baselineS;
  const deltaM = deltaS / 60;
  return `${pySignedFixed(deltaM, 1)}m`;
}

/** render_md.py:679-683 */
function fmtTokenVs(current: number, baseline: number): string {
  if (!baseline) {
    return "—";
  }
  const delta = current - baseline;
  return fmtTokenDelta(delta);
}

/** Format a token delta with sign and human-readable units. (render_md.py:686-694) */
function fmtTokenDelta(delta: number): string {
  // sign = "+" if delta >= 0 else "" — the minus comes from the value itself.
  const sign = delta >= 0 ? "+" : "";
  const absD = Math.abs(delta);
  if (absD >= 1_000_000) {
    return `${sign}${pyFixed(delta / 1_000_000, 2)}M`;
  }
  if (absD >= 1_000) {
    return `${sign}${pyFixed(delta / 1_000, 1)}K`;
  }
  return `${sign}${delta}`;
}

// A Python float carried into a PyNum for trend-sparkline's int/float dispatch.
// Plain JS numbers are Python ints; this wraps a float-intent value so
// format_number/format_delta route through the float branches. The trend models
// store avg/median context tokens and qualitative/time deltas as Python floats
// (models.py: avg_context_tokens/median_context_tokens are float;
// qualitative_delta/time_delta_seconds default 0.0). The PyFloat instance is the
// SAME class trend-sparkline recognizes via instanceof.
function asPyNum(value: number, isFloat: boolean): PyNum {
  return isFloat ? new PyFloat(value) : value;
}
