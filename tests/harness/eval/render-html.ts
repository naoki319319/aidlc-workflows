// render-html.ts — render a ReportData into a self-contained HTML report.
//
// Faithful 1:1 port of reporting/render_html.py:1-700. The _CSS constant is
// copied VERBATIM (note the `\2714`/`\2718` CSS escapes, which Python wrote as
// `\\2714`/`\\2718` inside a triple-quoted string → the literal two-char sequence
// backslash-2714; we emit the same literal). _esc reproduces html.escape(quote=
// True): & < > " ' → entities. _score_ring uses the hardcoded 3.14159 (NOT
// Math.PI). _progress_class thresholds (0.9 / 0.7) differ from _score_color
// (0.8 / 0.6). Handoff bar width = max(duration/total*100, 2).

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pyFixed, pyRound } from "./pyutil.ts";
import type { ReportData } from "./reporting-collector.ts";
import type { ComparisonResult } from "./types.ts";

// render_html.py:10-126 — CSS constant, VERBATIM. The leading newline matches
// Python's triple-quoted literal beginning with a newline. CSS `content` escapes
// \2714 / \2718 are preserved exactly (Python source `\\2714` → literal `\2714`).
const CSS = `
:root {
  --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
  --text: #e2e8f0; --text2: #94a3b8; --border: #475569;
  --green: #22c55e; --green-bg: #052e16; --green-border: #166534;
  --red: #ef4444; --red-bg: #450a0a; --red-border: #991b1b;
  --yellow: #eab308; --yellow-bg: #422006; --yellow-border: #854d0e;
  --blue: #3b82f6; --blue-bg: #172554; --blue-border: #1d4ed8;
  --purple: #a855f7; --accent: #38bdf8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6;
  max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem;
}
h1 { font-size: 2rem; font-weight: 700; margin-bottom: .25rem; }
h2 {
  font-size: 1.25rem; font-weight: 600; color: var(--accent);
  margin: 2.5rem 0 1rem; padding-bottom: .5rem; border-bottom: 1px solid var(--border);
}
h3 { font-size: 1.05rem; font-weight: 600; margin: 1.5rem 0 .75rem; }
.subtitle { color: var(--text2); font-size: .9rem; margin-bottom: 2rem; }
code {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: .85em;
  background: var(--surface2); padding: .15em .4em; border-radius: 4px;
}

/* ── Cards ── */
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 1.25rem; transition: border-color .2s;
}
.card:hover { border-color: var(--accent); }
.card-label { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text2); margin-bottom: .5rem; }
.card-value { font-size: 1.75rem; font-weight: 700; }
.card-detail { font-size: .8rem; color: var(--text2); margin-top: .25rem; }

/* ── Badges ── */
.badge {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .25rem .75rem; border-radius: 999px; font-size: .8rem; font-weight: 600;
}
.badge-pass { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
.badge-fail { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }
.badge-warn { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow-border); }
.badge-info { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }

/* ── Progress bar ── */
.progress-wrap { width: 100%; background: var(--surface2); border-radius: 6px; overflow: hidden; height: 10px; }
.progress-bar { height: 100%; border-radius: 6px; transition: width .4s ease; }
.progress-green { background: linear-gradient(90deg, #16a34a, #22c55e); }
.progress-yellow { background: linear-gradient(90deg, #ca8a04, #eab308); }
.progress-red { background: linear-gradient(90deg, #dc2626, #ef4444); }

/* ── Tables ── */
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: .875rem; }
th { text-align: left; padding: .6rem .75rem; background: var(--surface); color: var(--text2);
     font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
     border-bottom: 2px solid var(--border); }
td { padding: .55rem .75rem; border-bottom: 1px solid var(--surface2); }
tr:hover td { background: var(--surface); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.pass-icon::before { content: '\\2714'; color: var(--green); margin-right: .3rem; }
.fail-icon::before { content: '\\2718'; color: var(--red); margin-right: .3rem; }

/* ── Accordion ── */
details { margin: .5rem 0; }
details summary {
  cursor: pointer; padding: .5rem .75rem; background: var(--surface);
  border-radius: 8px; font-size: .85rem; color: var(--text2);
  transition: background .2s;
}
details summary:hover { background: var(--surface2); }
details[open] summary { border-radius: 8px 8px 0 0; }
details .detail-body { background: var(--surface); padding: .75rem; border-radius: 0 0 8px 8px;
  font-size: .82rem; line-height: 1.65; color: var(--text2); }

/* ── Score ring ── */
.score-ring { display: inline-flex; align-items: center; gap: .75rem; }
.ring-container { position: relative; width: 80px; height: 80px; }
.ring-container svg { transform: rotate(-90deg); }
.ring-container circle { fill: none; stroke-width: 6; }
.ring-bg { stroke: var(--surface2); }
.ring-fg { stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring-label {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.1rem; font-weight: 700;
}

/* ── Phase bar chart ── */
.phase-bars { display: flex; gap: 2rem; margin: 1rem 0; }
.phase-bar-group { flex: 1; }
.phase-bar-title { font-size: .8rem; font-weight: 600; margin-bottom: .5rem; text-transform: capitalize; }
.bar-row { display: flex; align-items: center; gap: .5rem; margin: .35rem 0; }
.bar-row-label { width: 80px; font-size: .75rem; color: var(--text2); text-align: right; }
.bar-track { flex: 1; height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; }
.bar-val { width: 35px; font-size: .75rem; font-weight: 600; }

.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
  color: var(--text2); font-size: .75rem; text-align: center; }

/* ── Comparison ── */
.cmp-summary { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
.cmp-stat { text-align: center; }
.cmp-stat-val { font-size: 1.75rem; font-weight: 700; }
.cmp-stat-label { font-size: .75rem; color: var(--text2); text-transform: uppercase; letter-spacing: .05em; }
.delta-improved { color: var(--green); }
.delta-regressed { color: var(--red); }
.delta-unchanged { color: var(--text2); }
.delta-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
.dot-improved { background: var(--green); }
.dot-regressed { background: var(--red); }
.dot-unchanged { background: var(--text2); }
`;

