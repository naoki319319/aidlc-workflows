// contract.test.ts — mirrors contracttest/tests/test_runner.py +
// test_spec.py 1:1 (17 pure tests).
//
// The Python tests inject a MagicMock httpx client into _run_case; the TS port
// injects an HttpClient stub (a synchronous seam mirroring httpx.Client). Spec
// loading parses the YAML string first (Bun.YAML.parse) because TS loadSpec
// takes a pre-parsed object — the file-read + `or {}` fallback lives in the
// caller (run.ts), mirroring spec.py:64-65.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContractResponse,
  type HttpClient,
  loadSpec,
  matchBody,
  runCase,
  writeResults,
} from "./contract.ts";
import type { ContractTestResults, TestCase } from "./types.ts";

// ── helpers ────────────────────────────────────────────────────────────────

// Parse a YAML spec string the way the Python caller does before load_spec.
function parseSpec(yaml: string) {
  return loadSpec(Bun.YAML.parse(yaml) as Record<string, any>);
}

// A MagicMock-style stub client. Configure a fixed response (or a thrown error)
// for the verb under test; mirrors the unittest.mock MagicMock the Python tests
// build (client.get.return_value / .side_effect, etc.).
function mockResponse(statusCode: number, body: unknown): ContractResponse {
  return { status_code: statusCode, json: () => body };
}

interface StubConfig {
  getResponse?: ContractResponse;
  getError?: Error;
  postResponse?: ContractResponse;
  postError?: Error;
  requestResponse?: ContractResponse;
}

function stubClient(cfg: StubConfig): HttpClient {
  return {
    get(_url, _opts) {
      if (cfg.getError) throw cfg.getError;
      return cfg.getResponse!;
    },
    post(_url, _opts) {
      if (cfg.postError) throw cfg.postError;
      return cfg.postResponse!;
    },
    request(_method, _url, _opts) {
      return cfg.requestResponse!;
    },
  };
}

// Build a TestCase with the spec.py dataclass defaults applied.
function makeCase(o: Partial<TestCase> & Pick<TestCase, "name" | "method" | "path" | "expected_status">): TestCase {
  return {
    body: null,
    expected_body: null,
    operation_id: null,
    skip: false,
    ...o,
  };
}

// ── test_runner.py: TestMatchBody ──────────────────────────────────────────
describe("TestMatchBody", () => {
  test("test_exact_match", () => {
    const expected = { status: "ok", result: 42 };
    const actual = { status: "ok", result: 42, extra: "ignored" };
    expect(matchBody(expected, actual)).toEqual([]);
  });

  test("test_missing_key", () => {
    const expected = { status: "ok", result: 42 };
    const actual = { status: "ok" };
    const failures = matchBody(expected, actual);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("missing key 'result'");
  });

  test("test_wrong_value", () => {
    const expected = { status: "ok" };
    const actual = { status: "error" };
    const failures = matchBody(expected, actual);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("'status'");
  });

  test("test_nested_match", () => {
    const expected = { error: { code: "DOMAIN_ERROR" } };
    const actual = { error: { code: "DOMAIN_ERROR", message: "sqrt of negative" } };
    expect(matchBody(expected, actual)).toEqual([]);
  });

  test("test_nested_mismatch", () => {
    const expected = { error: { code: "DOMAIN_ERROR" } };
    const actual = { error: { code: "OVERFLOW" } };
    const failures = matchBody(expected, actual);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("error.code");
  });

  test("test_float_tolerance", () => {
    const expected = { result: 3.0 };
    const actual = { result: 3.0000000001 };
    expect(matchBody(expected, actual)).toEqual([]);
  });

  test("test_float_mismatch", () => {
    const expected = { result: 3.0 };
    const actual = { result: 5.0 };
    const failures = matchBody(expected, actual);
    expect(failures.length).toBe(1);
  });

  // Drift 1 (not in Python's test list, pins the fix): bool matches int via
  // math.isclose because bool subclasses int. {ok: true} vs {ok: 1} passes.
  test("bool_matches_int (drift-1 fix)", () => {
    expect(matchBody({ ok: true }, { ok: 1 })).toEqual([]);
    expect(matchBody({ ok: false }, { ok: 0 })).toEqual([]);
    expect(matchBody({ ok: true }, { ok: 0 }).length).toBe(1);
  });
});

