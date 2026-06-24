#!/usr/bin/env bun
// scripts/package.ts — THE build entry for the one-core-N-harnesses layout.
//
//   bun scripts/package.ts            regenerate dist/{claude,kiro,codex}
//   bun scripts/package.ts --check     total drift guard (exit 1 on any drift)
//   bun scripts/package.ts <name>      regenerate just one harness
//   bun scripts/package.ts <name> --check
//
// PIPELINE PER HARNESS (per the engine design, generalized from the proven S4 prototype and
// the package-codex.ts engine):
//   1. COPY core/<src> → dist/<name>/<harnessDir>/<dst>, substituting
//      {{HARNESS_DIR}} → harnessDir in .md prose (the ONE transform class) and
//      applying the manifest's rules-dir rename.
//   2. COPY harness/<name>/<src> → dist/<name>/<harnessDir>/<dst> (authored
//      surfaces: orchestrator skill, CLAUDE.md/AGENTS.md, settings/config), same
//      token substitution on .md.
//   3. COMPILE the stage graph into the assembled tree (emits harness-correct
//      stage-graph.json + scope-grid.json — compiled data lives only in dist).
//   4. GENERATE runners into the assembled tree by composing aidlc-runner-gen's
//      exported render fns under AIDLC_HARNESS_DIR (the proven codex idiom, now
//      uniform for all three harnesses).
//   5. EMIT via harness/<name>/emit.ts if the manifest declares one (codex only
//      today: config.toml, hooks.json, trust-seed, agent TOMLs, .agents/skills).
//
// THE TRANSFORM CLASS (T5 — the only permitted text transform): the harness-dir
// token. core/ prose carries {{HARNESS_DIR}}; here it becomes `.claude`/`.kiro`/
// `.codex`. Truthful carve-outs in core (workspace-detection's 3-dir list, the
// `$CLAUDE_PROJECT_DIR on Claude Code` note) never carried the token, so they
// pass through untouched.
//
// --check is the freshness-diff idiom (aidlc-graph.ts compile --check): build
// each tree into a temp dir, diff byte-for-byte against the committed dist/,
// exit 1 with the offending paths on any drift. dist/ stays committed; this
// guard fails CI when someone hand-edits a dist or forgets to regenerate.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { DirMap, HarnessManifest } from "./manifest-types.ts";
import type { ExtensionManifest } from "./extension-types.ts";
import {
  parseContribution,
  validateContribution,
  type Contribution,
  type Fragment,
} from "./contribution-schema.ts";
import {
  coreArtifactsFrom,
  orderByDeps,
  validateExtensionSet,
  type CrossBundleContext,
} from "./extension-validate.ts";
import { emitStageFrontmatter, parseStageFrontmatter } from "../core/tools/aidlc-lib.ts";
import { renderOnboarding } from "./onboarding.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ROOT = join(REPO_ROOT, "core");
const HARNESS_ROOT = join(REPO_ROOT, "harness");
// Extensions (bundles) the packager projects as committed deltas. DISCOVERED,
// not hardcoded (mirrors harness discovery): adding a bundle is one
// extensions/<name>/ dir + extension.ts, zero edits here.
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
// Reserved bundle name — the framework core. An extension may not claim it.
const CORE_BUNDLE = "core";
// The shared onboarding-doc skeleton, rendered per harness (scripts/onboarding.ts).
const ONBOARDING_SKELETON = join(CORE_ROOT, "templates", "onboarding.md");
const HARNESS_TOKEN = /\{\{HARNESS_DIR\}\}/g;

// Harnesses the packager builds = every harness/<name>/ that carries a
// manifest.ts. DISCOVERED, not hardcoded: adding harness #N is one harness/<n>/
// dir + manifest row (+ optional emit.ts), with zero edits here — the
// one-core-many-harnesses promise. Sorted so the default build/--check order is
// stable (claude first by name).
function discoverHarnessNames(): string[] {
  if (!existsSync(HARNESS_ROOT)) return [];
  return readdirSync(HARNESS_ROOT)
    .filter((n) => existsSync(join(HARNESS_ROOT, n, "manifest.ts")))
    .sort();
}

// ---------------------------------------------------------------------------
// Transform: the ONE class. Token substitution on .md prose; .json + .ts copied
// verbatim (compiled JSON is regenerated per-tree by graph compile, never
// token-bearing in core; .ts uses the runtime harnessDir() seam).
// ---------------------------------------------------------------------------
function substituteToken(s: string, harnessDir: string): string {
  return s.replace(HARNESS_TOKEN, harnessDir);
}

// Rewrite in-prose `<harnessDir>/rules/` → `<harnessDir>/<rulesRename>/` for a
// harness that renames its rules dir (kiro: steering, codex: aidlc-rules).
// Anchored on the post-substitution harness-dir form so it can't touch an
// unrelated `rules/` mention — the proven STEERING_RENAME step from the spike
// packagers. No-op when rulesRename is null (claude).
function applyRulesRename(s: string, harnessDir: string, rulesRename: string | null): string {
  if (!rulesRename) return s;
  return s.replaceAll(`${harnessDir}/rules/`, `${harnessDir}/${rulesRename}/`);
}