// render_html.py:129-130 — html.escape(str(s)) with quote=True (default).
// Mirrors Python's html.escape: & first, then < > " '.
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// render_html.py:133-140
function msToHuman(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${pyFixed(secs, 0)}s`;
  const mins = secs / 60;
  if (mins < 60) return `${pyFixed(mins, 1)}m`;
  return `${pyFixed(mins / 60, 1)}h`;
}

// render_html.py:143-148
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${pyFixed(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${pyFixed(n / 1_000, 0)}K`;
  return String(n);
}

// render_html.py:151-156
function scoreColor(score: number): string {
  if (score >= 0.8) return "var(--green)";
  if (score >= 0.6) return "var(--yellow)";
  return "var(--red)";
}

// render_html.py:159-164 — thresholds 0.9 / 0.7 (NOT 0.8 / 0.6).
function progressClass(ratio: number): string {
  if (ratio >= 0.9) return "progress-green";
  if (ratio >= 0.7) return "progress-yellow";
  return "progress-red";
}

// render_html.py:167-172 — _fmt_val_html
function fmtValHtml(v: number | null): string {
  if (v === null) return "---";
  if (!Number.isInteger(v)) {
    // render_html.py:171 f"{v:,.0f}" rounds half-to-EVEN — use pyRound, not
    // Math.round (half-away: 88.5 → 88 not 89).
    return v < 10 ? pyFixed(v, 4) : pyComma(pyRound(v, 0));
  }
  return pyComma(v);
}

