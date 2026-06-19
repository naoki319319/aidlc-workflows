// qualitative.ts — Stage 5: doc-vs-golden semantic scoring.
//
// Ports qualitative/document.py (load + normalise + pair), scorer.py
// (LlmScorer + HeuristicScorer), models.py (overall weights + phase aggregation
// + ComparisonResult.to_dict), and comparator.py (compare_runs orchestration).
//
// Numeric fidelity: every Python round(...,4) is reproduced with pyRound (CPython
// round-half-to-even) — scorer.py:158-160 per-dimension, models.py:74,78-88
// to_dict. In-memory PhaseScore/QualitativeResult averages are kept UNROUNDED
// (models.py:40-47,61-66 compute_averages/compute_overall store raw means); the
// rounding lives only in toDict (models.py:68-98), which also renames each
// per-document relative_path → "path" (models.py:84) and wraps floats with
// pyFloat for PyYAML "1.0"-style rendering. compareRuns stores reference/candidate
// paths cwd-RELATIVE (comparator.py:81-89) and optionally writes toDict() YAML
// via atomicYamlDump after mkdir-parents (comparator.py:100-102).
//
// The LLM judge is the KNOWLEDGE→LLM third of the three-concerns split. It uses
// the first-party @anthropic-ai/sdk (already on disk) with structured outputs;
// to mirror the evaluator's Bedrock path exactly, swap the client for
// @anthropic-ai/bedrock-sdk (the messages.parse shape is identical). G2 (LLM
// pass-2 pairing, document.py:135-195,237-264) is left UNPORTED — faithful for
// the heuristic path because Python skips pass-2 when bedrock_client is None
// (document.py:238). LLM-only deviations (clamp01 vs Python-unclamped scores at
// scorer.py:282-284; dropped rubric prompt bullets at scorer.py:176-194) are
// documented and do NOT affect the deterministic heuristic path.

import { readdirSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { DocumentScore, PhaseScore, QualitativeResult } from "./types.ts";
import { pyRound } from "./pyutil.ts";
import { atomicYamlDump, pyFloat, type PyFloat } from "./yaml.ts";

// ── document.py constants ──────────────────────────────────────────────────
const SKIP_FILES = new Set([
  "aidlc-state.md",
  "audit.md",
  "intent-state.md",
  "intent-audit.md",
  "intent-prompt.md",
]);
const INTENT_PREFIX = /^intent-\d{3}-[^/]+\//;
const CONSTRUCTION_UNIT = /^(construction\/)[^/]+\/(.+)$/;

export interface AidlcDocument {
  relativePath: string;
  phase: string;
  content: string;
}

// document.py:_normalise_path
function normalisePath(p: string): string {
  return p.replace(INTENT_PREFIX, "").replace(CONSTRUCTION_UNIT, "$1_unit_/$2");
}

// document.py:classify_phase
export function classifyPhase(relativePath: string): string {
  const stripped = normalisePath(relativePath);
  const first = stripped.split("/")[0] ?? "";
  if (first === "inception") return "inception";
  if (first === "construction") return "construction";
  if (first === "bootstrap") return "bootstrap";
  return "other";
}

// document.py:load_documents — recursive *.md walk, skip state files + empties.
export function loadDocuments(docsPath: string): AidlcDocument[] {
  try {
    if (!statSync(docsPath).isDirectory()) return [];
  } catch {
    return [];
  }
  const docs: AidlcDocument[] = [];
  for (const file of walkMd(docsPath).sort(comparePathComponents)) {
    const rel = relative(docsPath, file).split("\\").join("/");
    const name = rel.split("/").pop() ?? "";
    if (SKIP_FILES.has(name)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    docs.push({ relativePath: rel, phase: classifyPhase(rel), content });
  }
  return docs;
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// document.py:92 — sorted(rglob("*.md")) sorts pathlib.Path objects, which
// compare COMPONENT-WISE (the "/" separator is not itself a compared char). A
// raw JS string .sort() compares "/" (0x2f) against "-"(0x2d)/"."(0x2e) and so
// orders e.g. "a-b.md" before "a/deep.md", whereas Python orders "a/deep.md"
// first ("a" < "a-b.md" as the first component). Compare component tuples to
// match. (Both sort full paths; the shared prefix is split identically.)
function comparePathComponents(a: string, b: string): number {
  const pa = a.split(/[/\\]/);
  const pb = b.split(/[/\\]/);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return pa.length - pb.length;
}

// ── document.py:pair_documents (exact-path pass only) ──────────────────────
// The Python adds an optional LLM-assisted second pass for unmatched docs; this
// port does the deterministic exact-path match (after normalisation). The LLM
// second pass is a documented TODO — see README.
export interface DocumentPair {
  relativePath: string;
  phase: string;
  reference: AidlcDocument;
  candidate: AidlcDocument;
}

export function pairDocuments(
  referenceDocs: AidlcDocument[],
  candidateDocs: AidlcDocument[],
): { paired: DocumentPair[]; unmatchedRef: string[]; unmatchedCand: string[] } {
  const refByStripped = new Map(referenceDocs.map((d) => [normalisePath(d.relativePath), d]));
  const candByStripped = new Map(candidateDocs.map((d) => [normalisePath(d.relativePath), d]));
  const paired: DocumentPair[] = [];
  const matched = new Set<string>();
  for (const [strippedPath, refDoc] of refByStripped) {
    const cand = candByStripped.get(strippedPath);
    if (cand) {
      paired.push({ relativePath: strippedPath, phase: refDoc.phase, reference: refDoc, candidate: cand });
      matched.add(strippedPath);
    }
  }
  const unmatchedRef = [...refByStripped.keys()].filter((p) => !matched.has(p)).sort();
  const unmatchedCand = [...candByStripped.keys()].filter((p) => !matched.has(p)).sort();
  return { paired, unmatchedRef, unmatchedCand };
}

// ── scorer.py:HeuristicScorer — deterministic, no network ──────────────────
// scorer.py:19-74 — 52-word _STOPWORDS frozenset, space-split here (a typo would
// silently shift every cosine score; guarded by a dedicated test).
export const STOPWORDS = new Set(
  "a an the and or but in on at to for of with by from is are was were be been being have has had do does did will would could should may might shall can this that these those it its not no as if then than so up out about".split(
    " ",
  ),
);

// scorer.py:88-91 — lowercase tokenize, drop stopwords + len<=1 tokens.
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]*/g) ?? []).filter(
    (w) => !STOPWORDS.has(w) && w.length > 1,
  );
}
// scorer.py:94-96 — markdown headings (any level), trimmed + lowercased.
export function extractHeadings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^#+\s+(.+)$/gm)) out.push(m[1].trim().toLowerCase());
  return out;
}
// scorer.py:99-104 — CamelCase + snake_case + path identifiers, lowercased.
export function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)) ids.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) ids.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b\w+(?:\/\w+)+(?:\.\w+)?\b/g)) ids.add(m[0].toLowerCase());
  return ids;
}
// collections.Counter analog — term-frequency map.
export function counter(tokens: string[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const t of tokens) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}
// scorer.py:107-116 — cosine similarity of two term-frequency counters.
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const [k, v] of a) if (b.has(k)) overlap += v * (b.get(k) as number);
  let magA = 0;
  for (const v of a.values()) magA += v * v;
  let magB = 0;
  for (const v of b.values()) magB += v * v;
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  return magA === 0 || magB === 0 ? 0 : overlap / (magA * magB);
}
// scorer.py:119-125 — Jaccard similarity (both-empty → 1.0, one-empty → 0.0).
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// models.py:22-26 — overall = intent*0.4 + design*0.4 + completeness*0.2
// pyRound (CPython round-half-to-even) everywhere Python uses round(...,4):
// scorer.py:158-160 (per-dim) and models.py:22-26/74,81,85-88 (overall + to_dict).
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function buildScore(
  pair: DocumentPair,
  intent: number,
  design: number,
  completeness: number,
  notes: string,
): DocumentScore {
  // scorer.py:155-161 constructs DocumentScore with each dimension rounded to
  // 4dp; DocumentScore.__post_init__ (models.py:20-26) THEN computes overall
  // from those already-rounded fields and stores it UNROUNDED (to_dict rounds
  // it later). Mirror that order exactly: round dims, derive overall from the
  // rounded dims, keep overall unrounded here.
  const i = pyRound(clamp01(intent), 4);
  const d = pyRound(clamp01(design), 4);
  const c = pyRound(clamp01(completeness), 4);
  return {
    relative_path: pair.relativePath,
    phase: pair.phase,
    intent_similarity: i,
    design_similarity: d,
    completeness: c,
    overall: i * 0.4 + d * 0.4 + c * 0.2,
    notes,
  };
}

