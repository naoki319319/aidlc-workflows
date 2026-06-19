// postrun.ts — Post-run test evaluation: detect project type, install deps, run tests.
//
// FAITHFUL port of execution/post_run.py (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/execution/src/aidlc_runner/post_run.py
//   (post_run.py:1-448 — citations below are to that file)
//
// What this stage does (post_run.py docstring): BFS-detect the project type from
// marker files, install dependencies, run the generated project's own test suite,
// parse the test output, and write a NESTED test-results.yaml. Shells to the same
// toolchains the Python does — this stage IS the build tools.
//
// PORTING NOTES (Python → TS):
//  - `shlex.split(command)` + `shell=False` (post_run.py:185-186) → a faithful
//    shlex-style POSIX tokenizer (`shlexSplit`) feeding `spawnSync(argv0, argv,
//    { shell: false })`. NOT shell:true (the spike's bug).
//  - env hygiene (post_run.py:179-180): start from `process.env`, DROP
//    VIRTUAL_ENV/CONDA_PREFIX, set HOME=cwd.
//  - `subprocess.TimeoutExpired` (post_run.py:202-223) → Node spawnSync surfaces a
//    timeout via `error.code === "ETIMEDOUT"` (or a null status + non-null signal);
//    we map that to the `timed_out: true` / `exit_code: null` branch, carrying any
//    partial stdout/stderr captured before the kill.
//  - `OSError` on spawn (post_run.py:224-231, e.g. missing binary → ENOENT) →
//    `{exit_code: null, success: false, output: <error message>, sandboxed: false}`.
//  - Sandbox branch (post_run.py:150-170): when `useSandbox && isDockerAvailable()`,
//    route through `sandboxRun` from shared-sandbox.ts; install gets `sandboxed: true`.
//    Gates cleanly when Docker is absent (falls back to host, warns on stderr).
//  - atomic_yaml_dump (post_run.py:447, shared/io.py) → atomicYamlDump from yaml.ts.
//  - RunnerConfig (post_run.py:18) → config.ts; post_run_timeout is SECONDS, so the
//    host/sandbox timeout is `post_run_timeout * 1000` ms.
//  - Injectable exec seams (`which`/`run`) keep the 41 pure tests toolchain-free; the
//    2 gated-binary tests run the real `uv pip install`/`pytest` and self-skip when
//    `uv`/`pytest` are absent.
//
// Type kept LOCAL to this module per the port rules (do not edit shared types.ts).
// `runPostRunTests` is RETAINED as a thin compatibility shim so the existing
// run.ts orchestrator (which imports it) keeps compiling unchanged; the faithful
// entry point is `runPostEvaluation`.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { relative as relativePath } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { ParsedTestResults, TestResults } from "./types.ts";
import type { RunnerConfig } from "./config.ts";
import { atomicYamlDump } from "./yaml.ts";
import { isDockerAvailable, sandboxRun } from "./shared-sandbox.ts";

// post_run.py:20-21
const MAX_OUTPUT_CHARS = 10_000;
const MAX_SEARCH_DEPTH = 3;

// post_run.py:43-64 — vendor/cache directories skipped during BFS.
const SKIP_DIRS = new Set([
  ".venv", "venv", ".env", "env", "node_modules", "__pycache__", ".pytest_cache",
  ".ruff_cache", ".mypy_cache", ".git", ".hg", ".svn", "target", "dist", "build",
  ".tox", ".nox", ".cache",
]);

// post_run.py:24-41 — (marker, type, install, test) in priority order.
const PROJECT_MARKERS: Array<{ marker: string; type: string; install: string; test: string }> = [
  { marker: "pyproject.toml", type: "python", install: 'uv pip install -qq -e ".[dev]"', test: "uv run pytest --tb=short -q --no-header -o console_output_style=classic" },
  { marker: "package.json", type: "node", install: "npm install", test: "npm test" },
  { marker: "Cargo.toml", type: "rust", install: "cargo build", test: "cargo test" },
  { marker: "go.mod", type: "go", install: "go build ./...", test: "go test ./..." },
  { marker: "setup.py", type: "python-legacy", install: 'pip install -e ".[dev]"', test: "python -m pytest --tb=short -q --no-header -o console_output_style=classic" },
];

