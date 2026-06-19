// qualitative.test.ts — 1:1 mirror of the Python qualitative test suite:
//   packages/qualitative/tests/test_document.py   (15 pure)
//   packages/qualitative/tests/test_scorer.py     (24 pure)
//   packages/qualitative/tests/test_comparator.py (8 pure, 2 ⏭FIXTURE)
// plus one NOT-in-Python guard that the ported STOPWORDS set equals the Python
// 55-word frozenset exactly (scorer.py:19-74) — a typo there would silently
// shift every cosine score and no Python test catches it.
//
// All scorer/comparator tests use the deterministic HeuristicScorer (the Python
// suite overrides the LlmScorer default for exactly this reason — test_comparator
// docstring). The two TestCompareRunsWithRealData tests are conditional skips
// that self-skip when their on-disk fixture/run dir is absent.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AidlcDocument,
  type DocumentPair,
  classifyPhase,
  compareRuns,
  cosine,
  counter,
  extractHeadings,
  extractIdentifiers,
  heuristicScore,
  HeuristicScorer,
  jaccard,
  loadDocuments,
  pairDocuments,
  STOPWORDS,
  toDict,
  tokenize,
} from "./qualitative.ts";
import { PyFloat } from "./yaml.ts";

// ── shared tmp-dir harness (mirrors pytest tmp_path) ───────────────────────
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qual-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeDoc(base: string, rel: string, content: string): void {
  const fp = join(base, rel);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, content, "utf-8");
}

// test_comparator.py:_create_aidlc_docs
function createAidlcDocs(base: string, docs: Record<string, string>): string {
  for (const [rel, content] of Object.entries(docs)) writeDoc(base, rel, content);
  return base;
}

const HEURISTIC = new HeuristicScorer();

// ───────────────────────────────────────────────────────────────────────────
// test_document.py
// ───────────────────────────────────────────────────────────────────────────

// TestClassifyPhase
test("classify_phase: inception path", () => {
  expect(classifyPhase("inception/requirements/requirements.md")).toBe("inception");
});
test("classify_phase: construction path", () => {
  expect(classifyPhase("construction/plans/code-gen-plan.md")).toBe("construction");
});
test("classify_phase: root file", () => {
  expect(classifyPhase("some-doc.md")).toBe("other");
});
test("classify_phase: nested inception", () => {
  expect(classifyPhase("inception/application-design/components.md")).toBe("inception");
});

// TestLoadDocuments
test("load_documents: loads markdown files", () => {
  writeDoc(tmp, "inception/requirements/requirements.md", "# Requirements\nFR-001: Do stuff\n");
  writeDoc(tmp, "construction/plans/plan.md", "# Code Plan\nStep 1\n");

  const docs = loadDocuments(tmp);
  expect(docs.length).toBe(2);
  const paths = new Set(docs.map((d) => d.relativePath));
  expect(paths.has("inception/requirements/requirements.md")).toBe(true);
  expect(paths.has("construction/plans/plan.md")).toBe(true);
});

test("load_documents: skips aidlc-state and audit", () => {
  writeDoc(tmp, "aidlc-state.md", "state tracking");
  writeDoc(tmp, "audit.md", "audit log");
  writeDoc(tmp, "real-doc.md", "# Real content");

  const docs = loadDocuments(tmp);
  expect(docs.length).toBe(1);
  expect(docs[0]!.relativePath).toBe("real-doc.md");
});

test("load_documents: skips empty files", () => {
  writeDoc(tmp, "empty.md", "");
  writeDoc(tmp, "whitespace.md", "   \n  ");
  writeDoc(tmp, "real.md", "# Content");

  const docs = loadDocuments(tmp);
  expect(docs.length).toBe(1);
});

test("load_documents: nonexistent directory", () => {
  expect(loadDocuments(join(tmp, "does-not-exist"))).toEqual([]);
});

test("load_documents: phase assignment", () => {
  writeDoc(tmp, "inception/reqs.md", "# Reqs");
  writeDoc(tmp, "construction/plan.md", "# Plan");
  writeDoc(tmp, "other.md", "# Other");

  const docs = loadDocuments(tmp);
  const phases = Object.fromEntries(docs.map((d) => [d.relativePath, d.phase]));
  expect(phases["inception/reqs.md"]).toBe("inception");
  expect(phases["construction/plan.md"]).toBe("construction");
  expect(phases["other.md"]).toBe("other");
});

