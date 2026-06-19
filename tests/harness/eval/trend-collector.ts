// trend-collector.ts — zip/directory extraction, YAML parsing, run
// classification, and trend assembly.
//
// Faithful 1:1 port of trend_reports/collector.py (read in full, lines 1-579).
// Imports all data models + SemVer/RunType/InfraFailureReason/CollectorError
// from trend-models.ts (do NOT redefine them). Reads YAML via Bun.YAML.parse and
// renders Python's round() via pyRound (none needed here — collector.py does no
// rounding — but kept consistent with the substrate contract).
//
// Source-of-truth citations are at collector.py:<line> on each construct.
//
// ── ZIP handling note ───────────────────────────────────────────────────────
// Python's extract_zip uses the stdlib zipfile module. Bun/Node ship no
// high-level zip-archive API, so this port implements a minimal ZIP reader
// (central-directory + local-file-header walk; STORE + DEFLATE methods) on top of
// node:zlib's inflateRawSync — sufficient for report bundles, which are written
// with zipfile's default STORE method. A non-zip / truncated archive throws,
// mirroring zipfile.BadZipFile → CollectorError("Corrupt zip: …").

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  type AgentTokens,
  type BaselineMetrics,
  type CodeQualityMetrics,
  CollectorError,
  type ContractTestFailure,
  type ContractTestResults,
  type DocumentScore,
  type HandoffMetrics,
  type InfraFailure,
  InfraFailureReason,
  type QualitativeComparison,
  type RunData,
  type RunMeta,
  type RunMetrics,
  RunType,
  SemVer,
  type UnitTestResults,
  type VersionDelta,
  makeAgentTokens,
  makeBaselineMetrics,
  makeCodeQualityMetrics,
  makeContractTestFailure,
  makeContractTestResults,
  makeHandoffMetrics,
  makeInfraFailure,
  makeQualitativeComparison,
  makeRunConfig,
  makeRunData,
  makeRunMeta,
  makeRunMetrics,
  makeTrendData,
  makeUnitTestResults,
  makeVersionDelta,
  type TrendData,
} from "./trend-models.ts";

// The YAML files we expect inside every report bundle (zip or directory).
// (collector.py:38-45) — insertion order is load-bearing for find_yaml_files.
export const REQUIRED_YAML: Record<string, string> = {
  "run-meta": "run-meta.yaml",
  "run-metrics": "run-metrics.yaml",
  "test-results": "test-results.yaml",
  "contract-test-results": "contract-test-results.yaml",
  "quality-report": "quality-report.yaml",
  "qualitative-comparison": "qualitative-comparison.yaml",
};

// ---------------------------------------------------------------------------
// Path helper — Python pathlib's `.stem` and `.name`
// ---------------------------------------------------------------------------