function transform(
  srcPath: string,
  content: Buffer,
  harnessDir: string,
  rulesRename: string | null,
): Buffer {
  if (srcPath.endsWith(".md")) {
    let s = substituteToken(content.toString("utf-8"), harnessDir);
    s = applyRulesRename(s, harnessDir, rulesRename);
    return Buffer.from(s, "utf-8");
  }
  return content;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

// The two compiled-data files graph compile regenerates into every tree (never
// authored in core/). Both are fully derived from the YAML stage files — number
// and name are now authored frontmatter, so compile needs no seed from the prior
// JSON. This list survives only for the rules-dir path-rewrite backstop.
const COMPILED_DATA = ["tools/data/stage-graph.json", "tools/data/scope-grid.json"];

// The packager-emitted harness descriptor (vision T1 open-set seam): the
// runtime reads tools/data/harness.json to learn this harness's rules-subdir
// without a hardcoded map. Derived from the manifest, written into every tree.
const HARNESS_DATA = "tools/data/harness.json";

// Write tools/data/harness.json from manifest data. Today it carries just the
// rules-subdir (the one rename the runtime must know per-tree); the object shape
// leaves room for future per-harness runtime facts. Pretty-printed + trailing
// newline so the committed file is diff-friendly and stable under --check.
function writeHarnessData(treeRoot: string, m: HarnessManifest): void {
  const data = { harnessDir: m.harnessDir, rulesSubdir: m.rulesRename ?? "rules" };
  const dst = join(treeRoot, HARNESS_DATA);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Build one harness tree into `outRoot` (the dist/<name> dir). Returns the set
// of paths the copy+generate steps produced, for the orphan scan. Compile is
// deterministic from core/ sources (number + name are authored frontmatter), so
// no compiled-data seed is copied in beforehand.
// ---------------------------------------------------------------------------
// Copy core dirs (and, for a bundle-variant build, an extension's merged
// subtrees) into <treeRoot>/<dst> with the standard transform + rules rename.
// `extraDirs` lets a bundle merge its subtrees INTO the same core roots so the
// single-root loaders (stagesDir(), loadAgents(), ...) see them at compile time.
function copyCoreDirs(
  treeRoot: string,
  harnessDir: string,
  dirs: DirMap[],
  rulesRename: string | null,
  srcRoot: string,
): void {
  for (const { src, dst } of dirs) {
    const srcDir = join(srcRoot, src);
    if (!existsSync(srcDir)) continue;
    const finalDst = rulesRename && dst === "rules" ? rulesRename : dst;
    for (const file of walk(srcDir)) {
      const rel = relative(srcDir, file);
      const outPath = join(treeRoot, finalDst, rel);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename));
    }
  }
}

// --- §4 per-stage contribution merge ---

// Union a contribution's string-list `adds` into a parsed frontmatter array,
// deduping and appending new entries in sorted order (deterministic so the
// re-emitted .md + recompiled graph are byte-reproducible).
function unionList(base: unknown, add: string[]): string[] {
  const out: string[] = Array.isArray(base) ? base.map(String) : [];
  const have = new Set(out);
  for (const v of [...add].sort()) if (!have.has(v)) { out.push(v); have.add(v); }
  return out;
}

