// shared-scenario.ts — Scenario discovery and loading for the AIDLC evaluator.
//
// FAITHFUL port of:
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/src/shared/scenario.py
//
// Each test-case directory (e.g. test_cases/sci-calc-v2/) holds a `scenario.yaml`
// manifest describing the scenario's inputs and golden-baseline artifacts. This
// module loads, lists, and resolves scenarios by name or path.
//
// Parity notes (cite scenario.py):
//   - The Scenario field defaults (vision/tech_env/openapi/golden_baseline/
//     golden_aidlc_docs) DOUBLE as overridable manifest keys (:30-34, :96-100);
//     a manifest may remap any of them. The 5 *_path resolvers join the (already
//     `.resolve()`d) scenario directory with the (possibly remapped) filename
//     (:39-57, :95).
//   - list_scenarios sorts by DIRECTORY name, not Scenario.name, despite the
//     docstring claiming "sorted by name" (:123 docstring vs :129 sorted iterdir).
//   - resolve_scenario does a TWO-STAGE lookup (direct dir, then by-name under
//     test_cases_dir) and emits the draft warning in BOTH branches (:170-200).
//   - load_scenario HARD-fails (throws) only for a missing scenario.yaml file
//     (FileNotFoundError, :81-82) and a missing/empty `name` key (ValueError,
//     :87-89). A missing vision file or missing golden-aidlc-docs dir is WARN-only
//     (logger.warning → console.warn, :106-114).
//
// YAML is read via Bun.YAML.parse (a faithful YAML 1.x parser) — matching the
// shared substrate's read path. `yaml.safe_load(f) or {}` (:85) maps to
// `parse(...) ?? {}` plus a falsy-guard for an empty document.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── exceptions ──────────────────────────────────────────────────────────────
// Python raises the builtins FileNotFoundError (:82, :195) and ValueError (:89).
// JS has no FileNotFoundError; we subclass Error and tag a `code` so callers can
// discriminate the same way (`err instanceof ScenarioFileNotFoundError`).
export class ScenarioFileNotFoundError extends Error {
  override readonly name = "ScenarioFileNotFoundError";
  constructor(message: string) {
    super(message);
  }
}

export class ScenarioValueError extends Error {
  override readonly name = "ScenarioValueError";
  constructor(message: string) {
    super(message);
  }
}

// ── Scenario model ────────────────────────────────────────────────────────────
// Parsed representation of a scenario.yaml manifest (scenario.py:20-57).
//
// `path` is the resolved (absolute) scenario directory. The five filename fields
// default to the conventional names but are overridable from the manifest; the
// *_path getters resolve them against `path`.
export class Scenario {
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly path: string;

  // Relative file names within the scenario directory (overridable manifest keys).
  readonly vision: string;
  readonly tech_env: string;
  readonly openapi: string;
  readonly golden_baseline: string;
  readonly golden_aidlc_docs: string;

  readonly tags: string[];

  constructor(opts: {
    name: string;
    description?: string;
    status?: string;
    path?: string;
    vision?: string;
    tech_env?: string;
    openapi?: string;
    golden_baseline?: string;
    golden_aidlc_docs?: string;
    tags?: string[];
  }) {
    // Dataclass defaults — scenario.py:24-36.
    this.name = opts.name;
    this.description = opts.description ?? "";
    this.status = opts.status ?? "active";
    this.path = opts.path ?? ".";
    this.vision = opts.vision ?? "vision.md";
    this.tech_env = opts.tech_env ?? "tech-env.md";
    this.openapi = opts.openapi ?? "openapi.yaml";
    this.golden_baseline = opts.golden_baseline ?? "golden.yaml";
    this.golden_aidlc_docs = opts.golden_aidlc_docs ?? "golden-aidlc-docs/";
    this.tags = opts.tags ?? [];
  }