/** Python Path(p).name — the final path component (basename), no dir. */
function pathName(p: string): string {
  // Strip a single trailing slash like pathlib, then take the last component.
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Python Path(p).stem — basename without the final suffix. */
function pathStem(p: string): string {
  const name = pathName(p);
  const dot = name.lastIndexOf(".");
  // pathlib: a leading-dot-only name (".bashrc") has no suffix → stem == name.
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (STORE + DEFLATE) — stands in for Python's zipfile module
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50; // End of central directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Parse a ZIP archive's bytes into its file entries. Throws on a malformed
 * archive (mirrors zipfile.BadZipFile). Supports compression methods 0 (STORE)
 * and 8 (DEFLATE); report bundles use STORE (zipfile.writestr default).
 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  // Locate the End Of Central Directory record by scanning backwards.
  const minEocd = 22;
  if (buf.length < minEocd) {
    throw new Error("Corrupt: too small for a zip archive");
  }
  let eocd = -1;
  // EOCD comment may be up to 65535 bytes; scan that window.
  const lowest = Math.max(0, buf.length - (minEocd + 0xffff));
  for (let i = buf.length - minEocd; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Corrupt: no end-of-central-directory record");
  }

  const totalEntries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // offset of start of central directory

  const entries: ZipEntry[] = [];
  for (let n = 0; n < totalEntries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error("Corrupt: bad central-directory header");
    }
    const compMethod = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf-8", off + 46, off + 46 + nameLen);

    // Walk to the local header to find the actual data offset (the local
    // header's name/extra lengths can differ from the central record's).
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error("Corrupt: bad local file header");
    }
    const locNameLen = buf.readUInt16LE(localOff + 26);
    const locExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (compMethod === 0) {
      data = Buffer.from(raw);
    } else if (compMethod === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported compression method ${compMethod}`);
    }
    entries.push({ name, data });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Zip handling (collector.py:53-67)
// ---------------------------------------------------------------------------

/**
 * Extract a report zip and return the directory containing the YAML files.
 * (collector.py:53-67)
 *
 * The zips are flat (files at root level), so we extract into a subdirectory
 * named after the zip stem. A corrupt archive raises CollectorError("Corrupt
 * zip: …"), mirroring zipfile.BadZipFile.
 */
export function extractZip(zipPath: string, destDir: string): string {
  const subdir = join(destDir, pathStem(zipPath));
  try {
    const buf = readFileSync(zipPath);
    const entries = readZipEntries(buf);
    mkdirSync(subdir, { recursive: true });
    for (const entry of entries) {
      // Skip directory entries (names ending with '/').
      if (entry.name.endsWith("/")) {
        mkdirSync(join(subdir, entry.name), { recursive: true });
        continue;
      }
      const dest = join(subdir, entry.name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
    }
  } catch (exc) {
    throw new CollectorError(`Corrupt zip: ${zipPath}`);
  }
  return subdir;
}

/**
 * Locate the expected YAML files inside *runDir*. (collector.py:70-83)
 *
 * Returns a record keyed by short name (e.g. "run-meta") with absolute path
 * values. Logs a warning for any missing file (logging is a no-op stub here).
 */
export function findYamlFiles(runDir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, filename] of Object.entries(REQUIRED_YAML)) {
    const path = join(runDir, filename);
    if (existsSync(path)) {
      found[key] = path;
    } else {
      logger.warning("Missing %s in %s", filename, runDir);
    }
  }
  return found;
}

// Logging stub — collector.py uses the stdlib logger; the port keeps warnings
// silent (the methodology routes determinism through tools, not log output).
const logger = {
  warning(..._args: unknown[]): void {
    /* no-op */
  },
  info(..._args: unknown[]): void {
    /* no-op */
  },
};

// ---------------------------------------------------------------------------
// YAML parsers — one per file type (collector.py:91-300)
// ---------------------------------------------------------------------------

/** collector.py:91-96 — load YAML and require it parse to a dict (mapping). */
function loadYaml(path: string): Record<string, any> {
  const text = readFileSync(path, "utf-8");
  const data = Bun.YAML.parse(text) as unknown;
  if (!isDict(data)) {
    // type(data).__name__ — Python's class name for the parsed value.
    raise(new CollectorError(`Expected YAML dict in ${path}, got ${pyTypeName(data)}`));
  }
  return data as Record<string, any>;
}

function isDict(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Best-effort Python type-name for the error message. */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return typeof v;
}

function raise(e: Error): never {
  throw e;
}

// Python dict.get(key, default) — undefined OR missing key → default.
function get<T>(obj: Record<string, any> | undefined | null, key: string, dflt: T): T {
  if (obj == null) return dflt;
  const v = obj[key];
  return v === undefined ? (dflt as T) : (v as T);
}

/** collector.py:99-114 */
export function parseRunMeta(yamlPath: string): RunMeta {
  const raw = loadYaml(yamlPath);
  const cfg = get<Record<string, any>>(raw, "config", {});
  const visionFile = get<string>(raw, "vision_file", "");
  return makeRunMeta(
    get<string>(raw, "run_folder", ""),
    makeRunConfig(get<string>(cfg, "rules_ref", ""), {
      model: get<string>(cfg, "executor_model", ""),
      // target_project: vision_file.split('/')[1] only when '/' is present
      // (collector.py:107-110). Without a slash → "".
      target_project: visionFile.includes("/") ? visionFile.split("/")[1]! : "",
    }),
    {
      start_time: String(get<unknown>(raw, "started_at", "")),
      end_time: String(get<unknown>(raw, "completed_at", "")),
      status: String(get<unknown>(raw, "status", "")),
    },
  );
}

/** collector.py:117-192 */
export function parseRunMetrics(yamlPath: string): RunMetrics {
  const raw = loadYaml(yamlPath);

  const tokens = get<Record<string, any>>(raw, "tokens", {});
  const total = get<Record<string, any>>(tokens, "total", {});
  const perAgent = get<Record<string, any>>(tokens, "per_agent", {});

  const agentTokens: AgentTokens[] = [];
  for (const [name, vals] of Object.entries(perAgent ?? {})) {
    const v = vals as Record<string, any>;
    agentTokens.push(
      makeAgentTokens(name, {
        input_tokens: get<number>(v, "input_tokens", 0),
        output_tokens: get<number>(v, "output_tokens", 0),
        total_tokens: get<number>(v, "total_tokens", 0),
        cache_read_tokens: get<number>(v, "cache_read_tokens", 0),
        cache_write_tokens: get<number>(v, "cache_write_tokens", 0),
      }),
    );
  }

  const timing = get<Record<string, any>>(raw, "timing", {});
  const handoffList = get<any[]>(timing, "handoffs", []);
  const handoffs: HandoffMetrics[] = [];
  for (const h of handoffList) {
    handoffs.push(
      makeHandoffMetrics(get<number>(h, "handoff", 0), {
        agent: get<string>(h, "node_id", ""),
        duration_seconds: get<number>(h, "duration_ms", 0) / 1000.0,
        tokens: 0,
      }),
    );
  }

  const hp = get<Record<string, any>>(raw, "handoff_patterns", {});
  const errors = get<Record<string, any>>(raw, "errors", {});
  const throttleEvents = get<number>(errors, "throttle_events", 0);
  const timeoutEvents = get<number>(errors, "timeout_events", 0);
  const failedToolCalls = get<number>(errors, "failed_tool_calls", 0);
  const modelErrorEvents = get<number>(errors, "model_error_events", 0);
  const serviceUnavailableEvents = get<number>(errors, "service_unavailable_events", 0);
  const validationErrorEvents = get<number>(errors, "validation_error_events", 0);
  // error_count = sum of all 6 error fields (collector.py:158-167).
  const errorCount =
    throttleEvents +
    timeoutEvents +
    failedToolCalls +
    modelErrorEvents +
    serviceUnavailableEvents +
    validationErrorEvents;

  const ctx = get<Record<string, any>>(get<Record<string, any>>(raw, "context_size", {}), "total", {});

  return makeRunMetrics({
    total_tokens: get<number>(total, "total_tokens", 0),
    total_input_tokens: get<number>(total, "input_tokens", 0),
    total_output_tokens: get<number>(total, "output_tokens", 0),
    total_cache_read_tokens: get<number>(total, "cache_read_tokens", 0),
    total_cache_write_tokens: get<number>(total, "cache_write_tokens", 0),
    execution_time_seconds: get<number>(timing, "total_wall_clock_ms", 0) / 1000.0,
    // num_handoffs default = len(handoff_list) when handoff_patterns absent.
    num_handoffs: get<number>(hp, "total_handoffs", handoffList.length),
    max_context_tokens: get<number>(ctx, "max_tokens", 0),
    avg_context_tokens: get<number>(ctx, "avg_tokens", 0.0),
    median_context_tokens: get<number>(ctx, "median_tokens", 0.0),
    agent_tokens: agentTokens,
    handoffs,
    server_startup_success: true,
    error_count: errorCount,
    throttle_events: throttleEvents,
    service_unavailable_events: serviceUnavailableEvents,
    model_error_events: modelErrorEvents,
    timeout_events: timeoutEvents,
    failed_tool_calls: failedToolCalls,
    validation_error_events: validationErrorEvents,
  });
}

/** collector.py:195-209 */
export function parseTestResults(yamlPath: string): UnitTestResults {
  const raw = loadYaml(yamlPath);
  const parsed = get<Record<string, any>>(get<Record<string, any>>(raw, "test", {}), "parsed_results", {});
  // `x or 0` — None/0/falsy coerce to 0 (collector.py:198-202).
  return makeUnitTestResults({
    passed: get<number>(parsed, "passed", 0) || 0,
    failed: get<number>(parsed, "failed", 0) || 0,
    errors: get<number>(parsed, "errors", 0) || 0,
    skipped: get<number>(parsed, "skipped", 0) || 0,
    total: get<number>(parsed, "total", 0) || 0,
  });
}

/** collector.py:212-243 */
export function parseContractTests(yamlPath: string): ContractTestResults {
  const raw = loadYaml(yamlPath);
  const total = get<number>(raw, "total", 0);
  const passed = get<number>(raw, "passed", 0);
  const failed = get<number>(raw, "failed", 0);
  const passRate = total > 0 ? passed / total : 0.0;

  const failures: ContractTestFailure[] = [];
  for (const c of get<any[]>(raw, "cases", [])) {
    // case.get("passed", True) — only collect failures.
    if (!get<boolean>(c, "passed", true)) {
      failures.push(
        makeContractTestFailure({
          endpoint: get<string>(c, "path", ""),
          method: get<string>(c, "method", ""),
          expected_status: get<number>(c, "expected_status", 0),
          actual_status: get<number>(c, "actual_status", 0),
          description: get<string>(c, "name", ""),
        }),
      );
    }
  }

  const serverStarted = get<boolean>(raw, "server_started", true);
  // raw.get("server_error") or "" — None/missing → "" (collector.py:233).
  const serverError = get<string | null>(raw, "server_error", null) || "";

  return makeContractTestResults({
    total,
    passed,
    failed,
    pass_rate: passRate,
    failures,
    server_started: serverStarted,
    server_error: serverError,
  });
}

/** collector.py:246-261 */
export function parseQualityReport(yamlPath: string): CodeQualityMetrics {
  const raw = loadYaml(yamlPath);
  const lint = get<Record<string, any>>(raw, "lint", {});
  const security = get<Record<string, any>>(raw, "security", {});
  const summary = get<Record<string, any>>(raw, "summary", {});

  const securityAvailable = get<boolean>(security, "available", false);
  return makeCodeQualityMetrics({
    // summary.lint_total default = len(lint.findings) (collector.py:253).
    lint_findings: get<number>(summary, "lint_total", get<any[]>(lint, "findings", []).length),
    // -1 sentinel when scanner unavailable (collector.py:254-256).
    security_findings: securityAvailable ? get<any[]>(security, "findings", []).length : -1,
    security_scanner_available: securityAvailable,
    source_file_count: 0,
    test_file_count: 0,
    total_lines_of_code: 0,
  });
}

/** collector.py:264-300 */
export function parseQualitative(yamlPath: string): QualitativeComparison {
  const raw = loadYaml(yamlPath);

  const overall = get<number>(raw, "overall_score", 0.0);
  const phases = get<any[]>(raw, "phases", []);
  let inceptionScore = 0.0;
  let constructionScore = 0.0;
  const docScores: DocumentScore[] = [];

  for (const phase of phases) {
    const phaseName = get<string>(phase, "phase", "");
    const avgOverall = get<number>(phase, "avg_overall", 0.0);
    if (phaseName === "inception") {
      inceptionScore = avgOverall;
    } else if (phaseName === "construction") {
      constructionScore = avgOverall;
    }

    for (const doc of get<any[]>(phase, "documents", [])) {
      docScores.push({
        document_name: pathName(get<string>(doc, "path", "")),
        overall_score: get<number>(doc, "overall", 0.0),
        phase: phaseName,
        completeness: get<number>(doc, "completeness", 0.0),
        // design_similarity → accuracy; intent_similarity → clarity
        // (collector.py:288-289).
        accuracy: get<number>(doc, "design_similarity", 0.0),
        clarity: get<number>(doc, "intent_similarity", 0.0),
      });
    }
  }

  return makeQualitativeComparison({
    overall_score: overall,
    inception_score: inceptionScore,
    construction_score: constructionScore,
    document_scores: docScores,
    unmatched_reference_docs: get<string[]>(raw, "unmatched_reference", []),
    unmatched_candidate_docs: get<string[]>(raw, "unmatched_candidate", []),
  });
}

// ---------------------------------------------------------------------------
// Run classification (collector.py:308-320)
// ---------------------------------------------------------------------------

/**
 * Determine run type, display label, semver, and PR number from rules_ref.
 * (collector.py:308-320)
 */
export function classifyRun(
  rulesRef: string,
): [RunType, string, SemVer | null, number | null] {
  if (rulesRef === "main") {
    return [RunType.MAIN, "main", null, null];
  }
  if (rulesRef.startsWith("pr-")) {
    // int(rules_ref.split("-", 1)[1]) — split on first '-' only.
    const num = Number.parseInt(rulesRef.slice(rulesRef.indexOf("-") + 1), 10);
    return [RunType.PR, `PR #${num}`, null, num];
  }
  try {
    const sv = SemVer.parse(rulesRef);
    return [RunType.RELEASE, sv.toString(), sv, null];
  } catch {
    // Unknown format — treat as release-like (collector.py:318-320).
    return [RunType.RELEASE, rulesRef, null, null];
  }
}