// Splice fragment prose into a stage body at a fragment anchor. Anchors:
//   after-step:<n>   → before the next "### "/"## " heading after Step n
//   before-step:<n>  → immediately before "### Step <n>"
//   after-questions  → after the questions-generating "### Step …" (heading
//                      mentions "Question"), i.e. before the next "###"/"##"
//   end-of-steps     → before the first "## " H2 that follows the "## Steps" block
//   in:<Compartment> → at the end of the "## <Compartment>" H2 block (e.g.
//                      in:Sensors, in:Learn) — before the next "## " or EOF
function spliceFragment(body: string, frag: Fragment): string {
  const lines = body.split("\n");
  const block = ["", frag.body, ""]; // blank-line padded
  const insertAt = (idx: number): string =>
    [...lines.slice(0, idx), ...block, ...lines.slice(idx)].join("\n");
  // First "## "/"### " heading at or after `from` (the block boundary / EOF).
  const nextHeadingAfter = (from: number, level3 = true): number => {
    for (let i = from; i < lines.length; i++) {
      if (/^##\s/.test(lines[i]) || (level3 && /^###\s/.test(lines[i]))) return i;
    }
    return lines.length;
  };

  const stepRe = (n: number) => new RegExp(`^###\\s+Step\\s+${n}\\b`);
  const m = frag.anchor.match(/^(after-step|before-step):(\d+)$/);
  if (m) {
    const n = parseInt(m[2], 10);
    const stepIdx = lines.findIndex((l) => stepRe(n).test(l.trim()));
    if (stepIdx === -1) throw new Error(`fragment anchor "${frag.anchor}": no "### Step ${n}" in target body`);
    if (m[1] === "before-step") return insertAt(stepIdx);
    return insertAt(nextHeadingAfter(stepIdx + 1));
  }
  if (frag.anchor === "after-questions") {
    // The questions-generating step is the "### Step …" whose heading mentions
    // "Question(s)" (e.g. "### Step 4: Generate Questions").
    const qIdx = lines.findIndex((l) => /^###\s.*Question/i.test(l.trim()));
    if (qIdx === -1) throw new Error(`fragment anchor "after-questions": no questions step ("### … Question…") in target body`);
    return insertAt(nextHeadingAfter(qIdx + 1));
  }
  if (frag.anchor === "end-of-steps") {
    const stepsIdx = lines.findIndex((l) => l.trim() === "## Steps");
    const from = stepsIdx === -1 ? 0 : stepsIdx + 1;
    return insertAt(nextHeadingAfter(from, false));
  }
  const inMatch = frag.anchor.match(/^in:(.+)$/);
  if (inMatch) {
    const compartment = inMatch[1].trim();
    const h2Idx = lines.findIndex((l) => l.trim() === `## ${compartment}`);
    if (h2Idx === -1) throw new Error(`fragment anchor "${frag.anchor}": no "## ${compartment}" compartment in target body`);
    // Append at the end of that compartment — before the next "## " H2 or EOF.
    return insertAt(nextHeadingAfter(h2Idx + 1, false));
  }
  throw new Error(`fragment anchor "${frag.anchor}" unsupported`);
}

// Merge all active bundles' contributions into the copied core stage .md files in
// the temp tree, BEFORE compile. No-op when `exts` is empty (the base build), so
// base trees stay byte-identical. For each target stage: union the structural
// `adds` into frontmatter, set required_sections, splice ordered fragments into
// the body, re-emit. Throws on an invalid contribution or a fragment conflict.
function mergeContributions(
  treeRoot: string,
  harnessDir: string,
  rulesRename: string | null,
  exts: ExtensionManifest[],
): void {
  if (exts.length === 0) return;
  const stagesRoot = join(treeRoot, "aidlc-common", "stages");
  if (!existsSync(stagesRoot)) return;

  // Known core stage slugs (for target validation) = stem of every copied stage .md.
  const coreSlugs = new Set<string>();
  for (const f of walk(stagesRoot)) if (f.endsWith(".md")) coreSlugs.add(basenameNoExt(f));

  // Collect contributions grouped by (phase/target → list).
  type Loaded = { c: Contribution; phase: string };
  const byTarget = new Map<string, Loaded[]>();
  for (const ext of exts) {
    const overlays = ext.contributes.overlays;
    if (!overlays) continue;
    const root = join(EXTENSIONS_ROOT, ext.name, overlays);
    if (!existsSync(root)) continue;
    for (const phase of readdirSync(root)) {
      const phaseDir = join(root, phase);
      if (!statSync(phaseDir).isDirectory()) continue;
      for (const f of readdirSync(phaseDir).filter((x) => x.endsWith(".md"))) {
        const raw = readFileSync(join(phaseDir, f), "utf-8");
        const c = parseContribution(raw);
        const errs = validateContribution(c, { coreSlugs, bundle: ext.name });
        if (errs.length > 0) {
          throw new Error(`contribution ${ext.name}/${overlays}${phase}/${f}: ${errs.join("; ")}`);
        }
        const list = byTarget.get(c.target) ?? [];
        list.push({ c, phase });
        byTarget.set(c.target, list);
      }
    }
  }
  if (byTarget.size === 0) return;

  for (const [target, loaded] of byTarget) {
    // Locate the copied core stage file (search phases under the temp tree).
    let stageFile: string | null = null;
    for (const phase of readdirSync(stagesRoot)) {
      const cand = join(stagesRoot, phase, `${target}.md`);
      if (existsSync(cand)) { stageFile = cand; break; }
    }
    if (!stageFile) throw new Error(`contribution target "${target}" not found in stages tree`);

    const raw = readFileSync(stageFile, "utf-8");
    const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    const parsed = parseStageFrontmatter(raw) as Record<string, unknown>;

    // Structural set-union across all contributions targeting this stage.
    let mergedBody = body;
    const fragments: Array<{ frag: Fragment; bundle: string }> = [];
    for (const { c } of loaded) {
      if (c.adds.produces.length) parsed.produces = unionList(parsed.produces, c.adds.produces);
      if (c.adds.sensors.length) parsed.sensors = unionList(parsed.sensors, c.adds.sensors);
      if (c.adds.requires_stage.length)
        parsed.requires_stage = unionList(parsed.requires_stage, c.adds.requires_stage);
      if (c.adds.required_sections.length)
        parsed.required_sections = unionList(parsed.required_sections, c.adds.required_sections);
      if (c.adds.consumes.length) {
        const existing = Array.isArray(parsed.consumes) ? (parsed.consumes as Array<{ artifact: string }>) : [];
        const have = new Set(existing.map((e) => e.artifact));
        for (const con of c.adds.consumes) if (!have.has(con.artifact)) { existing.push(con); have.add(con.artifact); }
        parsed.consumes = existing;
      }
      for (const frag of c.fragments) fragments.push({ frag, bundle: c.bundle });
    }

    // Deterministic fragment order: (order asc, bundle lexical, anchor).
    fragments.sort(
      (a, b) =>
        a.frag.order - b.frag.order ||
        a.bundle.localeCompare(b.bundle) ||
        a.frag.anchor.localeCompare(b.frag.anchor),
    );
    const seen = new Set<string>();
    for (const { frag, bundle } of fragments) {
      const key = `${frag.anchor}|${frag.order}|${bundle}`;
      if (seen.has(key)) throw new Error(`contribution conflict on ${target}: duplicate fragment ${key}`);
      seen.add(key);
      mergedBody = spliceFragment(mergedBody, frag);
    }

    // Re-emit: merged frontmatter + (token-transformed) merged body. The frontmatter
    // came from an already-transformed copied file, so re-emit as-is; the fragment
    // prose is transformed for {{HARNESS_DIR}} + rules-rename.
    const fm = emitStageFrontmatter(parsed);
    const transformedBody = transform(stageFile, Buffer.from(mergedBody, "utf-8"), harnessDir, rulesRename).toString("utf-8");
    writeFileSync(stageFile, `${fm}\n${transformedBody.replace(/^\n+/, "")}`);
  }
}

function basenameNoExt(p: string): string {
  const b = p.slice(p.lastIndexOf("/") + 1);
  return b.endsWith(".md") ? b.slice(0, -3) : b;
}

function buildTree(
  m: HarnessManifest,
  outRoot: string,
  extraDirs: DirMap[] = [],
  exts: ExtensionManifest[] = [],
): string[] {
  const harnessDir = m.harnessDir;
  const treeRoot = join(outRoot, harnessDir);

  // 1. Copy core dirs with token substitution + rules rename.
  copyCoreDirs(treeRoot, harnessDir, m.coreDirs, m.rulesRename, CORE_ROOT);
  // 1b. Bundle-variant build only: merge the extension's subtrees into the SAME
  //     roots (extraDirs already resolved to absolute-src / core-dst pairs).
  for (const { src, dst } of extraDirs) {
    if (!existsSync(src)) continue;
    const finalDst = m.rulesRename && dst === "rules" ? m.rulesRename : dst;
    for (const file of walk(src)) {
      const rel = relative(src, file);
      const outPath = join(treeRoot, finalDst, rel);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, m.rulesRename));
    }
  }
  // 1c. §4 contribution seam (bundle-variant build only — exts is [] for the base
  //     build, so this is a no-op and base trees stay byte-identical). Splice each
  //     bundle's contributions into the copied core stage files BEFORE compile, so
  //     the merged produces/consumes/sensors/required_sections + appended prose
  //     land in the compiled graph and the stage .md, hence in the committed delta.
  mergeContributions(treeRoot, harnessDir, m.rulesRename, exts);

  // 2. Copy authored harness surfaces (token substitution on .md). projectRoot
  //    files land beside the harness dir (e.g. dist/kiro/AGENTS.md), the rest
  //    inside <harnessDir>/.
  const harnessSrcRoot = join(HARNESS_ROOT, m.name);
  for (const { src, dst, projectRoot } of m.harnessFiles) {
    const srcPath = join(harnessSrcRoot, src);
    if (!existsSync(srcPath)) continue;
    const outPath = projectRoot ? join(outRoot, dst) : join(treeRoot, dst);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(srcPath, readFileSync(srcPath), harnessDir, m.rulesRename));
  }

  // 2b. Render the onboarding doc from the shared skeleton (scripts/onboarding.ts),
  //     then run it through the SAME transform as any core .md — so {{HARNESS_DIR}}
  //     and the rules-rename are applied identically. The skeleton is the single
  //     source for every harness's onboarding doc; codex renders its own (with a
  //     Codex-specific header) inside emit(), so its manifest leaves onboarding null.
  if (m.onboarding) {
    const { dst, projectRoot, fills } = m.onboarding;
    const rendered = renderOnboarding(readFileSync(ONBOARDING_SKELETON, "utf-8"), fills);
    const outPath = projectRoot ? join(outRoot, dst) : join(treeRoot, dst);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(dst, Buffer.from(rendered, "utf-8"), harnessDir, m.rulesRename));
  }

  // 3. Compile the stage graph into the assembled tree (writes harness-correct
  //    stage-graph.json + scope-grid.json). number + name are authored in each
  //    stage's frontmatter, so compile derives the whole file from the YAML with
  //    no seed — it just needs the assembled tree (the copied stages + rules).
  // For a renamed-rules harness, point loadRules at the renamed dir via
  // AIDLC_RULES_DIR so rules_in_context is populated (the rules ship under
  // steering/ | aidlc-rules/, not rules/). Since the rulesSubdir() seam landed,
  // compile (run under AIDLC_HARNESS_DIR) already EMITS the renamed segment in
  // the display path, so renameRulesInCompiledData is now a guarded no-op kept
  // as a defense-in-depth backstop (it rewrites only if a literal "<dir>/rules/"
  // ever reappears — e.g. a future code path that bypasses the seam).
  runTool(treeRoot, ["tools/aidlc-graph.ts", "compile"], m.rulesRename);
  if (m.rulesRename) renameRulesInCompiledData(treeRoot, harnessDir, m.rulesRename);

  // 3b. Emit tools/data/harness.json — the runtime's open-set source of truth
  //     for the rules-subdir rename. rulesSubdir() (aidlc-lib.ts) reads it so a
  //     real install of a rename-rules harness resolves its rule dir with ZERO
  //     core edits (the rename is manifest data, not a hardcoded map). Derived
  //     purely from the manifest, so unseeded; written into the same tools/data/
  //     the compile step just created, hence walked + byte-diffed by --check
  //     like any other generated file.
  writeHarnessData(treeRoot, m);

  // 4. Generate runners by composing aidlc-runner-gen's CLIs against the
  //    assembled tree (write + scopes). AIDLC_HARNESS_DIR steers harnessDir()
  //    so generated prose names the correct dir; AIDLC_SRC roots the tree.
  //    Codex skips this — it ships no <harnessDir>/skills/; emit() composes the
  //    whole skill set into .agents/skills/ instead.
  if (!m.skipRunnerGen) {
    runTool(treeRoot, ["tools/aidlc-runner-gen.ts", "write"]);
    runTool(treeRoot, ["tools/aidlc-runner-gen.ts", "scopes"]);
  }

  // 5. Per-shell emissions (codex only today). Returns the absolute paths it
  //    wrote, so the caller can byte-diff emit-owned files that live OUTSIDE
  //    <harnessDir> (e.g. .agents/skills/, the root AGENTS.md) under --check.
  if (m.emit) {
    return m.emit({
      repoRoot: REPO_ROOT,
      coreRoot: CORE_ROOT,
      harnessRoot: harnessSrcRoot,
      distRoot: outRoot,
      harnessDir,
      substituteToken: (s: string) => substituteToken(s, harnessDir),
      check: false,
    }).written;
  }
  return [];
}