  // Resolved absolute paths — scenario.py:39-57. `path / self.<field>`.
  // Uses pyJoin (NOT node:path join) because Python's `str(Path(p) / name)`
  // DROPS a trailing slash: `Path(".../sci-calc-v2") / "golden-aidlc-docs/"`
  // yields `.../golden-aidlc-docs` (no trailing /), while node join would keep
  // it. The default golden_aidlc_docs is "golden-aidlc-docs/" with a trailing
  // slash, so this divergence is load-bearing for the resolved-path string.
  get vision_path(): string {
    return pyJoin(this.path, this.vision);
  }
  get tech_env_path(): string {
    return pyJoin(this.path, this.tech_env);
  }
  get openapi_path(): string {
    return pyJoin(this.path, this.openapi);
  }
  get golden_baseline_path(): string {
    return pyJoin(this.path, this.golden_baseline);
  }
  get golden_aidlc_docs_path(): string {
    return pyJoin(this.path, this.golden_aidlc_docs);
  }
}

// ── pyJoin — pathlib `str(Path(base) / name)` (drops trailing slash) ──────────
// node:path join keeps a trailing slash; Python's str(Path) never has one. We
// join then strip a single trailing separator (keeping a bare-root "/"), so
// `pyJoin(".../sci-calc-v2", "golden-aidlc-docs/")` → `.../golden-aidlc-docs`.
function pyJoin(base: string, name: string): string {
  const joined = join(base, name);
  if (joined.length > 1 && joined.endsWith("/")) {
    return joined.slice(0, -1);
  }
  return joined;
}

// ── filesystem predicates (mirror pathlib's is_file / is_dir) ─────────────────
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── load_scenario ──────────────────────────────────────────────────────────────
// scenario.py:60-116. Load and validate scenario.yaml from a test-case directory.
//
// Throws ScenarioFileNotFoundError if scenario.yaml does not exist (:81-82).
// Throws ScenarioValueError if the manifest is missing/empty `name` (:87-89).
// Warns (console.warn) — but does NOT throw — for a missing vision file or a
// missing golden-aidlc-docs directory (:106-114).
export function loadScenario(testCasePath: string): Scenario {
  const manifest = join(testCasePath, "scenario.yaml");
  if (!isFile(manifest)) {
    throw new ScenarioFileNotFoundError(`scenario.yaml not found in ${testCasePath}`);
  }

  // `yaml.safe_load(f) or {}` (:85) — falsy (None/empty) → {}.
  const raw = Bun.YAML.parse(readFileSync(manifest, "utf-8"));
  const data: Record<string, unknown> = isRecord(raw) ? raw : {};

  // `name = data.get("name"); if not name:` (:87-88). Python's `not name` is true
  // for None, missing, "", and any falsy value → mirror with a truthiness guard.
  const name = data["name"];
  if (!name) {
    throw new ScenarioValueError(`scenario.yaml in ${testCasePath} is missing 'name'`);
  }

  const scenario = new Scenario({
    name: String(name),
    description: asStr(data["description"], ""),
    status: asStr(data["status"], "active"),
    // `path=test_case_path.resolve()` (:95) — absolute, symlink-collapsed.
    path: resolve(testCasePath),
    vision: asStr(data["vision"], "vision.md"),
    tech_env: asStr(data["tech_env"], "tech-env.md"),
    openapi: asStr(data["openapi"], "openapi.yaml"),
    golden_baseline: asStr(data["golden_baseline"], "golden.yaml"),
    golden_aidlc_docs: asStr(data["golden_aidlc_docs"], "golden-aidlc-docs/"),
    tags: asStrList(data["tags"]),
  });

  // Validate critical files early rather than failing deep in the pipeline.
  // WARN-only — scenario.py:106-114 uses logger.warning, not a raise.
  if (!isFile(scenario.vision_path)) {
    console.warn(
      `Scenario ${quoteRepr(name)}: vision file missing: ${scenario.vision_path}`,
    );
  }
  if (!isDir(scenario.golden_aidlc_docs_path)) {
    console.warn(
      `Scenario ${quoteRepr(name)}: golden aidlc-docs directory missing: ` +
        `${scenario.golden_aidlc_docs_path} — qualitative evaluation will fail`,
    );
  }

  return scenario;
}