// ---------------------------------------------------------------------------
// Infrastructure failure detection (collector.py:328-373)
// ---------------------------------------------------------------------------

/**
 * Detect infrastructure failures from run signals. (collector.py:328-373)
 *
 * Conservative: only flags clear infra issues. Reason append order is
 * load-bearing (THROTTLED, SERVICE_UNAVAILABLE, MODEL_ERROR; then RUN_FAILED
 * XOR RUN_CRASHED; then METRICS_MISSING; then SERVER_START_FAILED).
 */
export function detectInfraFailure(
  meta: RunMeta,
  metrics: RunMetrics,
  contractTests: ContractTestResults,
  hasMetricsFile: boolean,
): InfraFailure {
  const reasons: InfraFailureReason[] = [];

  // Signal 1: Bedrock infra errors in run-metrics.yaml
  if (metrics.throttle_events > 0) reasons.push(InfraFailureReason.THROTTLED);
  if (metrics.service_unavailable_events > 0) reasons.push(InfraFailureReason.SERVICE_UNAVAILABLE);
  if (metrics.model_error_events > 0) reasons.push(InfraFailureReason.MODEL_ERROR);

  // Signal 2: run-meta.yaml status indicates failure/crash
  const statusLower = meta.status ? meta.status.toLowerCase() : "";
  if (statusLower.includes("failed")) {
    reasons.push(InfraFailureReason.RUN_FAILED);
  } else if (!meta.status || meta.status.trim() === "") {
    reasons.push(InfraFailureReason.RUN_CRASHED);
  }

  // Signal 3: run-metrics.yaml missing entirely (swarm crashed before writing)
  if (!hasMetricsFile) reasons.push(InfraFailureReason.METRICS_MISSING);

  // Signal 4: Server failed to start (from contract-test-results.yaml)
  if (!contractTests.server_started) reasons.push(InfraFailureReason.SERVER_START_FAILED);

  if (reasons.length === 0) {
    return makeInfraFailure({ is_infra_failure: false });
  }

  const reasonStrs = reasons.map((r) => r as string);
  const summary = `Infrastructure failure detected: ${reasonStrs.join(", ")}`;

  return makeInfraFailure({
    is_infra_failure: true,
    reasons,
    summary,
  });
}

