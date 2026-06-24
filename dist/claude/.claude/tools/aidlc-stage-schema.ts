// Stage frontmatter schema — machine-checkable realisation of the spec in
// dist/claude/.claude/aidlc-common/protocols/stage-definition.md. Consumed by
// parseStageFrontmatter (lib.ts), aidlc-graph compile, and the doctor
// schema-lint check (aidlc-utility.ts handleDoctor). Hand-rolled,
// zero-dep — matches parseAgentFrontmatter precedent in lib.ts. Pure
// validator: no I/O, no YAML parsing, no mutation — callers pass an
// already-parsed object.

import { isPlainObject } from "./aidlc-lib.ts";

// --- Public types ---

export interface StageFrontmatter {
  slug: string;
  // number — the authored display order, `<phase-prefix>.<index>` (e.g. "2.7").
  // Optional in the schema (validated for shape when present) but REQUIRED at
  // compile: compileStageGraph throws if a shipped stage omits it. Authoring it
  // here — rather than seeding it from the committed stage-graph.json — is what
  // makes compile deterministic from core/ sources alone and lets an extension
  // claim its own number range without renumbering core stages.
  number?: string;
  // name — the authored human-readable display name. Same optionality contract
  // as `number`: shape-checked when present, presence enforced at compile.
  name?: string;
  // bundle — ownership identity (extension mechanism, Layer 1). Optional;
  // absent means the item belongs to core (read via bundleOf() in lib.ts, which
  // defaults absent → "core"). Stored only when authored, so core stages — which
  // never declare it — keep their compiled node byte-identical. Later layers
  // (packaging variants, drift, contribution merge) key off this.
  bundle?: string;
  phase: "initialization" | "ideation" | "inception" | "construction" | "operation";
  execution: "ALWAYS" | "CONDITIONAL";
  condition: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "agent-team";
  for_each?: string;
  produces: string[];
  consumes: Array<{
    artifact: string;
    required: boolean;
    conditional_on?: "brownfield" | "greenfield";
  }>;
  requires_stage: string[];
  sensors?: string[];
  // scopes — the per-stage scope-membership list. Active field:
  // the transpose of the legacy scope-mapping.json EXECUTE/SKIP matrix
  // onto stages. Naming a scope here marks the stage EXECUTE under that
  // scope; absence means SKIP. Optional in the schema (absent and `[]`
  // treated identically) so a fixture stage with no membership still
  // validates. `aidlc-graph compile` reads this to emit the compiled grid.
  scopes?: string[];
  // when — structured activation predicate (extension mechanism, Layer 4). A
  // single-key map: the key selects a predicate, the value is its argument. Today
  // the only key is `producer-in-plan: <artifact-slug>` — the stage is EXECUTE
  // under a scope only if some stage producing that artifact is also EXECUTE on
  // that scope's resolved plan; otherwise the compile-time grid pass SKIPs it.
  // Open-map-with-known-keys (like consumes[].conditional_on) so a future
  // predicate slots in as one more optional key + one WHEN_PREDICATE_KEYS entry.
  when?: { "producer-in-plan"?: string };
  // reviewer — agent slug to invoke as a quality gate after the stage body
  // (stage-protocol.md §12a). Optional; absent when the stage has no review step.
  reviewer?: string;
  // reviewer_max_iterations — review-cycle cap before escalating to the human.
  // Defaults to 2 when reviewer is present.
  reviewer_max_iterations?: number;
  inputs: string;
  outputs: string;
}

export type ValidationResult =
  | { valid: true; data: StageFrontmatter }
  | { valid: false; errors: string[] };

export interface ValidationContext {
  /**
   * When provided, `lead_agent` and each `support_agents[]` entry must be in
   * this list. Callers typically pass `loadAgents().map(a => a.slug)`.
   * When omitted, agent-slug lookup is skipped.
   */
  agents?: string[];
}

// --- Exported constants (imported by tests and the doctor check) ---

export const VALID_PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export const VALID_EXECUTIONS = ["ALWAYS", "CONDITIONAL"] as const;

export const VALID_MODES = ["inline", "subagent", "agent-team"] as const;

