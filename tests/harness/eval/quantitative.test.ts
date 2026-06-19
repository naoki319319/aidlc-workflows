// quantitative.test.ts — 1:1 port of the Python quantitative test suite.
//
// Mirrors (read-only worktree):
//   .../evaluator/packages/quantitative/tests/test_models.py    (4 pure)
//   .../evaluator/packages/quantitative/tests/test_scanner.py   (8 pure)
//   .../evaluator/packages/quantitative/tests/test_analyzers.py (10 pure w/ stubs)
//
// The Python analyzer tests `patch("...shutil.which")`, `patch("..._tool_version")`,
// and `patch("..._run_tool")`. Here those are injected via the AnalyzerDeps seam:
// each run* takes a deps object whose which/runTool/toolVersion are stubbed, so the
// parser logic runs PURE — no real ruff/bandit/eslint/npm/pmd binary needed.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnalyzerDeps,
  type ScanAnalyzers,
  type ToolRun,
  computeSummary,
  detectProject,
  runBandit,
  runEslint,
  runNpmAudit,
  runRuff,
  scanWorkspace,
  writeReport,
} from "./quantitative.ts";
import type {
  DuplicationFinding,
  LintFinding,
  QualityReport,
  SecurityFinding,
  ToolResult,
} from "./types.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

// A QualityReport with all-null tools, so each test fills only what it asserts.
function makeReport(overrides: Partial<QualityReport>): QualityReport {
  return {
    project_type: "python",
    project_root: ".",
    lint: null,
    security: null,
    semgrep: null,
    duplication: null,
    summary: {},
    ...overrides,
  };
}

function lintFinding(
  file: string,
  line: number,
  column: number,
  code: string,
  message: string,
  severity: LintFinding["severity"],
): LintFinding {
  return { file, line, column, code, message, severity };
}

function securityFinding(
  file: string,
  line: number,
  code: string,
  message: string,
  severity: SecurityFinding["severity"],
  confidence: SecurityFinding["confidence"],
  cwe: string | null = null,
): SecurityFinding {
  return { file, line, code, message, severity, confidence, cwe };
}

// test_analyzers.py:14-19 _mock_run.
function mockRun(stdout = "", stderr = "", returncode = 0): ToolRun {
  return { stdout, stderr, code: returncode };
}

// AnalyzerDeps stub builder. `whichMap`: name → path|null (default: everything
// found). `version`: the toolVersion result (mirrors patching _tool_version).
// `run`: the _run_tool result.
function makeDeps(opts: {
  which?: (bin: string) => string | null;
  version?: string | null;
  run?: ToolRun;
}): AnalyzerDeps {
  return {
    which: opts.which ?? (() => "/usr/bin/stub"),
    toolVersion: () => (opts.version ?? null),
    runTool: () => opts.run ?? mockRun(),
  };
}

let tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "quant-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// test_models.py — compute_summary (4 pure)
// ═══════════════════════════════════════════════════════════════════════════

