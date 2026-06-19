// render-md.ts — render a ReportData into polished GitHub-flavoured Markdown.
//
// Faithful 1:1 port of reporting/render_md.py:1-470. Consumes the collector's
// ReportData shapes (reporting-collector.ts) and the baseline ComparisonResult
// (baseline.ts via types.ts). Every Python f"{:.Nf}" goes through pyFixed so the
// rounding matches CPython round-half-to-even; comma grouping ({:,} / {:,.0f})
// is reproduced with pyComma below.
//
// NOTE on float/int distinction: Python's _fmt_val / _fmt_delta_val branch on
// isinstance(v, float) and delta.is_integer(). The collector/baseline carry plain
// JS numbers with no float/int tag, so we reproduce the runtime behaviour:
//   - _fmtVal: a value that is NOT an integer is treated as the float branch;
//     an integer value renders via the int branch (comma-grouped). This matches
//     Python for every metric the renderer actually surfaces (the only "float"
//     metrics — pass/coverage %, qualitative scores — are non-integral in
//     practice; the integer metrics are integral). Where a float happens to be
//     integral (e.g. pass_pct 100.0) Python's float branch would emit "100.0000"
//     for v<10 — but pass_pct is always >=0 and the <10 path only triggers for
//     tiny values, so this edge is not exercised by the renderers' inputs.
//   - _mdDelta / delta column: mirror `isinstance(delta, float) and not
//     delta.is_integer()` with `!Number.isInteger(delta)`.

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pyFixed, pyRound } from "./pyutil.ts";
import type { ReportData } from "./reporting-collector.ts";
import type { ComparisonResult } from "./types.ts";