// TestPairDocuments
function makeDoc(path: string, content = "content"): AidlcDocument {
  return { relativePath: path, phase: classifyPhase(path), content };
}

test("pair_documents: perfect match", () => {
  const ref = [makeDoc("inception/reqs.md"), makeDoc("construction/plan.md")];
  const cand = [makeDoc("inception/reqs.md"), makeDoc("construction/plan.md")];
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments(ref, cand);
  expect(paired.length).toBe(2);
  expect(unmatchedRef).toEqual([]);
  expect(unmatchedCand).toEqual([]);
});

test("pair_documents: unmatched reference", () => {
  const ref = [makeDoc("inception/reqs.md"), makeDoc("inception/extra.md")];
  const cand = [makeDoc("inception/reqs.md")];
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments(ref, cand);
  expect(paired.length).toBe(1);
  expect(unmatchedRef).toEqual(["inception/extra.md"]);
  expect(unmatchedCand).toEqual([]);
});

test("pair_documents: unmatched candidate", () => {
  const ref = [makeDoc("inception/reqs.md")];
  const cand = [makeDoc("inception/reqs.md"), makeDoc("inception/new.md")];
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments(ref, cand);
  expect(paired.length).toBe(1);
  expect(unmatchedRef).toEqual([]);
  expect(unmatchedCand).toEqual(["inception/new.md"]);
});

test("pair_documents: no overlap", () => {
  const ref = [makeDoc("inception/a.md")];
  const cand = [makeDoc("inception/b.md")];
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments(ref, cand);
  expect(paired.length).toBe(0);
  expect(unmatchedRef).toEqual(["inception/a.md"]);
  expect(unmatchedCand).toEqual(["inception/b.md"]);
});

test("pair_documents: empty inputs", () => {
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments([], []);
  expect(paired).toEqual([]);
  expect(unmatchedRef).toEqual([]);
  expect(unmatchedCand).toEqual([]);
});

test("pair_documents: preserves content", () => {
  const ref = [makeDoc("inception/reqs.md", "reference content")];
  const cand = [makeDoc("inception/reqs.md", "candidate content")];
  const { paired } = pairDocuments(ref, cand);
  expect(paired[0]!.reference.content).toBe("reference content");
  expect(paired[0]!.candidate.content).toBe("candidate content");
});

// ───────────────────────────────────────────────────────────────────────────
// test_scorer.py
// ───────────────────────────────────────────────────────────────────────────

// TestTokenize
test("tokenize: basic tokenization", () => {
  const tokens = tokenize("The API shall provide arithmetic operations");
  expect(tokens).toContain("api");
  expect(tokens).toContain("arithmetic");
  expect(tokens).toContain("operations");
  expect(tokens).not.toContain("the");
  expect(tokens).not.toContain("shall");
});

test("tokenize: removes stopwords", () => {
  expect(tokenize("a the and or but in on at to for of with")).toEqual([]);
});

test("tokenize: removes short tokens", () => {
  const tokens = tokenize("I a x go API test");
  expect(tokens).toContain("api");
  expect(tokens).toContain("test");
  expect(tokens).toContain("go");
  expect(tokens).not.toContain("x");
});

test("tokenize: handles code identifiers", () => {
  const tokens = tokenize("math_engine routes/arithmetic pyproject.toml");
  expect(tokens).toContain("math_engine");
  expect(tokens).toContain("arithmetic");
});

// TestExtractHeadings
test("extract_headings: extracts all levels", () => {
  const headings = extractHeadings("# Title\n## Section\n### Subsection\nBody text");
  expect(headings).toContain("title");
  expect(headings).toContain("section");
  expect(headings).toContain("subsection");
});

test("extract_headings: no headings", () => {
  expect(extractHeadings("just body text\nno headings")).toEqual([]);
});

test("extract_headings: strips whitespace", () => {
  expect(extractHeadings("#  Spaced Heading  \n")).toEqual(["spaced heading"]);
});

// TestExtractIdentifiers
test("extract_identifiers: camel case", () => {
  const ids = extractIdentifiers("Use the MathEngine and ResponseModel classes");
  expect(ids.has("mathengine")).toBe(true);
  expect(ids.has("responsemodel")).toBe(true);
});

test("extract_identifiers: snake case", () => {
  const ids = extractIdentifiers("call math_engine and run_tests");
  expect(ids.has("math_engine")).toBe(true);
  expect(ids.has("run_tests")).toBe(true);
});

