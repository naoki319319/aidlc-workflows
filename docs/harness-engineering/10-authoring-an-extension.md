# Authoring an Extension

> Part of the [Harness Engineer Guide](00-overview.md). Prerequisite:
> [Anatomy of a Stage](01-anatomy-of-a-stage.md). Design reference:
> [Extension Mechanism](../reference/18-extension-mechanism.md).

An **extension** (a **bundle**) is a reusable, optional set of AIDLC
contributions — new stages, agents, scopes, rules, sensors, and additive
modifications to existing core stages — packaged in its own directory and
projected into every harness as a committed, drift-guarded delta. A bundle never
edits `core/`; disabling it leaves the base byte-identical.

This chapter walks the shipped fixture `extensions/ops-min/` end to end. Copy its
shape for your own bundle.

## When to write an extension vs. a plain stage/rule

- **A stage/agent/rule** ([chapters 2–6](00-overview.md)) is a permanent part of
  the framework everyone gets.
- **An extension** is _optional and owned_ — it ships in `extensions/<name>/`,
  activates only under an opt-in scope (and/or a `when:` predicate), and a
  consumer overlays it onto their install. Use it for a domain pack (a full
  operation phase, a compliance bundle) that not every project wants.

## 1. The directory + manifest

```text
extensions/ops-min/
  extension.ts                              # the manifest
  stages/operation/ops-min-deploy.md        # NEW stages
  stages/operation/ops-min-verify.md
  contributions/construction/nfr-requirements.md   # MODIFY an existing stage (§4)
```

`extensions/ops-min/extension.ts` — a typed default export (the same convention
as a harness `manifest.ts`):

```ts
import type { ExtensionManifest } from "../../scripts/extension-types.ts";

const extension: ExtensionManifest = {
  name: "ops-min", // == the dir name; must not be "core"
  version: "0.1.0", // semver; checked by dependents' requiresBundle
  requiresBundle: ["core"], // deps; e.g. ["compliance@^1.0.0"]
  numberRanges: { operation: [["4.50", "4.99"]] }, // stage-number range(s) you claim
  contributes: {
    stages: "stages/", // dir of NEW stage files (merged into core roots)
    overlays: "contributions/", // dir of CONTRIBUTION files (§4 — modify existing)
  },
};

export default extension;
```

`contributes` keys map to core subtrees (`stages`, `agents`, `scopes`, `rules`,
`sensors`, `knowledge`) — those are copied in alongside core at build. `overlays`
is special: it is **not** copied; it holds the per-stage contributions consumed
by the merge pass.

## 2. Add a new stage

A bundle stage is an ordinary stage file (see [Anatomy of a Stage](01-anatomy-of-a-stage.md))
with two extra rules:

- Its `number:` must fall inside a range your manifest claims (`4.50`–`4.99`
  here). This is what lets you insert stages without renumbering core.
- Its `bundle:` field names your bundle.
- Any artifact it `produces:` must be prefixed `<bundle>-` (e.g.
  `ops-min-deploy-record`).

Gate it onto a scope with `scopes:` (it's SKIP everywhere else), and optionally
with a `when:` predicate — `ops-min-verify` only runs when its upstream producer
is on the plan:

```yaml
when:
  producer-in-plan: ops-min-deploy-record
```

See [Scopes](04-scopes.md) for scope membership and the `when:` predicate.

## 3. Modify an existing core stage (a contribution)

This is the §4 seam — additively change a core stage **without editing it**. A
contribution lives at `extensions/<bundle>/contributions/<phase>/<slug>.md`:

```markdown
---
target: nfr-requirements # the existing core stage you're enriching
bundle: ops-min
adds: # STRUCTURAL — set-unioned into the stage node
  produces:
    - ops-min-operational-nfr-requirements # <bundle>- prefixed
  required_sections:
    - "Operational NFRs" # machine-enforced by the required-sections sensor
fragments: # PROSE — spliced into the stage body
  - anchor: after-step:6
    order: 100
---

## fragment: after-step:6

### Step 6b (ops-min): Capture operational NFRs

...prose the agent will see, appended after the target stage's Step 6...
```

What you can add (all additive — **no override or removal**, by design):

- `adds.produces` / `adds.consumes` / `adds.sensors` / `adds.requires_stage` —
  set-unioned into the target stage's compiled node.
- `adds.required_sections` — named `##` H2 sections the required-sections sensor
  will **machine-enforce** in that stage's output.
- `fragments` — prose blocks appended into the stage body. Each fragment's prose
  is the `## fragment: <anchor>` block in the contribution file.

### Fragment anchors

| Anchor             | Inserts the fragment…                                              |
| ------------------ | ------------------------------------------------------------------ |
| `after-step:<n>`   | right after `### Step <n>` (before the next `###`/`##`)            |
| `before-step:<n>`  | immediately before `### Step <n>`                                  |
| `after-questions`  | after the questions-generating step (the `### Step …` whose heading mentions "Question") |
| `end-of-steps`     | at the end of the `## Steps` block                                 |
| `in:<Compartment>` | at the end of the named `## <Compartment>` block (e.g. `in:Sensors`, `in:Learn`) |

Fragments are ordered deterministically by `(order, bundle, anchor)`. Two
fragments with the same `(anchor, order, bundle)` is a build error.

## 4. Validate as you author (fast loop)

Run the standalone validator — it checks your bundle **without** a full harness
build (manifest, cross-bundle deps/ranges/artifact collisions, and every
contribution's target/anchors/namespacing):

```bash
bun scripts/package.ts --validate-ext ops-min   # one bundle
bun scripts/package.ts --validate-ext            # all discovered bundles
```

It prints a clear per-error list and exits non-zero on any problem, e.g.:

```text
validate-ext: extension "ops-min" — 2 problem(s):
  - extension "ops-min" artifact "deploy-record" must be prefixed "ops-min-"
  - ops-min/contributions/construction/nfr-requirements.md: target "typo-stage" is not a known core stage slug
```

## 5. Build + drift-guard

```bash
bun scripts/package.ts            # regenerate dist (base + each bundle delta)
bun scripts/package.ts --check    # byte-parity drift guard (base + deltas)
```

Your bundle is projected to `dist/<harness>/extensions/<bundle>/` as a committed
delta. The base trees stay byte-identical; `--check` byte-pins every delta. A
consumer installs the base `dist/<harness>/.claude/` and overlays the bundle dir.

## Rules of the road (what the validator enforces)

- **Number ranges:** your stages number inside a claimed range; ranges may not
  overlap core or another bundle.
- **Artifact namespacing:** every artifact you produce is `<bundle>-` prefixed;
  it may not collide with a core artifact or another bundle's.
- **Dependencies:** `requiresBundle` entries must resolve; a `name@^x.y.z`
  constraint is checked against the dependency's `version`; cycles are rejected.
- **Additive only:** contributions add — they cannot override or remove a core
  stage's fields, agent, or prose. (A genuine need to _change_ upstream behavior
  is a framework design decision, not a bundle concern.)

## See also

- [Extension Mechanism](../reference/18-extension-mechanism.md) — the full design
  and as-built record (layers, delta model, the `when:` predicate, §4 merge).
- [Anatomy of a Stage](01-anatomy-of-a-stage.md), [Scopes](04-scopes.md),
  [Sensors](06-sensors.md) — the building blocks a bundle composes.
