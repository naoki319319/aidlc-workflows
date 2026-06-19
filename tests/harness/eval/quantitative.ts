// quantitative.ts — Stage 3: lint / security / duplication.
//
// Ports quantitative/scanner.py (project detection + orchestration),
// quantitative/analyzers.py (per-tool invocation + output parsing), and
// quantitative/models.py:QualityReport.compute_summary.
//
// Source-of-truth (read-only worktree):
//   .../evaluator/packages/quantitative/src/quantitative/{models,scanner,analyzers}.py
//
// This stage IS the external binaries (ruff/bandit/semgrep/eslint/npm/pmd). A
// "port" still shells out to the same tools and re-parses the same JSON/XML —
// there is no pure-logic shortcut. The value of porting (vs shelling to the
// Python package) is one toolchain instead of two; the cost is re-implementing
// the parsers, done faithfully below. Tools absent from PATH degrade to
// {available:false} exactly like the Python.
//
// TESTABILITY SEAM. Python's analyzer tests `patch("...shutil.which")`,
// `patch("..._tool_version")`, and `patch("..._run_tool")`. To run the parser
// logic as PURE TS tests, every binary-shelling run* function accepts an
// optional `deps: AnalyzerDeps` whose `which`/`runTool`/`toolVersion` default to
// the real spawnSync-backed implementations but can be replaced by stubs. The
// default `toolVersion` calls `deps.which` internally, so a test that stubs only
// `which` propagates into the version gate exactly like Python's real
// `_tool_version` calling the mocked `shutil.which` (analyzers.py:36).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import type {
  DuplicationFinding,
  LintFinding,
  QualityReport,
  SecurityFinding,
  ToolResult,
} from "./types.ts";
import { dumpYaml } from "./yaml.ts";

const TIMEOUT_MS = 120_000; // analyzers.py:26 _TIMEOUT = 120

// ── injectable seams (mirror analyzers.py subprocess.run / shutil.which) ─────
export interface ToolRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface AnalyzerDeps {
  // shutil.which(bin) → path | None. Returns the resolved path (truthy) or null.
  which(bin: string): string | null;
  // analyzers.py:71 _run_tool — runs argv in cwd, captures stdout/stderr/rc.
  runTool(argv: string[], cwd: string): ToolRun;
  // analyzers.py:29-55 _tool_version — version string or null if not installed.
  toolVersion(cmd: string, cwd?: string): string | null;
}

// analyzers.py:36 — `shutil.which(argv[0]) is None`. spawnSync `which`/`where`.
function defaultWhich(bin: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim().split("\n")[0] ?? "";
  return out || bin;
}

function defaultRunTool(argv: string[], cwd: string): ToolRun {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    timeout: TIMEOUT_MS,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
}

// analyzers.py:29-55 _tool_version. Try [cmd,--version] then [uv,run,cmd,--version];
// skip an argv whose argv[0] is not on PATH; on rc==0 take stdout's first line and
// regex /[\d]+\.[\d]+[\.\d]*/, else return that first line. None if all attempts fail.
function makeDefaultToolVersion(deps: Pick<AnalyzerDeps, "which" | "runTool">) {
  return function toolVersion(cmd: string, cwd?: string): string | null {
    const attempts: string[][] = [
      [cmd, "--version"],
      ["uv", "run", cmd, "--version"],
    ];
    for (const argv of attempts) {
      if (deps.which(argv[0]!) === null) continue;
      const r = deps.runTool(argv, cwd ?? process.cwd());
      if (r.code !== 0) continue;
      const firstLine = (r.stdout ?? "").trim().split("\n")[0] ?? "";
      const m = /[\d]+\.[\d]+[\.\d]*/.exec(firstLine);
      return m ? m[0] : firstLine;
    }
    return null;
  };
}

function defaultDeps(): AnalyzerDeps {
  const base = { which: defaultWhich, runTool: defaultRunTool };
  return { ...base, toolVersion: makeDefaultToolVersion(base) };
}

