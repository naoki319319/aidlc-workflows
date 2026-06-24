# Stage Definition Format

This file is the authoritative contract for the shape of every stage file
under `{{HARNESS_DIR}}/aidlc-common/stages/`. The schema (`stage-schema.ts`), the
YAML parser (`parseStageFrontmatter` in `lib.ts`), and the YAML stage
files all implement against this document.

YAML frontmatter at the top of every stage `.md` is authoritative. The
build step `bun aidlc-graph.ts compile` regenerates
`{{HARNESS_DIR}}/tools/data/stage-graph.json` from the YAML sources; the runtime
reads the compiled JSON via the unchanged `loadStageGraph()` API at
`lib.ts:282-289`. The CI drift check `aidlc-graph compile --check` fails
the build if the JSON diverges from the YAML.

---

## File layout

```yaml
---
# YAML frontmatter — 14 top-level authored fields
---

# [Stage Title]

MANDATORY: Follow stage-protocol.md for approval gates, question format,
and completion messages.

## Steps
# prose body — required, always populated

## Sensors
# reserved — parser tolerates absence; populated when the sensor subsystem ships

## Learn
# reserved — parser tolerates absence; populated when the loop-driver subsystem ships
```

---

## Authored fields

Fourteen top-level authored fields (plus three `consumes[]` subfields).
All required unless marked optional. The schema in `stage-schema.ts`
copies this table verbatim.