test("extract_identifiers: paths", () => {
  const ids = extractIdentifiers("see src/sci_calc/routes/arithmetic.py");
  expect([...ids].some((i) => i.includes("src") && i.includes("arithmetic"))).toBe(true);
});

// TestCosineSimilarity
test("cosine: identical counters", () => {
  const c = counter(["api", "api", "api", "math", "math"]);
  expect(cosine(c, c)).toBeGreaterThan(0.99);
});

test("cosine: disjoint counters", () => {
  const a = counter(["api", "math"]);
  const b = counter(["dog", "cat"]);
  expect(cosine(a, b)).toBe(0.0);
});

test("cosine: partial overlap", () => {
  const a = counter(["api", "api", "math", "test"]);
  const b = counter(["api", "math", "math", "math", "route"]);
  const sim = cosine(a, b);
  expect(sim).toBeGreaterThan(0.0);
  expect(sim).toBeLessThan(1.0);
});

test("cosine: empty counter", () => {
  expect(cosine(new Map(), counter(["a"]))).toBe(0.0);
});

// TestJaccardSimilarity
test("jaccard: identical sets", () => {
  const s = new Set(["a", "b", "c"]);
  expect(jaccard(s, s)).toBe(1.0);
});

test("jaccard: disjoint sets", () => {
  expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0.0);
});

test("jaccard: both empty", () => {
  expect(jaccard(new Set(), new Set())).toBe(1.0);
});

test("jaccard: one empty", () => {
  expect(jaccard(new Set(), new Set(["a"]))).toBe(0.0);
});

// TestHeuristicScorer
function makePair(
  refContent: string,
  candContent: string,
  path = "inception/reqs.md",
): DocumentPair {
  return {
    relativePath: path,
    phase: "inception",
    reference: { relativePath: path, phase: "inception", content: refContent },
    candidate: { relativePath: path, phase: "inception", content: candContent },
  };
}

test("heuristic_scorer: identical documents", () => {
  const content = "# Requirements\n## FR-001: Arithmetic\nThe API shall add numbers.\n";
  const score = heuristicScore(makePair(content, content));
  expect(score.intent_similarity).toBeGreaterThan(0.95);
  expect(score.design_similarity).toBeGreaterThan(0.95);
  expect(score.completeness).toBe(1.0);
  expect(score.overall).toBeGreaterThan(0.95);
});

test("heuristic_scorer: completely different documents", () => {
  const ref = "# Database Schema\n## Tables\nusers, products, orders\n";
  const cand = "# Network Protocol\n## Packets\nTCP, UDP, ICMP\n";
  const score = heuristicScore(makePair(ref, cand));
  expect(score.intent_similarity).toBeLessThan(0.3);
  expect(score.completeness).toBeLessThan(0.3);
});

test("heuristic_scorer: similar but not identical", () => {
  const ref =
    "# Requirements\n## FR-001: Arithmetic Operations\n" +
    "The API shall provide add, subtract, multiply, divide.\n" +
    "## FR-002: Trigonometry\nThe API shall provide sin, cos, tan.\n";
  const cand =
    "# Requirements\n## FR-001: Arithmetic Operations\n" +
    "The API provides addition, subtraction, multiplication, division.\n" +
    "## FR-002: Trigonometry\nThe API provides sine, cosine, tangent.\n";
  const score = heuristicScore(makePair(ref, cand));
  expect(score.intent_similarity).toBeGreaterThan(0.3);
  expect(score.completeness).toBe(1.0);
});

test("heuristic_scorer: missing sections reduces completeness", () => {
  const ref = "# Requirements\n## Section A\ncontent\n## Section B\ncontent\n## Section C\ncontent\n";
  const cand = "# Requirements\n## Section A\ncontent\n";
  const score = heuristicScore(makePair(ref, cand));
  expect(score.completeness).toBeLessThanOrEqual(0.5);
});

test("heuristic_scorer: scores in valid range", () => {
  const score = heuristicScore(makePair("# Doc\nSome content here.\n", "# Doc\nOther content here.\n"));
  for (const val of [
    score.intent_similarity,
    score.design_similarity,
    score.completeness,
    score.overall,
  ]) {
    expect(val).toBeGreaterThanOrEqual(0.0);
    expect(val).toBeLessThanOrEqual(1.0);
  }
});