// ---------------------------------------------------------------------------
// Collection pipeline (collector.py:381-463)
// ---------------------------------------------------------------------------

/** collector.py:381-446 — parse YAML files in *runDir* into a RunData. */
function collectFromRunDir(runDir: string, sourceLabel: string): RunData {
  const yamlFiles = findYamlFiles(runDir);

  if (!("run-meta" in yamlFiles)) {
    throw new CollectorError(`run-meta.yaml missing from ${sourceLabel} — cannot classify run`);
  }

  const meta = parseRunMeta(yamlFiles["run-meta"]!);
  const [runType, label, semver, prNumber] = classifyRun(meta.config.rules_ref);

  const hasMetricsFile = "run-metrics" in yamlFiles;
  const metrics = hasMetricsFile ? parseRunMetrics(yamlFiles["run-metrics"]!) : makeRunMetrics();
  const unitTests =
    "test-results" in yamlFiles ? parseTestResults(yamlFiles["test-results"]!) : makeUnitTestResults();
  const contractTests =
    "contract-test-results" in yamlFiles
      ? parseContractTests(yamlFiles["contract-test-results"]!)
      : makeContractTestResults();

  // Propagate actual server_started to metrics (collector.py:408).
  metrics.server_startup_success = contractTests.server_started;

  const codeQuality =
    "quality-report" in yamlFiles ? parseQualityReport(yamlFiles["quality-report"]!) : makeCodeQualityMetrics();
  const qualitative =
    "qualitative-comparison" in yamlFiles
      ? parseQualitative(yamlFiles["qualitative-comparison"]!)
      : makeQualitativeComparison();

  // Backfill artifact counts from run-metrics if available — RE-READS the file
  // a second time (collector.py:422-427).
  if (hasMetricsFile) {
    const rawMetrics = loadYaml(yamlFiles["run-metrics"]!);
    const workspace = get<Record<string, any>>(get<Record<string, any>>(rawMetrics, "artifacts", {}), "workspace", {});
    codeQuality.source_file_count = get<number>(workspace, "source_files", 0);
    codeQuality.test_file_count = get<number>(workspace, "test_files", 0);
    codeQuality.total_lines_of_code = get<number>(workspace, "total_lines_of_code", 0);
  }

  // Detect infrastructure failures (collector.py:430-432).
  const infraFailure = detectInfraFailure(meta, metrics, contractTests, hasMetricsFile);
  if (infraFailure.is_infra_failure) {
    logger.warning("Infra failure detected in %s: %s", sourceLabel, infraFailure.summary);
  }

  return makeRunData(
    {
      label,
      run_type: runType,
      semver,
      pr_number: prNumber,
      meta,
      metrics,
      unit_tests: unitTests,
      contract_tests: contractTests,
      code_quality: codeQuality,
      qualitative,
    },
    { infra_failure: infraFailure },
  );
}