// analyzers.py:_resolve_cmd — prefer bare binary, fall back to `uv run <cmd>`.
function resolveCmd(deps: AnalyzerDeps, cmd: string): string[] | null {
  if (deps.which(cmd) !== null) return [cmd];
  if (deps.which("uv") !== null) return ["uv", "run", cmd];
  return [];
}

// analyzers.py:120 Path(raw_path).relative_to(project_root) → ValueError → raw.
function rel(root: string, raw: string): string {
  try {
    const r = relative(root, raw);
    return r.startsWith("..") ? raw : r;
  } catch {
    return raw;
  }
}

// ── ruff (analyzers.py:90-142) ─────────────────────────────────────────────
export function runRuff(root: string, deps: AnalyzerDeps = defaultDeps()): ToolResult<LintFinding> {
  // analyzers.py:92-96 — gate on version-is-None BEFORE _resolve_cmd.
  const version = deps.toolVersion("ruff", root);
  if (version === null) return unavailable("ruff", "ruff not found on PATH or via uv");
  const prefix = resolveCmd(deps, "ruff");
  if (!prefix || prefix.length === 0) return unavailable("ruff", "ruff not found on PATH or via uv");
  const r = deps.runTool([...prefix, "check", "--output-format=json", "--no-fix", "."], root);
  const findings: LintFinding[] = [];
  try {
    const items = r.stdout.trim() ? JSON.parse(r.stdout) : [];
    for (const item of items) {
      // analyzers.py:116 — "E"-prefixed codes are errors, else warnings.
      const sev: LintFinding["severity"] = String(item.code ?? "").startsWith("E") ? "error" : "warning";
      const rawPath = item.filename ?? "?"; // analyzers.py:117
      findings.push({
        file: rel(root, rawPath),
        line: item.location?.row ?? 0,
        column: item.location?.column ?? 0,
        code: item.code ?? "?", // analyzers.py:128
        message: item.message ?? "",
        severity: sev,
      });
    }
  } catch {
    /* JSONDecodeError → empty findings, still available (analyzers.py:133) */
  }
  return { tool: "ruff", version, available: true, exit_code: r.code, error: null, findings };
}

// ── bandit (analyzers.py:150-200) ──────────────────────────────────────────
export function runBandit(root: string, deps: AnalyzerDeps = defaultDeps()): ToolResult<SecurityFinding> {
  const version = deps.toolVersion("bandit", root);
  if (version === null) return unavailable("bandit", "bandit not found on PATH or via uv");
  const prefix = resolveCmd(deps, "bandit");
  if (!prefix || prefix.length === 0) return unavailable("bandit", "bandit not found on PATH or via uv");
  const target = existsSync(join(root, "src")) ? join(root, "src") : ".";
  const r = deps.runTool([...prefix, "-r", target, "-f", "json", "-q"], root);
  const findings: SecurityFinding[] = [];
  try {
    const output = r.stdout || r.stderr;
    const data = output.trim() ? JSON.parse(output) : {};
    for (const item of data.results ?? []) {
      findings.push({
        file: item.filename ?? "?", // analyzers.py:182
        line: item.line_number ?? 0,
        code: item.test_id ?? "?", // analyzers.py:184
        message: item.issue_text ?? "",
        severity: String(item.issue_severity ?? "MEDIUM").toLowerCase() as SecurityFinding["severity"],
        confidence: String(item.issue_confidence ?? "MEDIUM").toLowerCase() as SecurityFinding["confidence"],
        cwe: extractCwe(item),
      });
    }
  } catch {
    /* ignore */
  }
  return { tool: "bandit", version, available: true, exit_code: r.code, error: null, findings };
}

// analyzers.py:203-207 _extract_cwe — {"id": N} → "CWE-N".
function extractCwe(item: any): string | null {
  const cwe = item.issue_cwe;
  if (cwe && typeof cwe === "object" && cwe.id) return `CWE-${cwe.id}`;
  return null;
}