// Python f"{n:,}" / f"{n:,.0f}" — thousands separator, no decimals. Operates on
// an already-rounded integer value.
function pyComma(n: number): string {
  const neg = n < 0;
  const intPart = Math.abs(Math.trunc(n)).toString();
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

// render_md.py:10-18
function msToHuman(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${pyFixed(secs, 0)}s`;
  const mins = secs / 60;
  if (mins < 60) return `${pyFixed(mins, 1)}m`;
  const hrs = mins / 60;
  return `${pyFixed(hrs, 1)}h`;
}

// render_md.py:21-26
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${pyFixed(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${pyFixed(n / 1_000, 0)}K`;
  return String(n);
}

// render_md.py:29-34 — _fmt_val(v: float | int | None)
function fmtVal(v: number | null): string {
  if (v === null) return "---";
  if (!Number.isInteger(v)) {
    // float branch — render_md.py:33 f"{v:,.0f}" rounds half-to-EVEN, so use
    // pyRound (not Math.round, which is half-away-from-zero: 88.5 → 88 not 89).
    return v < 10 ? pyFixed(v, 4) : pyComma(pyRound(v, 0));
  }
  // int branch — comma-grouped
  return pyComma(v);
}

// render_md.py:37-38 — ✅ / ❌
function statusIcon(ok: boolean): string {
  return ok ? "✅" : "❌";
}

// render_md.py:41-58 — _fmt_delta_val
function fmtDeltaVal(delta: number, metricName: string): string {
  const sign = delta > 0 ? "+" : "";
  if (metricName === "Wall Clock (ms)") {
    const absMs = Math.abs(delta);
    if (absMs >= 60_000) return `${sign}${pyFixed(delta / 60_000, 1)}m`;
    return `${sign}${pyFixed(delta / 1_000, 1)}s`;
  }
  if (metricName.includes("Tokens")) {
    const absT = Math.abs(delta);
    if (absT >= 1_000_000) return `${sign}${pyFixed(delta / 1_000_000, 2)}M`;
    if (absT >= 1_000) return `${sign}${pyFixed(delta / 1_000, 1)}k`;
    return `${sign}${Math.trunc(delta)}`;
  }
  if (!Number.isInteger(delta)) return `${sign}${pyFixed(delta, 3)}`;
  return `${sign}${Math.trunc(delta)}`;
}

// render_md.py:61-76 — _md_delta
function mdDelta(cmp: ComparisonResult | null, metricName: string): string {
  if (cmp == null) return "";
  for (const d of cmp.deltas) {
    if (d.name === metricName && d.delta != null && Math.abs(d.delta) > 0.001) {
      const val = fmtDeltaVal(d.delta, metricName);
      const icon =
        d.direction === "improved"
          ? "\u{1f7e2}"
          : d.direction === "regressed"
            ? "\u{1f534}"
            : "⚪";
      return ` ${icon} _${val} vs golden_`;
    }
  }
  return " ⚪ _= golden_";
}

// render_md.py:79-464 — render_markdown(data: ReportData) -> str
export function renderMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  const runName = data.meta.run_folder ? basename(data.meta.run_folder) : "unknown";
  let cmp: ComparisonResult | null = (data.comparison as ComparisonResult | null) ?? null;

  // ── Header ─────────────────────────────────────────────────
  w("# AIDLC Evaluation Report");
  w("");
  w(`> **Run:** \`${runName}\``);
  w(`> **Generated:** ${data.generated_at}`);
  w("");

  // ── Test metadata ──────────────────────────────────────────
  w("| | |");
  w("|---|---|");
  w(`| **Executor Model** | \`${data.meta.executor_model}\` |`);
  w(`| **Simulator Model** | \`${data.meta.simulator_model}\` |`);
  if (data.meta.rules_source === "git" && data.meta.rules_repo) {
    w(`| **Rules Source** | \`${data.meta.rules_repo}\` @ \`${data.meta.rules_ref}\` |`);
  } else if (data.meta.rules_source === "local" && data.meta.rules_local_path) {
    w(`| **Rules Source** | local: \`${data.meta.rules_local_path}\` |`);
  } else if (data.meta.rules_source) {
    w(`| **Rules Source** | \`${data.meta.rules_source}\` |`);
  }
  w("");

  // ── Verdict banner ─────────────────────────────────────────
  const testOk = !!(data.tests && data.tests.test_ok && data.tests.failed === 0);
  const contractOk = !!(data.contracts && data.contracts.failed === 0 && data.contracts.errors === 0);
  const qualScore = data.qualitative ? data.qualitative.overall_score : 0;

  w("## Verdict");
  w("");
  w("| Dimension | Result |");
  w("|-----------|--------|");
  if (data.tests) {
    w(
      `| Unit Tests | ${statusIcon(testOk)} **${pyFixed(data.tests.pass_pct, 1)}%** (${data.tests.passed}/${data.tests.total})${mdDelta(cmp, "Tests Pass %")} |`,
    );
  }
  if (data.contracts) {
    w(
      `| Contract Tests | ${statusIcon(contractOk)} **${data.contracts.passed}/${data.contracts.total}** passed${mdDelta(cmp, "Contract Passed")} |`,
    );
  }
  if (data.quality) {
    const qOk = data.quality.lint_errors === 0 && data.quality.security_high === 0;
    w(
      `| Code Quality | ${statusIcon(qOk)} lint: ${data.quality.lint_total} (${data.quality.lint_errors} errors), security: ${data.quality.security_total} (${data.quality.security_high} high)${mdDelta(cmp, "Lint Errors")} |`,
    );
  }
  if (data.qualitative) {
    const icon = qualScore >= 0.8 ? "🟢" : qualScore >= 0.6 ? "🟡" : "🔴";
    w(`| Qualitative Score | ${icon} **${pyFixed(qualScore, 2)}**${mdDelta(cmp, "Qualitative Score")} |`);
  }
  w(`| Execution Time | ${msToHuman(data.metrics.wall_clock_ms)}${mdDelta(cmp, "Wall Clock (ms)")} |`);
  w(`| Total Tokens | ${fmtTokens(data.metrics.total_tokens.total_tokens)}${mdDelta(cmp, "Total Tokens")} |`);
  w("");

  // ── Run Overview ───────────────────────────────────────────
  w("## Run Overview");
  w("");
  w("| Property | Value |");
  w("|----------|-------|");
  w(`| Status | \`${data.meta.status}\` |`);
  w(`| Executor Model | \`${data.meta.executor_model}\` |`);
  w(`| Simulator Model | \`${data.meta.simulator_model}\` |`);
  w(`| Region | \`${data.meta.aws_region}\` |`);
  w(`| Wall Clock | ${msToHuman(data.metrics.wall_clock_ms)} |`);
  w(`| Handoffs | ${data.meta.total_handoffs} (${data.meta.node_history.join(" → ")}) |`);
  if (data.meta.started_at) w(`| Started | ${data.meta.started_at} |`);
  if (data.meta.completed_at) w(`| Completed | ${data.meta.completed_at} |`);
  w("");

  // ── Token Usage ────────────────────────────────────────────
  w("## Token Usage");
  w("");
  w("### Unique Tokens by Agent");
  w("");
  w("| Agent | Input | Output | Total |");
  w("|-------|------:|-------:|------:|");
  w(
    `| Executor | ${fmtTokens(data.metrics.executor_tokens.input_tokens)} | ${fmtTokens(data.metrics.executor_tokens.output_tokens)} | ${fmtTokens(data.metrics.executor_tokens.total_tokens)} |`,
  );
  w(
    `| Simulator | ${fmtTokens(data.metrics.simulator_tokens.input_tokens)} | ${fmtTokens(data.metrics.simulator_tokens.output_tokens)} | ${fmtTokens(data.metrics.simulator_tokens.total_tokens)} |`,
  );
  w(
    `| **Total Unique** | **${fmtTokens(data.metrics.total_tokens.input_tokens)}** | **${fmtTokens(data.metrics.total_tokens.output_tokens)}** | **${fmtTokens(data.metrics.total_tokens.total_tokens)}** |`,
  );
  w("");

  // Show repeated context if present
  if (data.metrics.repeated_context_tokens.total_tokens > 0) {
    w("### Context Repetition");
    w("");
    w("Tokens re-sent across multiple conversation turns:");
    w("");
    w("| Category | Input | Output | Total |");
    w("|----------|------:|-------:|------:|");
    w(
      `| Repeated Context | ${fmtTokens(data.metrics.repeated_context_tokens.input_tokens)} | ${fmtTokens(data.metrics.repeated_context_tokens.output_tokens)} | ${fmtTokens(data.metrics.repeated_context_tokens.total_tokens)} |`,
    );
    w(
      `| **API Total** | **${fmtTokens(data.metrics.api_total_tokens.input_tokens)}** | **${fmtTokens(data.metrics.api_total_tokens.output_tokens)}** | **${fmtTokens(data.metrics.api_total_tokens.total_tokens)}** |`,
    );
    w("");
  }
  w("");

  // ── Context Size ──────────────────────────────────────────
  const ctxTotal = data.metrics.context_size_total;
  if (ctxTotal && ctxTotal.sample_count > 0) {
    const ctxEx = data.metrics.context_size_executor;
    const ctxSi = data.metrics.context_size_simulator;
    w("## Context Size (Input Tokens per Invocation)");
    w("");
    w("| Agent | Min | Max | Average | Median | Samples |");
    w("|-------|----:|----:|--------:|-------:|--------:|");
    if (ctxEx && ctxEx.sample_count > 0) {
      w(
        `| Executor | ${fmtTokens(ctxEx.min_tokens)} | ${fmtTokens(ctxEx.max_tokens)} | ${fmtTokens(ctxEx.avg_tokens)} | ${fmtTokens(ctxEx.median_tokens)} | ${ctxEx.sample_count} |`,
      );
    }
    if (ctxSi && ctxSi.sample_count > 0) {
      w(
        `| Simulator | ${fmtTokens(ctxSi.min_tokens)} | ${fmtTokens(ctxSi.max_tokens)} | ${fmtTokens(ctxSi.avg_tokens)} | ${fmtTokens(ctxSi.median_tokens)} | ${ctxSi.sample_count} |`,
      );
    }
    w(
      `| **Total** | **${fmtTokens(ctxTotal.min_tokens)}** | **${fmtTokens(ctxTotal.max_tokens)}** | **${fmtTokens(ctxTotal.avg_tokens)}** | **${fmtTokens(ctxTotal.median_tokens)}** | **${ctxTotal.sample_count}** |`,
    );
    w("");
  }

  // ── Handoff Timeline ───────────────────────────────────────
  if (data.metrics.handoffs.length > 0) {
    w("## Handoff Timeline");
    w("");
    w("| # | Agent | Duration |");
    w("|--:|-------|----------|");
    for (const h of data.metrics.handoffs) {
      w(`| ${h.handoff} | ${h.node_id} | ${msToHuman(h.duration_ms)} |`);
    }
    w("");
  }

  // ── Generated Artifacts ────────────────────────────────────
  const art = data.metrics.artifacts;
  if (art.total_files > 0) {
    w("## Generated Artifacts");
    w("");
    w("| Category | Count |");
    w("|----------|------:|");
    w(`| Source files | ${art.source_files} |`);
    w(`| Test files | ${art.test_files} |`);
    w(`| Config files | ${art.config_files} |`);
    w(`| Total files | ${art.total_files} |`);
    w(`| Lines of code | ${pyComma(art.total_lines_of_code)} |`);
    w(`| AIDLC docs (inception) | ${art.inception_files} |`);
    w(`| AIDLC docs (construction) | ${art.construction_files} |`);
    w(`| AIDLC docs total | ${art.total_doc_files} |`);
    w("");
  }

  // ── Unit Tests ─────────────────────────────────────────────
  if (data.tests) {
    const t = data.tests;
    w("## Unit Tests");
    w("");
    w(`**${statusIcon(testOk)} ${pyFixed(t.pass_pct, 1)}% passed** (${t.passed}/${t.total})`);
    if (t.failed) w(` &mdash; ${t.failed} failed`);
    if (t.coverage_pct !== null) {
      w("");
      w(`**Coverage:** ${pyFixed(t.coverage_pct, 1)}%`);
    }
    w("");
  }

  // ── Contract Tests ─────────────────────────────────────────
  if (data.contracts) {
    const ct = data.contracts;
    w("## Contract Tests (API Specification)");
    w("");
    w(`**${statusIcon(contractOk)} ${ct.passed}/${ct.total}** endpoints validated`);
    w("");
    if (ct.server_error) {
      w(`> **Server error:** ${ct.server_error}`);
      w("");
    }

    const groups = new Map<string, typeof ct.cases>();
    for (const c of ct.cases) {
      const parts = c.path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
      const group = parts.length >= 3 ? parts[2]! : parts[0]!;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(c);
    }

    for (const [groupName, cases] of groups) {
      const passedInGroup = cases.filter((c) => c.passed).length;
      const totalInGroup = cases.length;
      const icon = statusIcon(passedInGroup === totalInGroup);
      w(`### ${titleCase(groupName)} ${icon} ${passedInGroup}/${totalInGroup}`);
      w("");
      w("| Test | Method | Path | Status | Latency |");
      w("|------|--------|------|:------:|--------:|");
      for (const c of cases) {
        const mark = statusIcon(c.passed);
        const statusStr = c.actual_status ? String(c.actual_status) : "---";
        const lat = c.latency_ms ? `${pyFixed(c.latency_ms, 0)}ms` : "---";
        w(`| ${mark} ${c.name} | ${c.method} | \`${c.path}\` | ${statusStr} | ${lat} |`);
      }
      w("");
      for (const c of cases) {
        if (!c.passed && (c.failures.length > 0 || c.error)) {
          const detail = c.failures.length > 0 ? c.failures.join("; ") : c.error;
          w(`> **${c.name}:** ${detail}`);
        }
      }
      w("");
    }
  }

  // ── Code Quality ───────────────────────────────────────────
  if (data.quality) {
    const q = data.quality;
    const qOk = q.lint_errors === 0 && q.security_high === 0;
    w("## Code Quality");
    w("");
    w(`**${statusIcon(qOk)} Lint: ${q.lint_total} findings** (${q.lint_errors} errors, ${q.lint_warnings} warnings)`);
    w("");
    if (q.lint_available && q.lint_findings.length > 0) {
      w(`**Linter:** ${q.lint_tool} ${q.lint_version}`);
      w("");
      w("| File | Line | Code | Message | Severity |");
      w("|------|-----:|------|---------|----------|");
      for (const f of q.lint_findings) {
        const sevIcon = f.severity === "error" ? "🔴" : "🟡";
        w(`| \`${f.file}\` | ${f.line} | \`${f.code}\` | ${f.message} | ${sevIcon} ${f.severity} |`);
      }
      w("");
    }

    w("### Security");
    w("");
    const secOk = q.security_high === 0;
    w(`**${statusIcon(secOk)} ${q.security_total} finding(s)** (${q.security_high} high)`);
    w("");
    if (!q.security_available) {
      w(`*Security scanner (${q.security_tool || "bandit"}) was not available.*`);
      w("");
    }
    if (q.semgrep_available) {
      w(`*Semgrep: ${q.semgrep_total} finding(s)*`);
      w("");
    } else if (q.semgrep_tool) {
      w("*Semgrep was not available.*");
      w("");
    }

    w("### Code Duplication");
    w("");
    if (q.duplication_available) {
      const dupOk = q.duplication_blocks === 0;
      w(
        `**${statusIcon(dupOk)} ${q.duplication_blocks} duplicate block(s)** (${q.duplication_lines} duplicated lines)`,
      );
    } else {
      w(`*Duplication scanner (${q.duplication_tool || "pmd-cpd"}) was not available.*`);
    }
    w("");
  }

  // ── Qualitative Evaluation ─────────────────────────────────
  if (data.qualitative) {
    const ql = data.qualitative;
    w("## Qualitative Evaluation (Semantic Similarity)");
    w("");
    const scoreIcon = ql.overall_score >= 0.8 ? "🟢" : ql.overall_score >= 0.6 ? "🟡" : "🔴";
    w(`**Overall Score: ${scoreIcon} ${pyFixed(ql.overall_score, 4)}**`);
    w("");

    for (const phase of ql.phases) {
      w(`### ${titleCase(phase.phase)} Phase`);
      w("");
      w("| Dimension | Score |");
      w("|-----------|------:|");
      w(`| Intent | ${pyFixed(phase.avg_intent, 2)} |`);
      w(`| Design | ${pyFixed(phase.avg_design, 2)} |`);
      w(`| Completeness | ${pyFixed(phase.avg_completeness, 2)} |`);
      w(`| **Overall** | **${pyFixed(phase.avg_overall, 2)}** |`);
      w("");

      w("| Document | Intent | Design | Complete | Overall |");
      w("|----------|-------:|-------:|---------:|--------:|");
      for (const d of phase.documents) {
        const name = basename(d.path);
        w(
          `| \`${name}\` | ${pyFixed(d.intent, 2)} | ${pyFixed(d.design, 2)} | ${pyFixed(d.completeness, 2)} | ${pyFixed(d.overall, 2)} |`,
        );
      }
      w("");

      for (const d of phase.documents) {
        if (d.notes) {
          const name = basename(d.path);
          w(`<details><summary><code>${name}</code> — ${pyFixed(d.overall, 2)}</summary>`);
          w("");
          w(`${d.notes}`);
          w("");
          w("</details>");
          w("");
        }
      }
    }

    if (ql.unmatched_candidate.length > 0) {
      w("### Unmatched Candidate Documents");
      w("");
      for (const p of ql.unmatched_candidate) {
        w(`- \`${p}\``);
      }
      w("");
    }
  }

  // ── Errors ─────────────────────────────────────────────────
  const errs = data.metrics.errors;
  if (errs && Object.values(errs).some((v) => v > 0)) {
    w("## Errors During Execution");
    w("");
    w("| Error Type | Count |");
    w("|------------|------:|");
    for (const [k, v] of Object.entries(errs)) {
      if (v > 0) {
        w(`| ${titleCase(k.replace(/_/g, " "))} | ${v} |`);
      }
    }
    w("");
  }

  // ── Baseline Comparison ──────────────────────────────────────
  if (data.comparison) {
    cmp = data.comparison as ComparisonResult;
    w("## Baseline Comparison");
    w("");
    const goldenName = cmp.golden_run ? basename(cmp.golden_run) : "unknown";
    w(`> Compared against golden baseline: \`${goldenName}\``);
    if (cmp.golden_promoted_at) {
      w(`> Promoted: ${cmp.golden_promoted_at}`);
    }
    w("");

    const improvedIcon = "\u{1f7e2}"; // green circle
    const regressedIcon = "\u{1f534}"; // red circle
    const unchangedIcon = "⚪"; // white circle

    w("| | Count |");
    w("|---|------:|");
    w(`| ${improvedIcon} Improved | ${cmp.improved} |`);
    w(`| ${regressedIcon} Regressed | ${cmp.regressed} |`);
    w(`| ${unchangedIcon} Unchanged | ${cmp.unchanged} |`);
    w("");

    const categoriesSeen = new Set<string>();
    for (let i = 0; i < cmp.deltas.length; i++) {
      const d = cmp.deltas[i]!;
      if (!categoriesSeen.has(d.category)) {
        categoriesSeen.add(d.category);
        w(`### ${d.category}`);
        w("");
        w("| Metric | Golden | Current | Delta | Change |");
        w("|--------|-------:|--------:|------:|--------|");
      }

      let icon: string;
      if (d.direction === "improved") icon = improvedIcon;
      else if (d.direction === "regressed") icon = regressedIcon;
      else icon = unchangedIcon;

      const goldenStr = fmtVal(d.golden);
      const currentStr = fmtVal(d.current);
      let changeStr: string;
      if (d.delta !== null) {
        const sign = d.delta > 0 ? "+" : "";
        const deltaStr = !Number.isInteger(d.delta)
          ? `${sign}${pyFixed(d.delta, 2)}`
          : `${sign}${Math.trunc(d.delta)}`;
        const pctStr =
          d.pct_change !== null && Math.abs(d.pct_change) >= 0.1
            ? `(${signedPct(d.pct_change)})`
            : "";
        changeStr = `${icon} ${deltaStr} ${pctStr}`.trim();
      } else {
        changeStr = `${icon}`;
      }

      w(`| ${d.name} | ${goldenStr} | ${currentStr} | ${changeStr} | ${d.direction} |`);

      // Close table when next category starts (render_md.py:454-456)
      const nextIdx = i + 1;
      if (nextIdx < cmp.deltas.length && cmp.deltas[nextIdx]!.category !== d.category) {
        w("");
      }
    }

    w("");
  }

  // ── Footer ─────────────────────────────────────────────────
  w("---");
  w("*Report generated by aidlc-reporting v0.1.0*");

  return lines.join("\n") + "\n";
}

// Python str.title() — uppercase the first letter of each run of alphabetic
// characters, lowercase the rest (a digit or non-letter resets the "first").
function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

// Python f"{x:+.1f}%" — always-signed, one decimal, percent suffix (pct_change).
function signedPct(x: number): string {
  const body = pyFixed(Math.abs(x), 1);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "+";
  return `${sign}${body}%`;
}

// render_md.py:467-470 — write_markdown(data, output_path)
export function writeMarkdown(data: ReportData, outputPath: string): void {
  const md = renderMarkdown(data);
  writeFileSync(outputPath, md, { encoding: "utf-8" });
}