// Run an in-tree tool (bun <treeRoot>/<rel> ...) with the harness env seams set
// so the tool resolves the assembled tree and interpolates the right harness dir.
// When the harness renames its rules dir, AIDLC_RULES_DIR points loadRules at
// the renamed location so it actually finds the rule files at compile time.
function runTool(treeRoot: string, args: string[], rulesRename?: string | null): void {
  const toolPath = join(treeRoot, args[0]);
  const rest = args.slice(1);
  const harnessDir = treeRoot.endsWith(".kiro")
    ? ".kiro"
    : treeRoot.endsWith(".codex")
      ? ".codex"
      : ".claude";
  const env: Record<string, string> = {
    ...process.env,
    AIDLC_SRC: treeRoot,
    AIDLC_HARNESS_DIR: harnessDir,
  };
  if (rulesRename) env.AIDLC_RULES_DIR = join(treeRoot, rulesRename);
  const res = spawnSync("bun", [toolPath, ...rest], {
    cwd: treeRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    console.error(`packager: \`bun ${args.join(" ")}\` failed in ${treeRoot}`);
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(1);
  }
}

// Defense-in-depth backstop: rewrite any residual "<harnessDir>/rules/" →
// "<harnessDir>/<rulesRename>/" in the compiled JSON path strings. Since the
// rulesSubdir() seam landed, compile (run under AIDLC_HARNESS_DIR) emits the
// renamed segment directly, so this normally matches nothing (guarded by the
// `out !== s` check). It stays as a safety net in case a future code path emits
// a literal "rules" segment that bypasses the seam. Slash-anchored, so it can
// only touch the rules path family.
function renameRulesInCompiledData(treeRoot: string, harnessDir: string, rulesRename: string): void {
  for (const rel of COMPILED_DATA) {
    const p = join(treeRoot, rel);
    if (!existsSync(p)) continue;
    const s = readFileSync(p, "utf-8");
    const out = s.replaceAll(`${harnessDir}/rules/`, `${harnessDir}/${rulesRename}/`);
    if (out !== s) writeFileSync(p, out);
  }
}

function loadManifest(name: string): HarnessManifest {
  const mod = require(join(HARNESS_ROOT, name, "manifest.ts")) as { default: HarnessManifest };
  return mod.default;
}

// ---------------------------------------------------------------------------
// Extensions (bundles): discovery, load, and the build-time delta.
// ---------------------------------------------------------------------------

// Extension contributes-key → the core dst dir it merges into. Mirrors the
// coreDirs dst names so merged files land where the single-root loaders read.
const CONTRIBUTES_DST: Record<string, string> = {
  stages: "aidlc-common/stages",
  agents: "agents",
  scopes: "scopes",
  rules: "rules",
  sensors: "sensors",
  knowledge: "knowledge",
};

function discoverExtensions(): string[] {
  if (!existsSync(EXTENSIONS_ROOT)) return [];
  return readdirSync(EXTENSIONS_ROOT)
    .filter((n) => existsSync(join(EXTENSIONS_ROOT, n, "extension.ts")))
    .sort();
}

function loadExtension(name: string): ExtensionManifest {
  const mod = require(join(EXTENSIONS_ROOT, name, "extension.ts")) as {
    default: ExtensionManifest;
  };
  const ext = mod.default;
  if (ext.name !== name) {
    throw new Error(`extension "${name}": manifest name "${ext.name}" must match dir name`);
  }
  if (ext.name === CORE_BUNDLE) {
    throw new Error(`extension may not claim the reserved bundle name "${CORE_BUNDLE}"`);
  }
  return ext;
}

// Resolve an extension's contributes map to absolute-src / core-dst DirMap pairs
// for buildTree's extraDirs merge.
function extensionDirs(ext: ExtensionManifest): DirMap[] {
  const out: DirMap[] = [];
  for (const [key, rel] of Object.entries(ext.contributes)) {
    if (!rel) continue;
    // overlays is NOT a copy-merge subtree — it is the §4 contribution dir,
    // consumed by mergeContributions (not copied into a core dst). Skip it here.
    if (key === "overlays") continue;
    const dst = CONTRIBUTES_DST[key];
    if (!dst) throw new Error(`extension "${ext.name}": unknown contributes key "${key}"`);
    out.push({ src: join(EXTENSIONS_ROOT, ext.name, rel), dst });
  }
  return out;
}

// A bundle delta: install-root-relative path → bytes. Paths are relative to
// dist/<name>/ (e.g. ".claude/aidlc-common/stages/operation/ops-min-deploy.md"),
// committed under dist/<name>/extensions/<bundle>/.
type Delta = Map<string, Buffer>;

// Recursively read every file under root into a rel→bytes map.
function readTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(root)) return out;
  for (const f of walk(root)) out.set(relative(root, f), readFileSync(f));
  return out;
}

