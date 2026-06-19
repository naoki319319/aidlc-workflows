// normalizer.ts — map a CLI workspace output to the evaluation-compatible
// run-folder layout (run-meta.yaml + run-metrics.yaml).
//
// FAITHFUL port of the PRODUCER half of the evaluator (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/cli-harness/src/cli_harness/normalizer.py
//   (normalizer.py:11-239 — citations below are to that file)
// PLUS the run-folder enrichment from the orchestrator that adds rules config to
// the meta after the normalizer writes it:
//   .../cli_harness/orchestrator.py:26-104 (_normalize_run_folder:81-87)
//
// What this produces is the WRITE side of the seam that reporting-collector.ts
// reads: collect() (reporting-collector.ts:251-359) pulls run-meta.yaml's
// config.executor_model / aws_region / rules_* (collector read at :268-286) and
// run-metrics.yaml's tokens.total / tokens.per_agent.executor / repeated_context /
// api_total, timing.total_wall_clock_ms / timing.handoffs, artifacts.workspace.* /
// artifacts.aidlc_docs.*, and the errors filter (collector read at :291-355). The
// key names emitted here MUST match those reads exactly — they are the contract.
//
// SINGLE-AGENT DEGRADATION (faithful to the Python CLI normalizer, by design):
// the Strands swarm that would populate a true multi-agent breakdown stays in
// Python; a CLI adapter is one executor session, so —
//   * tokens.per_agent has ONLY `executor` (no `simulator`); the collector reads
//     simulator_tokens as 0 (reporting-collector.ts:325-329, pa.simulator → {}).
//   * tokens.repeated_context is all-zero (normalizer.py:96-102).
//   * there is NO context_size section, so the collector leaves
//     context_size_* null (reporting-collector.ts:362-368, ctx absent).
//   * a SINGLE synthetic handoff covers the whole run, not per-turn
//     (normalizer.py:113-120).
// This is intentional, not a port gap.
//
// DETERMINISM: Python takes the timestamp from datetime.now(UTC).isoformat(
// timespec="seconds") (normalizer.py:43). Date/Date.now/new Date are BANNED in
// spike src (breaks resume + tests), so the timestamp is an INJECTED `generatedAt`
// param defaulting to "" — the same convention collect()/extractBaseline use. Both
// run-meta timestamps (started_at, completed_at) take that one value.
// run_folder is accepted as given (str(output_dir)); orchestrator.py:76-79 rewrites
// it to a cwd-relative path, but cwd semantics differ in the spike and the
// collector defaults run_folder to the runFolder it was handed anyway
// (reporting-collector.ts:270), so the absolute path is harmless.
//
// NUMERIC TYPING: every token/count/duration field is a Python int → a plain JS
// number here. The ONE float-typed field is cost_usd (claude_code.py total_cost_usd
// is a float), so it is wrapped with pyFloat so an integral cost renders "2.0" not
// "2" (PyYAML float behaviour). int(elapsed*1000) truncates toward zero →
// Math.trunc; Python `//` (floor div on non-negatives) → Math.floor.

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { atomicYamlDump, pyFloat } from "./yaml.ts";
import { pySplitlines } from "./pyutil.ts";

// The token-usage dict the adapter builds (claude_code.py:439-447) and the
// normalizer reads via .get(..., default) (normalizer.py:44-75). Every field is
// optional; the normalizer supplies the same defaults.
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  num_turns?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  model?: string;
}

// opts carries the normalizer.py signature (adapterName/modelHint/elapsedSeconds/
// tokenUsage) PLUS the orchestrator enrichment inputs (orchestrator.py:81-87:
// awsProfile/rulesSource/rulesRef/rulesRepo) and the injected generatedAt.
export interface NormalizeOptions {
  adapterName: string;
  modelHint?: string;
  elapsedSeconds?: number;
  tokenUsage?: TokenUsage | null;
  generatedAt?: string;
  awsProfile?: string;
  rulesSource?: string;
  rulesRef?: string;
  rulesRepo?: string;
}