| Field | Type | Required | Enum / Constraint |
|-------|------|----------|--------------------|
| `slug` | string | yes | kebab-case; must match filename stem |
| `number` | string | yes | authored display order, `<phase-prefix>.<index>` (e.g. `2.7`). Phase prefix: `initialization=0`, `ideation=1`, `inception=2`, `construction=3`, `operation=4`. Both halves non-negative integers; `numericStageOrder` sorts on them. Authoring it (rather than deriving from topo order) keeps numbers stable when an extension inserts stages — an extension claims its own range and core stages never renumber. Optional in `stage-schema.ts` (shape-checked when present) but **required at compile** — `aidlc-graph compile` fails if a stage omits it |
| `name` | string | yes | authored human-readable display name (e.g. `Requirements Analysis`). Same optionality contract as `number`: shape-checked by the schema, presence enforced at compile. Surfaces in the SKILL.md Stage Graph table, doctor/status output, and jump directives |
| `phase` | string | yes | `initialization` \| `ideation` \| `inception` \| `construction` \| `operation` (lowercase) |
| `execution` | string | yes | `ALWAYS` \| `CONDITIONAL` |
| `condition` | string | yes | free-form; describe always-on rationale for `ALWAYS`, branching condition for `CONDITIONAL` |
| `lead_agent` | string | yes | agent slug; validated dynamically against `{{HARNESS_DIR}}/agents/*.md` via `loadAgents()` — no hardcoded enum |
| `support_agents` | string[] | yes | empty list allowed; each entry a valid agent slug. Renamed from prose `Supporting Agents:` (format-only rename) |
| `mode` | string | yes | `inline` \| `subagent` \| `agent-team`. `inline` and `subagent` are active; **`agent-team` is reserved** — no stage declares it until a consumer ships. Orchestrator code reading `mode` MUST handle `agent-team` explicitly (at minimum throw "not yet implemented") — do not fall through to a default path |
| `for_each` | string | optional | artifact slug; stage runs once per instance of that artifact. Omit for once-per-workflow stages. Doctor validates the artifact is produced by an upstream stage |
| `produces` | string[] | yes | empty allowed; lowercase-kebab artifact names — see [Artifact Vocabulary](../../../../docs/reference/16-artifact-vocabulary.md) for rules and the live registry tool |
| `consumes` | object[] | yes | empty allowed; each entry `{artifact, required, conditional_on?}` |
| `consumes[].artifact` | string | yes per entry | lowercase-kebab |
| `consumes[].required` | boolean | yes per entry | Scoped to the active plan. `true` means "if the producing stage runs, this consume must be satisfied" — not a global assertion that the artifact always exists. Scopes that skip the producer (e.g., `bugfix` skipping `units-generation`) make the consume moot; the stage body handles graceful degradation. The active `when: {producer-in-plan: X}` predicate lets a stage instead auto-SKIP when its producer is off-plan (a real gate rather than runtime degradation) |
| `consumes[].conditional_on` | string | optional | `brownfield` \| `greenfield`. Omit for unconditional consumes — no `always` value |
| `requires_stage` | string[] | yes | empty allowed; each entry a known stage slug. Two roles: (1) semantic data dependency; (2) presentation-order edge for stages with no semantic link but a fixed display order. Compile asserts every edge points from a higher-numbered stage to a lower-numbered one (the authored `number` is the order of record) |
| `scopes` | string[] | optional | each entry a scope name with a matching `{{HARNESS_DIR}}/scopes/aidlc-<name>.md` file. Naming a scope marks this stage EXECUTE under that scope; absence marks it SKIP. The per-stage transpose of the scope membership matrix — `aidlc-graph compile` reads every stage's `scopes:` and emits the compiled EXECUTE/SKIP grid (`tools/data/scope-grid.json`). The 3 initialization stages name all scopes (always EXECUTE). Absent and `[]` are treated identically |
| `when` | object | optional | structured activation predicate (a single-key map). Today the one key is `producer-in-plan: <artifact-slug>` — the stage is EXECUTE under a scope only if some stage producing that artifact is also EXECUTE on that scope's resolved plan; otherwise the compile-time grid pass (`applyPredicates`, after the `scopes:` transpose) SKIPs it. A structured replacement for prose `condition:` and a real gate version of `consumes[].required`'s graceful degradation. Absent ⇒ no predicate |
| `inputs` | string | yes | human prose (preserves today's `**Inputs**:` line) |
| `outputs` | string | yes | human prose (preserves today's `**Outputs**:` line) |

---

## Computed fields (NOT authored)

Every field in `stage-graph.json` is now either authored in the stage YAML
(including `number` and `name`) or derived from other authored config —
`rules_in_context` (resolved from the rule layer chain by `phase`) and
`sensors_applicable` (resolved from each stage's `sensors:` list against the
sensor registry). Compile reads no value from the prior `stage-graph.json`: it
is deterministic from `core/` sources alone, which is what lets a new stage (or
an extension's stages) compile by dropping in a YAML file with an authored
`number` + `name` and recompiling — no pre-seeding a generated file.

---

## Worked example

The `scope-definition` stage's YAML frontmatter. Use this as a
copy-paste template when authoring a new stage; the schema in
`stage-schema.ts` validates against the same shape.

```yaml
---
slug: scope-definition
number: 1.4
name: Scope Definition
phase: ideation
execution: ALWAYS
condition: Always executes — defines the scope boundary and prioritized backlog
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
produces:
  - scope-document
  - intent-backlog
  - scope-definition-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
  - artifact: constraint-register
    required: false
requires_stage:
  - intent-capture
scopes:
  - enterprise
  - feature
  - mvp
inputs: Intent statement, feasibility assessment, constraint register
outputs: aidlc-docs/ideation/scope-definition/scope-document.md, aidlc-docs/ideation/scope-definition/intent-backlog.md, aidlc-docs/ideation/scope-definition/scope-definition-questions.md
---
```

Note: `number` + `name` are authored (above), and `for_each` is omitted (the
stage runs once per workflow).

---

## Body compartments

Three compartments, declared in this order. Only `## Steps` is populated
today; `## Sensors` and `## Learn` are reserved heading slots that
future releases will populate.

| Compartment | Today | Future | Parser rule |
|-------------|-------|--------|-------------|
| `## Steps` | Required, populated | Unchanged | Always present |
| `## Sensors` | Reserved, absent | Populated (deterministic sensors) | Parser tolerates absence |
| `## Learn` | Reserved, absent | Populated (loop drivers, observer rules) | Parser tolerates absence |

**Body structure rule:** all existing body content lives under
`## Steps` and nothing else. The parser tolerates absence of the
`## Sensors` and `## Learn` headings.

---

## Compile + drift invariant

`aidlc-graph compile` reads all stage YAML sources and regenerates
`{{HARNESS_DIR}}/tools/data/stage-graph.json`. Consumers continue to read the compiled
JSON via `loadStageGraph()`.

`aidlc-graph compile --check` re-runs the compile in memory, diffs against
the checked-in JSON, and exits non-zero if different. CI runs this on every
change. Drift is impossible if the check passes.

`aidlc-graph` implements this contract. See
`aidlc-graph.ts` in the harness tools directory for the library and CLI
(8 exports: loadGraph, producersOf, consumersOf, topoSort, findCycles,
subgraphForScope, validateScope, artifactsRegistry; plus compile, compile
--check, and seven query subcommands).

---

## Future extensions — reserved namespace

Fields not active today but reserved by intent. No stage declares
them; the schema rejects unknown keys. Naming them here prevents
future contributor additions from colliding with planned primitives.

| Key | Purpose |
|-----|---------|
| `on_failure` | Declarative error recovery (jump-back, retry-with-adjusted-inputs). Moves revision semantics out of `stage-protocol-recovery.md` prose |
| `blocks_on` | Completion dependency without data read. Splits today's overloaded `requires_stage` (which conflates "I consume your output" with "I run after you") |
| `timeout`, `retry` | Execution budgets. Homed in sensor bindings and loop config, not stage frontmatter (mirrors Claude Code's task-API design — no primitive-level retry/timeout) |

Precedent for the reserved-namespace pattern:
`docs/reference/06-hooks-and-tools.md` declares audit event names
`ERROR_LOGGED` and `RECOVERY_COMPLETED` the same way.

**Consumer contract for `mode`:** orchestrator code reading the `mode` field
must handle `agent-team` explicitly. At minimum, throw "mode agent-team not
yet implemented". Do not fall through to a default execution path — silent
fallthrough on enum extension is a known foot-gun flagged by review.

---

## Cross-references

- `stage-protocol.md` — runtime execution behaviour (approval gates, question
  flow, state tracking). This spec covers file format; stage-protocol covers
  behaviour.
- `SKILL.md` — orchestrator routing and dispatch.
- `docs/reference/15-stage-definition.md` — narrative counterpart for
  contributors.