// post_run.py:67-72 — ProjectInfo dataclass.
export interface ProjectInfo {
  type: string;
  install: string;
  test: string;
  root: string;
}

// post_run.py:75-85 — check a single directory for marker files (priority order).
function checkMarkers(directory: string): ProjectInfo | null {
  for (const m of PROJECT_MARKERS) {
    if (existsSync(`${directory}/${m.marker}`)) {
      return { type: m.type, install: m.install, test: m.test, root: directory };
    }
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// post_run.py:88-125 — BFS detection.
//
// Python first checks the workspace root itself (post_run.py:101-103), then BFS-es
// children depth-first-by-level. The marker check happens when a directory is
// DEQUEUED for the root, but at ENQUEUE time for children (post_run.py:119-123):
// each child is marker-checked the moment it is discovered, and only then queued
// for deeper descent. We mirror that ordering exactly.
export function detectProject(workspace: string): ProjectInfo | null {
  // post_run.py:98-99 — workspace must be a directory.
  if (!isDir(workspace)) return null;

  // post_run.py:101-103 — root check first.
  const root = checkMarkers(workspace);
  if (root !== null) return root;

  // post_run.py:106-123 — BFS through subdirectories up to MAX_SEARCH_DEPTH.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspace, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    // post_run.py:109-110 — stop descending past the depth bound.
    if (depth >= MAX_SEARCH_DEPTH) continue;

    let children: string[];
    try {
      // post_run.py:112-116 — sorted dirs only; skip dot-prefixed + SKIP_DIRS.
      children = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
        .map((e) => `${dir}/${e.name}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
      // post_run.py:117-118 — OSError ⇒ skip this directory.
      continue;
    }

    for (const child of children) {
      // post_run.py:120-122 — marker check at enqueue time.
      const result = checkMarkers(child);
      if (result !== null) return result;
      // post_run.py:123 — descend further.
      queue.push({ dir: child, depth: depth + 1 });
    }
  }

  // post_run.py:125 — nothing found.
  return null;
}

// post_run.py:128-131 — truncate over-long output WITH the suffix.
export function truncate(text: string, limit: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n... (output truncated)";
}

// ── shlex.split — POSIX-mode tokenizer (Python shlex.split, shell=False) ─────
// Faithful subset of shlex.split for the command strings this stage runs
// (post_run.py:186): whitespace-separated tokens, single/double quoting (no
// expansion difference matters for these commands), and backslash escaping.
// Throws on an unbalanced quote (Python raises ValueError) — surfaced as an
// OSError-style failure by the caller.
export function shlexSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      // Single quotes: literal until the next single quote.
      hasToken = true;
      i++;
      let closed = false;
      while (i < n) {
        if (command[i] === "'") {
          closed = true;
          i++;
          break;
        }
        current += command[i];
        i++;
      }
      if (!closed) throw new Error("No closing quotation");
      continue;
    }
    if (ch === '"') {
      // Double quotes: backslash escapes \ and " inside.
      hasToken = true;
      i++;
      let closed = false;
      while (i < n) {
        if (command[i] === "\\" && i + 1 < n && (command[i + 1] === '"' || command[i + 1] === "\\")) {
          current += command[i + 1];
          i += 2;
          continue;
        }
        if (command[i] === '"') {
          closed = true;
          i++;
          break;
        }
        current += command[i];
        i++;
      }
      if (!closed) throw new Error("No closing quotation");
      continue;
    }
    if (ch === "\\") {
      // Outside quotes: backslash escapes the next char.
      hasToken = true;
      if (i + 1 < n) {
        current += command[i + 1];
        i += 2;
      } else {
        // Trailing backslash: shlex raises; emulate ValueError.
        throw new Error("No escaped character");
      }
      continue;
    }
    hasToken = true;
    current += ch;
    i++;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// ── injectable exec seams (PORT-PLAN.md:36 "injectable exec/which seams") ─────
// Mirrors Python's `subprocess.run` patch point. Production passes the real
// spawnSync; pure tests inject a stub so install/test "run" without a toolchain.

/** Result of a single host subprocess execution (subset spawnSync surfaces). */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Present when the child could not be spawned OR was killed by the timeout. */
  error?: { code?: string; message?: string } | null;
}

/** Run seam signature: argv0 + args + opts → RunResult. */
export type RunSeam = (
  argv0: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => RunResult;

const defaultRun: RunSeam = (argv0, args, opts) => {
  const r = nodeSpawnSync(argv0, args as string[], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: (r.stdout as unknown as string) ?? "",
    stderr: (r.stderr as unknown as string) ?? "",
    error: (r.error as (Error & { code?: string }) | null) ?? null,
  };
};

/** Injectable seams for run_post_evaluation / _run_step. */
export interface PostRunDeps {
  run?: RunSeam;
  dockerAvailable?: () => boolean;
}

// ── _run_step — post_run.py:134-231 ─────────────────────────────────────────
// Run one command (install or test) and return the structured result dict that
// becomes a node in test-results.yaml.
function runStep(
  command: string,
  cwd: string,
  timeoutMs: number,
  opts: {
    useSandbox: boolean;
    sandboxImage: string;
    sandboxMemory: string;
    sandboxCpus: number;
    run: RunSeam;
    dockerAvailable: () => boolean;
  },
): Record<string, unknown> {
  // post_run.py:150-170 — sandbox branch when asked AND Docker is available.
  if (opts.useSandbox && opts.dockerAvailable()) {
    const result = sandboxRun(command, cwd, {
      image: opts.sandboxImage,
      timeout: Math.round(timeoutMs / 1000), // sandboxRun takes SECONDS
      network: true,
      memory: opts.sandboxMemory,
      cpus: opts.sandboxCpus,
    });
    const output = result.stdout + result.stderr;
    const data: Record<string, unknown> = {
      command,
      exit_code: result.exitCode,
      success: result.exitCode === 0,
      output: truncate(output),
      sandboxed: true,
    };
    // post_run.py:168-169 — surface timed_out only when set.
    if (result.timedOut) data.timed_out = true;
    return data;
  }

  // post_run.py:172-176 — asked for sandbox but Docker absent ⇒ warn, run on host.
  if (opts.useSandbox) {
    process.stderr.write("[WARN] Docker not available — running on host without sandbox\n");
  }

  // post_run.py:178-180 — env hygiene: strip VIRTUAL_ENV/CONDA_PREFIX, HOME=cwd.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "VIRTUAL_ENV" || k === "CONDA_PREFIX") continue;
    if (v !== undefined) env[k] = v;
  }
  env.HOME = cwd;

  // post_run.py:185-186 — shlex.split + shell=false.
  let argv: string[];
  try {
    argv = shlexSplit(command);
  } catch (e) {
    // A malformed command string (unbalanced quote) ≈ Python ValueError; treat as
    // an OSError-style spawn failure (post_run.py:224-231 shape).
    return {
      command,
      exit_code: null,
      success: false,
      output: String((e as Error).message ?? e),
      sandboxed: false,
    };
  }

  const r = opts.run(argv[0]!, argv.slice(1), { cwd, env, timeoutMs });

  // post_run.py:202-223 — TimeoutExpired branch. Node signals timeout via
  // error.code === "ETIMEDOUT" (or null status with no error but a kill signal).
  if (r.error && r.error.code === "ETIMEDOUT") {
    const partial = (r.stdout ?? "") + (r.stderr ?? "");
    return {
      command,
      exit_code: null,
      success: false,
      output: truncate(partial),
      timed_out: true,
      sandboxed: false,
    };
  }

  // post_run.py:224-231 — OSError branch (e.g. ENOENT missing binary). Output is
  // the raw error string (NOT truncated, matching `str(e)`).
  if (r.error) {
    return {
      command,
      exit_code: null,
      success: false,
      output: r.error.message ?? String(r.error.code ?? "spawn error"),
      sandboxed: false,
    };
  }

  // post_run.py:194-201 — success path.
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  return {
    command,
    exit_code: r.status,
    success: r.status === 0,
    output: truncate(output),
    sandboxed: false,
  };
}

// ── parsers (post_run.py:239-322) — regexes ported verbatim ────────────────
export function parsePytest(output: string): ParsedTestResults {
  const r: ParsedTestResults = { passed: null, failed: null, errors: null, skipped: null, total: null };
  // post_run.py:248-251 — final summary line, then the shorter "5 passed" form.
  let m = output.match(/=+\s*([\d\w\s,]+)\s+in\s+[\d.]+/);
  if (!m) m = output.match(/(\d+\s+passed(?:,\s*\d+\s+\w+)*)/);
  if (m) {
    const summary = m[1] ?? "";
    for (const key of ["passed", "failed", "error", "skipped", "warning", "deselected"]) {
      const cm = summary.match(new RegExp(`(\\d+)\\s+${key}`));
      if (cm) {
        const mapped = key === "error" ? "errors" : key;
        if (mapped in r) (r as unknown as Record<string, unknown>)[mapped] = Number(cm[1]);
      }
    }
  }
  return r;
}

export function parseJest(output: string): ParsedTestResults {
  const r: ParsedTestResults = { passed: null, failed: null, errors: null, skipped: null, total: null };
  // post_run.py:272-279 — Jest: "Tests:  2 failed, 5 passed, 7 total".
  let m = output.match(/Tests:\s+(.+total)/);
  if (m) {
    const summary = m[1]!;
    for (const key of ["passed", "failed", "skipped"]) {
      const cm = summary.match(new RegExp(`(\\d+)\\s+${key}`));
      if (cm) (r as unknown as Record<string, unknown>)[key] = Number(cm[1]);
    }
    return r;
  }
  // post_run.py:281-287 — Vitest: "Tests  5 passed | 2 failed (7)".
  m = output.match(/Tests\s+(.+\))/);
  if (m) {
    const summary = m[1]!;
    for (const key of ["passed", "failed"]) {
      const cm = summary.match(new RegExp(`(\\d+)\\s+${key}`));
      if (cm) (r as unknown as Record<string, unknown>)[key] = Number(cm[1]);
    }
  }
  return r;
}

export function parseCargo(output: string): ParsedTestResults {
  const r: ParsedTestResults = { passed: null, failed: null, errors: null, skipped: null, total: null };
  // post_run.py:299-303 — "test result: ok. 5 passed; 0 failed; 0 ignored".
  const m = output.match(/test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/);
  if (m) {
    r.passed = Number(m[1]);
    r.failed = Number(m[2]);
    r.skipped = Number(m[3]);
  }
  return r;
}

export function parseGo(output: string): ParsedTestResults {
  const r: ParsedTestResults = { passed: null, failed: null, errors: null, skipped: null, total: null };
  // post_run.py:315-321 — count --- PASS/FAIL/SKIP lines.
  const passed = (output.match(/--- PASS:/g) ?? []).length;
  const failed = (output.match(/--- FAIL:/g) ?? []).length;
  const skipped = (output.match(/--- SKIP:/g) ?? []).length;
  if (passed || failed || skipped) {
    r.passed = passed;
    r.failed = failed;
    r.skipped = skipped;
  }
  return r;
}

// post_run.py:325-331 — parser dispatch table.
function parserFor(type: string): ((o: string) => ParsedTestResults) | null {
  if (type === "python" || type === "python-legacy") return parsePytest;
  if (type === "node") return parseJest;
  if (type === "rust") return parseCargo;
  if (type === "go") return parseGo;
  return null;
}

// ── parse_test_output — post_run.py:334-347 ──────────────────────────────────
// UNKNOWN project type ⇒ ALL-None (NOT a pytest default). total = sum of the
// non-None passed/failed/errors/skipped counts (None if none parsed).
export function parseTestOutput(projectType: string, output: string): ParsedTestResults {
  const parser = parserFor(projectType);
  // post_run.py:340-342 — unknown type ⇒ everything None.
  if (parser === null) {
    return { passed: null, failed: null, errors: null, skipped: null, total: null };
  }
  const results = parser(output);
  // post_run.py:344-346 — total = sum of non-None counts (the 4 count fields).
  const counts = [results.passed, results.failed, results.errors, results.skipped].filter(
    (v): v is number => v !== null,
  );
  results.total = counts.length ? counts.reduce((a, b) => a + b, 0) : null;
  return results;
}

// ── run_post_evaluation — post_run.py:355-443 ────────────────────────────────
/**
 * Run post-run test evaluation on the generated workspace.
 *
 * Detects the project type, installs dependencies, runs tests, parses results,
 * and writes a NESTED test-results.yaml. Returns the path to that file (always
 * non-null in the Python — even the skipped paths write the file and return it).
 *
 * @param runFolder the run directory containing `workspace/`.
 * @param config RunnerConfig — supplies post_run_timeout (seconds) + sandbox cfg.
 * @param useSandbox null ⇒ read from config.execution.sandbox.enabled.
 * @param deps injectable run/dockerAvailable seams (pure-test support).
 */
export function runPostEvaluation(
  runFolder: string,
  config: RunnerConfig,
  useSandbox: boolean | null = null,
  deps: PostRunDeps = {},
): string {
  const run = deps.run ?? defaultRun;
  const dockerAvailable = deps.dockerAvailable ?? (() => isDockerAvailable());

  const workspace = `${runFolder}/workspace`;
  const outPath = `${runFolder}/test-results.yaml`;
  // post_run.py:372 — post_run_timeout is SECONDS; host/sandbox want ms/seconds.
  const timeoutSec = config.execution.post_run_timeout;
  const timeoutMs = timeoutSec * 1000;

  const sandboxCfg = config.execution.sandbox;
  // post_run.py:375-376 — None ⇒ read from config.
  const sandbox = useSandbox === null ? sandboxCfg.enabled : useSandbox;

  // post_run.py:378-380 — no workspace ⇒ skipped.
  if (!existsSync(workspace)) {
    writeResults(outPath, { status: "skipped", reason: "no workspace directory" });
    return outPath;
  }

  // post_run.py:382-385 — no recognised project markers ⇒ skipped.
  const project = detectProject(workspace);
  if (project === null) {
    writeResults(outPath, { status: "skipped", reason: "no recognised project markers" });
    return outPath;
  }

  const projectRoot = project.root;

  // post_run.py:389-395 — in sandbox mode remove any host-created .venv (broken
  // symlinks inside the container).
  if (sandbox) {
    const staleVenv = `${projectRoot}/.venv`;
    if (isDir(staleVenv)) {
      try {
        rmSync(staleVenv, { recursive: true, force: true });
      } catch {
        /* best effort, matches shutil.rmtree non-fatal posture in practice */
      }
    }
  }

  // post_run.py:397-401 — base output dict. project_root is RELATIVE to run_folder.
  const data: Record<string, unknown> = {
    status: "completed",
    project_type: project.type,
    project_root: toPosix(relativePath(runFolder, projectRoot)),
  };

  // post_run.py:403-417 — install. In sandbox mode for Python use `uv sync`.
  let installCmd = project.install;
  if (sandbox && (project.type === "python" || project.type === "python-legacy")) {
    installCmd = "uv sync --all-extras";
  }
  const installResult = runStep(installCmd, projectRoot, timeoutMs, {
    useSandbox: sandbox,
    sandboxImage: sandboxCfg.image,
    sandboxMemory: sandboxCfg.memory,
    sandboxCpus: sandboxCfg.cpus,
    run,
    dockerAvailable,
  });
  data.install = installResult;
  // post_run.py:419-422 — install timeout / failure ⇒ status, but DON'T early-return.
  if (installResult.timed_out) {
    data.status = "install_timeout";
  } else if (!installResult.success) {
    data.status = "install_failed";
  }

  // post_run.py:424-433 — run tests even if install failed (may produce output).
  const testResult = runStep(project.test, projectRoot, timeoutMs, {
    useSandbox: sandbox,
    sandboxImage: sandboxCfg.image,
    sandboxMemory: sandboxCfg.memory,
    sandboxCpus: sandboxCfg.cpus,
    run,
    dockerAvailable,
  });
  data.test = testResult;
  // post_run.py:435-436 — test timeout ⇒ status.
  if (testResult.timed_out) {
    data.status = "test_timeout";
  }

  // post_run.py:438-440 — parse test output, attach parsed_results.
  const parsed = parseTestOutput(project.type, String(testResult.output ?? ""));
  (testResult as Record<string, unknown>).parsed_results = parsed;

  // post_run.py:442 — write the nested dict atomically.
  writeResults(outPath, data);
  return outPath;
}

// post_run.py:446-447 — atomic_yaml_dump wrapper.
function writeResults(path: string, data: Record<string, unknown>): void {
  atomicYamlDump(data, path);
}

// relative() yields OS-native separators; Python's PurePath.relative_to(...) is
// rendered with forward slashes here for stable cross-platform YAML.
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

// ── compatibility shim — run.ts still imports runPostRunTests ────────────────
// The faithful entry point is runPostEvaluation (above). This thin wrapper
// preserves the FLAT TestResults summary shape the existing orchestrator
// (run.ts:19,55) consumes, so editing run.ts is unnecessary. It delegates
// detection + the two parsers to the faithful primitives and derives the flat
// summary the collector once produced.
export function runPostRunTests(
  workspace: string,
  opts: { installTimeoutMs?: number; testTimeoutMs?: number; run?: RunSeam } = {},
): TestResults {
  const skipped: TestResults = {
    status: "skipped", install_ok: false, test_ok: false,
    passed: 0, failed: 0, errors: 0, total: 0, pass_pct: 0, coverage_pct: null,
  };
  const project = detectProject(workspace);
  if (!project) return skipped;

  const run = opts.run ?? defaultRun;
  const hostEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "VIRTUAL_ENV" || k === "CONDA_PREFIX") continue;
    if (v !== undefined) hostEnv[k] = v;
  }
  hostEnv.HOME = project.root;

  const runOne = (command: string, timeoutMs: number) => {
    let argv: string[];
    try {
      argv = shlexSplit(command);
    } catch {
      return { status: null as number | null, output: "", timedOut: false };
    }
    const r = run(argv[0]!, argv.slice(1), { cwd: project.root, env: hostEnv, timeoutMs });
    const timedOut = r.error?.code === "ETIMEDOUT";
    return { status: r.status, output: truncate((r.stdout ?? "") + (r.stderr ?? "")), timedOut };
  };

  const install = runOne(project.install, opts.installTimeoutMs ?? 300_000);
  if (install.timedOut) return { ...skipped, status: "install_timeout" };
  const installOk = install.status === 0;

  const test = runOne(project.test, opts.testTimeoutMs ?? 300_000);
  if (test.timedOut) return { ...skipped, status: "test_timeout", install_ok: installOk };

  const parsed = parseTestOutput(project.type, test.output);
  const passed = parsed.passed ?? 0;
  const failed = parsed.failed ?? 0;
  const errors = parsed.errors ?? 0;
  const skippedCount = parsed.skipped ?? 0;
  const total = passed + failed + errors + skippedCount;
  return {
    status: installOk ? "completed" : "install_failed",
    install_ok: installOk,
    test_ok: test.status === 0,
    passed,
    failed,
    errors,
    total,
    pass_pct: total > 0 ? (passed / total) * 100 : 0,
    coverage_pct: null,
  };
}