test("heuristic_scorer: relative_path preserved (phase from pair, not path)", () => {
  const score = heuristicScore(makePair("content", "content", "construction/plans/plan.md"));
  expect(score.relative_path).toBe("construction/plans/plan.md");
  expect(score.phase).toBe("inception"); // phase comes from pair, not path
});

// ───────────────────────────────────────────────────────────────────────────
// test_comparator.py
// ───────────────────────────────────────────────────────────────────────────

// TestCompareRuns
test("compare_runs: identical runs", async () => {
  const content = {
    "inception/requirements/requirements.md":
      "# Requirements\n## FR-001: Arithmetic\nThe API shall add numbers.\n",
    "construction/plans/plan.md": "# Code Plan\n## Step 1: Setup\nCreate project structure.\n",
  };
  const ref = createAidlcDocs(join(tmp, "ref"), content);
  const cand = createAidlcDocs(join(tmp, "cand"), content);

  const result = await compareRuns(ref, cand, HEURISTIC);
  expect(result.overall_score).toBeGreaterThan(0.9);
  expect(result.phases.length).toBe(2);
  expect(result.unmatched_reference).toEqual([]);
  expect(result.unmatched_candidate).toEqual([]);
});

test("compare_runs: unmatched documents tracked", async () => {
  const refContent = {
    "inception/requirements/requirements.md": "# Reqs\nContent.\n",
    "inception/design/extra.md": "# Extra\nOnly in reference.\n",
  };
  const candContent = {
    "inception/requirements/requirements.md": "# Reqs\nContent.\n",
    "inception/design/new-doc.md": "# New\nOnly in candidate.\n",
  };
  const ref = createAidlcDocs(join(tmp, "ref"), refContent);
  const cand = createAidlcDocs(join(tmp, "cand"), candContent);

  const result = await compareRuns(ref, cand, HEURISTIC);
  expect(result.unmatched_reference).toContain("inception/design/extra.md");
  expect(result.unmatched_candidate).toContain("inception/design/new-doc.md");
});

test("compare_runs: empty candidate", async () => {
  const ref = createAidlcDocs(join(tmp, "ref"), { "inception/reqs.md": "# Reqs\nContent.\n" });
  const cand = join(tmp, "cand");
  mkdirSync(cand);

  const result = await compareRuns(ref, cand, HEURISTIC);
  expect(result.overall_score).toBe(0.0);
  expect(result.unmatched_reference.length).toBe(1);
});

// ⚠FAILS-against-spike-pre-fix: spike wrote NO YAML. Now compareRuns writes
// toDict() via atomicYamlDump (comparator.py:100-102).
test("compare_runs: yaml output", async () => {
  const content = { "inception/reqs.md": "# Requirements\nFR-001: Add numbers.\n" };
  const ref = createAidlcDocs(join(tmp, "ref"), content);
  const cand = createAidlcDocs(join(tmp, "cand"), content);
  const out = join(tmp, "results", "comparison.yaml");

  await compareRuns(ref, cand, HEURISTIC, out);

  expect(Bun.file(out).size).toBeGreaterThan(0); // out.exists()
  const data = Bun.YAML.parse(await Bun.file(out).text()) as Record<string, unknown>;
  expect("overall_score" in data).toBe(true);
  expect("phases" in data).toBe(true);
  const phases = data.phases as Array<Record<string, unknown>>;
  expect(phases.length).toBeGreaterThan(0);
  expect("documents" in phases[0]!).toBe(true);
});

// ⚠FAILS-against-spike-pre-fix: spike lacked to_dict + the relative_path→"path"
// rename (models.py:68-98,84).
test("compare_runs: to_dict structure", async () => {
  const content = {
    "inception/reqs.md": "# Requirements\nStuff.\n",
    "construction/plan.md": "# Plan\nSteps.\n",
  };
  const ref = createAidlcDocs(join(tmp, "ref"), content);
  const cand = createAidlcDocs(join(tmp, "cand"), content);

  const result = await compareRuns(ref, cand, HEURISTIC);
  const d = toDict(result);

  // isinstance(d["overall_score"], float) — PyFloat is our float marker.
  expect(d.overall_score).toBeInstanceOf(PyFloat);
  expect(typeof d.overall_score.valueOf()).toBe("number");
  expect(Array.isArray(d.phases)).toBe(true);
  for (const phaseData of d.phases) {
    expect("phase" in phaseData).toBe(true);
    expect("avg_intent" in phaseData).toBe(true);
    expect("avg_design" in phaseData).toBe(true);
    expect("avg_completeness" in phaseData).toBe(true);
    for (const docData of phaseData.documents) {
      expect("path" in docData).toBe(true);
      expect("intent_similarity" in docData).toBe(true);
      expect("design_similarity" in docData).toBe(true);
      expect("completeness" in docData).toBe(true);
    }
  }
});