// ── eslint (analyzers.py:215-259) ──────────────────────────────────────────
export function runEslint(root: string, deps: AnalyzerDeps = defaultDeps()): ToolResult<LintFinding> {
  // analyzers.py:217-226 — version gate uses the BARE 'eslint' (no cwd, no uv);
  // when None, fall back to npx if present, else unavailable.
  const version = deps.toolVersion("eslint");
  let argv: string[];
  if (version === null) {
    if (deps.which("npx") === null) {
      return unavailable("eslint", "eslint/npx not found on PATH");
    }
    argv = ["npx", "eslint", ".", "--format=json"];
  } else {
    argv = ["eslint", ".", "--format=json"];
  }
  const r = deps.runTool(argv, root);
  const findings: LintFinding[] = [];
  try {
    const items = r.stdout.trim() ? JSON.parse(r.stdout) : [];
    for (const fileResult of items) {
      for (const msg of fileResult.messages ?? []) {
        const sevNum = msg.severity ?? 1;
        const sev: LintFinding["severity"] = sevNum === 2 ? "error" : "warning";
        findings.push({
          file: fileResult.filePath ?? "?", // analyzers.py:242
          line: msg.line ?? 0,
          column: msg.column ?? 0,
          code: (msg.ruleId ?? "?") || "parse-error", // analyzers.py:245
          message: msg.message ?? "",
          severity: sev,
        });
      }
    }
  } catch {
    /* ignore */
  }
  // analyzers.py:255 — version=version or "npx".
  return { tool: "eslint", version: version ?? "npx", available: true, exit_code: r.code, error: null, findings };
}

// ── npm audit (analyzers.py:267-315) ───────────────────────────────────────
export function runNpmAudit(root: string, deps: AnalyzerDeps = defaultDeps()): ToolResult<SecurityFinding> {
  // analyzers.py:269-273 — npm gate is shutil.which('npm'), NOT _tool_version.
  if (deps.which("npm") === null) return unavailable("npm-audit", "npm not found on PATH");
  const version = deps.toolVersion("npm");
  if (!existsSync(join(root, "package-lock.json"))) {
    return { tool: "npm-audit", version, available: true, exit_code: null, error: "no package-lock.json found", findings: [] };
  }
  const r = deps.runTool(["npm", "audit", "--json"], root);
  const findings: SecurityFinding[] = [];
  try {
    const data = r.stdout.trim() ? JSON.parse(r.stdout) : {};
    for (const [name, info] of Object.entries<any>(data.vulnerabilities ?? {})) {
      // analyzers.py:299-300 — via[0].source / via[0].title, guarded by `if info.get("via")`.
      const via = info.via;
      const via0 = Array.isArray(via) && via.length && typeof via[0] === "object" ? via[0] : null;
      findings.push({
        file: `package: ${name}`,
        line: 0,
        code: via && via0 ? (via0.source ?? "?") : "?",
        message: via && via0 ? (via0.title ?? "") : name,
        severity: String(info.severity ?? "medium").toLowerCase() as SecurityFinding["severity"],
        confidence: "high",
        cwe: null,
      });
    }
  } catch {
    /* ignore */
  }
  return { tool: "npm-audit", version, available: true, exit_code: r.code, error: null, findings };
}

