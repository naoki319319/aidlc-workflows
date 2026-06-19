// contract.ts — Stage 4: contract testing.
//
// Ports contracttest/spec.py (OpenAPI x-test-cases loader) and runner.py
// (_match_body recursive subset matcher + _run_case + run_contract_tests +
// write_results).
//
// PORTABLE vs PYTHON-BOUND (verified against server.py:52-427):
//   - _match_body, _run_case, write_results, the consecutive-error abort,
//     x-test-cases parsing: pure logic, ported 1:1 here. _run_case takes an
//     injectable HttpClient seam (mirroring Python's httpx.Client mock point).
//   - Server launch (`venv-python -m uvicorn <module>`) is Python-toolchain-bound
//     because the AIDLC run generates a Python app. We DO NOT reimplement venv
//     discovery; startServer() shells to uvicorn exactly like server.py, and is
//     the one spot that requires python+uv on PATH. Port polling is generic.
//
// DRIFTS FIXED vs the original spike (verified against runner.py / spec.py):
//   1. matchBody numeric branch treats booleans as numbers — runner.py:59
//      `isinstance(., (int, float))` is True for bool (bool subclasses int), so
//      {ok: true} vs {ok: 1} passes via math.isclose (True==1.0). (runner.py:59-61)
//   2. writeResults ported (runner.py:222-226) via atomicYamlDump.
//   3. loadSpec guards null/undefined doc → {} (spec.py:64-65 `... or {}`).
//   4. Non-GET sends json=body unconditionally, even when body is None
//      (runner.py:75-77).
//   5. Failure-message quoting matches Python: numeric branch uses str()
//      (runner.py:61), non-numeric branch uses !r repr — strings single-quoted
//      (runner.py:63).
//
// HOST-MODE LAUNCH CONCERNS LEFT GATED / UNPORTED (server.py, document only):
//   - _resolve_module/_discover_asgi_module/_find_project_root module-resolution
//     layer (server.py:52-183), graceful venv degrade + network retry
//     (server.py:196-256), SIGTERM→wait→SIGKILL escalation (server.py:389-405),
//     mid-loop is_running death check (runner.py:174-188), stderr drain
//     (server.py:362-369). These are deferred — the matcher/runner/spec are the
//     deterministic core the tests cover.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AppConfig,
  CaseResult,
  ContractSpec,
  ContractTestResults,
  TestCase,
} from "./types.ts";
import { pyRound } from "./pyutil.ts";
import { atomicYamlDump } from "./yaml.ts";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_CONSECUTIVE_ERRORS = 3; // runner.py:116

// Python bool(x) truthiness for the skip flag: 0/""/null/undefined and EMPTY
// list/dict are falsy; any non-empty container or nonzero scalar is truthy.
// (JS Boolean([]) / Boolean({}) are truthy, which would wrongly skip a case
// whose spec has `skip: []`.)
function pyTruthy(x: unknown): boolean {
  if (x == null || x === false || x === 0 || x === "") return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return Boolean(x);
}

// ── spec.py:load_spec — parse OpenAPI x-app + x-test-cases ─────────────────
// spec.py:64-65 — `doc = yaml.safe_load(f) or {}`. The file-read + parse live
// in the caller; loadSpec takes a pre-parsed object and applies the `or {}`
// fallback so a null/undefined/empty doc is treated as an empty mapping.
export function loadSpec(doc: Record<string, any> | null | undefined): ContractSpec {
  doc = doc ?? {};
  const xApp = doc["x-app"] ?? {};
  const app: AppConfig = {
    module: xApp.module ?? "",
    framework: xApp.framework ?? "fastapi",
    startup_timeout: xApp.startup_timeout ?? 15,
    port: xApp.port ?? 0,
  };
  const info = doc.info ?? {};
  const cases: TestCase[] = [];
  for (const [pathStr, pathItem] of Object.entries(doc.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as any)[method];
      if (typeof operation !== "object" || operation === null) continue;
      const opId = operation.operationId ?? null;
      for (const tc of operation["x-test-cases"] ?? []) {
        cases.push({
          name: tc.name ?? `${method.toUpperCase()} ${pathStr}`,
          method: method.toUpperCase(),
          path: pathStr,
          expected_status: tc.expected_status ?? 200,
          body: tc.body ?? null,
          expected_body: tc.expected_body ?? null,
          operation_id: opId,
          // spec.py:100 `bool(tc.get("skip", False))` — Python truthiness, so an
          // empty list/dict/string/0 is FALSY (the case RUNS). JS Boolean([]) /
          // Boolean({}) are truthy, so use pyTruthy to match (a `skip: []` spec
          // runs the case in Python, must run it here too).
          skip: pyTruthy(tc.skip),
        });
      }
    }
  }
  return { app, test_cases: cases, title: info.title ?? "", version: info.version ?? "" };
}