export function heuristicScore(pair: DocumentPair): DocumentScore {
  const intent = cosine(counter(tokenize(pair.reference.content)), counter(tokenize(pair.candidate.content)));
  const refIds = extractIdentifiers(pair.reference.content);
  const candIds = extractIdentifiers(pair.candidate.content);
  const refHeadings = new Set(extractHeadings(pair.reference.content));
  const candHeadings = new Set(extractHeadings(pair.candidate.content));
  const design = 0.6 * jaccard(refIds, candIds) + 0.4 * jaccard(refHeadings, candHeadings);
  let completeness: number;
  if (refHeadings.size > 0) {
    let inter = 0;
    for (const h of refHeadings) if (candHeadings.has(h)) inter++;
    completeness = inter / refHeadings.size;
  } else {
    completeness = candHeadings.size === 0 ? 1 : 0;
  }
  return buildScore(pair, intent, design, completeness, "");
}

// ── scorer.py:LlmScorer — Bedrock in Python, first-party SDK here ──────────
const MAX_DOC_CHARS = 15_000;
const SCORE_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  additionalProperties: false,
  properties: {
    intent_similarity: { type: "number" },
    design_similarity: { type: "number" },
    completeness: { type: "number" },
    notes: { type: "string" },
  },
  required: ["intent_similarity", "design_similarity", "completeness", "notes"],
} as const);

function buildPrompt(pair: DocumentPair): string {
  // Verbatim from scorer.py:168-201 (minus the "respond with ONLY JSON" line —
  // structured outputs enforce shape).
  return `You are an expert evaluator comparing two AIDLC (AI-Driven Development Life Cycle) documents.

The REFERENCE document represents the golden baseline. The CANDIDATE document is from a new run.
Both documents were produced by the same AIDLC phase: ${pair.phase}.

Score the CANDIDATE against the REFERENCE on three dimensions (each 0.0 to 1.0):

1. **Intent Similarity**: Do both documents capture the same goals, requirements, and purpose?
2. **Design Similarity**: Are the architectural decisions, component structures, and technical approaches similar?
3. **Completeness**: Does the candidate cover the same topics and sections as the reference?

--- REFERENCE DOCUMENT (${pair.relativePath}) ---
${pair.reference.content.slice(0, MAX_DOC_CHARS)}

--- CANDIDATE DOCUMENT (${pair.relativePath}) ---
${pair.candidate.content.slice(0, MAX_DOC_CHARS)}`;
}

export interface Scorer {
  score(pair: DocumentPair): Promise<DocumentScore>;
}

// scorer.py:272-277 fence-strip + JSON.parse — used by the agent-SDK scorer,
// which (like the Python's Bedrock path) gets raw text, not structured output.
function parseScoreJson(raw: string): { intent: number; design: number; completeness: number; notes: string } {
  let body = raw.trim();
  if (body.startsWith("```")) body = body.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  const p = JSON.parse(body);
  return {
    intent: Number(p.intent_similarity),
    design: Number(p.design_similarity),
    completeness: Number(p.completeness),
    notes: p.notes ?? "",
  };
}