// Build the committed delta for one (harness, extension) pair: the files a
// base+bundle build produces that are NEW or DIFFER vs the base build. The merge
// happens in a temp tree so the single-root loaders see the extension at compile;
// only the diff is kept. baseFiles is the prebuilt base (built once, reused).
function buildBundleDelta(
  m: HarnessManifest,
  ext: ExtensionManifest,
  baseFiles: Map<string, Buffer>,
): Delta {
  const mergedTmp = mkdtempSync(join(tmpdir(), `aidlc-bundle-${m.name}-${ext.name}-`));
  try {
    const emitWritten = buildTree(m, mergedTmp, extensionDirs(ext), [ext]);
    // Validate the merged compiled graph: every bundle-owned stage must number
    // inside a claimed range and prefix its produced artifacts with "<bundle>-".
    validateBundleGraph(mergedTmp, m.harnessDir, ext);

    const delta: Delta = new Map();
    // In-harness files: diff merged <harnessDir>/ vs base.
    const mergedRoot = join(mergedTmp, m.harnessDir);
    for (const f of walk(mergedRoot)) {
      const rel = join(m.harnessDir, relative(mergedRoot, f));
      const bytes = readFileSync(f);
      const base = baseFiles.get(rel);
      if (!base || !base.equals(bytes)) delta.set(rel, bytes);
    }
    // Out-of-harness emit files (codex .agents/skills/, etc.): diff vs base.
    for (const abs of emitWritten) {
      if (abs.startsWith(join(mergedTmp, m.harnessDir) + "/")) continue; // already covered
      const rel = relative(mergedTmp, abs);
      const bytes = readFileSync(abs);
      const base = baseFiles.get(rel);
      if (!base || !base.equals(bytes)) delta.set(rel, bytes);
    }
    return delta;
  } finally {
    rmSync(mergedTmp, { recursive: true, force: true });
  }
}