// ── runner.py:_match_body — recursive subset match, 1e-6/1e-9 float tol ────
// math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9) ported exactly.
function isClose(a: number, b: number, relTol = 1e-6, absTol = 1e-9): boolean {
  return Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol);
}

// runner.py:59 — `isinstance(., (int, float))`. In Python, `bool` subclasses
// `int`, so booleans pass this guard and route to math.isclose (True==1.0,
// False==0.0). Mirror that here: a boolean is a Python numeric for matching.
function isPyNumeric(v: unknown): v is number | boolean {
  return typeof v === "number" || typeof v === "boolean";
}

// Coerce a Python-numeric (number or bool) to its float value: True→1, False→0.
function asNumber(v: number | boolean): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export function matchBody(
  expected: Record<string, any>,
  actual: Record<string, any>,
  prefix = "",
): string[] {
  const failures: string[] = [];
  for (const [key, expVal] of Object.entries(expected)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in actual)) {
      failures.push(`missing key '${path}'`);
      continue;
    }
    const actVal = actual[key];
    const expIsObj = expVal !== null && typeof expVal === "object" && !Array.isArray(expVal);
    const actIsObj = actVal !== null && typeof actVal === "object" && !Array.isArray(actVal);
    if (expIsObj && actIsObj) {
      failures.push(...matchBody(expVal, actVal, path));
    } else if (isPyNumeric(expVal) && isPyNumeric(actVal)) {
      if (!isClose(asNumber(expVal), asNumber(actVal))) {
        // runner.py:61 — plain str() formatting (no !r) for the numeric branch.
        failures.push(`'${path}': expected ${pyStr(expVal)}, got ${pyStr(actVal)}`);
      }
    } else if (!deepEqual(expVal, actVal)) {
      // runner.py:63 — !r repr formatting for the non-numeric mismatch branch.
      failures.push(`'${path}': expected ${pyRepr(expVal)}, got ${pyRepr(actVal)}`);
    }
  }
  return failures;
}

// runner.py:63 — Python f-string `{...!r}` repr. Strings get single quotes
// ('error'), bools render True/False, None renders None, numbers as-is. Matches
// the emitted failure-message text the Python runner produces.
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return JSON.stringify(v);
}

// runner.py:61 — Python f-string `{...}` (str, not repr) for the numeric branch.
// Bools render True/False, numbers as-is.
function pyStr(v: unknown): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

// Python `!=` on lists/strings/etc. — structural equality for the non-numeric,
// non-dict leaf case.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

// ── runner.py:_run_case — one request over an injectable HTTP client ───────
// The Python runner passes an httpx.Client into _run_case so tests can mock it
// (test_runner.py uses MagicMock). The TS port mirrors that with an HttpClient
// seam: production uses fetchClient(); tests inject a stub. A response exposes
// status_code + json() (sync, like httpx's parsed body).
export interface ContractResponse {
  status_code: number;
  json(): any;
}

export interface HttpClient {
  get(url: string, opts?: { timeout?: number }): ContractResponse;
  post(url: string, opts: { json: unknown; timeout?: number }): ContractResponse;
  request(method: string, url: string, opts: { json: unknown; timeout?: number }): ContractResponse;
}

