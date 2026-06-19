// postrun.test.ts — 1:1 mirror of execution/tests/test_post_run.py.
//
// Source of truth (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/execution/tests/test_post_run.py
//
// 38 pure tests (project detection / output parsers / truncate / parse_test_output /
// no-workspace / empty-workspace) run WITHOUT any toolchain. The 2 gated-binary
// tests (test_python_project_detected, test_result_yaml_schema) run the real
// `uv pip install`/`pytest` and self-skip cleanly when `uv` is absent.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCargo,
  parseGo,
  parseJest,
  parsePytest,
  truncate as _truncate,
  detectProject,
  parseTestOutput as parse_test_output,
  runPostEvaluation as run_post_evaluation,
} from "./postrun.ts";
import { defaultRunnerConfig as RunnerConfig } from "./config.ts";

// pytest tmp_path equivalent — a fresh temp dir per test.
function tmpPath(): string {
  return mkdtempSync(join(tmpdir(), "aidlc-postrun-"));
}

// Bun.YAML.parse stands in for the test's `yaml.safe_load`.
function loadYaml(path: string): Record<string, unknown> {
  return Bun.YAML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Project detection — test_post_run.py:25-146
// ---------------------------------------------------------------------------

describe("TestDetectProject", () => {
  test("test_pyproject_toml", () => {
    const t = tmpPath();
    writeFileSync(join(t, "pyproject.toml"), "[project]\nname='x'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("python");
    expect(info!.install).toContain("uv");
    expect(info!.test).toContain("pytest");
    expect(info!.root).toBe(t);
  });

  test("test_package_json", () => {
    const t = tmpPath();
    writeFileSync(join(t, "package.json"), '{"name": "x"}');
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("node");
    expect(info!.install).toContain("npm install");
  });

  test("test_cargo_toml", () => {
    const t = tmpPath();
    writeFileSync(join(t, "Cargo.toml"), "[package]\nname='x'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("rust");
  });

  test("test_go_mod", () => {
    const t = tmpPath();
    writeFileSync(join(t, "go.mod"), "module example.com/x\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("go");
  });

  test("test_setup_py", () => {
    const t = tmpPath();
    writeFileSync(join(t, "setup.py"), "from setuptools import setup\nsetup()");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("python-legacy");
  });

  test("test_no_markers", () => {
    const t = tmpPath();
    writeFileSync(join(t, "README.md"), "# Hello");
    const info = detectProject(t);
    expect(info).toBeNull();
  });

  test("test_priority_pyproject_over_package_json", () => {
    const t = tmpPath();
    writeFileSync(join(t, "pyproject.toml"), "[project]\nname='x'\n");
    writeFileSync(join(t, "package.json"), '{"name": "x"}');
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("python");
  });

  test("test_empty_directory", () => {
    const t = tmpPath();
    const info = detectProject(t);
    expect(info).toBeNull();
  });

  test("test_subdirectory_detection", () => {
    const t = tmpPath();
    const subdir = join(t, "my-app");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "pyproject.toml"), "[project]\nname='x'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("python");
    expect(info!.root).toBe(subdir);
  });

  test("test_subdirectory_not_checked_when_root_has_marker", () => {
    const t = tmpPath();
    writeFileSync(join(t, "package.json"), '{"name": "root"}');
    const subdir = join(t, "sub");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "pyproject.toml"), "[project]\nname='sub'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("node");
    expect(info!.root).toBe(t);
  });

  test("test_hidden_subdirectories_skipped", () => {
    const t = tmpPath();
    const hidden = join(t, ".cache");
    mkdirSync(hidden);
    writeFileSync(join(hidden, "pyproject.toml"), "[project]\nname='x'\n");
    const info = detectProject(t);
    expect(info).toBeNull();
  });

  test("test_vendor_directories_skipped", () => {
    const t = tmpPath();
    for (const vendor of [".venv", "node_modules", "__pycache__"]) {
      const d = join(t, vendor);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "pyproject.toml"), "[project]\nname='x'\n");
    }
    const info = detectProject(t);
    expect(info).toBeNull();
  });

  test("test_deeply_nested_project", () => {
    const t = tmpPath();
    const nested = join(t, "sci-calc", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "pyproject.toml"), "[project]\nname='x'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("python");
    expect(info!.root).toBe(nested);
  });

  test("test_max_depth_exceeded", () => {
    const t = tmpPath();
    const deep = join(t, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "pyproject.toml"), "[project]\nname='x'\n");
    const info = detectProject(t);
    expect(info).toBeNull();
  });

  test("test_nonexistent_workspace", () => {
    const t = tmpPath();
    const info = detectProject(join(t, "does-not-exist"));
    expect(info).toBeNull();
  });

  test("test_shallowest_project_preferred", () => {
    const t = tmpPath();
    const shallow = join(t, "app");
    mkdirSync(shallow);
    writeFileSync(join(shallow, "package.json"), '{"name":"shallow"}');
    const deep = join(t, "deep", "nested");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "pyproject.toml"), "[project]\nname='deep'\n");
    const info = detectProject(t);
    expect(info).not.toBeNull();
    expect(info!.root).toBe(shallow);
  });
});