export const VALID_CONDITIONAL_ON = ["brownfield", "greenfield"] as const;

// Allowed predicate keys for the stage `when:` map (extension mechanism, Layer
// 4). Today only `producer-in-plan`; the grid-generation pass evaluates it at
// compile. Adding a predicate (e.g. `bundle-active`) is one entry here + one
// optional key on StageFrontmatter.when + a case in the grid pass.
export const WHEN_PREDICATE_KEYS = ["producer-in-plan"] as const;

// The conductor itself, named as a lead_agent on the bootstrap initialization
// stages. It is a reserved pseudo-agent with no .claude/agents/*.md file by
// design (the orchestrator session IS the actor), so the Rule 9 registration
// cross-check must exempt it. The Stage Graph table in SKILL.md writes it as
// "(orchestrator)"; t38 normalizes the parens away to compare bare slugs.
export const RESERVED_AGENT_SLUG = "orchestrator";

// Reserved-namespace keys from stage-definition.md. Listed here so the
// parser, compile step, and doctor all reject them with a consistent
// error message. Each reserved key has a brief reason — the reason
// describes the intended subsystem, not a target release.
export const RESERVED_KEYS: Readonly<Record<string, string>> = {
  // `when` is no longer reserved — it is an active structured predicate as of
  // Layer 4 (see WHEN_PREDICATE_KEYS + the when validator below).
  on_failure: "loop driver",
  blocks_on: "construction worktrees",
  timeout: "sensor binding",
  retry: "loop driver",
};

const REQUIRED_FIELDS = [
  "slug",
  "phase",
  "execution",
  "condition",
  "lead_agent",
  "support_agents",
  "mode",
  "produces",
  "consumes",
  "requires_stage",
  "inputs",
  "outputs",
] as const;

// number + name are authored but OPTIONAL at the schema layer (validated for
// shape when present); compileStageGraph enforces their PRESENCE on shipped
// stages. Keeping them optional here preserves the validator's minimal-fixture
// contract (a unit fixture need not carry display metadata to be structurally
// valid) while compile still fails loud for a real stage that forgets them.
const OPTIONAL_FIELDS = ["number", "name", "bundle", "for_each", "sensors", "scopes", "when", "reviewer", "reviewer_max_iterations"] as const;

const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

// Kebab-case: start with lowercase letter, followed by lowercase letters,
// digits, or hyphens. Spec says "kebab-case; must match filename stem".
// Filename-stem check is the parser's responsibility (where the filename
// is known); here we only validate the shape.
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

// Stage display number: `<phase-prefix>.<index>`, both non-negative integers
// (e.g. "0.1", "2.7", "4.50"). numericStageOrder (aidlc-graph.ts) parses this
// shape; an extension authors numbers in its claimed range. Shape only — the
// phase-prefix/phase agreement is a separate compile-time cross-check.
const NUMBER_RE = /^\d+\.\d+$/;

// Lowercase-kebab artifact names — see docs/reference/16-artifact-vocabulary.md
// for the naming rules and aidlc-graph.ts for the derived registry.
// Membership validation runs in the doctor graph-references check; here we
// only assert the string shape.
const ARTIFACT_SLUG_RE = /^[a-z][a-z0-9-]*$/;

// --- Validator ---