// runner.py:67-113 — execute a single case against a client and return result.
// `client.get/post/request` may throw a connection/timeout error (httpx.* in
// Python) → reported as result.error with no status.
export function runCase(client: HttpClient, baseUrl: string, c: TestCase): CaseResult {
  const url = `${baseUrl}${c.path}`;
  const start = performance.now();
  let resp: ContractResponse;
  let latency: number;
  try {
    if (c.method === "GET") {
      resp = client.get(url, { timeout: 5.0 });
    } else if (c.method === "POST") {
      resp = client.post(url, { json: c.body, timeout: 5.0 });
    } else {
      // runner.py:75-77 — non-GET passes json=body unconditionally, even when
      // body is None (httpx sends `null`).
      resp = client.request(c.method, url, { json: c.body, timeout: 5.0 });
    }
    latency = performance.now() - start;
  } catch (e) {
    return {
      name: c.name,
      path: c.path,
      method: c.method,
      passed: false,
      expected_status: c.expected_status,
      actual_status: null,
      failures: [],
      latency_ms: null,
      error: String((e as Error)?.message ?? e),
      skipped: false,
    };
  }

  const failures: string[] = [];
  if (resp.status_code !== c.expected_status) {
    failures.push(`status: expected ${c.expected_status}, got ${resp.status_code}`);
  }
  if (c.expected_body != null) {
    let actualBody: any = null;
    try {
      actualBody = resp.json();
    } catch {
      failures.push("response is not valid JSON");
      actualBody = null;
    }
    if (actualBody != null) failures.push(...matchBody(c.expected_body, actualBody));
  }
  return {
    name: c.name,
    path: c.path,
    method: c.method,
    passed: failures.length === 0,
    expected_status: c.expected_status,
    actual_status: resp.status_code,
    failures,
    latency_ms: pyRound(latency, 1),
    error: null,
    skipped: false,
  };
}

// ── server.py:ServerProcess (host mode, lines 303-329) — PYTHON-BOUND ──────
// The generated app is a Python ASGI app; this is the irreducibly Python part.
export interface ServerHandle {
  baseUrl: string;
  stop(): void;
}

