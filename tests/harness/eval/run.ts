// run.ts — LLM-free entry surface for the JS evaluator port.
//
// Mirrors the SCORING slice of the Python evaluator's entry points (run.py is a
// pure mode-dispatcher to out-of-scope drivers; the in-scope, LLM-free surface
// is the evaluate-only scoring path plus scripts/run_comparison_report.py and
// scripts/run_trend_report.py → trend_reports.__main__.cmd_trend). The Strands
// execution swarm, cli-harness, and ide-harness drivers are OUT of scope.
//
// Modes:
//   evaluate-only  — score an already-produced workspace + aidlc-docs (stages
//                    2–6), render the consolidated report. The cheapest faithful
//                    slice (no workflow execution).
//   compare        — cross-run comparison vs a golden baseline, reading real run
//                    folders through the collector (run_comparison_report.py).
//                    G3/G7: execution-cost metrics come from real run-metrics.yaml
//                    via reporting-collector, not zeros.
//   trend          — trend report across releases (trend_reports.cmd_trend);
//                    GATED on the `gh` CLI, skips cleanly when absent.
//
// G1 (judge transport): the default LIVE qualitative scorer is AgentSdkScorer
// (repo's authenticated claude CLI, no API key). --heuristic forces the offline
// deterministic scorer; --llm uses the first-party SDK (needs ANTHROPIC_API_KEY).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Repo root, derived from this module's location (tests/harness/eval/ → 3 up),
// so the dist + run-output defaults are portable across checkouts/CI rather than
// machine-specific absolute paths. Mirrors shared-scenario.test.ts's REPO_ROOT.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
import { runPostEvaluation, runPostRunTests } from "./postrun.ts";
import { scanWorkspace, writeReport } from "./quantitative.ts";
import { loadSpec, runContractTests, writeResults as writeContractResults } from "./contract.ts";
import { defaultRunnerConfig } from "./config.ts";
import { normalizeOutput, type TokenUsage } from "./normalizer.ts";
import { driveAidlcRun } from "./driver-sdk.ts";
import { driveAidlcTui } from "./driver-tui.ts";
import {
  AgentSdkScorer,
  compareRuns,
  HeuristicScorer,
  LlmScorer,
  type Scorer,
  toDict as qualitativeToDict,
} from "./qualitative.ts";
import {
  compare,
  compareRunToBaseline,
  extractBaseline,
  loadBaseline,
} from "./baseline.ts";
import { collect, type QualitativeResults, type ReportData } from "./reporting-collector.ts";
import { renderMarkdown, writeMarkdown } from "./render-md.ts";
import { writeHtml } from "./render-html.ts";
import type { ComparisonResult, QualitativeResult } from "./types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ── scorer selection (G1) ────────────────────────────────────────────────────
function selectScorer(): Scorer {
  if (flag("heuristic")) return new HeuristicScorer();
  if (flag("llm")) return new LlmScorer();
  return new AgentSdkScorer(); // default: repo-consistent, no API key
}

// ── empty ReportData scaffold (collector dataclass defaults) ─────────────────
function emptyReportData(generatedAt = ""): ReportData {
  const tok = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  return {
    meta: {
      run_folder: "current", started_at: "", completed_at: "", status: "",
      execution_time_ms: 0, total_handoffs: 0, node_history: [],
      executor_model: "", simulator_model: "", aws_region: "",
      rules_source: "", rules_repo: "", rules_ref: "", rules_local_path: "",
      vision_file: "", tech_env_file: "",
    },
    metrics: {
      total_tokens: tok(), executor_tokens: tok(), simulator_tokens: tok(),
      repeated_context_tokens: tok(), api_total_tokens: tok(),
      wall_clock_ms: 0, handoffs: [],
      artifacts: {
        source_files: 0, test_files: 0, config_files: 0, total_files: 0,
        total_lines_of_code: 0, inception_files: 0, construction_files: 0, total_doc_files: 0,
      },
      errors: {}, context_size_total: null, context_size_executor: null, context_size_simulator: null,
    },
    tests: null, quality: null, contracts: null, qualitative: null, comparison: null,
    generated_at: generatedAt,
  };
}