// ── list_scenarios ──────────────────────────────────────────────────────────────
// scenario.py:119-142. Discover all scenarios under a test_cases/ directory.
//
// TRAP: despite the docstring ("sorted by name"), the implementation sorts by
// DIRECTORY name via `sorted(test_cases_dir.iterdir())` (:129). Skips non-dirs
// (:130-131) and dirs lacking scenario.yaml (:132-133). Malformed manifests
// (ScenarioValueError / YAML parse error) are warned-and-skipped (:136-140), NOT
// fatal — a missing-name dir does not abort the listing.
export function listScenarios(testCasesDir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  if (!isDir(testCasesDir)) {
    return scenarios;
  }

  // `sorted(test_cases_dir.iterdir())` — pathlib sorts by full path string, which
  // (with a common parent) orders by child name. Match with a name sort.
  const children = readdirSync(testCasesDir).sort();
  for (const childName of children) {
    const child = join(testCasesDir, childName);
    if (!isDir(child)) {
      continue;
    }
    const manifest = join(child, "scenario.yaml");
    if (isFile(manifest)) {
      try {
        scenarios.push(loadScenario(child));
      } catch (exc) {
        // Python catches (ValueError, yaml.YAMLError) — skip malformed but warn.
        // A FileNotFoundError would NOT be caught here, but the is_file() guard
        // above guarantees the manifest exists, so loadScenario can only raise
        // ScenarioValueError (missing name) or a YAML parse error at this point.
        if (exc instanceof ScenarioFileNotFoundError) {
          throw exc; // not in Python's catch tuple — propagate (defensive; unreachable)
        }
        const msg = exc instanceof Error ? exc.message : String(exc);
        process.stderr.write(`[WARN] Skipping ${childName}: ${msg}\n`);
      }
    }
  }

  return scenarios;
}

// ── resolve_scenario ──────────────────────────────────────────────────────────
// scenario.py:145-200. Resolve a scenario name or path to a Scenario.
//
// name_or_path is interpreted as:
//   1. A path (absolute or relative) to a test-case dir containing scenario.yaml.
//   2. A short name (e.g. "sci-calc-v2") mapping to <test_cases_dir>/<name>/.
//
// The draft warning fires in BOTH branches (:175-180, :187-193). Throws
// ScenarioFileNotFoundError with the available-scenario list if neither resolves
// (:195-200).
export function resolveScenario(nameOrPath: string, testCasesDir: string): Scenario {
  // `candidate = Path(name_or_path)` (:170). Path keeps the string verbatim;
  // is_dir / scenario.yaml checks below run against it directly.
  const candidate = nameOrPath;

  // Stage 1: an existing directory with a scenario.yaml — use it directly (:173).
  if (isDir(candidate) && isFile(join(candidate, "scenario.yaml"))) {
    const scenario = loadScenario(candidate);
    warnIfDraft(scenario);
    return scenario;
  }

  // Stage 2: try as a name under test_cases_dir (:184-193).
  const byName = join(testCasesDir, nameOrPath);
  if (isDir(byName) && isFile(join(byName, "scenario.yaml"))) {
    const scenario = loadScenario(byName);
    warnIfDraft(scenario);
    return scenario;
  }

  // Neither resolved — error with the available list (:195-200).
  const available = listScenarios(testCasesDir)
    .map((s) => s.name)
    .join(", ");
  throw new ScenarioFileNotFoundError(
    `Scenario '${nameOrPath}' not found. Looked in:\n` +
      `  - ${candidate}\n` +
      `  - ${byName}\n` +
      `Available scenarios: ${available}`,
  );
}

// Draft warning shared by both resolve branches (scenario.py:175-180, 187-193).
function warnIfDraft(scenario: Scenario): void {
  if (scenario.status === "draft") {
    console.warn(
      `Scenario ${quoteRepr(scenario.name)} is marked as draft — golden baseline ` +
        `and some artifacts may be missing`,
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// `data.get(key, default)` — only the default applies when KEY IS ABSENT.
// Here Python passes the raw value through to the Scenario field (a string in
// every real manifest); we coerce defensively but preserve the default semantics.
function asStr(v: unknown, dflt: string): string {
  if (v === undefined) return dflt;
  return v == null ? dflt : String(v);
}

// `data.get("tags", [])` (:101) — default empty list when absent.
function asStrList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

// Python logs `%r` (repr) for the scenario name, e.g. `'sci-calc-v2'`. The repr
// of a str single-quotes it; mirror that so warning text matches Python's.
function quoteRepr(name: unknown): string {
  return `'${String(name)}'`;
}