// ---------------------------------------------------------------------------
// Test output parsers — test_post_run.py:154-246
// ---------------------------------------------------------------------------

describe("TestParsePytest", () => {
  test("test_all_passed", () => {
    const output = "========================= 5 passed in 1.23s =========================";
    const result = parsePytest(output);
    expect(result.passed).toBe(5);
    expect(result.failed).toBeNull();
  });

  test("test_mixed_results", () => {
    const output = "============ 3 passed, 2 failed, 1 error in 4.56s ============";
    const result = parsePytest(output);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.errors).toBe(1);
  });

  test("test_with_skipped", () => {
    const output = "========= 10 passed, 1 skipped, 1 warning in 2.00s =========";
    const result = parsePytest(output);
    expect(result.passed).toBe(10);
    expect(result.skipped).toBe(1);
  });

  test("test_no_summary", () => {
    const output = "some random output\nno test summary here";
    const result = parsePytest(output);
    expect(result.passed).toBeNull();
  });

  test("test_short_form", () => {
    const output = "5 passed";
    const result = parsePytest(output);
    expect(result.passed).toBe(5);
  });
});

describe("TestParseJest", () => {
  test("test_jest_summary", () => {
    const output = "Tests:       2 failed, 5 passed, 7 total";
    const result = parseJest(output);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(2);
  });

  test("test_jest_all_passed", () => {
    const output = "Tests:       10 passed, 10 total";
    const result = parseJest(output);
    expect(result.passed).toBe(10);
    expect(result.failed).toBeNull();
  });

  test("test_vitest_format", () => {
    const output = "Tests  5 passed | 2 failed (7)";
    const result = parseJest(output);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(2);
  });

  test("test_no_summary", () => {
    const output = "running tests...";
    const result = parseJest(output);
    expect(result.passed).toBeNull();
  });
});