// ── semgrep (analyzers.py:329-399) ─────────────────────────────────────────
const SEMGREP_SEVERITY: Record<string, SecurityFinding["severity"]> = {
  ERROR: "high",
  WARNING: "medium",
  INFO: "low",
};
export function runSemgrep(root: string, deps: AnalyzerDeps = defaultDeps()): ToolResult<SecurityFinding> {
  const version = deps.toolVersion("semgrep", root);
  if (version === null) return unavailable("semgrep", "semgrep not found on PATH or via uv");
  const prefix = resolveCmd(deps, "semgrep");
  if (!prefix || prefix.length === 0) return unavailable("semgrep", "semgrep not found on PATH or via uv");
  const srcDir = join(root, "src");
  const scanTarget = existsSync(srcDir) ? srcDir : root;
  const r = deps.runTool([...prefix, "scan", "--config", "auto", "--json", scanTarget], root);
  const findings: SecurityFinding[] = [];
  try {
    const data = r.stdout.trim() ? JSON.parse(r.stdout) : {};
    for (const item of data.results ?? []) {
      const rawSev = item.extra?.severity ?? "WARNING";
      const sev = SEMGREP_SEVERITY[rawSev] ?? "medium";
      const meta = item.extra?.metadata ?? {};
      const cweList = meta.cwe ?? [];
      findings.push({
        file: rel(root, item.path ?? "?"), // analyzers.py:368
        line: item.start?.line ?? 0,
        code: item.check_id ?? "?", // analyzers.py:380
        message: item.extra?.message ?? "",
        severity: sev,
        confidence: String(meta.confidence ?? "MEDIUM").toLowerCase() as SecurityFinding["confidence"],
        cwe: Array.isArray(cweList) && cweList.length ? cweList[0] : null,
      });
    }
  } catch {
    /* ignore */
  }
  return { tool: "semgrep", version, available: true, exit_code: r.code, error: null, findings };
}

// ── PMD CPD (analyzers.py:406-533) ─────────────────────────────────────────
const CPD_LANGUAGE_MAP: Record<string, string> = { python: "python", node: "ecmascript" };
const CPD_EXCLUDES = new Set([
  ".pytest_cache", "__pycache__", ".venv", "venv", "node_modules",
  ".git", ".tox", ".mypy_cache", ".ruff_cache", ".cache",
]);

// analyzers.py:412-426 _resolve_pmd — honor configured pmd_path (expanduser+is_file)
// else search PATH for pmd then pmd.bat.
export function resolvePmd(deps: AnalyzerDeps, configuredPath?: string | null): string | null {
  if (configuredPath) {
    const p = expanduser(configuredPath);
    // is_file() — exists and not a directory. existsSync + statSync.
    try {
      const st = require("node:fs").statSync(p);
      if (st.isFile()) return p;
    } catch {
      /* not a file */
    }
    return null;
  }
  for (const name of ["pmd", "pmd.bat"]) {
    const found = deps.which(name);
    if (found) return found;
  }
  return null;
}

function expanduser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home + p.slice(1);
  }
  return p;
}

export function runCpd(
  root: string,
  language = "python",
  minTokens = 100,
  pmdPath: string | null = null,
  deps: AnalyzerDeps = defaultDeps(),
): ToolResult<DuplicationFinding> {
  const pmd = resolvePmd(deps, pmdPath);
  if (pmd === null) {
    return unavailable("pmd-cpd", "pmd not found — set tools.pmd_path in config or install pmd on PATH");
  }
  const cpdLang = CPD_LANGUAGE_MAP[language] ?? language;

  // analyzers.py:459-467 — os.walk the whole tree emitting --exclude ./<relpath>
  // per nested match, pruning descent into excluded dirs.
  const excludeArgs: string[] = [];
  const absRoot = resolve(root);
  walkExcludes(absRoot, absRoot, excludeArgs);

  const r = deps.runTool(
    [
      pmd, "cpd", "--minimum-tokens", String(minTokens), "--dir", ".",
      "--language", cpdLang, "--format", "xml", "--no-fail-on-violation",
      ...excludeArgs,
    ],
    root,
  );
  const findings: DuplicationFinding[] = [];
  try {
    if (r.stdout.trim()) {
      // analyzers.py:493-523 — defusedxml strips the namespace; reproduce by
      // matching tags with an optional `ns:` prefix (namespace-tolerant).
      for (const dup of matchTags(r.stdout, "duplication")) {
        const lines = Number(attr(dup.attrs, "lines") ?? 0);
        const tokens = Number(attr(dup.attrs, "tokens") ?? 0);
        const files: DuplicationFinding["files"] = [];
        for (const f of matchSelfClosing(dup.inner, "file")) {
          const rawPath = attr(f.attrs, "path") ?? "?";
          files.push({
            file: rel(root, rawPath),
            line: Number(attr(f.attrs, "line") ?? 0),
            endline: Number(attr(f.attrs, "endline") ?? 0),
          });
        }
        const fragMatch = matchTags(dup.inner, "codefragment")[0];
        const codefragment = (fragMatch ? decodeXmlText(fragMatch.inner).trim() : "");
        findings.push({ files, tokens, lines, codefragment: codefragment.slice(0, 500) });
      }
    }
  } catch {
    /* ParseError → ignore */
  }
  // analyzers.py:529 — CPD version is None (not "pmd").
  return { tool: "pmd-cpd", version: null, available: true, exit_code: r.code, error: null, findings };
}