// Map a stage-5 QualitativeResult (types.ts shape, per-doc relative_path) into
// the collector's QualitativeResults shape (per-doc `path`) for the renderer.
function toCollectorQualitative(q: QualitativeResult): QualitativeResults {
  return {
    overall_score: q.overall_score,
    phases: q.phases.map((p) => ({
      phase: p.phase,
      avg_intent: p.avg_intent,
      avg_design: p.avg_design,
      avg_completeness: p.avg_completeness,
      avg_overall: p.avg_overall,
      documents: p.documents.map((d) => ({
        path: d.relative_path,
        intent: d.intent_similarity,
        design: d.design_similarity,
        completeness: d.completeness,
        overall: d.overall,
        notes: d.notes,
      })),
    })),
    unmatched_reference: q.unmatched_reference,
    unmatched_candidate: q.unmatched_candidate,
  };
}

// ── evaluate-only (stages 2–6 over a produced workspace + docs) ──────────────
async function evaluateOnly(): Promise<void> {
  const workspace = arg("workspace");
  const aidlcDocs = arg("aidlc-docs");
  const goldenDocs = arg("golden-docs");
  const openapi = arg("openapi");
  const goldenYaml = arg("golden");
  const out = arg("out");
  const htmlOut = arg("html-out");

  const data = emptyReportData();

  // Stage 2 — post-run tests (needs a workspace with a project).
  if (workspace) {
    console.error("[stage 2] post-run tests…");
    try {
      const t = runPostRunTests(workspace);
      data.tests = {
        status: t.status, install_ok: t.install_ok, test_ok: t.test_ok,
        passed: t.passed, failed: t.failed, errors: t.errors, total: t.total,
        pass_pct: t.pass_pct, coverage_pct: t.coverage_pct,
      };
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // Stage 3 — quantitative (lint/security/dup).
  if (workspace) {
    console.error("[stage 3] quantitative…");
    try {
      const q = scanWorkspace(workspace);
      if (q) {
        const s = q.summary;
        data.quality = {
          project_type: q.project_type,
          lint_tool: q.lint?.tool ?? "", lint_version: q.lint?.version ?? "",
          lint_available: q.lint?.available ?? false,
          lint_findings: (q.lint?.findings ?? []).map((f) => ({
            file: basename(f.file), line: f.line, code: f.code, message: f.message, severity: f.severity,
          })),
          lint_total: s.lint_total ?? 0, lint_errors: s.lint_errors ?? 0, lint_warnings: s.lint_warnings ?? 0,
          security_tool: q.security?.tool ?? "", security_available: q.security?.available ?? false,
          security_total: s.security_total ?? 0, security_high: s.security_high ?? 0,
          semgrep_tool: q.semgrep?.tool ?? "", semgrep_available: q.semgrep?.available ?? false,
          semgrep_total: (q.semgrep?.findings ?? []).length,
          semgrep_high: (q.semgrep?.findings ?? []).filter((f) => f.severity === "high").length,
          duplication_tool: q.duplication?.tool ?? "", duplication_available: q.duplication?.available ?? false,
          duplication_blocks: s.duplication_blocks ?? 0, duplication_lines: s.duplication_lines ?? 0,
        };
      }
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // Stage 4 — contract tests (needs openapi + a runnable app in workspace).
  if (workspace && openapi) {
    console.error("[stage 4] contract tests…");
    try {
      const spec = loadSpec(Bun.YAML.parse(readFileSync(openapi, "utf-8")) as Record<string, any>);
      const c = await runContractTests(spec, workspace);
      data.contracts = {
        total: c.total, passed: c.passed, failed: c.failed, errors: c.errors,
        server_started: c.server_started, server_error: c.server_error,
        cases: c.cases.map((cc) => ({
          name: cc.name, path: cc.path, method: cc.method, passed: cc.passed,
          expected_status: cc.expected_status, actual_status: cc.actual_status,
          failures: cc.failures, latency_ms: cc.latency_ms, error: cc.error,
        })),
      };
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // Stage 5 — qualitative (AgentSdkScorer by default; --heuristic / --llm).
  let qualitative: QualitativeResult | null = null;
  if (aidlcDocs && goldenDocs) {
    console.error("[stage 5] qualitative…");
    const scorer = selectScorer();
    try {
      qualitative = await compareRuns(goldenDocs, aidlcDocs, scorer);
      data.qualitative = toCollectorQualitative(qualitative);
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // Stage 6 — baseline comparison (if a golden.yaml is provided).
  if (goldenYaml) {
    console.error("[stage 6] baseline comparison…");
    try {
      const golden = loadBaseline(Bun.YAML.parse(readFileSync(goldenYaml, "utf-8")) as Record<string, any>);
      const current = extractBaseline(data);
      let comparison: ComparisonResult = compare(current, golden);
      // G4: the shipped golden.yaml zeroes artifact-count fields (see its in-file
      // comment), so the Artifacts category false-alarms in evaluate-only mode
      // (no run-metrics → current artifacts are 0 too, but a real run inflates
      // them). Exclude the Artifacts category from the displayed tally unless
      // --include-artifacts is passed.
      if (!flag("include-artifacts")) comparison = excludeArtifacts(comparison);
      data.comparison = comparison;
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // Optionally persist the stage-5 qualitative-comparison.yaml (to_dict shape).
  const qualOut = arg("qualitative-out");
  if (qualitative && qualOut) {
    mkdirSync(join(qualOut, ".."), { recursive: true });
    writeFileSync(qualOut, "");
    // compareRuns already writes via its outputPath; here we re-emit explicitly.
    const { atomicYamlDump } = await import("./yaml.ts");
    atomicYamlDump(qualitativeToDict(qualitative), qualOut);
  }

  const md = renderMarkdown(data);
  if (out) {
    writeMarkdown(data, out);
    console.error(`\nmarkdown report → ${out}`);
  } else {
    console.log(md);
  }
  if (htmlOut) {
    writeHtml(data, htmlOut);
    console.error(`html report → ${htmlOut}`);
  }
}

// G4 — drop the Artifacts category from a ComparisonResult and recount.
function excludeArtifacts(c: ComparisonResult): ComparisonResult {
  const deltas = c.deltas.filter((d) => d.category !== "Artifacts");
  let improved = 0, regressed = 0, unchanged = 0;
  for (const d of deltas) {
    if (d.direction === "improved") improved++;
    else if (d.direction === "regressed") regressed++;
    else unchanged++;
  }
  return { ...c, deltas, improved, regressed, unchanged };
}

// ── compare (run_comparison_report.py — collector-backed, G3/G7) ─────────────
async function compareMode(): Promise<void> {
  const runFolder = arg("run");
  const goldenYaml = arg("golden");
  const out = arg("out");
  const htmlOut = arg("html-out");
  if (!runFolder || !goldenYaml) {
    console.error("usage: bun src/run.ts compare --run <run-folder> --golden <golden.yaml> [--out report.md] [--html-out report.html] [--include-artifacts]");
    process.exit(2);
  }
  if (!existsSync(runFolder)) {
    console.error(`run folder not found: ${runFolder}`);
    process.exit(1);
  }

  // G3/G7: compareRunToBaseline reads the run folder's six YAMLs (incl.
  // run-metrics.yaml) through the collector, so execution-cost metrics carry
  // REAL token/wall-clock/handoff numbers — no zero-vs-zero "improved" false
  // positives.
  let comparison = compareRunToBaseline(runFolder, goldenYaml);
  if (!flag("include-artifacts")) comparison = excludeArtifacts(comparison);

  // Render a full report from the collected run data + the comparison.
  const data = collect(runFolder);
  data.comparison = comparison;
  const md = renderMarkdown(data);
  if (out) {
    writeMarkdown(data, out);
    console.error(`\nmarkdown report → ${out}`);
  } else {
    console.log(md);
  }
  if (htmlOut) {
    writeHtml(data, htmlOut);
    console.error(`html report → ${htmlOut}`);
  }
  console.error(
    `\nimproved ${comparison.improved} · regressed ${comparison.regressed} · unchanged ${comparison.unchanged}`,
  );
}

// ── trend (trend_reports.cmd_trend — GATED on gh) ────────────────────────────
function resolveFormats(fmt: string): Set<string> {
  if (fmt === "both") return new Set(["md", "html"]);
  if (fmt === "all") return new Set(["md", "html", "yaml"]);
  return new Set([fmt]);
}

async function trendMode(): Promise<void> {
  const baseline = arg("baseline");
  const fmt = arg("format") ?? "all";
  const outputDir = arg("output-dir") ?? join(process.cwd(), "runs");
  const repo = arg("repo") ?? "awslabs/aidlc-workflows";
  const gate = flag("gate");
  if (!baseline) {
    console.error("usage: bun src/run.ts trend --baseline <golden.yaml> [--format md|html|yaml|both|all] [--output-dir dir] [--repo owner/name] [--gate] [--local-run-dir <dir>...]");
    process.exit(2);
  }

  const { checkGhAvailable, fetchPrereleaseBundles, fetchReleaseBundles } = await import("./trend-fetcher.ts");
  const { collectTrendData } = await import("./trend-collector.ts");
  const { checkRegressions } = await import("./gate.ts");
  const { renderTrendMarkdown } = await import("./trend-render-md.ts");
  const { renderTrendHtml } = await import("./trend-render-html.ts");
  const { renderTrendYaml } = await import("./trend-render-yaml.ts");

  // 1. Prerequisite: gh CLI. GATED — skip cleanly when absent (this whole mode
  //    needs network + gh, the knowledge/judgement boundary is irrelevant here;
  //    it is a deterministic data-fetch path that simply cannot run offline).
  try {
    checkGhAvailable();
  } catch (e) {
    console.error(`[trend] skipped — ${String(e)}`);
    console.error("[trend] the trend report needs the gh CLI on PATH (and a network connection).");
    process.exit(0);
  }

  mkdirSync(outputDir, { recursive: true });

  // Local run dirs let trend run fully offline against on-disk folders.
  const localRunDirs: string[] = [];
  let i = process.argv.indexOf("--local-run-dir");
  while (i >= 0) {
    const v = process.argv[i + 1];
    if (v && !v.startsWith("--")) localRunDirs.push(v);
    i = process.argv.indexOf("--local-run-dir", i + 1);
  }

  const workDir = join(outputDir, ".trend-work");
  mkdirSync(workDir, { recursive: true });
  const bundlePaths: string[] = [...localRunDirs];
  try {
    bundlePaths.push(...fetchReleaseBundles(repo, { workDir }));
    const pre = fetchPrereleaseBundles(repo, { cachePrefix: "report-", workDir });
    if (pre.length) bundlePaths.push(...pre);
  } catch (e) {
    console.error(`[trend] fetch error: ${String(e)}`);
  }

  const trend = collectTrendData(bundlePaths, baseline, repo, workDir);
  console.error(`[trend] assembled ${trend.runs.length} run(s)`);

  const formats = resolveFormats(fmt);
  if (formats.has("md")) {
    const p = join(outputDir, "trend-report.md");
    writeFileSync(p, renderTrendMarkdown(trend));
    console.error(`wrote ${p}`);
  }
  if (formats.has("html")) {
    const p = join(outputDir, "trend-report.html");
    writeFileSync(p, renderTrendHtml(trend));
    console.error(`wrote ${p}`);
  }
  if (formats.has("yaml")) {
    const p = join(outputDir, "trend-data.yaml");
    writeFileSync(p, renderTrendYaml(trend));
    console.error(`wrote ${p}`);
  }

  if (gate) {
    const result = checkRegressions(trend);
    if (result.infra_failure_detected) console.error(`Gate WARNING: ${result.infra_failure_summary}`);
    if (result.passed) {
      console.error(`Gate PASSED: ${result.latest_label} vs ${result.comparison_label} — no regressions detected.`);
      process.exit(0);
    }
    console.error(`Gate FAILED: ${result.latest_label} vs ${result.comparison_label}`);
    for (const reg of result.regressions) console.error(`  - ${reg}`);
    process.exit(1);
  }
}

// ── run (orchestrator.run_cli_evaluation, orchestrator.py:107-277) ───────────
// The PRODUCER → SCORER loop: drive a live /aidlc workflow (SDK or TUI), normalize
// the run folder, post-run-test it, score it, self-verify the collect()-complete
// folder, then optionally compare to a golden baseline. This is the only LIVE mode
// (it spends tokens), so it is GATED: AIDLC_DRIVER_LIVE=1 (claude-code) or
// AIDLC_DRIVER_TUI_LIVE=1 (tui); without the gate it prints a clean skip + exit 0.
//
// The default --dist is the repo's shipped dist/claude/.claude. The default --out
// is a timestamped folder under tests/harness/eval/runs/. The timestamp is the ONE
// new Date() in this module — generated at the CLI boundary (allowed in the entry
// point, like trend-collector.ts:797) and threaded DOWN as `generatedAt` so the
// normalizer/collector stay Date-free. Format mirrors runner.py:67
// (%Y%m%dT%H%M%S-<pid>).
function runFolderTimestamp(): string {
  // runner.py:67 — datetime.now().strftime("%Y%m%dT%H%M%S") + f"-{os.getpid()}".
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return `${stamp}-${process.pid}`;
}

// datetime.now(UTC).isoformat(timespec="seconds") (normalizer.py:43 / collector.py:232).
// Python emits the explicit UTC offset "+00:00" (NOT a "Z" suffix), e.g.
// "2026-06-17T06:09:35+00:00" — match that byte-for-byte for normalizer parity.
function isoSeconds(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

async function runMode(): Promise<void> {
  const visionPath = arg("vision");
  const techEnvPath = arg("tech-env");
  const goldenDocs = arg("golden-docs");
  const goldenYaml = arg("golden");
  const openapi = arg("openapi");
  const cli = arg("cli") ?? "claude-code";
  const scope = arg("scope") ?? "mvp";
  // tech-env binding is ON by default; --no-bind-tech-env opts out (bare-faithful).
  // Safe default-on: the directive only appends when a tech-env.md is actually
  // present (setupWorkspace gates on hasTechEnv), so it is a no-op without --tech-env.
  const bindTechEnv = !flag("no-bind-tech-env");
  const dist = arg("dist") ?? join(REPO_ROOT, "dist/claude/.claude");
  const out = arg("out") ?? join(import.meta.dir, "runs", runFolderTimestamp());

  if (!visionPath) {
    console.error(
      "usage: bun src/run.ts run --vision <vision.md> [--tech-env <f>] [--golden-docs <dir>] " +
        "[--golden <golden.yaml>] [--openapi <f>] [--cli claude-code|tui] [--scope mvp] " +
        "[--out <run-folder>] [--dist <dist/claude/.claude>] [--no-bind-tech-env]",
    );
    console.error(
      "  tech-env.md is bound as a HARD constraint by default when --tech-env is given; " +
        "pass --no-bind-tech-env for bare-faithful behavior.",
    );
    process.exit(2);
  }
  if (cli !== "claude-code" && cli !== "tui") {
    console.error(`unknown --cli '${cli}' (expected claude-code|tui)`);
    process.exit(2);
  }

  // 1. Drive — LIVE. Gate per transport; clean skip + exit 0 when ungated
  //    (orchestrator.py:142-179 prereq + run).
  const liveGate = cli === "tui" ? "AIDLC_DRIVER_TUI_LIVE" : "AIDLC_DRIVER_LIVE";
  if (process.env[liveGate] !== "1") {
    console.error(
      `[run] skipped — the ${cli} driver spends tokens against a live model.\n` +
        `[run] set ${liveGate}=1 to run it. (No model call was made.)`,
    );
    process.exit(0);
  }

  console.error(`[run] driving ${cli} → ${out}`);
  const adapterName = cli === "tui" ? "claude-tui" : "claude-code";
  const result =
    cli === "tui"
      ? // TUI branch stays bare-faithful (out of scope): no bindTechEnv threaded,
        // so setupWorkspace keeps the bare V2 prompt for the TUI transport.
        await driveAidlcTui({
          visionPath,
          techEnvPath,
          outputDir: out,
          distClaudePath: dist,
          scope,
          live: true,
        })
      : await driveAidlcRun({
          visionPath,
          techEnvPath,
          outputDir: out,
          distClaudePath: dist,
          scope,
          testRun: true,
          bindTechEnv,
          live: true,
        });

  console.error(
    `[run] ${cli} ${result.success ? "completed" : "finished"} ` +
      `(subtype=${result.finalSubtype}, ${result.elapsedSeconds.toFixed(0)}s)`,
  );
  if (!result.aidlcDocsDir) {
    console.error("[run] no aidlc-docs produced — nothing to score.");
    process.exit(1);
  }

  // The injected, Date-derived timestamp (one value for the whole run folder).
  const generatedAt = isoSeconds();
  const defaults = defaultRunnerConfig();

  // 2. normalizeOutput → run-meta.yaml + run-metrics.yaml (normalizer.py:11-178 +
  //    orchestrator enrichment, folded into one writer — normalizer.ts header).
  console.error("[run] normalizing run folder…");
  normalizeOutput(result.workspaceDir, out, {
    adapterName,
    modelHint: "",
    tokenUsage: (result.tokenUsage as TokenUsage | null) ?? null,
    elapsedSeconds: result.elapsedSeconds,
    generatedAt,
    awsProfile: defaults.aws.profile ?? "",
    rulesSource: defaults.aidlc.rules_source,
    rulesRef: defaults.aidlc.rules_ref,
    rulesRepo: defaults.aidlc.rules_repo,
  });

  // 3. Post-run tests → test-results.yaml (postrun.ts; orchestrator.py:208-246).
  //    Tolerate failure (skip-with-note, like evaluate-only).
  console.error("[run] post-run tests…");
  try {
    runPostEvaluation(out, defaultRunnerConfig(), false);
  } catch (e) {
    console.error("  skipped:", String(e));
  }

  // 4. Score (each in its own try/skip-with-note).
  // 4a. quantitative → quality-report.yaml (scanWorkspace + writeReport).
  console.error("[run] quality scan…");
  try {
    const quality = scanWorkspace(result.workspaceDir);
    if (quality) writeReport(quality, join(out, "quality-report.yaml"));
    else console.error("  skipped: no recognised project type");
  } catch (e) {
    console.error("  skipped:", String(e));
  }

  // 4b. contract tests → contract-test-results.yaml (loadSpec + runContractTests).
  if (openapi) {
    console.error("[run] contract tests…");
    try {
      const spec = loadSpec(Bun.YAML.parse(readFileSync(openapi, "utf-8")) as Record<string, any>);
      const contracts = await runContractTests(spec, result.workspaceDir);
      writeContractResults(contracts, join(out, "contract-test-results.yaml"));
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // 4c. qualitative → qualitative-comparison.yaml (compareRuns(outputPath)).
  if (goldenDocs) {
    console.error("[run] qualitative comparison…");
    try {
      await compareRuns(
        goldenDocs,
        result.aidlcDocsDir,
        selectScorer(),
        join(out, "qualitative-comparison.yaml"),
      );
    } catch (e) {
      console.error("  skipped:", String(e));
    }
  }

  // 5. Self-verify the collect()-complete folder (which of the 6 YAMLs parsed).
  console.error("[run] self-verify (collect)…");
  const data = collect(out, generatedAt);
  const present = {
    "run-meta.yaml": data.meta.status !== "",
    "run-metrics.yaml": data.metrics.wall_clock_ms !== 0 || data.metrics.total_tokens.total_tokens !== 0,
    "test-results.yaml": data.tests !== null,
    "quality-report.yaml": data.quality !== null,
    "contract-test-results.yaml": data.contracts !== null,
    "qualitative-comparison.yaml": data.qualitative !== null,
  };
  for (const [name, ok] of Object.entries(present)) {
    console.error(`  ${ok ? "✓" : "·"} ${name}${ok ? "" : " (absent/noted)"}`);
  }

  // 6. If --golden given, compare to baseline + render (reuse compareMode's path).
  if (goldenYaml) {
    let comparison = compareRunToBaseline(out, goldenYaml);
    if (!flag("include-artifacts")) comparison = excludeArtifacts(comparison);
    data.comparison = comparison;
    const md = renderMarkdown(data);
    console.log(md);
    console.error(
      `\nimproved ${comparison.improved} · regressed ${comparison.regressed} · unchanged ${comparison.unchanged}`,
    );
  } else {
    console.error(`\n[run] run folder → ${out}`);
  }
}

async function main() {
  const mode = process.argv[2];
  switch (mode) {
    case "run":
      return runMode();
    case "evaluate-only":
      return evaluateOnly();
    case "compare":
      return compareMode();
    case "trend":
      return trendMode();
    default:
      console.error("usage: bun src/run.ts <run|evaluate-only|compare|trend> [options]");
      console.error("  run           --vision <vision.md> [--tech-env …] [--golden-docs …] [--golden …] [--openapi …] [--cli claude-code|tui] [--scope mvp] [--out …] [--dist …] [--no-bind-tech-env]   (live; gated on AIDLC_DRIVER_LIVE/AIDLC_DRIVER_TUI_LIVE; tech-env bound as a HARD constraint by default, --no-bind-tech-env for bare-faithful)");
      console.error("  evaluate-only --aidlc-docs … --golden-docs … [--workspace …] [--openapi …] [--golden …] [--heuristic|--llm] [--out report.md] [--html-out report.html]");
      console.error("  compare       --run <run-folder> --golden <golden.yaml> [--out …] [--html-out …] [--include-artifacts]");
      console.error("  trend         --baseline <golden.yaml> [--format all] [--gate] [--local-run-dir <dir>…]   (gated on gh)");
      process.exit(2);
  }
}

main();
