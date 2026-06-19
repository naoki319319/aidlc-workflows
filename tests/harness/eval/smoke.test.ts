// smoke.test.ts — exercises the pure-logic ports against known values.
// Run: bun test tmp/eval-js-judge/src/smoke.test.ts
import { expect, test } from "bun:test";
import { matchBody, loadSpec } from "./contract.ts";
import { compare, loadBaseline } from "./baseline.ts";
import { checkRegressions } from "./gate.ts";
import { RunType, type TrendData } from "./trend-models.ts";
import { make_run, make_trend } from "./trend-factories.ts";
import { heuristicScore, classifyPhase, pairDocuments, type AidlcDocument } from "./qualitative.ts";

// ── contract matcher ───────────────────────────────────────────────────────
test("matchBody: subset match, extra keys OK", () => {
  expect(matchBody({ a: 1 }, { a: 1, b: 2 })).toEqual([]);
});
test("matchBody: float tolerance 1e-6", () => {
  expect(matchBody({ x: 1.0 }, { x: 1.0 + 1e-9 })).toEqual([]);
  expect(matchBody({ x: 1.0 }, { x: 1.1 }).length).toBe(1);
});
test("matchBody: missing key + nested", () => {
  expect(matchBody({ a: { b: 1 } }, { a: {} })).toEqual(["missing key 'a.b'"]);
});

// ── openapi x-test-cases loader ──────────────────────────────────────────────
test("loadSpec: pulls x-test-cases per method", () => {
  const spec = loadSpec({
    "x-app": { module: "main:app", port: 8000 },
    info: { title: "T", version: "1" },
    paths: {
      "/add": {
        post: {
          operationId: "add",
          "x-test-cases": [{ name: "adds", expected_status: 200, body: { a: 1, b: 2 }, expected_body: { result: 3 } }],
        },
      },
    },
  });
  expect(spec.app.module).toBe("main:app");
  expect(spec.test_cases.length).toBe(1);
  expect(spec.test_cases[0].method).toBe("POST");
  expect(spec.test_cases[0].expected_body).toEqual({ result: 3 });
});

// ── baseline compare ─────────────────────────────────────────────────────────
test("baseline compare: higher_is_better direction + 0.001 tolerance", () => {
  const golden = loadBaseline({ qualitative: { overall_score: 0.9 }, unit_tests: { failed: 0 } });
  const better = loadBaseline({ qualitative: { overall_score: 0.95 }, unit_tests: { failed: 0 } });
  const worse = loadBaseline({ qualitative: { overall_score: 0.8 }, unit_tests: { failed: 3 } });
  const up = compare(better, golden).deltas.find((d) => d.name === "Qualitative Score")!;
  const down = compare(worse, golden).deltas.find((d) => d.name === "Qualitative Score")!;
  const fails = compare(worse, golden).deltas.find((d) => d.name === "Tests Failed")!;
  expect(up.direction).toBe("improved");
  expect(down.direction).toBe("regressed");
  expect(fails.direction).toBe("regressed"); // failures: lower is better, went up
});

// ── trend gate (uses the trend-models + trend-factories built in Wave A/B) ────
test("gate: qualitative drop > 0.02 regresses", () => {
  const trend: TrendData = make_trend([
    make_run({ label: "v0.1.0", run_type: RunType.RELEASE, qualitative_score: 0.9 }),
    make_run({ label: "v0.2.0", run_type: RunType.RELEASE, qualitative_score: 0.85 }),
  ]);
  const r = checkRegressions(trend);
  expect(r.passed).toBe(false);
  expect(r.regressions.some((x) => x.includes("Qualitative score regressed"))).toBe(true);
});
test("gate: infra-failure latest passes with annotation", () => {
  const trend: TrendData = make_trend([
    make_run({ label: "v0.1.0", run_type: RunType.RELEASE, qualitative_score: 0.9 }),
    make_run({
      label: "v0.2.0",
      run_type: RunType.RELEASE,
      qualitative_score: 0.1,
      infra_failure: { is_infra_failure: true, reasons: [], summary: "bedrock_throttled" },
    }),
  ]);
  const r = checkRegressions(trend);
  expect(r.passed).toBe(true);
  expect(r.infra_failure_detected).toBe(true);
});

// ── qualitative heuristic + pairing ──────────────────────────────────────────
test("classifyPhase: strips v2 intent prefix", () => {
  expect(classifyPhase("intent-001-foo/inception/requirements.md")).toBe("inception");
  expect(classifyPhase("construction/sci-calc/code/x.md")).toBe("construction");
});
test("pairDocuments: construction unit-name normalisation pairs across runs", () => {
  const ref: AidlcDocument[] = [{ relativePath: "construction/sci-calc/code/c.md", phase: "construction", content: "x" }];
  const cand: AidlcDocument[] = [{ relativePath: "construction/calculator-api/code/c.md", phase: "construction", content: "x" }];
  const { paired } = pairDocuments(ref, cand);
  expect(paired.length).toBe(1);
});
test("heuristicScore: identical docs score ~1 overall", () => {
  const content = "# Title\n\nThe SystemArchitect designs the api_gateway in src/main.py.";
  const s = heuristicScore({ relativePath: "x.md", phase: "inception", reference: { relativePath: "x.md", phase: "inception", content }, candidate: { relativePath: "x.md", phase: "inception", content } });
  expect(s.overall).toBeGreaterThan(0.99);
  expect(s.intent_similarity).toBeGreaterThan(0.99);
});