export async function startServer(
  workspace: string,
  app: AppConfig,
): Promise<ServerHandle> {
  const port = app.port && app.port > 0 ? app.port : await freePort();
  const venvPython = join(workspace, ".venv", "bin", "python");
  // server.py:196-224 — ensure a venv exists (uv sync) if missing.
  if (!existsSync(venvPython)) {
    await run("uv", ["sync", "--all-extras"], workspace);
  }
  const proc: ChildProcess = spawn(
    venvPython,
    ["-m", "uvicorn", app.module, "--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
    { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(baseUrl, proc, app.startup_timeout);
  return {
    baseUrl,
    stop() {
      proc.kill("SIGTERM");
    },
  };
}

// server.py:349-387 — poll until the server accepts connections, or timeout.
//
// DELIBERATE DIVERGENCE from server.py:371-372 (documented — spike house rule):
// Python gates readiness on `GET /health` returning EXACTLY 200, which conflates
// two things — "the socket is live" and "the app implements /health at that path".
// A generated app that serves health at `/` (or omits the spec's `/health`) then
// never becomes ready, so EVERY contract case is reported as a server-start ERROR
// (0/N) and the per-endpoint conformance signal is lost. Readiness should mean
// only "the server answers HTTP"; whether each route conforms is what the 88 cases
// themselves measure. So we probe /health first (the faithful path) and fall back
// to `/` (root) — and treat ANY HTTP response, including 404, as "accepting
// connections" (a 404 came FROM the server, proving the socket is up). Route/path
// conformance is then graded honestly per-case by runCaseHttp, not pre-empted here.
async function waitReady(baseUrl: string, proc: ChildProcess, timeoutS: number): Promise<void> {
  const deadline = performance.now() + timeoutS * 1000;
  // /health first (faithful to server.py), then / as a fallback for apps that
  // serve health at the root. Any HTTP status from either proves the socket is up.
  const probePaths = ["/health", "/"];
  while (performance.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server process exited (code ${proc.exitCode})`);
    for (const path of probePaths) {
      try {
        const r = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(2000) });
        // 200 on /health is the ideal signal; any HTTP response (e.g. 404 because
        // the route is absent) still proves the server is accepting connections.
        if (r.status === 200 || r.status === 404) return;
      } catch {
        // connection refused / reset — not up yet, try the next path / next poll.
      }
    }
    await sleep(500);
  }
  proc.kill("SIGTERM");
  throw new Error(`server did not become ready within ${timeoutS}s`);
}

// ── runner.py:run_contract_tests — orchestration, ported 1:1 ───────────────
export async function runContractTests(
  spec: ContractSpec,
  workspace: string,
): Promise<ContractTestResults> {
  const results: ContractTestResults = {
    total: spec.test_cases.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    cases: [],
    server_started: false,
    server_error: null,
  };

  let server: ServerHandle;
  try {
    server = await startServer(workspace, spec.app);
  } catch (e) {
    results.server_error = String(e);
    results.errors = results.total;
    return results;
  }

  try {
    results.server_started = true;
    let consecutiveErrors = 0;
    for (const c of spec.test_cases) {
      if (c.skip) {
        results.skipped++;
        results.cases.push({
          name: c.name,
          path: c.path,
          method: c.method,
          passed: false,
          expected_status: c.expected_status,
          actual_status: null,
          failures: [],
          latency_ms: null,
          error: null,
          skipped: true,
        });
        continue;
      }
      const result = await runCaseHttp(server.baseUrl, c);
      results.cases.push(result);
      if (result.error) {
        results.errors++;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          const remaining =
            results.total - results.passed - results.failed - results.errors - results.skipped;
          results.server_error = `server unresponsive (${consecutiveErrors} consecutive errors); ${remaining} tests skipped`;
          results.errors += remaining;
          break;
        }
      } else {
        consecutiveErrors = 0;
        if (result.passed) results.passed++;
        else results.failed++;
      }
    }
  } finally {
    server.stop();
  }
  return results;
}

// ── runner.py:write_results — serialize results to YAML ────────────────────
// runner.py:222-226 — `data = asdict(results); yaml.dump(data, f,
// default_flow_style=False, sort_keys=False)`. ContractTestResults + its nested
// CaseResult are plain objects here (dataclasses in Python), so the object is
// already the asdict() shape; atomicYamlDump applies the same block style.
export function writeResults(results: ContractTestResults, outputPath: string): void {
  atomicYamlDump(results, outputPath);
}

// ── host-mode async request (PYTHON-BOUND, gated) ──────────────────────────
// runner.py:_run_case over the live server. Async because JS HTTP (fetch) is
// async — the deterministic, test-covered seam is the sync `runCase(client,…)`
// above; this is the production launch path only. Applies drift-4: non-GET
// sends the JSON body unconditionally (even when null).
async function runCaseHttp(baseUrl: string, c: TestCase): Promise<CaseResult> {
  const url = `${baseUrl}${c.path}`;
  const start = performance.now();
  let resp: Response;
  try {
    const init: RequestInit = { method: c.method, signal: AbortSignal.timeout(5000) };
    if (c.method !== "GET") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(c.body ?? null);
    }
    resp = await fetch(url, init);
  } catch (e) {
    return {
      name: c.name,
      path: c.path,
      method: c.method,
      passed: false,
      expected_status: c.expected_status,
      actual_status: null,
      failures: [],
      latency_ms: null,
      error: String((e as Error)?.message ?? e),
      skipped: false,
    };
  }
  const latency = performance.now() - start;
  const failures: string[] = [];
  if (resp.status !== c.expected_status) {
    failures.push(`status: expected ${c.expected_status}, got ${resp.status}`);
  }
  if (c.expected_body != null) {
    let actualBody: any = null;
    try {
      actualBody = await resp.json();
    } catch {
      failures.push("response is not valid JSON");
      actualBody = null;
    }
    if (actualBody != null) failures.push(...matchBody(c.expected_body, actualBody));
  }
  return {
    name: c.name,
    path: c.path,
    method: c.method,
    passed: failures.length === 0,
    expected_status: c.expected_status,
    actual_status: resp.status,
    failures,
    latency_ms: pyRound(latency, 1),
    error: null,
    skipped: false,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function freePort(): Promise<number> {
  // Bun: bind to :0, read the assigned port, close.
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = srv.port;
  srv.stop();
  return p;
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}