export function validateStageFrontmatter(
  obj: unknown,
  ctx?: ValidationContext
): ValidationResult {
  // Rule 1: shape. Must be a plain object. If not, return a single error —
  // we can't collect field-level errors on a non-object. After this guard,
  // TS narrows `obj` to `object` (still not `Record<string, unknown>`),
  // so we use isPlainObject to get the indexable narrow.
  if (!isPlainObject(obj)) {
    const actual =
      obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj;
    return { valid: false, errors: [`expected object, got ${actual}`] };
  }

  const o = obj;
  const errors: string[] = [];

  // Rule 2: reserved keys. Specific release error before generic unknown-key.
  for (const key of Object.keys(o)) {
    if (key in RESERVED_KEYS) {
      errors.push(`${key} is reserved (${RESERVED_KEYS[key]}); not active yet`);
    }
  }

  // Rule 3: unknown keys (not in REQUIRED_FIELDS ∪ OPTIONAL_FIELDS and not reserved).
  for (const key of Object.keys(o)) {
    if (!KNOWN_FIELDS.has(key) && !(key in RESERVED_KEYS)) {
      errors.push(`unknown key: ${key}`);
    }
  }

  // Rule 4: required fields present.
  for (const field of REQUIRED_FIELDS) {
    if (!(field in o)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // Rule 5-7: per-field type, enum, regex checks.
  checkString(o, "slug", errors);
  checkSlugPattern(o, "slug", SLUG_RE, "kebab-case", errors);

  // number + name — authored display metadata. Optional at this layer (absent
  // is structurally valid; compile enforces presence on shipped stages), but
  // shape-checked when present. number must be `<int>.<int>`; name any string.
  checkString(o, "number", errors);
  checkSlugPattern(o, "number", NUMBER_RE, "<phase-prefix>.<index>", errors);
  checkString(o, "name", errors);

  // bundle — optional ownership tag. String when present; no enum (bundle names
  // are an open set, validated against discovered extensions at a later layer).
  checkString(o, "bundle", errors);

  checkString(o, "phase", errors);
  checkEnum(o, "phase", VALID_PHASES, errors);

  checkString(o, "execution", errors);
  checkEnum(o, "execution", VALID_EXECUTIONS, errors);

  checkString(o, "condition", errors);
  checkString(o, "lead_agent", errors);

  checkStringArray(o, "support_agents", errors);

  checkString(o, "mode", errors);
  checkEnum(o, "mode", VALID_MODES, errors);

  // for_each — optional. Absent → valid. Present → must be string.
  // Explicit `null` falls through the typeof check and is rejected as
  // "must be string, got object" — same branch as any other wrong type.
  if ("for_each" in o && o.for_each !== undefined) {
    if (typeof o.for_each !== "string") {
      errors.push(`for_each must be string, got ${describe(o.for_each)}`);
    }
  }

  // reviewer — optional. When present, must be a string. Validated exactly
  // like lead_agent (checkString + the Rule 9 roster cross-check below), since
  // reviewer is an agent-slug field of the same kind. checkString does not
  // enforce non-emptiness (lead_agent does not either); an empty reviewer is
  // caught by the Rule 9 roster check when ctx.agents is supplied (it matches
  // no agent file), which every production caller does. No standalone
  // kebab-pattern check: lead_agent has none either, and a pattern-invalid slug
  // can never match a real agent file, so Rule 9 already rejects it — a pattern
  // check here would be redundant.
  checkString(o, "reviewer", errors);

  // reviewer_max_iterations — optional. When present, must be a positive
  // integer (>= 1). V1 makes the parser return a number for an integer
  // literal; a non-integer literal stays a string and is rejected here as a
  // type error rather than silently coercing to NaN at compile.
  checkPositiveInteger(o, "reviewer_max_iterations", errors);

  // Coupling — a cap with no reviewer is silently dropped at compile
  // (aidlc-graph.ts guards the whole reviewer block on `reviewer` being
  // present). Make the schema's contract match the compiler: reject a cap
  // declared without a reviewer. The inverse (reviewer present, cap absent)
  // is valid — the cap defaults to 2.
  if (
    "reviewer_max_iterations" in o &&
    o.reviewer_max_iterations !== undefined &&
    !("reviewer" in o && o.reviewer !== undefined)
  ) {
    errors.push("reviewer_max_iterations requires a reviewer");
  }

  checkStringArray(o, "produces", errors);

  // Rule 8: nested consumes[] — array of {artifact, required, conditional_on?}.
  if ("consumes" in o) {
    const consumesVal = o.consumes;
    if (!Array.isArray(consumesVal)) {
      errors.push(`consumes must be array, got ${describe(consumesVal)}`);
    } else {
      // TS narrows Array.isArray(unknown) to any[] (known quirk); re-bind
      // to unknown[] to keep the iteration typed.
      const consumes: unknown[] = consumesVal;
      consumes.forEach((entry: unknown, i: number) => {
        if (!isPlainObject(entry)) {
          errors.push(`consumes[${i}] must be object, got ${describe(entry)}`);
          return;
        }
        const e = entry;

        if (!("artifact" in e)) {
          errors.push(`consumes[${i}].artifact missing`);
        } else if (typeof e.artifact !== "string") {
          errors.push(`consumes[${i}].artifact must be string, got ${describe(e.artifact)}`);
        } else if (!ARTIFACT_SLUG_RE.test(e.artifact)) {
          errors.push(`consumes[${i}].artifact must be kebab-case, got "${e.artifact}"`);
        }

        if (!("required" in e)) {
          errors.push(`consumes[${i}].required missing`);
        } else if (typeof e.required !== "boolean") {
          errors.push(`consumes[${i}].required must be boolean, got ${describe(e.required)}`);
        }

        if ("conditional_on" in e && e.conditional_on !== undefined) {
          if (typeof e.conditional_on !== "string") {
            errors.push(
              `consumes[${i}].conditional_on must be string, got ${describe(e.conditional_on)}`
            );
          } else if (!(VALID_CONDITIONAL_ON as readonly string[]).includes(e.conditional_on)) {
            errors.push(
              `consumes[${i}].conditional_on must be one of ${VALID_CONDITIONAL_ON.join(" | ")}, got "${e.conditional_on}"`
            );
          }
        }
      });
    }
  }

  checkStringArray(o, "requires_stage", errors);

  // sensors — optional. When present, must be a list of non-empty strings.
  // Cross-validation (each id resolves to a known manifest) happens at
  // compile, not parse — the schema validator doesn't know the registry.
  if ("sensors" in o && o.sensors !== undefined) {
    checkStringArray(o, "sensors", errors);
    const sensorsVal: unknown = o.sensors;
    if (Array.isArray(sensorsVal)) {
      const sensors: unknown[] = sensorsVal;
      sensors.forEach((id: unknown, i: number) => {
        if (typeof id === "string" && id.length === 0) {
          errors.push(`sensors[${i}] must be non-empty`);
        }
      });
    }
  }

  // scopes — optional. When present, must be a list of non-empty strings.
  // Cross-validation (each name resolves to a known .claude/scopes/*.md
  // file) is not enforced here — the schema validator doesn't read the
  // scopes registry; `aidlc-graph compile` transposes whatever names are
  // declared into the grid, and an unknown scope name simply yields a
  // column nobody asks for.
  if ("scopes" in o && o.scopes !== undefined) {
    checkStringArray(o, "scopes", errors);
    const scopesVal: unknown = o.scopes;
    if (Array.isArray(scopesVal)) {
      const scopes: unknown[] = scopesVal;
      scopes.forEach((name: unknown, i: number) => {
        if (typeof name === "string" && name.length === 0) {
          errors.push(`scopes[${i}] must be non-empty`);
        }
      });
    }
  }

  // when — optional structured activation predicate. When present: a plain
  // object with exactly one key from WHEN_PREDICATE_KEYS whose value is a
  // kebab-case artifact slug. Mirrors the consumes[] nested validator's
  // plain-object + per-field discipline.
  if ("when" in o && o.when !== undefined) {
    const w = o.when;
    if (!isPlainObject(w)) {
      errors.push(`when must be object, got ${describe(w)}`);
    } else {
      const keys = Object.keys(w);
      if (keys.length !== 1) {
        errors.push(`when must have exactly one predicate key, got ${keys.length}`);
      }
      for (const k of keys) {
        if (!(WHEN_PREDICATE_KEYS as readonly string[]).includes(k)) {
          errors.push(
            `when has unknown predicate "${k}"; allowed: ${WHEN_PREDICATE_KEYS.join(" | ")}`,
          );
          continue;
        }
        const val = w[k];
        if (typeof val !== "string") {
          errors.push(`when.${k} must be string, got ${describe(val)}`);
        } else if (!ARTIFACT_SLUG_RE.test(val)) {
          errors.push(`when.${k} must be kebab-case, got "${val}"`);
        }
      }
    }
  }

  checkString(o, "inputs", errors);
  checkString(o, "outputs", errors);

  // Rule 9: dynamic agent lookup (only if ctx.agents provided). The reserved
  // "orchestrator" pseudo-agent is exempt — it names the conductor session,
  // which has no agent file by design (see RESERVED_AGENT_SLUG).
  if (ctx?.agents) {
    const known = new Set(ctx.agents);
    if (
      typeof o.lead_agent === "string" &&
      o.lead_agent !== RESERVED_AGENT_SLUG &&
      !known.has(o.lead_agent)
    ) {
      errors.push(`lead_agent "${o.lead_agent}" has no matching .claude/agents/*.md`);
    }
    const supportAgentsVal: unknown = o.support_agents;
    if (Array.isArray(supportAgentsVal)) {
      const supportAgents: unknown[] = supportAgentsVal;
      supportAgents.forEach((a: unknown, i: number) => {
        if (
          typeof a === "string" &&
          a !== RESERVED_AGENT_SLUG &&
          !known.has(a)
        ) {
          errors.push(`support_agents[${i}] "${a}" has no matching .claude/agents/*.md`);
        }
      });
    }
    // reviewer is an agent-slug field like lead_agent; cross-check it against
    // the same roster (exempting the reserved orchestrator pseudo-agent). This
    // is the silent-failure fix: a reviewer naming a non-existent agent passed
    // validation today and surfaced only as a runtime no-op.
    if (
      typeof o.reviewer === "string" &&
      o.reviewer !== RESERVED_AGENT_SLUG &&
      !known.has(o.reviewer)
    ) {
      errors.push(`reviewer "${o.reviewer}" has no matching .claude/agents/*.md`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // On success, return the same reference — no copy, no normalisation.
  // Callers must NOT mutate `data`; it aliases the input object. The
  // double-cast (unknown → StageFrontmatter) is the documented trust
  // boundary: rules 1–9 above have already verified each field's shape
  // (presence, type, enum, regex), so the structural compatibility is
  // guaranteed at runtime even though TS can't follow the per-field
  // checks. Centralising this single cast in the validator keeps the
  // rest of the codebase cast-free.
  // type-coverage:ignore-next-line — documented validator trust boundary
  return { valid: true, data: o as unknown as StageFrontmatter };
}

// --- Helpers ---

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkString(o: Record<string, unknown>, field: string, errors: string[]): void {
  if (!(field in o)) return;
  if (typeof o[field] !== "string") {
    errors.push(`${field} must be string, got ${describe(o[field])}`);
  }
}

// checkPositiveInteger — an optional field that, when present, must be a
// positive integer (>= 1). Mirrors checkString's presence-first shape: absent
// is valid, present-and-wrong is reported. A non-number (e.g. the string "two"
// the parser leaves untouched for a non-integer literal), a non-integer
// (2.5), or a value < 1 (0, -3) all fail. reviewer_max_iterations is the only
// numeric stage field, so the error names the contract directly.
function checkPositiveInteger(
  o: Record<string, unknown>,
  field: string,
  errors: string[],
): void {
  if (!(field in o) || o[field] === undefined) return;
  const v = o[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    errors.push(`${field} must be a positive integer, got ${describe(v)}`);
  }
}

function checkStringArray(
  o: Record<string, unknown>,
  field: string,
  errors: string[]
): void {
  if (!(field in o)) return;
  const v: unknown = o[field];
  if (!Array.isArray(v)) {
    errors.push(`${field} must be array, got ${describe(v)}`);
    return;
  }
  const arr: unknown[] = v;
  arr.forEach((item: unknown, i: number) => {
    if (typeof item !== "string") {
      errors.push(`${field}[${i}] must be string, got ${describe(item)}`);
    }
  });
}

function checkEnum(
  o: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  errors: string[]
): void {
  if (!(field in o)) return;
  const v = o[field];
  if (typeof v !== "string") return; // type error already reported by checkString
  if (!allowed.includes(v)) {
    errors.push(`${field} must be one of ${allowed.join(" | ")}, got "${v}"`);
  }
}

function checkSlugPattern(
  o: Record<string, unknown>,
  field: string,
  re: RegExp,
  shape: string,
  errors: string[]
): void {
  if (!(field in o)) return;
  const v = o[field];
  if (typeof v !== "string") return;
  if (!re.test(v)) {
    errors.push(`${field} must be ${shape}, got "${v}"`);
  }
}