// Agent-SDK transport: uses the repo's claude CLI auth (same as sdk-drive.ts),
// no ANTHROPIC_API_KEY required. The closest analog to the Python's Bedrock
// converse path — asks for bare JSON and fence-strip-parses, with the same
// heuristic fallback on any error.
export class AgentSdkScorer implements Scorer {
  private model?: string;
  constructor(opts: { model?: string } = {}) {
    this.model = opts.model ?? process.env.JUDGE_MODEL;
  }
  async score(pair: DocumentPair): Promise<DocumentScore> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const prompt = `${buildPrompt(pair)}

Respond with ONLY a JSON object (no markdown fences):
{"intent_similarity": <float>, "design_similarity": <float>, "completeness": <float>, "notes": "<brief explanation>"}`;
      const run = query({
        prompt,
        options: { maxTurns: 1, ...(this.model ? { model: this.model } : {}) },
      });
      let text = "";
      for await (const m of run as AsyncIterable<any>) {
        if (m.type === "result" && typeof m.result === "string") text = m.result;
      }
      if (!text) throw new Error("no result text from agent SDK");
      const s = parseScoreJson(text);
      return buildScore(pair, s.intent, s.design, s.completeness, s.notes);
    } catch (err) {
      const h = heuristicScore(pair);
      h.notes = `[fallback: heuristic] ${h.notes}`.trim();
      if (process.env.JUDGE_DEBUG) console.error(`agent-SDK scoring failed for ${pair.relativePath}:`, err);
      return h;
    }
  }
}

export class HeuristicScorer implements Scorer {
  async score(pair: DocumentPair): Promise<DocumentScore> {
    return heuristicScore(pair);
  }
}

export class LlmScorer implements Scorer {
  private client: Anthropic;
  private model: string;
  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.JUDGE_MODEL ?? "claude-opus-4-8";
  }
  async score(pair: DocumentPair): Promise<DocumentScore> {
    try {
      const res = await this.client.messages.parse({
        model: this.model,
        max_tokens: 512,
        output_config: { format: SCORE_FORMAT },
        messages: [{ role: "user", content: buildPrompt(pair) }],
      });
      const p = res.parsed_output;
      if (!p) throw new Error("structured output returned null");
      return buildScore(pair, Number(p.intent_similarity), Number(p.design_similarity), Number(p.completeness), p.notes ?? "");
    } catch (err) {
      // scorer.py:244-255 — fall back to heuristic on any error.
      const h = heuristicScore(pair);
      h.notes = `[fallback: heuristic] ${h.notes}`.trim();
      if (process.env.JUDGE_DEBUG) console.error(`LLM scoring failed for ${pair.relativePath}:`, err);
      return h;
    }
  }
}

// ── comparator.py:compare_runs + models.py phase aggregation ───────────────
// models.py:40-47 compute_averages — raw arithmetic means, NOT rounded. The
// rounding lives only in to_dict (models.py:78-81), so keep avg_* unrounded in
// the in-memory PhaseScore (matches the Python dataclass).
function aggregatePhase(phase: string, documents: DocumentScore[]): PhaseScore {
  if (documents.length === 0) {
    // compute_averages early-returns on empty; PhaseScore defaults stay 0.0.
    return { phase, avg_intent: 0, avg_design: 0, avg_completeness: 0, avg_overall: 0, documents };
  }
  const n = documents.length;
  const sum = (sel: (d: DocumentScore) => number) => documents.reduce((acc, d) => acc + sel(d), 0);
  return {
    phase,
    avg_intent: sum((d) => d.intent_similarity) / n,
    avg_design: sum((d) => d.design_similarity) / n,
    avg_completeness: sum((d) => d.completeness) / n,
    avg_overall: sum((d) => d.overall) / n,
    documents,
  };
}