describe("TestParseCargo", () => {
  test("test_ok_result", () => {
    const output = "test result: ok. 10 passed; 0 failed; 2 ignored; 0 measured";
    const result = parseCargo(output);
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  test("test_failed_result", () => {
    const output = "test result: FAILED. 8 passed; 2 failed; 0 ignored; 0 measured";
    const result = parseCargo(output);
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(2);
  });

  test("test_no_summary", () => {
    const output = "compiling...";
    const result = parseCargo(output);
    expect(result.passed).toBeNull();
  });
});

describe("TestParseGo", () => {
  test("test_mixed_results", () => {
    const output = "--- PASS: TestAdd (0.00s)\n--- PASS: TestSub (0.00s)\n--- FAIL: TestDiv (0.01s)\n";
    const result = parseGo(output);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
  });

  test("test_all_pass", () => {
    const output = "--- PASS: TestOne (0.00s)\n--- PASS: TestTwo (0.00s)\n";
    const result = parseGo(output);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  test("test_no_results", () => {
    const output = "building...";
    const result = parseGo(output);
    expect(result.passed).toBeNull();
  });
});

describe("TestParseTestOutput", () => {
  test("test_total_computed", () => {
    const result = parse_test_output("python", "===== 3 passed, 1 failed in 1.0s =====");
    expect(result.total).toBe(4);
  });

  test("test_unknown_project_type", () => {
    const result = parse_test_output("unknown", "some output");
    expect(result.passed).toBeNull();
    expect(result.total).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Output truncation — test_post_run.py:265-277
// ---------------------------------------------------------------------------

describe("TestTruncate", () => {
  test("test_short_text_unchanged", () => {
    expect(_truncate("hello", 100)).toBe("hello");
  });

  test("test_long_text_truncated", () => {
    const text = "x".repeat(20000);
    const result = _truncate(text, 10000);
    expect(result.length).toBeLessThan(11000);
    expect(result).toContain("truncated");
  });

  test("test_exact_limit", () => {
    const text = "x".repeat(10000);
    expect(_truncate(text, 10000)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Full run_post_evaluation integration — test_post_run.py:285-349
// ---------------------------------------------------------------------------

// Gate for the 2 gated-binary tests: real `uv` (the python install/test toolchain).
function uvAvailable(): boolean {
  try {
    const r = spawnSync("uv", ["--version"], { encoding: "utf-8", timeout: 10_000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
const UV = uvAvailable();
const gatedTest = UV ? test : test.skip;
if (!UV) {
  // eslint-disable-next-line no-console
  console.warn("[postrun.test] `uv` not found — skipping 2 gated-binary tests (test_python_project_detected, test_result_yaml_schema)");
}

describe("TestRunPostEvaluation", () => {
  test("test_no_workspace", () => {
    const t = tmpPath();
    // No workspace/ directory at all.
    const config = RunnerConfig();
    const resultPath = run_post_evaluation(t, config);
    expect(resultPath).not.toBeNull();
    const data = loadYaml(resultPath);
    expect(data.status).toBe("skipped");
  });

  test("test_empty_workspace", () => {
    const t = tmpPath();
    mkdirSync(join(t, "workspace"));
    const config = RunnerConfig();
    const resultPath = run_post_evaluation(t, config);
    expect(resultPath).not.toBeNull();
    const data = loadYaml(resultPath);
    expect(data.status).toBe("skipped");
    expect(String(data.reason)).toContain("no recognised");
  });

  gatedTest("test_python_project_detected", () => {
    const t = tmpPath();
    const ws = join(t, "workspace");
    mkdirSync(ws);
    // Minimal Python project that will fail install but still produce output.
    writeFileSync(join(ws, "pyproject.toml"), '[project]\nname = "test-proj"\nversion = "0.1.0"\n');

    // Sandbox OFF — host execution of the real uv toolchain (the Python test
    // implicitly runs on the host; we pin useSandbox=false to match).
    const config = RunnerConfig();
    const resultPath = run_post_evaluation(t, config, false);
    expect(resultPath).toBe(join(t, "test-results.yaml"));
    expect(existsSync(resultPath)).toBe(true);

    const data = loadYaml(resultPath);
    expect(data.project_type).toBe("python");
    expect("install" in data).toBe(true);
    expect("test" in data).toBe(true);
    expect("command" in (data.install as Record<string, unknown>)).toBe(true);
    expect("command" in (data.test as Record<string, unknown>)).toBe(true);
  }, 120_000);

  gatedTest("test_result_yaml_schema", () => {
    const t = tmpPath();
    const ws = join(t, "workspace");
    mkdirSync(ws);
    writeFileSync(join(ws, "pyproject.toml"), '[project]\nname = "test-proj"\nversion = "0.1.0"\n');

    const config = RunnerConfig();
    const resultPath = run_post_evaluation(t, config, false);

    const data = loadYaml(resultPath);

    // Required top-level keys.
    expect("status" in data).toBe(true);
    expect("project_type" in data).toBe(true);
    expect("project_root" in data).toBe(true);
    expect("install" in data).toBe(true);
    expect("test" in data).toBe(true);

    const install = data.install as Record<string, unknown>;
    expect("command" in install).toBe(true);
    expect("exit_code" in install || install.timed_out === true).toBe(true);
    expect("output" in install).toBe(true);

    const testNode = data.test as Record<string, unknown>;
    expect("command" in testNode).toBe(true);
    expect("parsed_results" in testNode).toBe(true);
  }, 120_000);
});