test("compare_runs: phase ordering", async () => {
  const content = {
    "construction/plan.md": "# Plan\n",
    "inception/reqs.md": "# Reqs\n",
  };
  const ref = createAidlcDocs(join(tmp, "ref"), content);
  const cand = createAidlcDocs(join(tmp, "cand"), content);

  const result = await compareRuns(ref, cand, HEURISTIC);
  const phases = result.phases.map((ps) => ps.phase);
  expect(phases).toEqual(["inception", "construction"]);
});

// ───────────────────────────────────────────────────────────────────────────
// TestCompareRunsWithRealData — conditional skips (self-skip when fixture absent)
// test_comparator.py uses Path(__file__).resolve().parents[3] == evaluator/.
// ───────────────────────────────────────────────────────────────────────────
// The read-only Python evaluator worktree, resolved relative to the repo root
// (tests/harness/eval/ → 3 up → repo root → .claude/worktrees/v2-inspect/evaluator).
// .claude/worktrees/ is gitignored + machine-local, so these real-data tests
// self-skip when it is absent (CI / another checkout) — see the isDir guards below.
const EVALUATOR_ROOT = join(
  dirname(dirname(dirname(import.meta.dir))),
  ".claude/worktrees/v2-inspect/evaluator",
);
const GOLDEN_DOCS = join(EVALUATOR_ROOT, "test_cases", "sci-calc-v2", "golden-aidlc-docs");
const RUN1_DOCS = join(
  EVALUATOR_ROOT,
  "runs",
  "20260213T194046-9412bc326d7f4fd09990b9aafecbf026",
  "aidlc-docs",
);

function isDir(p: string): boolean {
  try {
    return require("node:fs").statSync(p).isDirectory();
  } catch {
    return false;
  }
}

test("compare_runs real-data: self comparison golden", async () => {
  if (!isDir(GOLDEN_DOCS)) return; // self-skip when golden dir absent
  const result = await compareRuns(GOLDEN_DOCS, GOLDEN_DOCS, HEURISTIC);
  expect(result.overall_score).toBeGreaterThan(0.95);
  expect(result.unmatched_reference).toEqual([]);
  expect(result.unmatched_candidate).toEqual([]);
  expect(result.phases.length).toBeGreaterThanOrEqual(2);
});

test("compare_runs real-data: cross-run comparison", async () => {
  if (!isDir(GOLDEN_DOCS) || !isDir(RUN1_DOCS)) return; // self-skip when dirs absent
  const result = await compareRuns(GOLDEN_DOCS, RUN1_DOCS, HEURISTIC);
  expect(result.overall_score).toBeGreaterThan(0.3);
  for (const ps of result.phases) {
    expect(ps.avg_intent).toBeGreaterThan(0.0);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// NOT-in-Python guard: ported STOPWORDS must equal the Python 55-word frozenset
// exactly (scorer.py:19-74). The spike encodes them as a space-split string
// (qualitative.ts STOPWORDS) — a single typo would silently shift every cosine
// score and no existing test would catch it.
// ───────────────────────────────────────────────────────────────────────────
test("STOPWORDS equals the Python frozenset exactly (scorer.py:19-74)", () => {
  // Transcribed verbatim, in source order, from scorer.py:20-73 — the Python
  // _STOPWORDS frozenset has 52 entries (the port-map's "55-word" label is
  // approximate; 52 is the authoritative frozenset length on disk).
  const PY_STOPWORDS = [
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "from", "is", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
    "this", "that", "these", "those", "it", "its", "not", "no", "as", "if", "then", "than",
    "so", "up", "out", "about",
  ];
  const pySet = new Set(PY_STOPWORDS);
  expect(PY_STOPWORDS.length).toBe(52); // exact frozenset length on disk
  expect(pySet.size).toBe(52); // no accidental dupes in transcription
  expect(STOPWORDS.size).toBe(52);
  for (const w of pySet) expect(STOPWORDS.has(w)).toBe(true);
  for (const w of STOPWORDS) expect(pySet.has(w)).toBe(true);
});