// Python f"{n:,}" / f"{n:,.0f}" — thousands separator, integer.
function pyComma(n: number): string {
  const neg = n < 0;
  const intPart = Math.abs(Math.trunc(n)).toString();
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

// render_html.py:175-187 — _score_ring. circ uses hardcoded 3.14159 (NOT pi).
function scoreRing(score: number, size = 80): string {
  const r = (size - 6) / 2;
  const circ = 2 * 3.14159 * r;
  const offset = circ * (1 - score);
  const color = scoreColor(score);
  // render_html.py:176 `r = (size - 6) / 2` is a Python float (true division),
  // so str(r) keeps the trailing ".0" for the even default sizes (64/80 → 29.0/
  // 37.0). JS `/` yields a plain integer there; render it as a float to match.
  const rStr = Number.isInteger(r) ? `${r}.0` : String(r);
  return `<div class="ring-container" style="width:${size}px;height:${size}px">
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle class="ring-bg" cx="${Math.trunc(size / 2)}" cy="${Math.trunc(size / 2)}" r="${rStr}"/>
    <circle class="ring-fg" cx="${Math.trunc(size / 2)}" cy="${Math.trunc(size / 2)}" r="${rStr}"
      stroke="${color}" stroke-dasharray="${pyFixed(circ, 1)}" stroke-dashoffset="${pyFixed(offset, 1)}"/>
  </svg>
  <div class="ring-label" style="color:${color}">${pyPercent0(score)}</div>
</div>`;
}

// Python f"{score:.0%}" — value*100, round-half-to-even to 0 decimals, '%' suffix.
function pyPercent0(score: number): string {
  return `${pyFixed(score * 100, 0)}%`;
}

// render_html.py:190-191 — _badge
function badge(label: string, cls: string): string {
  return `<span class="badge badge-${cls}">${esc(label)}</span>`;
}

// render_html.py:194-211 — _fmt_delta_val
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

// render_html.py:214-223 — _delta_tag
function deltaTag(cmp: ComparisonResult | null, metricName: string): string {
  if (cmp == null) return "";
  for (const d of cmp.deltas) {
    if (d.name === metricName && d.delta != null && Math.abs(d.delta) > 0.001) {
      const val = fmtDeltaVal(d.delta, metricName);
      const cls = `delta-${d.direction}`;
      return ` <span class="${cls}" style="font-size:.7rem;font-weight:600">${val} vs golden</span>`;
    }
  }
  return ' <span class="delta-unchanged" style="font-size:.7rem">= golden</span>';
}

// render_html.py:226-694 — render_html(data: ReportData) -> str
export function renderHtml(data: ReportData): string {
  const out: string[] = [];
  const w = (s: string) => out.push(s);

  const runName = data.meta.run_folder ? basename(data.meta.run_folder) : "unknown";
  let cmp: ComparisonResult | null = (data.comparison as ComparisonResult | null) ?? null;

  w("<!DOCTYPE html>");
  w('<html lang="en"><head><meta charset="utf-8">');
  w('<meta name="viewport" content="width=device-width,initial-scale=1">');
  w(`<title>AIDLC Report — ${esc(runName)}</title>`);
  w("<link rel='preconnect' href='https://fonts.googleapis.com'>");
  w(
    "<link href='https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap' rel='stylesheet'>",
  );
  w(`<style>${CSS}</style>`);
  w("</head><body>");

  // ── Header ─────────────────────────────────────────────────
  w("<h1>AIDLC Evaluation Report</h1>");
  w(`<div class="subtitle"><code>${esc(runName)}</code> &middot; ${esc(data.generated_at)}</div>`);

  // ── Test metadata ──────────────────────────────────────────
  w('<table style="margin-bottom:1.5rem">');
  w(
    `<tr><td><strong>Executor Model</strong></td><td><code>${esc(data.meta.executor_model)}</code></td></tr>`,
  );
  w(
    `<tr><td><strong>Simulator Model</strong></td><td><code>${esc(data.meta.simulator_model)}</code></td></tr>`,
  );
  if (data.meta.rules_source === "git" && data.meta.rules_repo) {
    w(
      `<tr><td><strong>Rules Source</strong></td><td><code>${esc(data.meta.rules_repo)}</code> @ <code>${esc(data.meta.rules_ref)}</code></td></tr>`,
    );
  } else if (data.meta.rules_source === "local" && data.meta.rules_local_path) {
    w(
      `<tr><td><strong>Rules Source</strong></td><td>local: <code>${esc(data.meta.rules_local_path)}</code></td></tr>`,
    );
  } else if (data.meta.rules_source) {
    w(
      `<tr><td><strong>Rules Source</strong></td><td><code>${esc(data.meta.rules_source)}</code></td></tr>`,
    );
  }
  w("</table>");

  // ── Verdict Cards ──────────────────────────────────────────
  const testOk = !!(data.tests && data.tests.test_ok && data.tests.failed === 0);
  const contractOk = !!(data.contracts && data.contracts.failed === 0 && data.contracts.errors === 0);
  const qualScore = data.qualitative ? data.qualitative.overall_score : 0;

  w('<div class="card-grid">');

  if (data.tests) {
    const t = data.tests;
    const cls = testOk ? "pass" : "fail";
    w('<div class="card"><div class="card-label">Unit Tests</div>');
    w(
      `<div class="card-value">${badge(`${pyFixed(t.pass_pct, 1)}% (${t.passed}/${t.total})`, cls)}${deltaTag(cmp, "Tests Pass %")}</div>`,
    );
    if (t.coverage_pct !== null) {
      w(`<div class="card-detail">Coverage: ${pyFixed(t.coverage_pct, 1)}%${deltaTag(cmp, "Coverage %")}</div>`);
    }
    w("</div>");
  }

  if (data.contracts) {
    const ct = data.contracts;
    const cls = contractOk ? "pass" : "fail";
    w('<div class="card"><div class="card-label">Contract Tests</div>');
    w(`<div class="card-value">${badge(`${ct.passed}/${ct.total}`, cls)}${deltaTag(cmp, "Contract Passed")}</div>`);
    w('<div class="card-detail">API endpoints validated</div>');
    w("</div>");
  }

  if (data.quality) {
    const q = data.quality;
    const qOk = q.lint_errors === 0 && q.security_high === 0;
    const cls = qOk ? "pass" : "warn";
    w('<div class="card"><div class="card-label">Code Quality</div>');
    w(
      `<div class="card-value">${badge(`${q.lint_total} lint / ${q.security_total} security`, cls)}${deltaTag(cmp, "Lint Errors")}</div>`,
    );
    w(`<div class="card-detail">${q.lint_errors} errors, ${q.security_high} high severity</div>`);
    w("</div>");
  }

  if (data.qualitative) {
    w('<div class="card"><div class="card-label">Qualitative Score</div>');
    w('<div class="card-value" style="display:flex;align-items:center;gap:.75rem">');
    w(scoreRing(qualScore, 64));
    w(`${deltaTag(cmp, "Qualitative Score")}`);
    w("</div></div>");
  }

  // Timing + tokens
  w('<div class="card"><div class="card-label">Execution Time</div>');
  w(`<div class="card-value">${msToHuman(data.metrics.wall_clock_ms)}${deltaTag(cmp, "Wall Clock (ms)")}</div>`);
  w(`<div class="card-detail">${data.meta.total_handoffs} handoffs</div>`);
  w("</div>");

  w('<div class="card"><div class="card-label">Total Tokens</div>');
  w(
    `<div class="card-value">${fmtTokens(data.metrics.total_tokens.total_tokens)}${deltaTag(cmp, "Total Tokens")}</div>`,
  );
  w(
    `<div class="card-detail">in: ${fmtTokens(data.metrics.total_tokens.input_tokens)} / out: ${fmtTokens(data.metrics.total_tokens.output_tokens)}</div>`,
  );
  w("</div>");

  w("</div>"); // card-grid

  // ── Run Overview ───────────────────────────────────────────
  w("<h2>Run Overview</h2>");
  w("<table>");
  const rows: Array<[string, string]> = [
    ["Status", `<code>${esc(data.meta.status)}</code>`],
    ["Executor", `<code>${esc(data.meta.executor_model)}</code>`],
    ["Simulator", `<code>${esc(data.meta.simulator_model)}</code>`],
    ["Region", `<code>${esc(data.meta.aws_region)}</code>`],
    [
      "Handoffs",
      `${data.meta.total_handoffs} (${data.meta.node_history.map((n) => esc(n)).join(" &rarr; ")})`,
    ],
  ];
  for (const [label, val] of rows) {
    w(`<tr><td><strong>${label}</strong></td><td>${val}</td></tr>`);
  }
  w("</table>");

  // ── Handoff Timeline ───────────────────────────────────────
  if (data.metrics.handoffs.length > 0) {
    const totalMs = data.metrics.wall_clock_ms || 1;
    w("<h2>Handoff Timeline</h2>");
    w('<div style="display:flex;gap:2px;height:32px;border-radius:8px;overflow:hidden;margin-bottom:1rem">');
    const colors: Record<string, string> = { executor: "var(--blue)", simulator: "var(--purple)" };
    for (const h of data.metrics.handoffs) {
      const pct = Math.max((h.duration_ms / totalMs) * 100, 2);
      const col = colors[h.node_id] ?? "var(--accent)";
      w(
        `<div style="width:${pyFixed(pct, 1)}%;background:${col};display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:600;min-width:30px" title="${esc(h.node_id)} #${h.handoff}: ${msToHuman(h.duration_ms)}">${esc(h.node_id[0]!.toUpperCase())}${h.handoff}</div>`,
      );
    }
    w("</div>");
    w("<table><tr><th>#</th><th>Agent</th><th>Duration</th><th>% of Total</th></tr>");
    for (const h of data.metrics.handoffs) {
      const pct = (h.duration_ms / totalMs) * 100;
      w(
        `<tr><td class="num">${h.handoff}</td><td>${esc(h.node_id)}</td>` +
          `<td>${msToHuman(h.duration_ms)}</td><td class="num">${pyFixed(pct, 1)}%</td></tr>`,
      );
    }
    w("</table>");
  }

  // ── Token Breakdown ────────────────────────────────────────
  w("<h2>Token Usage</h2>");
  w("<h3>Unique Tokens by Agent</h3>");
  w("<table><tr><th>Agent</th><th class='num'>Input</th><th class='num'>Output</th><th class='num'>Total</th></tr>");
  for (const [name, tok] of [
    ["Executor", data.metrics.executor_tokens],
    ["Simulator", data.metrics.simulator_tokens],
    ["<strong>Total Unique</strong>", data.metrics.total_tokens],
  ] as const) {
    w(
      `<tr><td>${name}</td><td class='num'>${fmtTokens(tok.input_tokens)}</td>` +
        `<td class='num'>${fmtTokens(tok.output_tokens)}</td><td class='num'>${fmtTokens(tok.total_tokens)}</td></tr>`,
    );
  }
  w("</table>");

  // Show repeated context if present
  if (data.metrics.repeated_context_tokens.total_tokens > 0) {
    w("<h3>Context Repetition</h3>");
    w("<p>Tokens re-sent across multiple conversation turns:</p>");
    w(
      "<table><tr><th>Category</th><th class='num'>Input</th><th class='num'>Output</th><th class='num'>Total</th></tr>",
    );
    w(
      `<tr><td>Repeated Context</td><td class='num'>${fmtTokens(data.metrics.repeated_context_tokens.input_tokens)}</td>` +
        `<td class='num'>${fmtTokens(data.metrics.repeated_context_tokens.output_tokens)}</td>` +
        `<td class='num'>${fmtTokens(data.metrics.repeated_context_tokens.total_tokens)}</td></tr>`,
    );
    w(
      `<tr><td><strong>API Total</strong></td><td class='num'><strong>${fmtTokens(data.metrics.api_total_tokens.input_tokens)}</strong></td>` +
        `<td class='num'><strong>${fmtTokens(data.metrics.api_total_tokens.output_tokens)}</strong></td>` +
        `<td class='num'><strong>${fmtTokens(data.metrics.api_total_tokens.total_tokens)}</strong></td></tr>`,
    );
    w("</table>");
  }

  // ── Context Size ──────────────────────────────────────────
  const ctxTotal = data.metrics.context_size_total;
  if (ctxTotal && ctxTotal.sample_count > 0) {
    const ctxEx = data.metrics.context_size_executor;
    const ctxSi = data.metrics.context_size_simulator;
    w("<h2>Context Size (Input Tokens per Invocation)</h2>");
    w(
      "<table><tr><th>Agent</th><th class='num'>Min</th><th class='num'>Max</th>" +
        "<th class='num'>Average</th><th class='num'>Median</th><th class='num'>Samples</th></tr>",
    );
    if (ctxEx && ctxEx.sample_count > 0) {
      w(
        `<tr><td>Executor</td><td class='num'>${fmtTokens(ctxEx.min_tokens)}</td>` +
          `<td class='num'>${fmtTokens(ctxEx.max_tokens)}</td><td class='num'>${fmtTokens(ctxEx.avg_tokens)}</td>` +
          `<td class='num'>${fmtTokens(ctxEx.median_tokens)}</td><td class='num'>${ctxEx.sample_count}</td></tr>`,
      );
    }
    if (ctxSi && ctxSi.sample_count > 0) {
      w(
        `<tr><td>Simulator</td><td class='num'>${fmtTokens(ctxSi.min_tokens)}</td>` +
          `<td class='num'>${fmtTokens(ctxSi.max_tokens)}</td><td class='num'>${fmtTokens(ctxSi.avg_tokens)}</td>` +
          `<td class='num'>${fmtTokens(ctxSi.median_tokens)}</td><td class='num'>${ctxSi.sample_count}</td></tr>`,
      );
    }
    w(
      `<tr><td><strong>Total</strong></td><td class='num'><strong>${fmtTokens(ctxTotal.min_tokens)}</strong></td>` +
        `<td class='num'><strong>${fmtTokens(ctxTotal.max_tokens)}</strong></td>` +
        `<td class='num'><strong>${fmtTokens(ctxTotal.avg_tokens)}</strong></td>` +
        `<td class='num'><strong>${fmtTokens(ctxTotal.median_tokens)}</strong></td>` +
        `<td class='num'><strong>${ctxTotal.sample_count}</strong></td></tr>`,
    );
    w("</table>");
  }

  // ── Unit Tests ─────────────────────────────────────────────
  if (data.tests) {
    const t = data.tests;
    w("<h2>Unit Tests</h2>");
    const ratio = t.total ? t.passed / t.total : 0;
    w('<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">');
    w(`${badge(`${pyFixed(t.pass_pct, 1)}% passed (${t.passed}/${t.total})`, testOk ? "pass" : "fail")}`);
    if (t.coverage_pct !== null) {
      const covCls = t.coverage_pct >= 90 ? "pass" : t.coverage_pct >= 70 ? "warn" : "fail";
      w(`${badge(`${pyFixed(t.coverage_pct, 1)}% coverage`, covCls)}`);
    }
    w("</div>");
    w(
      `<div class="progress-wrap"><div class="progress-bar ${progressClass(ratio)}" style="width:${pyFixed(ratio * 100, 1)}%"></div></div>`,
    );
  }

  // ── Contract Tests ─────────────────────────────────────────
  if (data.contracts) {
    const ct = data.contracts;
    w("<h2>Contract Tests</h2>");
    const ratio = ct.total ? ct.passed / ct.total : 0;
    w('<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">');
    w(`${badge(`${ct.passed}/${ct.total} passed`, contractOk ? "pass" : "fail")}`);
    if (ct.failed) w(`${badge(`${ct.failed} failed`, "fail")}`);
    if (ct.errors) w(`${badge(`${ct.errors} errors`, "fail")}`);
    w("</div>");
    w(
      `<div class="progress-wrap"><div class="progress-bar ${progressClass(ratio)}" style="width:${pyFixed(ratio * 100, 1)}%"></div></div>`,
    );

    const groups = new Map<string, typeof ct.cases>();
    for (const c of ct.cases) {
      const parts = c.path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
      const group = parts.length >= 3 ? parts[2]! : parts[0]!;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(c);
    }

    for (const [groupName, cases] of groups) {
      const passedG = cases.filter((c) => c.passed).length;
      const totalG = cases.length;
      const okG = passedG === totalG;
      w(`<h3>${esc(titleCase(groupName))} ${badge(`${passedG}/${totalG}`, okG ? "pass" : "fail")}</h3>`);
      w(
        "<table><tr><th></th><th>Test</th><th>Method</th><th>Path</th><th class='num'>Status</th><th class='num'>Latency</th></tr>",
      );
      for (const c of cases) {
        const iconCls = c.passed ? "pass-icon" : "fail-icon";
        const statusStr = c.actual_status ? String(c.actual_status) : "---";
        const lat = c.latency_ms ? `${pyFixed(c.latency_ms, 0)}ms` : "---";
        w(
          `<tr><td class="${iconCls}"></td><td>${esc(c.name)}</td><td>${c.method}</td>` +
            `<td><code>${esc(c.path)}</code></td><td class="num">${statusStr}</td><td class="num">${lat}</td></tr>`,
        );
      }
      w("</table>");
    }
  }

  // ── Code Quality ───────────────────────────────────────────
  if (data.quality) {
    const q = data.quality;
    w("<h2>Code Quality</h2>");
    w('<div style="margin-bottom:1rem">');
    w(`${badge(`${q.lint_errors} lint errors`, q.lint_errors === 0 ? "pass" : "fail")}`);
    w(`${badge(`${q.lint_warnings} warnings`, q.lint_warnings ? "warn" : "pass")}`);
    w(`${badge(`${q.security_total} security findings`, q.security_high === 0 ? "pass" : "fail")}`);
    if (q.lint_available) w(`${badge(`${esc(q.lint_tool)} ${esc(q.lint_version)}`, "info")}`);
    if (q.semgrep_available) w(`${badge("semgrep", "info")}`);
    w("</div>");

    if (q.lint_findings.length > 0) {
      w("<h3>Lint Findings</h3>");
      w("<table><tr><th>File</th><th class='num'>Line</th><th>Code</th><th>Message</th><th>Severity</th></tr>");
      for (const f of q.lint_findings) {
        const sevCls = f.severity === "error" ? "fail" : "warn";
        w(
          `<tr><td><code>${esc(f.file)}</code></td><td class="num">${f.line}</td>` +
            `<td><code>${esc(f.code)}</code></td><td>${esc(f.message)}</td>` +
            `<td>${badge(f.severity, sevCls)}</td></tr>`,
        );
      }
      w("</table>");
    }

    if (q.duplication_available) {
      const dupOk = q.duplication_blocks === 0;
      w("<h3>Code Duplication</h3>");
      w('<div style="margin-bottom:1rem">');
      w(`${badge(`${q.duplication_blocks} duplicate blocks`, dupOk ? "pass" : "warn")}`);
      w(`${badge(`${q.duplication_lines} duplicated lines`, "info")}`);
      w("</div>");
    }
  }

  // ── Qualitative Evaluation ─────────────────────────────────
  if (data.qualitative) {
    const ql = data.qualitative;
    w("<h2>Qualitative Evaluation</h2>");
    w('<div class="score-ring" style="margin-bottom:1.5rem">');
    w(scoreRing(ql.overall_score));
    w(
      '<div><div style="font-size:1.5rem;font-weight:700">Overall Score</div>' +
        '<div style="color:var(--text2);font-size:.85rem">Semantic similarity to golden baseline</div></div>',
    );
    w("</div>");

    if (ql.phases.length > 0) {
      w('<div class="phase-bars">');
      for (const phase of ql.phases) {
        w(`<div class="phase-bar-group"><div class="phase-bar-title">${esc(phase.phase)}</div>`);
        for (const [dim, val] of [
          ["Intent", phase.avg_intent],
          ["Design", phase.avg_design],
          ["Complete", phase.avg_completeness],
          ["Overall", phase.avg_overall],
        ] as const) {
          const col = scoreColor(val);
          w(
            `<div class="bar-row"><div class="bar-row-label">${dim}</div>` +
              `<div class="bar-track"><div class="bar-fill" style="width:${pyFixed(val * 100, 0)}%;background:${col}"></div></div>` +
              `<div class="bar-val" style="color:${col}">${pyFixed(val, 2)}</div></div>`,
          );
        }
        w("</div>");
      }
      w("</div>");
    }

    for (const phase of ql.phases) {
      w(`<h3>${esc(titleCase(phase.phase))} Phase — Documents</h3>`);
      w(
        "<table><tr><th>Document</th><th class='num'>Intent</th><th class='num'>Design</th>" +
          "<th class='num'>Completeness</th><th class='num'>Overall</th></tr>",
      );
      for (const d of phase.documents) {
        const name = basename(d.path);
        w(
          `<tr><td><code>${esc(name)}</code></td>` +
            `<td class="num" style="color:${scoreColor(d.intent)}">${pyFixed(d.intent, 2)}</td>` +
            `<td class="num" style="color:${scoreColor(d.design)}">${pyFixed(d.design, 2)}</td>` +
            `<td class="num" style="color:${scoreColor(d.completeness)}">${pyFixed(d.completeness, 2)}</td>` +
            `<td class="num" style="color:${scoreColor(d.overall)}"><strong>${pyFixed(d.overall, 2)}</strong></td></tr>`,
        );
      }
      w("</table>");

      for (const d of phase.documents) {
        if (d.notes) {
          const name = basename(d.path);
          w(`<details><summary><code>${esc(name)}</code> &mdash; ${pyFixed(d.overall, 2)}</summary>`);
          w(`<div class="detail-body">${esc(d.notes)}</div></details>`);
        }
      }
    }
  }

  // ── Artifacts ──────────────────────────────────────────────
  const art = data.metrics.artifacts;
  if (art.total_files > 0) {
    w("<h2>Generated Artifacts</h2>");
    w('<div class="card-grid">');
    for (const [label, val] of [
      ["Source Files", art.source_files],
      ["Test Files", art.test_files],
      ["Config Files", art.config_files],
      ["Total Files", art.total_files],
      ["Lines of Code", pyComma(art.total_lines_of_code)],
      ["AIDLC Docs", art.total_doc_files],
    ] as const) {
      w(`<div class="card"><div class="card-label">${label}</div><div class="card-value">${val}</div></div>`);
    }
    w("</div>");
  }

  // ── Baseline Comparison ──────────────────────────────────────
  if (data.comparison) {
    cmp = data.comparison as ComparisonResult;
    const goldenName = cmp.golden_run ? basename(cmp.golden_run) : "unknown";

    w("<h2>Baseline Comparison</h2>");
    w(
      `<div style="color:var(--text2);font-size:.85rem;margin-bottom:1rem">` +
        `vs golden <code>${esc(goldenName)}</code>`,
    );
    if (cmp.golden_promoted_at) {
      w(` &middot; promoted ${esc(cmp.golden_promoted_at)}`);
    }
    w("</div>");

    w('<div class="cmp-summary">');
    w(
      `<div class="cmp-stat"><div class="cmp-stat-val delta-improved">${cmp.improved}</div><div class="cmp-stat-label">Improved</div></div>`,
    );
    w(
      `<div class="cmp-stat"><div class="cmp-stat-val delta-regressed">${cmp.regressed}</div><div class="cmp-stat-label">Regressed</div></div>`,
    );
    w(
      `<div class="cmp-stat"><div class="cmp-stat-val delta-unchanged">${cmp.unchanged}</div><div class="cmp-stat-label">Unchanged</div></div>`,
    );
    w("</div>");

    let currentCat = "";
    for (const d of cmp.deltas) {
      if (d.category !== currentCat) {
        if (currentCat) w("</table>");
        currentCat = d.category;
        w(`<h3>${esc(d.category)}</h3>`);
        w(
          "<table><tr><th></th><th>Metric</th><th class='num'>Golden</th>" +
            "<th class='num'>Current</th><th class='num'>Delta</th><th>Change</th></tr>",
        );
      }

      const dotCls = `dot-${d.direction}`;
      const deltaCls = `delta-${d.direction}`;
      const goldenStr = fmtValHtml(d.golden);
      const currentStr = fmtValHtml(d.current);
      let deltaStr: string;
      let pctStr: string;
      if (d.delta !== null) {
        const sign = d.delta > 0 ? "+" : "";
        if (!Number.isInteger(d.delta)) {
          deltaStr = `${sign}${pyFixed(d.delta, 4)}`;
        } else {
          deltaStr = `${sign}${Math.trunc(d.delta)}`;
        }
        pctStr =
          d.pct_change !== null && Math.abs(d.pct_change) >= 0.1 ? ` (${signedPct(d.pct_change)})` : "";
      } else {
        deltaStr = "---";
        pctStr = "";
      }

      w(
        `<tr><td><span class="delta-dot ${dotCls}"></span></td>` +
          `<td>${esc(d.name)}</td>` +
          `<td class="num">${goldenStr}</td>` +
          `<td class="num">${currentStr}</td>` +
          `<td class="num ${deltaCls}">${deltaStr}${pctStr}</td>` +
          `<td class="${deltaCls}">${d.direction}</td></tr>`,
      );
    }

    if (currentCat) w("</table>");
  }

  // ── Footer ─────────────────────────────────────────────────
  w('<div class="footer">Generated by aidlc-reporting v0.1.0</div>');
  w("</body></html>");

  return out.join("\n");
}

// Python str.title() — uppercase first letter of each alphabetic run.
function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

// Python f"{x:+.1f}%" — always-signed, one decimal, percent suffix.
function signedPct(x: number): string {
  const body = pyFixed(Math.abs(x), 1);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "+";
  return `${sign}${body}%`;
}

// render_html.py:697-700 — write_html(data, output_path)
export function writeHtml(data: ReportData, outputPath: string): void {
  const htmlStr = renderHtml(data);
  writeFileSync(outputPath, htmlStr, { encoding: "utf-8" });
}