// normalize_output (normalizer.py:11-178) — write run-meta.yaml and
// run-metrics.yaml for a completed CLI run. Returns the outputDir.
export function normalizeOutput(
  sourceDir: string,
  outputDir: string,
  opts: NormalizeOptions,
): string {
  const {
    adapterName,
    modelHint = "",
    elapsedSeconds = 0,
    tokenUsage = null,
    generatedAt = "",
    awsProfile = "",
    rulesSource = "",
    rulesRef = "",
    rulesRepo = "",
  } = opts;

  // normalizer.py:37 — output_dir.mkdir(parents=True, exist_ok=True). atomicYamlDump
  // writes its temp file inside outputDir and throws if it is absent, so self-create
  // it here exactly like Python (a Phase-2 driver need not pre-create it).
  mkdirSync(outputDir, { recursive: true });

  // Adapters now work directly in <output_dir>/workspace/ and move aidlc-docs/ up
  // to <output_dir>/aidlc-docs/ themselves (normalizer.py:21-23,39-40).
  const dstDocs = join(outputDir, "aidlc-docs");

  // ── run-meta.yaml (normalizer.py:42-64) ──
  // now = datetime.now(UTC).isoformat(timespec="seconds") → injected generatedAt.
  const now = generatedAt;
  const tu = tokenUsage ?? {};
  const numTurns = tu.num_turns ?? 0; // (token_usage or {}).get("num_turns", 0)
  // model_id = model_hint or token_usage.get("model") or f"cli:{adapter_name}"
  const modelId = modelHint || tu.model || `cli:${adapterName}`;
  // Label CLI runs clearly so reports don't show 0 tokens as a failure (:46-47).
  const executorLabel = numTurns ? `${modelId} (${numTurns} turns)` : modelId;

  const meta = {
    // orchestrator.py:76-79 rewrites this to a cwd-relative path; accepted as
    // given here (collector defaults it anyway — see header).
    run_folder: outputDir,
    started_at: now,
    completed_at: now,
    status: "completed",
    execution_time_ms: Math.trunc(elapsedSeconds * 1000), // int(elapsed*1000)
    total_handoffs: numTurns,
    // [f"executor (turn {i+1})" for i in range(num_turns)] (:55)
    node_history: Array.from({ length: numTurns }, (_, i) => `executor (turn ${i + 1})`),
    config: {
      executor_model: executorLabel,
      simulator_model: "human",
      aws_region: "",
      // ENRICHMENT folded in from orchestrator.py:81-87 — the normal run includes
      // these and the collector reads them (reporting-collector.ts:280-283:
      // rules_source / rules_repo / rules_ref; aws_profile is carried for parity
      // with the normal run even though collect() does not surface it). Emitted
      // here directly rather than via the Python's read-modify-write (:67-90) since
      // the spike has no separate enrichment pass.
      aws_profile: awsProfile,
      rules_source: rulesSource,
      rules_ref: rulesRef,
      rules_repo: rulesRepo,
    },
  };
  atomicYamlDump(meta, join(outputDir, "run-meta.yaml"));

  // ── run-metrics.yaml (normalizer.py:66-176) ──
  const inputTokens = tu.input_tokens ?? 0; // .get("input_tokens", 0)
  const outputTokens = tu.output_tokens ?? 0;
  const cacheRead = tu.cache_read_tokens ?? 0;
  const cacheWrite = tu.cache_write_tokens ?? 0;
  // .get("total_tokens", input + output + cache_read + cache_write) (:72)
  const totalTokens = tu.total_tokens ?? inputTokens + outputTokens + cacheRead + cacheWrite;
  const durationMs = Math.trunc(elapsedSeconds * 1000); // int(elapsed*1000) (:74)
  const durationApiMs = tu.duration_api_ms ?? 0; // .get("duration_api_ms", 0)

  // tokens section (normalizer.py:79-110). per_agent has only `executor`;
  // repeated_context is all-zero (single-agent degradation — see header).
  const tokensSection = {
    total: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
    per_agent: {
      executor: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
      },
    },
    repeated_context: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    api_total: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
  };

  // timing section (normalizer.py:112-125) — one synthetic handoff for the whole
  // run; duration prefers the API-reported figure, falling back to wall clock.
  const handoffs = [
    {
      handoff: 1,
      node_id: "executor",
      duration_ms: durationApiMs || durationMs,
    },
  ];
  const timingSection = {
    total_wall_clock_ms: durationMs,
    handoffs,
  };

  // handoff_patterns section (normalizer.py:127-138). avg uses Python `//`
  // (floor div) over max(num_turns, 1) → Math.floor.
  const handoffPatterns = {
    total_handoffs: 1,
    sequence: ["executor"],
    per_agent: {
      executor: {
        turn_count: numTurns,
        total_duration_ms: durationApiMs || durationMs,
        avg_turn_duration_ms: Math.floor((durationApiMs || durationMs) / Math.max(numTurns, 1)),
      },
    },
  };

  // errors section (normalizer.py:140-149) — all six counters at 0, empty details.
  const errorsSection = {
    throttle_events: 0,
    timeout_events: 0,
    failed_tool_calls: 0,
    model_error_events: 0,
    service_unavailable_events: 0,
    validation_error_events: 0,
    details: [] as unknown[],
  };

  // model_params section (normalizer.py:151-158).
  const modelParamsSection = {
    executor: {
      model_id: modelId,
      provider: "bedrock",
    },
    aws_region: "",
  };

  // metrics (normalizer.py:160-170). aidlc_docs is {} when the dir is absent.
  const metrics: Record<string, unknown> = {
    tokens: tokensSection,
    timing: timingSection,
    handoff_patterns: handoffPatterns,
    artifacts: {
      workspace: countWorkspaceFiles(sourceDir),
      aidlc_docs: isDir(dstDocs) ? countDocFiles(dstDocs) : {},
    },
    errors: errorsSection,
    model_params: modelParamsSection,
  };
  // Add cost only if present (normalizer.py:172-173 — truthy guard). total_cost_usd
  // is a Python float (claude_code.py:305,341 init 0.0 / `or 0.0`), so a
  // whole-dollar cost must render "2.0" not "2" — wrap with pyFloat (the ONE
  // float-typed field the normalizer emits).
  if (tu.total_cost_usd) {
    metrics.cost_usd = pyFloat(tu.total_cost_usd);
  }
  atomicYamlDump(metrics, join(outputDir, "run-metrics.yaml"));

  return outputDir;
}