/** collector.py:449-452 — extract a zip bundle and parse all YAML into RunData. */
export function collectFromZip(zipPath: string, workDir: string): RunData {
  const runDir = extractZip(zipPath, workDir);
  return collectFromRunDir(runDir, zipPath);
}

/** collector.py:455-463 — parse all YAML from a plain directory into RunData. */
export function collectFromDirectory(dirPath: string): RunData {
  if (!isDir(dirPath)) {
    throw new CollectorError(`Not a directory: ${dirPath}`);
  }
  return collectFromRunDir(dirPath, dirPath);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** collector.py:466-495 — parse a golden.yaml baseline file into BaselineMetrics. */
export function loadBaseline(goldenPath: string): BaselineMetrics {
  if (!existsSync(goldenPath)) {
    logger.warning("Golden baseline file %s not found — using empty baseline", goldenPath);
    return makeBaselineMetrics();
  }

  const raw = loadYaml(goldenPath);

  const execution = get<Record<string, any>>(raw, "execution", {});
  const unitTests = get<Record<string, any>>(raw, "unit_tests", {});
  const contractTests = get<Record<string, any>>(raw, "contract_tests", {});
  const codeQuality = get<Record<string, any>>(raw, "code_quality", {});
  const qualitative = get<Record<string, any>>(raw, "qualitative", {});

  const docScores: Record<string, number> = {};
  for (const [name, score] of Object.entries(get<Record<string, any>>(qualitative, "document_scores", {}))) {
    // isinstance(score, (int, float)) — accept numeric, exclude bool
    // (Python bool is an int, but score is never a bool here; mirror the numeric
    // gate, excluding JS booleans defensively).
    if (typeof score === "number") {
      docScores[name] = score;
    }
  }

  return makeBaselineMetrics({
    unit_tests_passed: get<number>(unitTests, "passed", 0),
    unit_tests_total: get<number>(unitTests, "total", 0),
    contract_tests_passed: get<number>(contractTests, "passed", 0),
    contract_tests_total: get<number>(contractTests, "total", 0),
    lint_findings: get<number>(codeQuality, "lint_total", 0),
    qualitative_overall: get<number>(qualitative, "overall_score", 0.0),
    execution_time_seconds: get<number>(execution, "wall_clock_ms", 0) / 1000.0,
    total_tokens: get<number>(execution, "total_tokens", 0),
    document_scores: docScores,
  });
}

// ---------------------------------------------------------------------------
// Sorting and deltas (collector.py:503-535)
// ---------------------------------------------------------------------------

/** Sort runs: releases by semver ascending, then main, then PRs. (collector.py:503-516) */
export function sortRuns(runs: RunData[]): RunData[] {
  const typeOrder: Record<RunType, number> = {
    [RunType.RELEASE]: 0,
    [RunType.MAIN]: 1,
    [RunType.PR]: 2,
  };

  // Sentinel (999,999,999) for runs without a semver (collector.py:508-512).
  const key = (run: RunData): [number, number, number, number, number] => {
    const sv: [number, number, number] = run.semver
      ? [run.semver.major, run.semver.minor, run.semver.patch]
      : [999, 999, 999];
    const pr = run.pr_number ?? 0;
    return [typeOrder[run.run_type], sv[0], sv[1], sv[2], pr];
  };

  // Stable sort matching Python's sorted() (Timsort is stable). Array.sort in
  // Bun/V8 is stable for all lengths, so a tuple comparator suffices.
  return [...runs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! !== kb[i]!) return ka[i]! < kb[i]! ? -1 : 1;
    }
    return 0;
  });
}