describe("compute_summary", () => {
  test("test_compute_summary_lint_only", () => {
    const report = makeReport({
      lint: {
        tool: "ruff",
        version: "0.8.0",
        available: true,
        exit_code: 1,
        error: null,
        findings: [
          lintFinding("a.py", 1, 1, "E501", "line too long", "error"),
          lintFinding("b.py", 2, 1, "W291", "trailing whitespace", "warning"),
          lintFinding("c.py", 3, 1, "E302", "expected 2 blank lines", "error"),
        ],
      },
    });
    const summary = computeSummary(report);
    expect(summary.lint_total).toBe(3);
    expect(summary.lint_errors).toBe(2);
    expect(summary.lint_warnings).toBe(1);
  });

  test("test_compute_summary_security_only", () => {
    const report = makeReport({
      security: {
        tool: "bandit",
        version: "1.7.0",
        available: true,
        exit_code: 1,
        error: null,
        findings: [
          securityFinding("s.py", 10, "B101", "assert used", "low", "high"),
          securityFinding("s.py", 20, "B608", "SQL injection", "high", "medium"),
        ],
      },
    });
    const summary = computeSummary(report);
    expect(summary.security_total).toBe(2);
    expect(summary.security_high).toBe(1);
    expect(summary.security_low).toBe(1);
  });

  test("test_compute_summary_both", () => {
    const report = makeReport({
      lint: { tool: "ruff", version: "0.8.0", available: true, exit_code: 0, error: null, findings: [] },
      security: { tool: "bandit", version: "1.7.0", available: true, exit_code: 0, error: null, findings: [] },
    });
    const summary = computeSummary(report);
    expect(summary.lint_total).toBe(0);
    expect(summary.lint_errors).toBe(0);
    expect(summary.security_total).toBe(0);
    expect(summary.security_high).toBe(0);
  });

  test("test_compute_summary_unavailable_tool", () => {
    const report = makeReport({
      lint: { tool: "ruff", version: null, available: false, exit_code: null, error: "not found", findings: [] },
    });
    const summary = computeSummary(report);
    // Python: "lint_total" not in report.summary — omitted, not zeroed.
    expect("lint_total" in summary).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// test_scanner.py — _detect_project + scan_workspace + write_report (8 pure)
// ═══════════════════════════════════════════════════════════════════════════

describe("TestDetectProject", () => {
  test("test_python_at_root", () => {
    const tmp = mkTmp();
    writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname = 'x'\n");
    const result = detectProject(tmp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("python");
    expect(result!.root).toBe(tmp);
  });

  test("test_python_nested", () => {
    const tmp = mkTmp();
    const nested = join(tmp, "app");
    mkdirSync(nested);
    writeFileSync(join(nested, "package.json"), "{}");
    const result = detectProject(tmp);
    expect(result).not.toBeNull();
    // Python test name says python, asserts node (BFS finds package.json).
    expect(result!.type).toBe("node");
    expect(result!.root).toBe(nested);
  });

  test("test_empty_workspace", () => {
    const tmp = mkTmp();
    expect(detectProject(tmp)).toBeNull();
  });

  test("test_skips_venv", () => {
    const tmp = mkTmp();
    const venv = join(tmp, ".venv");
    mkdirSync(venv);
    writeFileSync(join(venv, "pyproject.toml"), "[project]\nname='x'\n");
    expect(detectProject(tmp)).toBeNull();
  });

  test("test_skips_node_modules", () => {
    const tmp = mkTmp();
    const nm = join(tmp, "node_modules");
    mkdirSync(nm);
    writeFileSync(join(nm, "package.json"), "{}");
    expect(detectProject(tmp)).toBeNull();
  });
});

describe("TestScanWorkspace", () => {
  test("test_no_project", () => {
    const tmp = mkTmp();
    expect(scanWorkspace(tmp)).toBeNull();
  });

  test("test_python_project", () => {
    const tmp = mkTmp();
    writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname='x'\n");
    mkdirSync(join(tmp, "src"));

    const mockLint: ToolResult<LintFinding> = {
      tool: "ruff", version: "0.8.0", available: true, exit_code: 0, error: null, findings: [],
    };
    const mockSec: ToolResult<SecurityFinding> = {
      tool: "bandit", version: "1.7.0", available: true, exit_code: 0, error: null, findings: [],
    };
    const unavail = <F>(tool: string): ToolResult<F> => ({
      tool, version: null, available: false, exit_code: null, error: "stub", findings: [],
    });
    // Mirror patch(run_ruff)/patch(run_bandit); stub the rest so nothing shells out.
    const analyzers: ScanAnalyzers = {
      runRuff: () => mockLint,
      runBandit: () => mockSec,
      runEslint: () => unavail<LintFinding>("eslint"),
      runNpmAudit: () => unavail<SecurityFinding>("npm-audit"),
      runSemgrep: () => unavail<SecurityFinding>("semgrep"),
      runCpd: () => unavail<DuplicationFinding>("pmd-cpd"),
    };

    const report = scanWorkspace(tmp, null, analyzers);
    expect(report).not.toBeNull();
    expect(report!.project_type).toBe("python");
    expect(report!.lint!.tool).toBe("ruff");
    expect(report!.security!.tool).toBe("bandit");
    expect(report!.summary.lint_total).toBe(0);
    expect(report!.summary.security_total).toBe(0);
  });
});

describe("TestWriteReport", () => {
  test("test_roundtrip", () => {
    const tmp = mkTmp();
    writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname='x'\n");

    const mockLint: ToolResult<LintFinding> = {
      tool: "ruff", version: "0.8.0", available: true, exit_code: 0, error: null, findings: [],
    };
    const mockSec: ToolResult<SecurityFinding> = {
      tool: "bandit", version: "1.7.0", available: true, exit_code: 0, error: null, findings: [],
    };
    const unavail = <F>(tool: string): ToolResult<F> => ({
      tool, version: null, available: false, exit_code: null, error: "stub", findings: [],
    });
    const analyzers: ScanAnalyzers = {
      runRuff: () => mockLint,
      runBandit: () => mockSec,
      runEslint: () => unavail<LintFinding>("eslint"),
      runNpmAudit: () => unavail<SecurityFinding>("npm-audit"),
      runSemgrep: () => unavail<SecurityFinding>("semgrep"),
      runCpd: () => unavail<DuplicationFinding>("pmd-cpd"),
    };

    const report = scanWorkspace(tmp, null, analyzers)!;
    const out = join(tmp, "quality-report.yaml");
    writeReport(report, out);

    const data: any = Bun.YAML.parse(require("node:fs").readFileSync(out, "utf-8"));
    expect(data.project_type).toBe("python");
    expect(data.lint.tool).toBe("ruff");
    expect(data.security.tool).toBe("bandit");
    expect(data.summary.lint_total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// test_analyzers.py — parser logic with injected which/runTool/toolVersion (10)
// ═══════════════════════════════════════════════════════════════════════════

describe("TestRuff", () => {
  test("test_not_installed", () => {
    // patch shutil.which → None only; real _tool_version then returns None.
    const deps: AnalyzerDeps = {
      which: () => null,
      runTool: () => mockRun(),
      toolVersion: () => null, // which→None propagates to version gate
    };
    const result = runRuff(".", deps);
    expect(result.available).toBe(false);
    expect(result.error).toContain("ruff not found");
  });

  test("test_clean_output", () => {
    const deps = makeDeps({ which: () => "/usr/bin/ruff", version: "0.8.0", run: mockRun("[]") });
    const result = runRuff(".", deps);
    expect(result.available).toBe(true);
    expect(result.findings.length).toBe(0);
  });

  test("test_findings_parsed", () => {
    const items = [
      { filename: "app.py", location: { row: 10, column: 5 }, code: "E501", message: "Line too long" },
      { filename: "utils.py", location: { row: 3, column: 1 }, code: "W291", message: "Trailing whitespace" },
    ];
    const deps = makeDeps({
      which: () => "/usr/bin/ruff",
      version: "0.8.0",
      run: mockRun(JSON.stringify(items), "", 1),
    });
    const result = runRuff(".", deps);
    expect(result.findings.length).toBe(2);
    expect(result.findings[0]!.code).toBe("E501");
    expect(result.findings[0]!.severity).toBe("error");
    expect(result.findings[1]!.code).toBe("W291");
    expect(result.findings[1]!.severity).toBe("warning");
  });
});

describe("TestBandit", () => {
  test("test_not_installed", () => {
    const deps: AnalyzerDeps = { which: () => null, runTool: () => mockRun(), toolVersion: () => null };
    const result = runBandit(".", deps);
    expect(result.available).toBe(false);
  });

  test("test_clean_output", () => {
    const deps = makeDeps({
      which: () => "/usr/bin/bandit",
      version: "1.7.0",
      run: mockRun(JSON.stringify({ results: [] })),
    });
    const result = runBandit(".", deps);
    expect(result.available).toBe(true);
    expect(result.findings.length).toBe(0);
  });

  test("test_findings_parsed", () => {
    const data = {
      results: [
        {
          filename: "app.py",
          line_number: 42,
          test_id: "B608",
          issue_text: "Possible SQL injection",
          issue_severity: "HIGH",
          issue_confidence: "MEDIUM",
          issue_cwe: { id: 89, link: "https://cwe.mitre.org/data/definitions/89.html" },
        },
      ],
    };
    const deps = makeDeps({
      which: () => "/usr/bin/bandit",
      version: "1.7.0",
      run: mockRun(JSON.stringify(data), "", 1),
    });
    const result = runBandit(".", deps);
    expect(result.findings.length).toBe(1);
    const f = result.findings[0]!;
    expect(f.code).toBe("B608");
    expect(f.severity).toBe("high");
    expect(f.cwe).toBe("CWE-89");
  });
});

describe("TestEslint", () => {
  test("test_not_installed", () => {
    // which→None for both eslint and npx; _tool_version→None.
    const deps: AnalyzerDeps = { which: () => null, runTool: () => mockRun(), toolVersion: () => null };
    const result = runEslint(".", deps);
    expect(result.available).toBe(false);
  });

  test("test_findings_parsed", () => {
    const items = [
      {
        filePath: "/app/index.js",
        messages: [
          { severity: 2, ruleId: "no-unused-vars", message: "'x' is unused", line: 5, column: 1 },
          { severity: 1, ruleId: "semi", message: "Missing semicolon", line: 10, column: 20 },
        ],
      },
    ];
    const deps = makeDeps({
      which: () => "/usr/bin/eslint",
      version: "8.0.0",
      run: mockRun(JSON.stringify(items), "", 1),
    });
    const result = runEslint(".", deps);
    expect(result.findings.length).toBe(2);
    expect(result.findings[0]!.severity).toBe("error");
    expect(result.findings[1]!.severity).toBe("warning");
  });
});

describe("TestNpmAudit", () => {
  test("test_not_installed", () => {
    const deps: AnalyzerDeps = { which: () => null, runTool: () => mockRun(), toolVersion: () => null };
    const result = runNpmAudit(".", deps);
    expect(result.available).toBe(false);
  });

  test("test_no_lockfile", () => {
    // npm present + version; tmp_path has no package-lock.json.
    const tmp = mkTmp();
    const deps = makeDeps({ which: () => "/usr/bin/npm", version: "10.0.0" });
    const result = runNpmAudit(tmp, deps);
    expect(result.available).toBe(true);
    expect(result.error).toBe("no package-lock.json found");
  });
});
