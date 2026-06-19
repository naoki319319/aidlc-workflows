// trend-collector.test.ts — mirrors trend_reports/tests/test_collector.py 1:1.
//
// 54 pure tests, tmp-dir + real-YAML harness (no mocking). The Python harness
// builds real YAML files via yaml.safe_dump and real zip bundles via
// zipfile.ZipFile.writestr (STORE method). The port mirrors this with dumpYaml
// (PyYAML-faithful) and a minimal STORE-method zip writer (writeReportZip), so
// the round-trip exercises the same byte path the production reader walks.
//
// make_run is mirrored from tests/factories.py:23-71 — it auto-parses a SemVer
// from the label when run_type is RELEASE and semver is unset.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dumpYaml } from "./yaml.ts";
import {
  classifyRun,
  collectFromDirectory,
  collectFromZip,
  collectTrendData,
  computeDeltas,
  detectInfraFailure,
  extractZip,
  findYamlFiles,
  loadBaseline,
  parseContractTests,
  parseQualitative,
  parseQualityReport,
  parseRunMeta,
  parseRunMetrics,
  parseTestResults,
  sortRuns,
} from "./trend-collector.ts";
import {
  CollectorError,
  InfraFailureReason,
  type RunData,
  type RunType as RunTypeT,
  RunType,
  SemVer,
  type DocumentScore,
  type InfraFailure,
  makeContractTestResults,
  makeRunConfig,
  makeRunMeta,
  makeRunMetrics,
} from "./trend-models.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "trend-collector-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// A fresh sub-tmp dir per test, mirroring pytest's per-test tmp_path isolation.
let caseDir = 0;
function tmpPath(): string {
  const d = join(tmp, `t${caseDir++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// test_collector.py:44-47 _write_yaml
function writeYaml(path: string, data: unknown): void {
  writeFileSync(path, dumpYaml(data));
}

// ── minimal STORE-method zip writer (mirrors zipfile.writestr) ───────────────
function zipUInt16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function zipUInt32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** Build a ZIP archive (STORE method) from name→bytes entries. */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const crc = Bun.hash.crc32(f.data) >>> 0;
    const size = f.data.length;

    const localHeader = Buffer.concat([
      zipUInt32(0x04034b50), // local file header sig
      zipUInt16(20), // version needed
      zipUInt16(0), // flags
      zipUInt16(0), // method = STORE
      zipUInt16(0), // mod time
      zipUInt16(0), // mod date
      zipUInt32(crc),
      zipUInt32(size), // compressed size
      zipUInt32(size), // uncompressed size
      zipUInt16(nameBuf.length),
      zipUInt16(0), // extra len
      nameBuf,
    ]);
    locals.push(localHeader, f.data);

    const central = Buffer.concat([
      zipUInt32(0x02014b50), // central dir header sig
      zipUInt16(20), // version made by
      zipUInt16(20), // version needed
      zipUInt16(0), // flags
      zipUInt16(0), // method
      zipUInt16(0), // mod time
      zipUInt16(0), // mod date
      zipUInt32(crc),
      zipUInt32(size),
      zipUInt32(size),
      zipUInt16(nameBuf.length),
      zipUInt16(0), // extra
      zipUInt16(0), // comment
      zipUInt16(0), // disk number
      zipUInt16(0), // internal attrs
      zipUInt32(0), // external attrs
      zipUInt32(offset), // local header offset
      nameBuf,
    ]);
    centrals.push(central);

    offset += localHeader.length + f.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    zipUInt32(0x06054b50), // EOCD sig
    zipUInt16(0), // disk
    zipUInt16(0), // disk w/ central dir
    zipUInt16(files.length),
    zipUInt16(files.length),
    zipUInt32(centralBuf.length),
    zipUInt32(centralStart),
    zipUInt16(0), // comment len
  ]);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// test_collector.py:50-56 _make_report_zip — writes a report.zip with YAML files.
function makeReportZip(dir: string, yamlFiles: Record<string, unknown>): string {
  const zipPath = join(dir, "report.zip");
  const entries = Object.entries(yamlFiles).map(([filename, data]) => ({
    name: filename,
    data: Buffer.from(dumpYaml(data), "utf-8"),
  }));
  writeFileSync(zipPath, buildZip(entries));
  return zipPath;
}

// ── factories.py:23-71 make_run ──────────────────────────────────────────────
function makeRun(
  label = "v0.1.0",
  opts: {
    run_type?: RunTypeT;
    semver?: SemVer | null;
    pr_number?: number | null;
    passed?: number;
    failed?: number;
    qualitative_score?: number;
    total_tokens?: number;
    time_seconds?: number;
    contract_passed?: number;
    contract_total?: number;
    document_scores?: DocumentScore[] | null;
    inception_score?: number;
    construction_score?: number;
    infra_failure?: InfraFailure | null;
  } = {},
): RunData {
  const run_type = opts.run_type ?? RunType.RELEASE;
  let semver = opts.semver ?? null;
  const pr_number = opts.pr_number ?? null;
  const passed = opts.passed ?? 100;
  const failed = opts.failed ?? 0;
  const qualitative_score = opts.qualitative_score ?? 0.9;
  const total_tokens = opts.total_tokens ?? 1_000_000;
  const time_seconds = opts.time_seconds ?? 600.0;
  const contract_passed = opts.contract_passed ?? 88;
  const contract_total = opts.contract_total ?? 88;
  const inception_score = opts.inception_score ?? 0.0;
  const construction_score = opts.construction_score ?? 0.0;

  // factories.py:41-45 — auto-parse SemVer when RELEASE and semver unset.
  if (semver === null && run_type === RunType.RELEASE) {
    try {
      semver = SemVer.parse(label);
    } catch {
      /* leave null */
    }
  }

  return {
    label,
    run_type,
    semver,
    pr_number,
    meta: makeRunMeta("test", makeRunConfig(label)),
    metrics: makeRunMetrics({
      total_tokens,
      execution_time_seconds: time_seconds,
    }),
    unit_tests: { passed, failed, errors: 0, skipped: 0, total: passed + failed },
    contract_tests: makeContractTestResults({
      total: contract_total,
      passed: contract_passed,
      failed: contract_total - contract_passed,
      pass_rate: contract_total ? contract_passed / contract_total : 0.0,
    }),
    code_quality: {
      lint_findings: 0,
      security_findings: -1,
      security_scanner_available: false,
      source_file_count: 0,
      test_file_count: 0,
      total_lines_of_code: 0,
      artifact_counts: {},
    },
    qualitative: {
      overall_score: qualitative_score,
      inception_score,
      construction_score,
      document_scores: opts.document_scores ?? [],
      unmatched_reference_docs: [],
      unmatched_candidate_docs: [],
    },
    infra_failure: opts.infra_failure ?? {
      is_infra_failure: false,
      reasons: [],
      summary: "",
    },
  };
}

// ---------------------------------------------------------------------------
// Zip handling
// ---------------------------------------------------------------------------

describe("TestExtractZip", () => {
  test("test_normal_extraction", () => {
    const d = tmpPath();
    const zipPath = join(d, "test.zip");
    writeFileSync(zipPath, buildZip([{ name: "hello.txt", data: Buffer.from("world") }]));

    const result = extractZip(zipPath, d);
    expect(existsSync(result)).toBe(true);
    expect(readFileSync(join(result, "hello.txt"), "utf-8")).toBe("world");
  });

  test("test_corrupt_zip_raises", () => {
    const d = tmpPath();
    const badZip = join(d, "bad.zip");
    writeFileSync(badZip, Buffer.from("not a zip"));
    expect(() => extractZip(badZip, d)).toThrow(/Corrupt zip/);
  });
});

describe("TestFindYamlFiles", () => {
  test("test_all_present", () => {
    const d = tmpPath();
    for (const name of [
      "run-meta.yaml",
      "run-metrics.yaml",
      "test-results.yaml",
      "contract-test-results.yaml",
      "quality-report.yaml",
      "qualitative-comparison.yaml",
    ]) {
      writeFileSync(join(d, name), "key: value");
    }
    const result = findYamlFiles(d);
    expect(Object.keys(result).length).toBe(6);
  });

  test("test_none_present", () => {
    const result = findYamlFiles(tmpPath());
    expect(Object.keys(result).length).toBe(0);
  });

  test("test_partial", () => {
    const d = tmpPath();
    writeFileSync(join(d, "run-meta.yaml"), "key: value");
    const result = findYamlFiles(d);
    expect(Object.keys(result).length).toBe(1);
    expect("run-meta" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// YAML parsers
// ---------------------------------------------------------------------------

describe("TestParseRunMeta", () => {
  test("test_normal", () => {
    const path = join(tmpPath(), "run-meta.yaml");
    writeYaml(path, {
      run_folder: "run-001",
      config: { rules_ref: "v0.1.5", executor_model: "claude-3" },
      vision_file: "test_cases/sci-calc/vision.md",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T01:00:00Z",
      status: "completed",
    });
    const meta = parseRunMeta(path);
    expect(meta.run_id).toBe("run-001");
    expect(meta.config.rules_ref).toBe("v0.1.5");
    expect(meta.config.model).toBe("claude-3");
    expect(meta.config.target_project).toBe("sci-calc");
  });

  test("test_missing_config", () => {
    const path = join(tmpPath(), "run-meta.yaml");
    writeYaml(path, { run_folder: "run-002" });
    const meta = parseRunMeta(path);
    expect(meta.config.rules_ref).toBe("");
    expect(meta.config.model).toBe("");
  });
});

describe("TestParseRunMetrics", () => {
  test("test_normal", () => {
    const path = join(tmpPath(), "run-metrics.yaml");
    writeYaml(path, {
      tokens: {
        total: { total_tokens: 9000000, input_tokens: 5000000 },
        per_agent: {
          executor: { total_tokens: 8000000, input_tokens: 4000000 },
        },
      },
      timing: {
        total_wall_clock_ms: 600000,
        handoffs: [{ handoff: 1, node_id: "executor", duration_ms: 300000 }],
      },
      errors: { throttle_events: 0, timeout_events: 0 },
      context_size: { total: { max_tokens: 100000 } },
    });
    const metrics = parseRunMetrics(path);
    expect(metrics.total_tokens).toBe(9000000);
    expect(metrics.execution_time_seconds).toBe(600.0);
    expect(metrics.agent_tokens.length).toBe(1);
    expect(metrics.handoffs.length).toBe(1);
    expect(metrics.max_context_tokens).toBe(100000);
  });

  test("test_empty", () => {
    const path = join(tmpPath(), "run-metrics.yaml");
    writeYaml(path, {});
    const metrics = parseRunMetrics(path);
    expect(metrics.total_tokens).toBe(0);
    expect(metrics.execution_time_seconds).toBe(0.0);
  });
});

describe("TestParseTestResults", () => {
  test("test_normal", () => {
    const path = join(tmpPath(), "test-results.yaml");
    writeYaml(path, {
      test: { parsed_results: { passed: 175, failed: 0, total: 175 } },
    });
    const result = parseTestResults(path);
    expect(result.passed).toBe(175);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(175);
  });

  test("test_none_values", () => {
    const path = join(tmpPath(), "test-results.yaml");
    writeYaml(path, {
      test: { parsed_results: { passed: null, failed: null } },
    });
    const result = parseTestResults(path);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("TestParseContractTests", () => {
  test("test_normal", () => {
    const path = join(tmpPath(), "contract-test-results.yaml");
    writeYaml(path, {
      total: 88,
      passed: 85,
      failed: 3,
      cases: [
        { path: "/api/calc", method: "GET", passed: true },
        {
          path: "/api/err",
          method: "POST",
          passed: false,
          expected_status: 400,
          actual_status: 200,
        },
      ],
    });
    const result = parseContractTests(path);
    expect(result.total).toBe(88);
    expect(result.passed).toBe(85);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.endpoint).toBe("/api/err");
  });

  test("test_zero_total", () => {
    const path = join(tmpPath(), "contract-test-results.yaml");
    writeYaml(path, { total: 0, passed: 0, failed: 0 });
    const result = parseContractTests(path);
    expect(result.pass_rate).toBe(0.0);
  });
});

describe("TestParseQualityReport", () => {
  test("test_with_security", () => {
    const path = join(tmpPath(), "quality-report.yaml");
    writeYaml(path, {
      lint: { findings: [{ file: "a.py" }] },
      security: { available: true, findings: [{ issue: "x" }] },
      summary: { lint_total: 1 },
    });
    const result = parseQualityReport(path);
    expect(result.lint_findings).toBe(1);
    expect(result.security_findings).toBe(1);
    expect(result.security_scanner_available).toBe(true);
  });

  test("test_without_security", () => {
    const path = join(tmpPath(), "quality-report.yaml");
    writeYaml(path, { lint: {}, summary: {} });
    const result = parseQualityReport(path);
    expect(result.security_findings).toBe(-1);
    expect(result.security_scanner_available).toBe(false);
  });
});

describe("TestParseQualitative", () => {
  test("test_normal", () => {
    const path = join(tmpPath(), "qualitative-comparison.yaml");
    writeYaml(path, {
      overall_score: 0.898,
      phases: [
        {
          phase: "inception",
          avg_overall: 0.87,
          documents: [{ path: "docs/requirements.md", overall: 0.95 }],
        },
        {
          phase: "construction",
          avg_overall: 0.92,
          documents: [{ path: "docs/build-instructions.md", overall: 0.9 }],
        },
      ],
    });
    const result = parseQualitative(path);
    expect(result.overall_score).toBe(0.898);
    expect(result.inception_score).toBe(0.87);
    expect(result.construction_score).toBe(0.92);
    expect(result.document_scores.length).toBe(2);
  });

  test("test_empty_phases", () => {
    const path = join(tmpPath(), "qualitative-comparison.yaml");
    writeYaml(path, { overall_score: 0.5, phases: [] });
    const result = parseQualitative(path);
    expect(result.inception_score).toBe(0.0);
    expect(result.construction_score).toBe(0.0);
    expect(result.document_scores).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Run classification
// ---------------------------------------------------------------------------

describe("TestClassifyRun", () => {
  test("test_release", () => {
    const [runType, label, semver, pr] = classifyRun("v0.1.5");
    expect(runType).toBe(RunType.RELEASE);
    expect(label).toBe("v0.1.5");
    expect(semver!.equals(new SemVer(0, 1, 5))).toBe(true);
    expect(pr).toBeNull();
  });

  test("test_main", () => {
    const [runType, label, semver] = classifyRun("main");
    expect(runType).toBe(RunType.MAIN);
    expect(label).toBe("main");
    expect(semver).toBeNull();
  });

  test("test_pr", () => {
    const [runType, label, , pr] = classifyRun("pr-42");
    expect(runType).toBe(RunType.PR);
    expect(label).toBe("PR #42");
    expect(pr).toBe(42);
  });

  test("test_unknown_format", () => {
    const [runType, label, semver] = classifyRun("some-branch");
    expect(runType).toBe(RunType.RELEASE);
    expect(label).toBe("some-branch");
    expect(semver).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sorting and deltas
// ---------------------------------------------------------------------------

describe("TestSortRuns", () => {
  test("test_releases_sorted_by_semver", () => {
    const runs = [makeRun("v0.1.2"), makeRun("v0.1.0"), makeRun("v0.1.1")];
    const sorted = sortRuns(runs);
    expect(sorted.map((r) => r.label)).toEqual(["v0.1.0", "v0.1.1", "v0.1.2"]);
  });

  test("test_main_after_releases", () => {
    const runs = [
      makeRun("main", { run_type: RunType.MAIN, semver: null }),
      makeRun("v0.1.0"),
    ];
    const sorted = sortRuns(runs);
    expect(sorted[0]!.label).toBe("v0.1.0");
    expect(sorted[1]!.label).toBe("main");
  });

  test("test_pr_after_main", () => {
    const runs = [
      makeRun("PR #42", { run_type: RunType.PR, semver: null, pr_number: 42 }),
      makeRun("main", { run_type: RunType.MAIN, semver: null }),
      makeRun("v0.1.0"),
    ];
    const sorted = sortRuns(runs);
    expect(sorted.map((r) => r.label)).toEqual(["v0.1.0", "main", "PR #42"]);
  });

  test("test_empty_list", () => {
    expect(sortRuns([])).toEqual([]);
  });
});

describe("TestComputeDeltas", () => {
  test("test_two_runs", () => {
    const runs = [
      makeRun("v0.1.0", { passed: 100, qualitative_score: 0.85, total_tokens: 1_000_000 }),
      makeRun("v0.1.1", { passed: 120, qualitative_score: 0.9, total_tokens: 1_200_000 }),
    ];
    const deltas = computeDeltas(runs);
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.from_label).toBe("v0.1.0");
    expect(deltas[0]!.to_label).toBe("v0.1.1");
    expect(deltas[0]!.unit_tests_delta).toBe(20);
    expect(Math.abs(deltas[0]!.qualitative_delta - 0.05)).toBeLessThan(0.001);
    expect(deltas[0]!.token_delta).toBe(200000);
  });

  test("test_empty_list", () => {
    expect(computeDeltas([])).toEqual([]);
  });

  test("test_single_run", () => {
    expect(computeDeltas([makeRun("v0.1.0")])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Baseline loading
// ---------------------------------------------------------------------------

describe("TestLoadBaseline", () => {
  test("test_file_exists", () => {
    const path = join(tmpPath(), "golden.yaml");
    writeYaml(path, {
      execution: { wall_clock_ms: 1200000, total_tokens: 9000000 },
      unit_tests: { passed: 192, total: 192 },
      contract_tests: { passed: 88, total: 88 },
      code_quality: { lint_total: 18 },
      qualitative: {
        overall_score: 0.891,
        document_scores: { "requirements.md": 0.97, "components.md": 0.98 },
      },
    });
    const bl = loadBaseline(path);
    expect(bl.unit_tests_passed).toBe(192);
    expect(bl.qualitative_overall).toBe(0.891);
    expect(bl.execution_time_seconds).toBe(1200.0);
    expect(bl.document_scores["requirements.md"]).toBe(0.97);
  });

  test("test_file_missing", () => {
    const bl = loadBaseline(join(tmpPath(), "nonexistent.yaml"));
    expect(bl.unit_tests_passed).toBe(0);
    expect(bl.qualitative_overall).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// collect_from_zip
// ---------------------------------------------------------------------------

describe("TestCollectFromZip", () => {
  test("test_full_zip", () => {
    const d = tmpPath();
    const zipPath = makeReportZip(d, {
      "run-meta.yaml": { run_folder: "run-001", config: { rules_ref: "v0.1.5" } },
      "run-metrics.yaml": {
        tokens: { total: { total_tokens: 9000000 } },
        timing: { total_wall_clock_ms: 600000 },
      },
      "test-results.yaml": { test: { parsed_results: { passed: 175, failed: 0, total: 175 } } },
      "contract-test-results.yaml": { total: 88, passed: 88, failed: 0 },
      "quality-report.yaml": { lint: {}, summary: { lint_total: 0 } },
      "qualitative-comparison.yaml": { overall_score: 0.898, phases: [] },
    });
    const run = collectFromZip(zipPath, join(d, "work"));
    expect(run.label).toBe("v0.1.5");
    expect(run.run_type).toBe(RunType.RELEASE);
    expect(run.unit_tests.passed).toBe(175);
    expect(run.qualitative.overall_score).toBe(0.898);
  });

  test("test_missing_run_meta_raises", () => {
    const d = tmpPath();
    const zipPath = makeReportZip(d, {
      "test-results.yaml": { test: { parsed_results: {} } },
    });
    expect(() => collectFromZip(zipPath, join(d, "work"))).toThrow(/run-meta\.yaml missing/);
  });

  test("test_missing_optional_files_use_defaults", () => {
    const d = tmpPath();
    const zipPath = makeReportZip(d, {
      "run-meta.yaml": { run_folder: "run-002", config: { rules_ref: "v0.1.0" } },
    });
    const run = collectFromZip(zipPath, join(d, "work"));
    expect(run.unit_tests.passed).toBe(0);
    expect(run.contract_tests.total).toBe(0);
    expect(run.qualitative.overall_score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// collect_from_directory
// ---------------------------------------------------------------------------

describe("TestCollectFromDirectory", () => {
  test("test_full_directory", () => {
    const runDir = join(tmpPath(), "run-001");
    mkdirSync(runDir);
    writeYaml(join(runDir, "run-meta.yaml"), {
      run_folder: "run-001",
      config: { rules_ref: "v0.1.5" },
    });
    writeYaml(join(runDir, "run-metrics.yaml"), {
      tokens: { total: { total_tokens: 9000000 } },
      timing: { total_wall_clock_ms: 600000 },
    });
    writeYaml(join(runDir, "test-results.yaml"), {
      test: { parsed_results: { passed: 175, failed: 0, total: 175 } },
    });
    writeYaml(join(runDir, "contract-test-results.yaml"), { total: 88, passed: 88, failed: 0 });
    writeYaml(join(runDir, "quality-report.yaml"), { lint: {}, summary: { lint_total: 0 } });
    writeYaml(join(runDir, "qualitative-comparison.yaml"), { overall_score: 0.898, phases: [] });

    const run = collectFromDirectory(runDir);
    expect(run.label).toBe("v0.1.5");
    expect(run.run_type).toBe(RunType.RELEASE);
    expect(run.unit_tests.passed).toBe(175);
    expect(run.qualitative.overall_score).toBe(0.898);
  });

  test("test_missing_run_meta_raises", () => {
    const runDir = join(tmpPath(), "run-bad");
    mkdirSync(runDir);
    writeYaml(join(runDir, "test-results.yaml"), { test: { parsed_results: {} } });
    expect(() => collectFromDirectory(runDir)).toThrow(/run-meta\.yaml missing/);
  });

  test("test_not_a_directory_raises", () => {
    const filePath = join(tmpPath(), "not-a-dir.txt");
    writeFileSync(filePath, "hello");
    expect(() => collectFromDirectory(filePath)).toThrow(/Not a directory/);
  });

  test("test_nonexistent_path_raises", () => {
    expect(() => collectFromDirectory(join(tmpPath(), "nonexistent"))).toThrow(/Not a directory/);
  });

  test("test_missing_optional_files_use_defaults", () => {
    const runDir = join(tmpPath(), "run-minimal");
    mkdirSync(runDir);
    writeYaml(join(runDir, "run-meta.yaml"), {
      run_folder: "run-002",
      config: { rules_ref: "v0.1.0" },
    });
    const run = collectFromDirectory(runDir);
    expect(run.unit_tests.passed).toBe(0);
    expect(run.contract_tests.total).toBe(0);
    expect(run.qualitative.overall_score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// collect_trend_data — directory dispatch
// ---------------------------------------------------------------------------

describe("TestCollectTrendDataDirectoryDispatch", () => {
  test("test_mix_of_zips_and_directories", () => {
    const d = tmpPath();
    // Create a directory bundle
    const runDir = join(d, "dir-bundle");
    mkdirSync(runDir);
    writeYaml(join(runDir, "run-meta.yaml"), {
      run_folder: "run-dir",
      config: { rules_ref: "pr-42" },
    });
    writeYaml(join(runDir, "run-metrics.yaml"), { tokens: { total: {} }, timing: {} });
    writeYaml(join(runDir, "test-results.yaml"), { test: { parsed_results: {} } });
    writeYaml(join(runDir, "contract-test-results.yaml"), { total: 0, passed: 0, failed: 0 });
    writeYaml(join(runDir, "quality-report.yaml"), { lint: {}, summary: {} });
    writeYaml(join(runDir, "qualitative-comparison.yaml"), { overall_score: 0.5, phases: [] });

    // Create a zip bundle
    const zipPath = makeReportZip(d, {
      "run-meta.yaml": { run_folder: "run-zip", config: { rules_ref: "v0.1.0" } },
      "run-metrics.yaml": { tokens: { total: {} }, timing: {} },
      "test-results.yaml": { test: { parsed_results: {} } },
      "contract-test-results.yaml": { total: 0, passed: 0, failed: 0 },
      "quality-report.yaml": { lint: {}, summary: {} },
      "qualitative-comparison.yaml": { overall_score: 0.6, phases: [] },
    });

    const baselinePath = join(d, "golden.yaml");
    writeYaml(baselinePath, {});

    const trend = collectTrendData([zipPath, runDir], baselinePath, "test/repo", join(d, "work"));
    expect(trend.runs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Infrastructure failure detection
// ---------------------------------------------------------------------------

describe("TestDetectInfraFailure", () => {
  const cleanMeta = () =>
    makeRunMeta("r1", makeRunConfig("v0.1.0"), { status: "Status.COMPLETED" });

  test("test_clean_run_no_failure", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics(),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test("test_throttle_events_flagged", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics({ throttle_events: 5 }),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.THROTTLED);
  });

  test("test_service_unavailable_flagged", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics({ service_unavailable_events: 3 }),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.SERVICE_UNAVAILABLE);
  });

  test("test_model_error_flagged", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics({ model_error_events: 1 }),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.MODEL_ERROR);
  });

  test("test_run_failed_status", () => {
    const meta = makeRunMeta("r1", makeRunConfig("v0.1.0"), { status: "Status.FAILED" });
    const result = detectInfraFailure(
      meta,
      makeRunMetrics(),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.RUN_FAILED);
  });

  test("test_missing_status_means_crash", () => {
    const meta = makeRunMeta("r1", makeRunConfig("v0.1.0"), { status: "" });
    const result = detectInfraFailure(
      meta,
      makeRunMetrics(),
      makeContractTestResults({ server_started: true }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.RUN_CRASHED);
  });

  test("test_metrics_missing", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics(),
      makeContractTestResults({ server_started: true }),
      false,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.METRICS_MISSING);
  });

  test("test_server_start_failed", () => {
    const result = detectInfraFailure(
      cleanMeta(),
      makeRunMetrics(),
      makeContractTestResults({ server_started: false, server_error: "Connection refused" }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons).toContain(InfraFailureReason.SERVER_START_FAILED);
  });

  test("test_multiple_reasons", () => {
    const meta = makeRunMeta("r1", makeRunConfig("v0.1.0"), { status: "Status.FAILED" });
    const result = detectInfraFailure(
      meta,
      makeRunMetrics({ throttle_events: 10, service_unavailable_events: 5 }),
      makeContractTestResults({ server_started: false }),
      true,
    );
    expect(result.is_infra_failure).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    expect(result.summary).toContain("Infrastructure failure detected");
  });
});

describe("TestParseRunMetricsIndividualErrors", () => {
  test("test_individual_error_fields_populated", () => {
    const path = join(tmpPath(), "run-metrics.yaml");
    writeYaml(path, {
      tokens: { total: { total_tokens: 100 } },
      timing: { total_wall_clock_ms: 1000 },
      errors: {
        throttle_events: 3,
        service_unavailable_events: 2,
        model_error_events: 1,
        timeout_events: 4,
        failed_tool_calls: 5,
        validation_error_events: 6,
      },
    });
    const metrics = parseRunMetrics(path);
    expect(metrics.throttle_events).toBe(3);
    expect(metrics.service_unavailable_events).toBe(2);
    expect(metrics.model_error_events).toBe(1);
    expect(metrics.timeout_events).toBe(4);
    expect(metrics.failed_tool_calls).toBe(5);
    expect(metrics.validation_error_events).toBe(6);
    expect(metrics.error_count).toBe(21);
  });

  test("test_missing_errors_default_to_zero", () => {
    const path = join(tmpPath(), "run-metrics.yaml");
    writeYaml(path, { tokens: { total: {} }, timing: {} });
    const metrics = parseRunMetrics(path);
    expect(metrics.throttle_events).toBe(0);
    expect(metrics.service_unavailable_events).toBe(0);
    expect(metrics.error_count).toBe(0);
  });
});

describe("TestParseContractTestsServerStarted", () => {
  test("test_server_started_true", () => {
    const path = join(tmpPath(), "contract-test-results.yaml");
    writeYaml(path, {
      total: 88,
      passed: 88,
      failed: 0,
      server_started: true,
      server_error: null,
    });
    const result = parseContractTests(path);
    expect(result.server_started).toBe(true);
    expect(result.server_error).toBe("");
  });

  test("test_server_started_false", () => {
    const path = join(tmpPath(), "contract-test-results.yaml");
    writeYaml(path, {
      total: 0,
      passed: 0,
      failed: 0,
      server_started: false,
      server_error: "Connection refused",
    });
    const result = parseContractTests(path);
    expect(result.server_started).toBe(false);
    expect(result.server_error).toBe("Connection refused");
  });

  test("test_server_started_missing_defaults_true", () => {
    const path = join(tmpPath(), "contract-test-results.yaml");
    writeYaml(path, { total: 88, passed: 88, failed: 0 });
    const result = parseContractTests(path);
    expect(result.server_started).toBe(true);
    expect(result.server_error).toBe("");
  });
});