// Validate a built bundle variant's compiled stage graph: bundle-owned stages
// number inside a claimed range and namespace their produced artifacts with the
// "<bundle>-" prefix. Reads the merged stage-graph.json (which carries the
// authored `bundle` and `number` per Layers 0/1).
function validateBundleGraph(mergedTmp: string, harnessDir: string, ext: ExtensionManifest): void {
  const graphPath = join(mergedTmp, harnessDir, "tools/data/stage-graph.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{
    slug: string;
    number: string;
    phase: string;
    bundle?: string;
    produces?: string[];
  }>;
  for (const s of graph) {
    if (s.bundle !== ext.name) continue;
    const ranges = ext.numberRanges[s.phase] ?? [];
    const n = parseFloat(s.number);
    const inRange = ranges.some(([lo, hi]) => n >= parseFloat(lo) && n <= parseFloat(hi));
    if (!inRange) {
      throw new Error(
        `extension "${ext.name}" stage "${s.slug}" number ${s.number} (phase ${s.phase}) ` +
          `is outside its claimed range(s) ${JSON.stringify(ranges)}`,
      );
    }
    for (const art of s.produces ?? []) {
      if (!art.startsWith(`${ext.name}-`)) {
        throw new Error(
          `extension "${ext.name}" stage "${s.slug}" produces "${art}" — bundle artifacts ` +
            `must be prefixed "${ext.name}-"`,
        );
      }
    }
  }
}

// Discover + load + validate every extension once; reused by write and check.
// Runs the cross-bundle (multi-tenant) validation — semver deps, range overlaps,
// artifact-namespace collisions, dependency cycles — and returns the extensions
// in dependency order so a bundle's contributions apply after its dependencies'.
function loadExtensions(): ExtensionManifest[] {
  const exts = discoverExtensions().map(loadExtension);
  const ctx: CrossBundleContext = {
    extensionsRoot: EXTENSIONS_ROOT,
    coreArtifacts: coreArtifactsFrom(join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json")),
  };
  const errors = validateExtensionSet(exts, ctx);
  if (errors.length > 0) {
    throw new Error(`extension validation failed:\n  ${errors.join("\n  ")}`);
  }
  return orderByDeps(exts);
}

// ---------------------------------------------------------------------------
// write mode: regenerate dist/<name> in place (clean-sweep).
// ---------------------------------------------------------------------------
function writeHarness(name: string, exts: ExtensionManifest[]): void {
  const m = loadManifest(name);
  const distDir = join(REPO_ROOT, "dist", name);
  const treeRoot = join(distDir, m.harnessDir);
  const extDir = join(distDir, "extensions");
  // Clean sweep the harness dir AND the committed extension deltas so removed
  // core/bundle files don't linger. Compile is seedless (number + name are
  // authored frontmatter), so nothing needs to survive the sweep.
  if (existsSync(treeRoot)) rmSync(treeRoot, { recursive: true, force: true });
  if (existsSync(extDir)) rmSync(extDir, { recursive: true, force: true });
  buildTree(m, distDir);
  console.log(`[${name}] regenerated dist/${name}/${m.harnessDir}`);

  // Project each bundle as a committed delta under dist/<name>/extensions/<bundle>/.
  // The delta keys are install-root-relative (.claude/..., .agents/...), so a user
  // overlays the bundle dir onto their install root.
  if (exts.length > 0) {
    const baseFiles = readTree(distDir); // base just written (harness dir only; no extensions/ yet)
    for (const ext of exts) {
      const delta = buildBundleDelta(m, ext, baseFiles);
      const bundleRoot = join(extDir, ext.name);
      for (const [rel, bytes] of delta) {
        const out = join(bundleRoot, rel);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, bytes);
      }
      console.log(`[${name}] bundle "${ext.name}": ${delta.size} delta file(s)`);
    }
  }
}