/** Compute version-over-version deltas for consecutive runs. (collector.py:519-535) */
export function computeDeltas(runs: RunData[]): VersionDelta[] {
  const deltas: VersionDelta[] = [];
  // zip(runs, runs[1:]) — consecutive pairs.
  for (let i = 0; i + 1 < runs.length; i++) {
    const prev = runs[i]!;
    const curr = runs[i + 1]!;
    deltas.push(
      makeVersionDelta(prev.label, curr.label, {
        unit_tests_delta: curr.unit_tests.passed - prev.unit_tests.passed,
        contract_tests_delta: curr.contract_tests.passed - prev.contract_tests.passed,
        qualitative_delta: curr.qualitative.overall_score - prev.qualitative.overall_score,
        token_delta: curr.metrics.total_tokens - prev.metrics.total_tokens,
        time_delta_seconds: curr.metrics.execution_time_seconds - prev.metrics.execution_time_seconds,
      }),
    );
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Top-level collection (collector.py:543-579)
// ---------------------------------------------------------------------------

/**
 * Parse all bundles (zip files or directories) and assemble a TrendData.
 * (collector.py:543-579)
 *
 * *workDir* defaults to a fresh temp dir (mirroring tempfile.mkdtemp). The port
 * accepts it explicitly for testability; callers pass a path.
 */
export function collectTrendData(
  bundlePaths: string[],
  baselinePath: string,
  repo: string,
  workDir?: string,
): TrendData {
  if (workDir === undefined) {
    workDir = mkdtempSyncFallback("trend-collect-");
  }

  const baseline = loadBaseline(baselinePath);

  const runs: RunData[] = [];
  for (const bp of bundlePaths) {
    logger.info("Collecting data from %s …", pathName(bp));
    try {
      const run = isDir(bp) ? collectFromDirectory(bp) : collectFromZip(bp, workDir);
      runs.push(run);
    } catch (exc) {
      if (exc instanceof CollectorError) {
        logger.warning("Skipping %s: %s", pathName(bp), (exc as Error).message);
      } else {
        throw exc;
      }
    }
  }

  if (runs.length === 0) {
    throw new CollectorError("No runs could be parsed from the provided bundles.");
  }

  const sorted = sortRuns(runs);

  return makeTrendData(sorted, baseline, {
    repo,
    generated_at: new Date().toISOString(),
  });
}

// mkdtemp fallback for the no-workDir path (collector.py imports tempfile).
function mkdtempSyncFallback(prefix: string): string {
  // Defer the import so the common test path (explicit workDir) never touches os.
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  return mkdtempSync(join(tmpdir(), prefix));
}