// ── test_runner.py: TestRunCase ─────────────────────────────────────────────
describe("TestRunCase", () => {
  test("test_get_success", () => {
    const c = makeCase({
      name: "health",
      method: "GET",
      path: "/health",
      expected_status: 200,
      expected_body: { status: "ok" },
    });
    const client = stubClient({
      getResponse: mockResponse(200, { status: "ok", version: "0.1.0" }),
    });
    const result = runCase(client, "http://localhost:8000", c);
    expect(result.passed).toBe(true);
    expect(result.actual_status).toBe(200);
    expect(result.failures).toEqual([]);
    expect(result.latency_ms).not.toBeNull();
  });

  test("test_wrong_status", () => {
    const c = makeCase({ name: "not found", method: "GET", path: "/missing", expected_status: 404 });
    const client = stubClient({ getResponse: mockResponse(200, {}) });
    const result = runCase(client, "http://localhost:8000", c);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("status"))).toBe(true);
  });

  test("test_post_body_mismatch", () => {
    const c = makeCase({
      name: "add",
      method: "POST",
      path: "/api/v1/arithmetic/add",
      expected_status: 200,
      body: { a: 1, b: 2 },
      expected_body: { status: "ok", result: 3 },
    });
    const client = stubClient({
      postResponse: mockResponse(200, { status: "ok", result: 99 }),
    });
    const result = runCase(client, "http://localhost:8000", c);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("result"))).toBe(true);
  });

  test("test_connection_error", () => {
    const c = makeCase({ name: "health", method: "GET", path: "/health", expected_status: 200 });
    const client = stubClient({ getError: new Error("refused") });
    const result = runCase(client, "http://localhost:9999", c);
    expect(result.passed).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

// ── test_runner.py: TestWriteResults ────────────────────────────────────────
describe("TestWriteResults", () => {
  test("test_roundtrip", () => {
    const results: ContractTestResults = {
      total: 3,
      passed: 2,
      failed: 1,
      errors: 0,
      skipped: 0,
      cases: [],
      server_started: true,
      server_error: null,
    };
    const dir = mkdtempSync(join(tmpdir(), "contract-write-"));
    const out = join(dir, "results.yaml");
    writeResults(results, out);

    const data = Bun.YAML.parse(readFileSync(out, "utf-8")) as Record<string, any>;
    expect(data.total).toBe(3);
    expect(data.passed).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.server_started).toBe(true);
  });
});

// ── test_spec.py ────────────────────────────────────────────────────────────
describe("test_spec", () => {
  test("test_load_openapi_spec", () => {
    const spec = parseSpec(`
openapi: "3.1.0"
info:
  title: Test API
  version: "1.0.0"

x-app:
  module: "myapp.app:app"
  framework: "fastapi"
  startup_timeout: 10
  port: 8080

paths:
  /health:
    get:
      operationId: health_check
      x-test-cases:
        - name: "health"
          expected_status: 200
          expected_body:
            status: "ok"

  /api/data:
    post:
      operationId: create_data
      x-test-cases:
        - name: "create item"
          body: {"key": "value"}
          expected_status: 201
          expected_body:
            id: 1
        - name: "missing body - 422"
          body: {}
          expected_status: 422
`);
    expect(spec.app.module).toBe("myapp.app:app");
    expect(spec.app.framework).toBe("fastapi");
    expect(spec.app.startup_timeout).toBe(10);
    expect(spec.app.port).toBe(8080);
    expect(spec.title).toBe("Test API");
    expect(spec.version).toBe("1.0.0");
    expect(spec.test_cases.length).toBe(3);

    const c0 = spec.test_cases[0]!;
    expect(c0.name).toBe("health");
    expect(c0.method).toBe("GET");
    expect(c0.path).toBe("/health");
    expect(c0.expected_status).toBe(200);
    expect(c0.expected_body).toEqual({ status: "ok" });
    expect(c0.body).toBeNull();
    expect(c0.operation_id).toBe("health_check");

    const c1 = spec.test_cases[1]!;
    expect(c1.method).toBe("POST");
    expect(c1.body).toEqual({ key: "value" });
    expect(c1.operation_id).toBe("create_data");

    const c2 = spec.test_cases[2]!;
    expect(c2.expected_status).toBe(422);
  });

  test("test_load_spec_defaults", () => {
    const spec = parseSpec(`
openapi: "3.1.0"
info:
  title: Minimal
  version: "0.0.1"

x-app:
  module: "app:app"

paths:
  /ping:
    get:
      x-test-cases:
        - name: "ping"
          expected_status: 200
`);
    expect(spec.app.framework).toBe("fastapi");
    expect(spec.app.startup_timeout).toBe(15);
    expect(spec.app.port).toBe(0);
    expect(spec.test_cases.length).toBe(1);
    expect(spec.test_cases[0]!.method).toBe("GET");
    expect(spec.test_cases[0]!.body).toBeNull();
    expect(spec.test_cases[0]!.expected_body).toBeNull();
  });

  test("test_load_spec_multiple_methods", () => {
    const spec = parseSpec(`
openapi: "3.1.0"
info:
  title: Multi
  version: "0.1.0"
x-app:
  module: "app:app"
paths:
  /items:
    get:
      operationId: list_items
      x-test-cases:
        - name: "list all"
          expected_status: 200
    post:
      operationId: create_item
      x-test-cases:
        - name: "create"
          body: {"name": "x"}
          expected_status: 201
`);
    expect(spec.test_cases.length).toBe(2);
    const methods = new Set(spec.test_cases.map((tc) => tc.method));
    expect(methods).toEqual(new Set(["GET", "POST"]));
  });

  test("test_load_spec_no_test_cases", () => {
    const spec = parseSpec(`
openapi: "3.1.0"
info:
  title: Empty
  version: "0.1.0"
x-app:
  module: "app:app"
paths:
  /hidden:
    get:
      operationId: hidden
      summary: "No test cases here"
`);
    expect(spec.test_cases.length).toBe(0);
  });

  // ⏭FIXTURE — self-skips when the on-disk sci-calc-v2 spec is absent.
  test("test_load_real_openapi_spec", () => {
    // test_spec.py:153 — parents[3]/test_cases/sci-calc-v2/openapi.yaml, where
    // parents[3] is the `evaluator` package root.
    const specPath = join(
      import.meta.dir,
      "../../../.claude/worktrees/v2-inspect/evaluator/test_cases/sci-calc-v2/openapi.yaml",
    );
    if (!existsSync(specPath)) return; // self-skip
    const spec = loadSpec(Bun.YAML.parse(readFileSync(specPath, "utf-8")) as Record<string, any>);
    expect(spec.title).toBe("Scientific Calculator API");
    expect(spec.version).toBe("0.1.0");
    expect(spec.app.module).toBe("sci_calc.app:app");
    expect(spec.test_cases.length).toBeGreaterThanOrEqual(60);
    const ops = new Set(
      spec.test_cases.filter((tc) => tc.operation_id).map((tc) => tc.operation_id),
    );
    expect(ops.has("health")).toBe(true);
    expect(ops.has("arithmetic_add")).toBe(true);
    expect(ops.has("powers_sqrt")).toBe(true);
    expect(ops.has("trig_sin")).toBe(true);
    expect(ops.has("log_ln")).toBe(true);
    expect(ops.has("stats_mean")).toBe(true);
    expect(ops.has("constants_pi")).toBe(true);
    expect(ops.has("convert_temperature")).toBe(true);
  });
});