// ---------------------------------------------------------------------------
// check mode: build into a temp dir, diff byte-for-byte vs committed dist/<name>.
// ---------------------------------------------------------------------------
function checkHarness(name: string, exts: ExtensionManifest[]): string[] {
  const m = loadManifest(name);
  const committed = join(REPO_ROOT, "dist", name, m.harnessDir);
  const tmp = mkdtempSync(join(tmpdir(), `aidlc-pkg-${name}-`));
  const problems: string[] = [];
  try {
    // Build into a temp dir (seedless compile; committed tree is only the diff
    // target, never read as a seed).
    const emitWritten = buildTree(m, tmp);
    const builtRoot = join(tmp, m.harnessDir);
    // Built → committed: MISSING / DIFFERS.
    const builtFiles = new Set<string>();
    for (const f of walk(builtRoot)) {
      const rel = relative(builtRoot, f);
      builtFiles.add(rel);
      const want = readFileSync(f);
      const committedPath = join(committed, rel);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${m.harnessDir}/${rel}`);
      else if (!readFileSync(committedPath).equals(want))
        problems.push(`DIFFERS: ${name}/${m.harnessDir}/${rel}`);
    }
    // Committed → built: ORPHAN (a committed file the build didn't produce).
    if (existsSync(committed)) {
      for (const f of walk(committed)) {
        const rel = relative(committed, f);
        if (builtFiles.has(rel)) continue;
        if (m.authoredExempt.some((re) => re.test(rel))) continue;
        problems.push(`ORPHAN in dist: ${name}/${m.harnessDir}/${rel}`);
      }
    }
    // Project-root harness files (e.g. dist/<name>/AGENTS.md) live OUTSIDE the
    // harness dir — diff each explicitly (built into tmp/<dst> vs dist/<name>/<dst>).
    const committedDistRoot = join(REPO_ROOT, "dist", name);
    for (const { dst, projectRoot } of m.harnessFiles) {
      if (!projectRoot) continue;
      const built = readFileSync(join(tmp, dst));
      const committedPath = join(committedDistRoot, dst);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${dst}`);
      else if (!readFileSync(committedPath).equals(built)) problems.push(`DIFFERS: ${name}/${dst}`);
    }
    // Emit-owned files OUTSIDE <harnessDir> (codex: .agents/skills/, root
    // AGENTS.md). buildTree returns their tmp paths; diff each against committed.
    const emitOutsideHarness = emitWritten.filter((p) => !p.startsWith(join(tmp, m.harnessDir) + "/"));
    const committedEmitSet = new Set<string>();
    for (const builtPath of emitOutsideHarness) {
      const rel = relative(tmp, builtPath);
      committedEmitSet.add(rel);
      const committedPath = join(committedDistRoot, rel);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${rel}`);
      else if (!readFileSync(committedPath).equals(readFileSync(builtPath)))
        problems.push(`DIFFERS: ${name}/${rel}`);
    }
    // Orphan scan over emit-owned out-of-harness dirs (e.g. dist/<name>/.agents/).
    for (const sub of [".agents"]) {
      const dir = join(committedDistRoot, sub);
      if (!existsSync(dir)) continue;
      for (const f of walk(dir)) {
        const rel = relative(committedDistRoot, f);
        if (!committedEmitSet.has(rel)) problems.push(`ORPHAN in dist: ${name}/${rel}`);
      }
    }
    // Bundle deltas live at dist/<name>/extensions/<bundle>/ — a sibling of the
    // harness dir and .agents/, so the base scans above never touch them. Rebuild
    // each delta and byte-compare it against the committed bundle dir (MISSING /
    // DIFFERS / ORPHAN), giving true byte-pinning of every committed delta file.
    if (exts.length > 0) {
      const baseFiles = readTree(committed); // committed base = the reference for the diff
      // Re-key base files to install-root-relative (<harnessDir>/...) to match delta keys.
      const baseByInstallRel = new Map<string, Buffer>();
      for (const [rel, bytes] of baseFiles) baseByInstallRel.set(join(m.harnessDir, rel), bytes);
      // Out-of-harness committed emit files (e.g. .agents/...) are also valid base.
      for (const rel of committedEmitSet) {
        const p = join(committedDistRoot, rel);
        if (existsSync(p)) baseByInstallRel.set(rel, readFileSync(p));
      }
      for (const ext of exts) {
        const delta = buildBundleDelta(m, ext, baseByInstallRel);
        const bundleRoot = join(committedDistRoot, "extensions", ext.name);
        for (const [rel, bytes] of delta) {
          const cp = join(bundleRoot, rel);
          if (!existsSync(cp)) problems.push(`MISSING in dist: ${name}/extensions/${ext.name}/${rel}`);
          else if (!readFileSync(cp).equals(bytes))
            problems.push(`DIFFERS: ${name}/extensions/${ext.name}/${rel}`);
        }
        // Committed → rebuilt: ORPHAN.
        if (existsSync(bundleRoot)) {
          for (const f of walk(bundleRoot)) {
            const rel = relative(bundleRoot, f);
            if (!delta.has(rel)) problems.push(`ORPHAN in dist: ${name}/extensions/${ext.name}/${rel}`);
          }
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`[${name}] --check: ${problems.length === 0 ? "OK" : `${problems.length} problem(s)`}`);
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);

// `package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]` —
// print the codex hook-trust entries with <PROJECT_DIR> substituted, for the
// installer to paste into $CODEX_HOME/config.toml (the trust-seed.toml recipe).
if (argv[0] === "codex" && argv[1] === "trust") {
  const pIdx = argv.indexOf("--project");
  if (pIdx === -1 || !argv[pIdx + 1]) {
    console.error("usage: package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]");
    process.exit(1);
  }
  const hIdx = argv.indexOf("--hooks-json");
  const { trustEntries } = require(join(HARNESS_ROOT, "codex", "emit.ts")) as {
    trustEntries: (project: string, hooksJson?: string) => string;
  };
  console.log(trustEntries(argv[pIdx + 1], hIdx !== -1 ? argv[hIdx + 1] : undefined));
  process.exit(0);
}

// `package.ts --validate-ext [<name>]` — STANDALONE extension author check.
// Validates one bundle (or all discovered) WITHOUT a harness build: manifest
// load, cross-bundle set checks (deps/semver/ranges/artifact collisions), and
// each contribution file (target resolves, anchors, namespacing). Fast iteration
// loop for authors; exits 1 with a clear per-error list on any problem.
if (argv.includes("--validate-ext")) {
  const i = argv.indexOf("--validate-ext");
  const only = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  const allNames = discoverExtensions();
  if (allNames.length === 0) {
    console.log("validate-ext: no extensions/ bundles discovered.");
    process.exit(0);
  }
  const errors: string[] = [];
  let exts;
  try {
    exts = allNames.map(loadExtension); // dir/name match + reserved-name guards
  } catch (e) {
    console.error(`validate-ext: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // Core stage slugs (target validation) + core artifacts (collision check) from
  // the committed base graph.
  const baseGraphPath = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json");
  const coreSlugs = new Set<string>();
  if (existsSync(baseGraphPath)) {
    for (const s of JSON.parse(readFileSync(baseGraphPath, "utf-8")) as Array<{ slug: string; bundle?: string }>) {
      if (!s.bundle || s.bundle === CORE_BUNDLE) coreSlugs.add(s.slug);
    }
  }
  // Cross-bundle set checks (always run over the full set so collisions surface).
  errors.push(
    ...validateExtensionSet(exts, {
      extensionsRoot: EXTENSIONS_ROOT,
      coreArtifacts: coreArtifactsFrom(baseGraphPath),
    }),
  );
  // Per-contribution checks for the targeted bundle(s).
  for (const ext of exts) {
    if (only && ext.name !== only) continue;
    const overlays = ext.contributes.overlays;
    if (!overlays) continue;
    const root = join(EXTENSIONS_ROOT, ext.name, overlays);
    if (!existsSync(root)) continue;
    for (const phase of readdirSync(root)) {
      const phaseDir = join(root, phase);
      if (!statSync(phaseDir).isDirectory()) continue;
      for (const f of readdirSync(phaseDir).filter((x) => x.endsWith(".md"))) {
        const rel = `${ext.name}/${overlays}${phase}/${f}`;
        try {
          const c = parseContribution(readFileSync(join(phaseDir, f), "utf-8"));
          for (const e of validateContribution(c, { coreSlugs, bundle: ext.name })) {
            errors.push(`${rel}: ${e}`);
          }
        } catch (e) {
          errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  const scope = only ? `extension "${only}"` : `${exts.length} extension(s)`;
  if (errors.length > 0) {
    console.error(`validate-ext: ${scope} — ${errors.length} problem(s):`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(`validate-ext: ${scope} OK.`);
  process.exit(0);
}

const check = argv.includes("--check");
// --no-extensions: build/check the base only (escape hatch for base-parity
// debugging). Does NOT touch committed dist/<name>/extensions/.
const withExtensions = !argv.includes("--no-extensions");
const named = argv.find((a) => !a.startsWith("--"));
// Default targets are DISCOVERED from harness/ (one manifest = one harness); a
// named target builds just that one.
const targets = named ? [named] : discoverHarnessNames();

// Discover + validate bundles once (deps + cross-bundle range overlaps). Empty
// when extensions/ is absent or --no-extensions is set.
const extensions = withExtensions ? loadExtensions() : [];

// Only build harnesses that actually have a manifest. Discovery already
// guarantees this, so the filter only matters for an explicit named target that
// lacks a manifest — surface that as a skip rather than a crash.
const present = targets.filter((n) => existsSync(join(HARNESS_ROOT, n, "manifest.ts")));
const absent = targets.filter((n) => !present.includes(n));
if (absent.length > 0) console.log(`(skipping harness(es) without a manifest: ${absent.join(", ")})`);

if (check) {
  let problems: string[] = [];
  for (const n of present) problems = problems.concat(checkHarness(n, extensions));
  if (problems.length > 0) {
    console.error(`\npackage --check FAILED (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error("  " + p);
    process.exit(1);
  }
  console.log("package --check: all harness trees in sync with core/ + harness/.");
} else {
  for (const n of present) writeHarness(n, extensions);
}