// os.walk-equivalent: for each dir under root, emit --exclude ./<relpath> for any
// child dir whose name is in CPD_EXCLUDES, and do not descend into excluded dirs.
function walkExcludes(absRoot: string, dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (CPD_EXCLUDES.has(e.name)) {
      const childAbs = join(dir, e.name);
      let relPath = relative(absRoot, childAbs);
      if (relPath === "") relPath = ".";
      out.push("--exclude", `./${relPath}`);
    } else {
      subdirs.push(join(dir, e.name));
    }
  }
  for (const sub of subdirs) walkExcludes(absRoot, sub, out);
}

// ── namespace-tolerant XML helpers (defusedxml ns-strip equivalent) ─────────
// Match <ns:tag ...>...</ns:tag> (paired). Returns attrs string + inner text.
function matchTags(xml: string, tag: string): Array<{ attrs: string; inner: string }> {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "g");
  const out: Array<{ attrs: string; inner: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1]!, inner: m[2]! });
  return out;
}
// Match self-closing or paired <ns:tag .../> (file elements are self-closing).
function matchSelfClosing(xml: string, tag: string): Array<{ attrs: string }> {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)\\/?>`, "g");
  const out: Array<{ attrs: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1]! });
  return out;
}
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1]! : null;
}
function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function unavailable<F>(tool: string, error: string): ToolResult<F> {
  return { tool, version: null, available: false, exit_code: null, error, findings: [] };
}

// ── scanner.py:_detect_project ─────────────────────────────────────────────
const MAX_SEARCH_DEPTH = 3;
const SKIP_DIRS = new Set([
  ".venv", "venv", ".env", "env", "node_modules", "__pycache__", ".pytest_cache",
  ".ruff_cache", ".mypy_cache", ".git", ".hg", ".svn", "target", "dist", "build",
  ".tox", ".nox", ".cache",
]);
const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];
const NODE_MARKERS = ["package.json"];

// scanner.py:48-88 — BFS, max depth 3, skip vendor + hidden dirs. Returns the
// ABSOLUTE project root (matches _detect_project's tuple second element).
export function detectProject(workspace: string): { type: string; root: string } | null {
  if (!isDir(workspace)) return null;

  const check = (d: string): string | null => {
    if (PYTHON_MARKERS.some((m) => existsSync(join(d, m)))) return "python";
    if (NODE_MARKERS.some((m) => existsSync(join(d, m)))) return "node";
    return null;
  };

  const pt = check(workspace);
  if (pt) return { type: pt, root: workspace };

  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspace, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth >= MAX_SEARCH_DEPTH) continue;
    let children: string[];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort()
        .map((n) => join(dir, n));
    } catch {
      continue;
    }
    for (const child of children) {
      const cpt = check(child);
      if (cpt) return { type: cpt, root: child };
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return require("node:fs").statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── scanner.py:scan_workspace ──────────────────────────────────────────────
// Injectable analyzers so tests can stub run_ruff/run_bandit/etc. (parity with
// test_scanner.py patching quantitative.scanner.run_ruff / run_bandit).
export interface ScanAnalyzers {
  runRuff(root: string): ToolResult<LintFinding>;
  runBandit(root: string): ToolResult<SecurityFinding>;
  runEslint(root: string): ToolResult<LintFinding>;
  runNpmAudit(root: string): ToolResult<SecurityFinding>;
  runSemgrep(root: string): ToolResult<SecurityFinding>;
  runCpd(root: string, language: string, pmdPath?: string | null): ToolResult<DuplicationFinding>;
}

function defaultAnalyzers(): ScanAnalyzers {
  return {
    runRuff: (root) => runRuff(root),
    runBandit: (root) => runBandit(root),
    runEslint: (root) => runEslint(root),
    runNpmAudit: (root) => runNpmAudit(root),
    runSemgrep: (root) => runSemgrep(root),
    runCpd: (root, language, pmdPath) => runCpd(root, language, 100, pmdPath ?? null),
  };
}

export function scanWorkspace(
  workspace: string,
  pmdPath: string | null = null,
  analyzers: ScanAnalyzers = defaultAnalyzers(),
): QualityReport | null {
  const detection = detectProject(workspace);
  if (detection === null) return null;
  const { type: projectType, root: projectRoot } = detection;

  let lint: ToolResult<LintFinding>;
  let security: ToolResult<SecurityFinding>;
  let semgrep: ToolResult<SecurityFinding>;
  let duplication: ToolResult<DuplicationFinding>;
  if (projectType === "python") {
    lint = analyzers.runRuff(projectRoot);
    security = analyzers.runBandit(projectRoot);
    semgrep = analyzers.runSemgrep(projectRoot);
    duplication = analyzers.runCpd(projectRoot, "python", pmdPath);
  } else if (projectType === "node") {
    lint = analyzers.runEslint(projectRoot);
    security = analyzers.runNpmAudit(projectRoot);
    semgrep = analyzers.runSemgrep(projectRoot);
    duplication = analyzers.runCpd(projectRoot, "node", pmdPath);
  } else {
    return null;
  }

  const report: QualityReport = {
    project_type: projectType,
    // scanner.py:135 — project_root RELATIVE to workspace, or "." when equal.
    project_root: projectRoot !== workspace ? relWorkspace(workspace, projectRoot) : ".",
    lint,
    security,
    semgrep,
    duplication,
    summary: {},
  };
  report.summary = computeSummary(report);
  return report;
}

// Python str(project_root.relative_to(workspace)) — raises if not a subpath, but
// scan_workspace only computes it when projectRoot != workspace and BFS keeps
// roots inside the workspace, so a plain relative() suffices.
function relWorkspace(workspace: string, projectRoot: string): string {
  return relative(workspace, projectRoot);
}

// scanner.py:145-149 write_report — asdict(report) → YAML (block style, no sort).
export function writeReport(report: QualityReport, outputPath: string): void {
  require("node:fs").writeFileSync(outputPath, dumpYaml(report), "utf-8");
}

// Back-compat alias for the prior spike export name.
export const runQualityAnalysis = scanWorkspace;

// ── quantitative/models.py:57-85 compute_summary ───────────────────────────
export function computeSummary(report: QualityReport): Record<string, number> {
  const s: Record<string, number> = {};
  if (report.lint?.available) {
    const f = report.lint.findings;
    s.lint_total = f.length;
    s.lint_errors = f.filter((x) => x.severity === "error").length;
    s.lint_warnings = f.filter((x) => x.severity === "warning").length;
  }
  const sec: SecurityFinding[] = [];
  let hasSecTool = false;
  if (report.security?.available) {
    sec.push(...report.security.findings);
    hasSecTool = true;
  }
  if (report.semgrep?.available) {
    sec.push(...report.semgrep.findings);
    hasSecTool = true;
  }
  if (hasSecTool) {
    s.security_total = sec.length;
    s.security_high = sec.filter((x) => x.severity === "high").length;
    s.security_medium = sec.filter((x) => x.severity === "medium").length;
    s.security_low = sec.filter((x) => x.severity === "low").length;
  }
  if (report.duplication?.available) {
    const d = report.duplication.findings;
    s.duplication_blocks = d.length;
    s.duplication_lines = d.reduce((a, x) => a + x.lines, 0);
    s.duplication_tokens = d.reduce((a, x) => a + x.tokens, 0);
  }
  return s;
}
