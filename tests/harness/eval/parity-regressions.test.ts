// parity-regressions.test.ts — pins the four reachable TS↔Python divergences
// the Phase-4 adversarial skeptic pass found and that were FIXED. Each was
// confirmed against the real Python (cited file:line); these guards stop a
// silent regression. (The remaining skeptic findings — NaN/inf casing,
// >2^53 ints, matchBody float-string formatting, unicode \w/\d/\s regex
// classes, multiline-YAML scalar style, ENOENT error text — are documented
// residuals in README "Known gaps", unreachable with real evaluator data or
// fundamental JS-runtime limits.)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyRound } from "./pyutil.ts";
import { loadSpec } from "./contract.ts";
import { loadDocuments } from "./qualitative.ts";
import { renderHtml } from "./render-html.ts";
import { collect } from "./reporting-collector.ts";

// FIX 1 — renderer _fmt_val ≥10 must round half-to-EVEN (Python f"{v:,.0f}",
// render_md.py:33 / render_html.py:171), NOT Math.round half-away.
describe("parity: renderer fmtVal rounds half-to-even", () => {
  test("88.5 → 88, 89.5 → 90, 90.5 → 90 (banker's)", () => {
    expect(pyRound(88.5, 0)).toBe(88);
    expect(pyRound(89.5, 0)).toBe(90);
    expect(pyRound(90.5, 0)).toBe(90);
  });
});

// FIX 2 — contract skip flag uses Python bool() truthiness (spec.py:100): an
// empty list/dict is FALSY → the case RUNS. JS Boolean([]) would skip it.
describe("parity: contract skip flag = Python truthiness", () => {
  const spec = loadSpec({
    paths: {
      "/x": {
        get: {
          "x-test-cases": [
            { name: "empty-list", skip: [] },
            { name: "empty-dict", skip: {} },
            { name: "nonempty-list", skip: [1] },
            { name: "true", skip: true },
            { name: "absent" },
          ],
        },
      },
    },
  });
  const byName = Object.fromEntries(spec.test_cases.map((c) => [c.name, c.skip]));
  test("empty list/dict are falsy (case runs)", () => {
    expect(byName["empty-list"]).toBe(false);
    expect(byName["empty-dict"]).toBe(false);
  });
  test("non-empty container / true / absent", () => {
    expect(byName["nonempty-list"]).toBe(true);
    expect(byName["true"]).toBe(true);
    expect(byName["absent"]).toBe(false);
  });
});

// FIX 3 — loadDocuments sorts by PATH COMPONENTS like pathlib.Path
// (document.py:92 sorted(rglob)), not raw strings. With a file "a.md" beside a
// dir "a/", Python orders "a/deep.md" before "a-b.md"/"a.md".
describe("parity: qualitative doc order = pathlib component-wise", () => {
  test("a/deep.md sorts before a-b.md and a.md", () => {
    const d = mkdtempSync(join(tmpdir(), "qsort-"));
    try {
      mkdirSync(join(d, "inception", "a"), { recursive: true });
      mkdirSync(join(d, "inception", "sub"), { recursive: true });
      writeFileSync(join(d, "inception", "a.md"), "x");
      writeFileSync(join(d, "inception", "a-b.md"), "x");
      writeFileSync(join(d, "inception", "a", "deep.md"), "x");
      writeFileSync(join(d, "inception", "sub", "c.md"), "x");
      const order = loadDocuments(d).map((x) => x.relativePath);
      expect(order).toEqual([
        "inception/a/deep.md",
        "inception/a-b.md",
        "inception/a.md",
        "inception/sub/c.md",
      ]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// FIX 4 — _score_ring radius is a Python float (render_html.py:176 true
// division), so str(r) keeps ".0" for the even default sizes (29.0 / 37.0).
describe("parity: HTML score-ring radius renders as a float", () => {
  test("r=\"29.0\" and r=\"37.0\" appear when a qualitative section renders", () => {
    const d = mkdtempSync(join(tmpdir(), "ring-"));
    try {
      // Minimal run folder with a qualitative-comparison.yaml so both rings
      // (size 64 card + size 80 section) render.
      writeFileSync(
        join(d, "qualitative-comparison.yaml"),
        "overall_score: 0.9\nphases:\n- phase: inception\n  avg_intent: 0.9\n  avg_design: 0.9\n  avg_completeness: 0.9\n  avg_overall: 0.9\n  documents: []\n",
      );
      const html = renderHtml(collect(d));
      expect(html).toContain('r="29.0"'); // size 64 → (64-6)/2
      expect(html).toContain('r="37.0"'); // size 80 → (80-6)/2
      expect(html).not.toContain('r="29"');
      expect(html).not.toContain('r="37"');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
