// yaml.test.ts — verify the block-style serializer matches PyYAML
// (default_flow_style=False, sort_keys=False) on representative evaluator data,
// and that every emitted document round-trips through Bun.YAML.parse to the same
// value. Fixtures (pyyaml-samples.json) are the exact strings python3 yaml.dump
// produced.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dumpYaml, pyFloat } from "./yaml.ts";

// Fixtures use FLOAT_FIELDS markers ("@float:<n>") to tag values the Python
// evaluator types as float (pass_pct, coverage_pct, scores, latency_ms) so the
// JS side can wrap them with pyFloat() — JS Number can't distinguish 100.0 from
// 100, but the Python YAML does ("100.0").
const FLOAT_FIELDS = new Set([
  "pass_pct", "coverage_pct", "overall_score", "inception_score", "construction_score",
  "intent_similarity", "design_similarity", "completeness", "overall", "avg_intent",
  "avg_design", "avg_completeness", "avg_overall", "latency_ms", "a", "b", "c",
]);
function wrapFloats(v: unknown, key?: string): unknown {
  if (v !== null && typeof v === "number" && key && FLOAT_FIELDS.has(key)) return pyFloat(v);
  if (Array.isArray(v)) return v.map((x) => wrapFloats(x));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrapFloats(x, k)]));
  return v;
}

const samples: Array<{ data: any; yaml: string }> = JSON.parse(
  readFileSync(join(import.meta.dir, "pyyaml-samples.json"), "utf-8"),
);

test("dumpYaml matches PyYAML block output byte-for-byte on evaluator fixtures", () => {
  for (const { data, yaml } of samples) {
    expect(dumpYaml(wrapFloats(data))).toBe(yaml);
  }
});

test("every dumped document round-trips through Bun.YAML.parse to the same value", () => {
  for (const { data } of samples) {
    const text = dumpYaml(wrapFloats(data));
    expect(Bun.YAML.parse(text)).toEqual(data);
  }
});

test("block style: nested dict indentation + sequences at parent indent", () => {
  const out = dumpYaml({ execution: { executor: { input_tokens: 78628 } }, list: [1, 2] });
  expect(out).toBe(
    "execution:\n  executor:\n    input_tokens: 78628\nlist:\n- 1\n- 2\n",
  );
});

test("list of dicts: dash shares the first key's line", () => {
  const out = dumpYaml({ cases: [{ name: "health", passed: true }, { name: "add" }] });
  expect(out).toBe("cases:\n- name: health\n  passed: true\n- name: add\n");
});

test("scalar quoting: empty string, leading-zero, colon-space, null, bool, float", () => {
  expect(dumpYaml({ a: "" })).toBe("a: ''\n");
  expect(dumpYaml({ a: "007" })).toBe("a: '007'\n");
  expect(dumpYaml({ a: "yes: no" })).toBe("a: 'yes: no'\n");
  expect(dumpYaml({ a: null })).toBe("a: null\n");
  expect(dumpYaml({ a: true })).toBe("a: true\n");
  expect(dumpYaml({ a: 1.0 })).toBe("a: 1\n"); // JS 1.0 === 1 (integer) — see note
  expect(dumpYaml({ a: 0.7702 })).toBe("a: 0.7702\n");
  expect(dumpYaml({ a: "construction/sci-calc/code.md" })).toBe(
    "a: construction/sci-calc/code.md\n",
  );
});

test("empty containers", () => {
  expect(dumpYaml({ a: [] })).toBe("a: []\n");
  expect(dumpYaml({ a: {} })).toBe("a: {}\n");
  expect(dumpYaml([])).toBe("[]\n");
  expect(dumpYaml({})).toBe("{}\n");
});