export async function compareRuns(
  referencePath: string,
  candidatePath: string,
  scorer: Scorer,
  outputPath?: string,
): Promise<QualitativeResult> {
  const refDocs = loadDocuments(referencePath);
  const candDocs = loadDocuments(candidatePath);
  const { paired, unmatchedRef, unmatchedCand } = pairDocuments(refDocs, candDocs);

  const byPhase = new Map<string, DocumentScore[]>();
  for (const pair of paired) {
    const score = await scorer.score(pair);
    if (!byPhase.has(pair.phase)) byPhase.set(pair.phase, []);
    byPhase.get(pair.phase)!.push(score);
  }

  // comparator.py:72-74 — known phases first, then any extras sorted.
  const knownOrder = ["inception", "construction", "other"];
  const ordered = [
    ...knownOrder.filter((p) => byPhase.has(p)),
    ...[...byPhase.keys()].filter((p) => !knownOrder.includes(p)).sort(),
  ];
  const phases = ordered.map((p) => aggregatePhase(p, byPhase.get(p)!));

  // models.py:61-66 compute_overall — mean of scored phases' avg_overall, raw
  // (unrounded); to_dict rounds it. Empty → overall_score stays 0.0.
  const scoredPhases = phases.filter((p) => p.documents.length > 0);
  const overall = scoredPhases.length
    ? scoredPhases.reduce((a, p) => a + p.avg_overall, 0) / scoredPhases.length
    : 0;

  // comparator.py:81-89 — store paths relative to cwd so YAML never leaks an
  // absolute path; fall back to the original on ValueError (not a subpath).
  const result: QualitativeResult = {
    reference_path: cwdRelative(referencePath),
    candidate_path: cwdRelative(candidatePath),
    overall_score: overall,
    phases,
    unmatched_reference: unmatchedRef,
    unmatched_candidate: unmatchedCand,
  };

  // comparator.py:100-102 — if output_path given, mkdir parents then write the
  // to_dict() payload via the atomic YAML dump.
  if (outputPath !== undefined) {
    mkdirSync(dirname(outputPath), { recursive: true });
    atomicYamlDump(toDict(result), outputPath);
  }

  return result;
}

// comparator.py:81-89 — Path.resolve().relative_to(Path.cwd().resolve()); on a
// ValueError (the path is not under cwd) Python keeps the ORIGINAL input path
// (NOT the resolved one). Mirror that: emit a forward-slash cwd-relative path
// when the resolved path is a subpath of cwd, else the original string.
function cwdRelative(p: string): string {
  const resolved = resolve(p);
  const cwd = resolve(process.cwd());
  // relative_to raises unless resolved is cwd or strictly below it.
  if (resolved === cwd) return ".";
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (resolved.startsWith(prefix)) {
    return resolved.slice(prefix.length).split("\\").join("/");
  }
  return p;
}

// ── models.py:68-98 ComparisonResult.to_dict ───────────────────────────────
// Re-runs compute_overall (already done in compareRuns; idempotent), rounds
// every numeric to 4dp via pyRound, and CRUCIALLY renames each per-document
// `relative_path`→`path` (models.py:84). Float fields are wrapped with pyFloat
// so the YAML emits a trailing ".0" on integral floats (1.0 not 1), matching
// PyYAML's float rendering — the Python scores are all floats.
export interface QualitativeResultDict {
  reference_path: string;
  candidate_path: string;
  overall_score: PyFloat;
  phases: Array<{
    phase: string;
    avg_intent: PyFloat;
    avg_design: PyFloat;
    avg_completeness: PyFloat;
    avg_overall: PyFloat;
    documents: Array<{
      path: string;
      intent_similarity: PyFloat;
      design_similarity: PyFloat;
      completeness: PyFloat;
      overall: PyFloat;
      notes: string;
    }>;
  }>;
  unmatched_reference: string[];
  unmatched_candidate: string[];
}

export function toDict(result: QualitativeResult): QualitativeResultDict {
  const f = (n: number) => pyFloat(pyRound(n, 4)) as PyFloat;
  return {
    reference_path: result.reference_path,
    candidate_path: result.candidate_path,
    overall_score: f(result.overall_score),
    phases: result.phases.map((ps) => ({
      phase: ps.phase,
      avg_intent: f(ps.avg_intent),
      avg_design: f(ps.avg_design),
      avg_completeness: f(ps.avg_completeness),
      avg_overall: f(ps.avg_overall),
      documents: ps.documents.map((ds) => ({
        path: ds.relative_path, // models.py:84 — relative_path → "path"
        intent_similarity: f(ds.intent_similarity),
        design_similarity: f(ds.design_similarity),
        completeness: f(ds.completeness),
        overall: f(ds.overall),
        notes: ds.notes,
      })),
    })),
    unmatched_reference: result.unmatched_reference,
    unmatched_candidate: result.unmatched_candidate,
  };
}