// _count_workspace_files (normalizer.py:181-220) — classify every file under the
// workspace; count source LINES for source files. Empty {} when not a dir.
export function countWorkspaceFiles(workspace: string): Record<string, number> {
  if (!isDir(workspace)) return {}; // (:182-184)

  const sourceExts = new Set([".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".java"]);
  const testPatterns = ["test_", "_test.", ".test.", ".spec."];
  const configExts = new Set([".yaml", ".yml", ".json", ".toml", ".cfg", ".ini"]);

  let source = 0;
  let test = 0;
  let config = 0;
  let other = 0;
  let totalLines = 0;

  for (const f of rglobFiles(workspace)) {
    const ext = suffix(f).toLowerCase();
    const name = basename(f).toLowerCase();

    const isTest = testPatterns.some((p) => name.includes(p)); // any(p in name) (:199)
    if (isTest && sourceExts.has(ext)) {
      test += 1;
    } else if (sourceExts.has(ext)) {
      source += 1;
      try {
        // len(f.read_text(errors="replace").splitlines()) (:205). errors="replace"
        // never throws on decode; OSError (open failure) is the guarded case.
        // pySplitlines (pyutil.ts) matches CPython str.splitlines()'s full boundary
        // set (\f/\v/NEL/LS/PS), so files containing those count identically.
        totalLines += pySplitlines(readFileSync(f, "utf-8")).length;
      } catch {
        /* except OSError: pass (:206-207) */
      }
    } else if (configExts.has(ext)) {
      config += 1;
    } else {
      other += 1;
    }
  }

  return {
    source_files: source,
    test_files: test,
    config_files: config,
    other_files: other,
    total_files: source + test + config + other,
    total_lines_of_code: totalLines,
  };
}

// _count_doc_files (normalizer.py:223-239) — count *.md docs by phase prefix.
export function countDocFiles(docsDir: string): Record<string, number> {
  let inception = 0;
  let construction = 0;
  let other = 0;
  for (const f of rglobFiles(docsDir)) {
    // rglob("*.md") (:226) is CASE-SENSITIVE — only a lowercase ".md" extension
    // matches (a README.MD is skipped by Python, so it must be skipped here too).
    if (!f.endsWith(".md")) continue;
    const rel = relative(docsDir, f); // str(f.relative_to(docs_dir)) (:227)
    if (rel.startsWith("inception")) {
      inception += 1;
    } else if (rel.startsWith("construction")) {
      construction += 1;
    } else {
      other += 1;
    }
  }
  return {
    inception_files: inception,
    construction_files: construction,
    other_files: other,
    total_files: inception + construction + other,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Path.suffix — the final ".ext" (or "" if none). Python's Path.suffix is empty
// for dotfiles like ".gitignore" and for names with no dot.
function suffix(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // leading dot or no dot → no suffix (Path semantics)
  return name.slice(dot);
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// Path.rglob("*") restricted to files (the Python skips non-files via f.is_file()).
// Yields absolute paths. node:fs recursive readdir, like Python's recursive glob.
function* rglobFiles(root: string): Generator<string> {
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    // With recursive:true, parentPath holds the directory of the entry.
    const dir = (e as { parentPath?: string; path?: string }).parentPath ?? root;
    yield join(dir, e.name);
  }
}

// (str.splitlines() parity lives in pyutil.ts pySplitlines — shared with
// human-analog.ts's extractFinalResponse so both match CPython's full boundary set.)
