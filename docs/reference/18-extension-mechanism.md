# Extension Mechanism — Design

> **Status:** Layers 0–3 implemented; Layers 4–5 + §4/§5 still design. This
> document specifies a first-class extension mechanism for AIDLC v2 so that third
> parties can ship **bundles** — self-contained sets of stages, agents, scopes,
> rules, sensors, and _contributions to existing stages_ — without editing
> `core/` or hand-editing any generated `dist/` artifact.
>
> **As-built (Layers 0–3):** Layer 0 (authored `number`/`name`, seedless compile)
> and Layer 1 (`bundle:` ownership field + `bundleOf()`) shipped. Layer 2/3 ships
> as: an extension lives in `extensions/<name>/` with an `extension.ts` manifest
> (`scripts/extension-types.ts`), discovered like a harness (`discoverExtensions`
> in `scripts/package.ts`). The packager projects each bundle as a **committed
> delta** at `dist/<name>/extensions/<bundle>/` — computed as
> _diff(base+bundle build, base build)_: the bundle's subtrees are merged into the
> core roots in a temp tree so the single-root loaders see them at compile, and
> only the NEW/DIFFERING files are kept. The base trees stay byte-identical (so the
> 32-stage/13-agent base pins are untouched), and `package.ts --check` byte-pins
> every delta. The delta sits at the install root (a sibling of `.claude`/`.codex`/
> `.agents`), keyed install-root-relative, so a user overlays the bundle dir onto
> their install — and codex's out-of-harness `.agents/skills/` runner is captured
> by the same diff with **no** emit() change. Activation is via the existing scope
> grid (a bundle stage gated `scopes: [enterprise]`); the dedicated `when:`
> predicate (Layer 4) and the per-stage contribution seam (§4) are not yet built.
> Fixture: `extensions/ops-min/`.

## 1. Context — why this is being built

AIDLC v2 today ships a single hand-authored core (32 stages, 13 agents, 9
scopes, layered rules/sensors) projected into per-harness `dist/` trees. The
methodology is meant to be reshaped, and the immediate driver is a **large
optional operation phase** that needs to:

1. **add** new operation stages, and
2. **make existing upstream stages do more** — e.g. capture operational
   non-functional requirements (NFRs), emit extra artifacts, ask extra
   questions, enforce extra sections.

Investigation (see §9, evidence) showed that AIDLC has **no first-class
extension concept** and that the _only_ edit-free seam for adding behavior to an
existing stage is **rules attached by phase** (`resolveRulesForStage`,
`core/tools/aidlc-graph.ts:463-476` — strict-additive concatenation). Everything
else that determines what a stage _does_ (`produces`, `consumes`, `sensors`, the
`## Steps` body, the questions it asks, its required sections) lives inside a
single file the framework explicitly calls **immutable** (the `## Learn`
compartment: "Stage files are immutable framework artefacts").

Worse, adding even a _new_ stage today requires hand-editing a **generated**
file: stage `number` and `name` live only in the committed
`dist/.../stage-graph.json`, and `compileStageGraph()` harvests them by slug and
**throws if missing** (`core/tools/aidlc-graph.ts:1092-1100`). This circularity
blocks the "drop files in, recompile" premise an extension system needs.

**Intended outcome:** turn "extending AIDLC" into a supported, reversible,
multi-tenant composition. A bundle is authored in its own tree, discovered
automatically, activated by a predicate, merged at compile time with
strict-additive semantics, and removable by disabling it — with `core/`
untouched and the drift guard green.

## 2. Design principles

- **Generalize the one proven pattern.** `resolveRulesForStage` already composes
  a stage's effective behavior from a base plus external pieces, additively, with
  no override logic. The mechanism widens that from _per-phase rules_ to
  _per-stage contributions_ across the other surfaces. No new conceptual model.
- **Strict-additive, never override.** The codebase's load-bearing invariant is
  "no drop logic, no overrides" (`aidlc-graph.ts:270-284`). Contributions append;
  conflicts are rejected at compile, never silently resolved. Append-only merge
  is commutative for structural surfaces, which is what makes it safe for
  independent authors.
- **Core immutability is preserved.** No bundle ever edits a `core/` stage file.
  Contributions live entirely in the bundle's own tree.
- **Reversible & inert when off.** Bundle disabled ⇒ contributions vanish ⇒ core
  compiles byte-identical to today.
- **Deterministic from authored sources.** Compile must not depend on a
  hand-seeded generated file (fix the `number`/`name` circularity first).

## 3. Foundation layers (prerequisites)

These are ordered by dependency. **Layer 0 is non-negotiable** — without it,
nothing downstream is achievable, and it has standalone value (it unblocks even
plain core stage authoring).

### Layer 0 — Deterministic compile (remove the dist-seed circularity)

**Problem:** `number` + `name` exist only in committed `dist/.../stage-graph.json`;
`compileStageGraph()` seeds from them and throws if a slug is missing
(`aidlc-graph.ts:1032-1034`, `1092-1100`). `package.ts` stashes/restores that
seed around every build (`seedCompiledData`, `scripts/package.ts:142-152`,
`314-337`).

**Fix:** make `number` + `name` **authored stage frontmatter**.

- Add both to `REQUIRED_FIELDS`/`OPTIONAL_FIELDS` in
  `core/tools/aidlc-stage-schema.ts` so the Rule-3 unknown-key guard stops
  rejecting them.
- `compileStageGraph()` reads them from YAML; delete the `numberBySlug`/
  `nameBySlug` harvest and the throw.
- Delete `COMPILED_DATA` seed stash/restore in `scripts/package.ts`.
- One-time migration script: lift the current `{slug, number, name}` rows out of
  `dist/claude/.claude/tools/data/stage-graph.json` into each core stage's
  frontmatter. Mechanical, 32 stages.

**Why authored, not topologically derived:** the spec
(`core/aidlc-common/protocols/stage-definition.md:69-78`) describes deriving
`number` as `<phase-prefix>.<topoIndex>`, but derivation means an inserted
extension stage **renumbers downstream core stages**, destabilizing
`resolveStage(number)` (`aidlc-lib.ts:1620-1626`), jump-audit records
(`aidlc-jump.ts:172`), and the SKILL.md table. Authored numbers let a bundle
claim its own range and touch nothing in core. (`name` may safely be derived
from the H1 — no stability concern — if preferred.)

### Layer 1 — Ownership identity (`bundle:`)

Add an optional `bundle:` field to stages, agents, scopes, rules, and sensors,
defaulting to `core`. A bundle is a named set of contributions. Every downstream
layer keys off this single field — packaging, drift, tests all become
_per-bundle_ instead of _global literal_.

### Layer 2 — Extension manifest + discovery

#### Where an extension lives — the folder grammar

The repo already has a three-folder grammar, and an extension is a **fourth
axis** orthogonal to all three:

| Folder | Role | Sense |
|--------|------|-------|
| `core/` | harness-neutral source of truth | the *what* |
| `harness/<name>/` | per-harness projection surface | the *how to emit* |
| `dist/<harness>/` | generated, committed output users copy in | the *result* |
| `extensions/<name>/` | **optional, owned contribution set** | the *add-on* |

An extension is not a harness (that is the emit *target*) and not core (it is
*optional* and *owned*), so it earns its own top-level sibling directory. Two
properties this gets right:

- **Discovery mirrors harnesses.** `discoverExtensions()` scans
  `extensions/<name>/` for an `extension.ts`, exactly as `discoverHarnessNames()`
  (`scripts/package.ts:66-71`) scans `harness/<name>/` for `manifest.ts`. Same
  proven open-set pattern, no new concept.
- **An extension is harness-neutral, like `core/`.** Its internal subtree shape
  *is* `core/`'s shape, so the packager projects it into **every** harness's
  dist — author once, get Claude + Kiro + Codex. An extension MUST NOT be
  authored per-harness; that would fork the very thing "one core, many
  harnesses" avoids.

Authoring layout (mirrors `core/`'s subtrees):

```
extensions/
  ops-pro/
    extension.ts                      # the manifest (below)
    stages/operation/*.md             # new stages (own number range)
    agents/aidlc-*.md                 # new agents
    scopes/aidlc-*.md                 # new scopes
    rules/aidlc-phase-*.md            # phase-rule additions
    sensors/aidlc-*.md                # new sensors
    knowledge/...                     # per-agent / shared knowledge
    contributions/<phase>/<slug>.md   # additive deltas to existing stages (§4)
```

#### Where it lands in a consumer's install

When the packager builds an enabled extension, it is projected as a **committed
delta beside the base tree**, not interleaved into it:

```
dist/claude/.claude/                     # base (copied as today)
dist/claude/.claude/extensions/ops-pro/  # the extension's projected files
```

The user copies `dist/<harness>/.claude/` as today; the extension rides along as
a self-contained subtree they can include or omit. The drift guard byte-pins the
base tree and each extension delta independently (Layer 3), so "optional" stays
real and `--check` does not conflate the two.

#### First-party vs third-party — same structure, different repo

The only real fork is *whose repo the `extensions/<name>/` folder is in*:

- **First-party** extensions (e.g. the operation phase, `extensions/ops-pro/`)
  live **in this repo**, reviewed and versioned with AIDLC, shipped in `dist/`.
- **Third-party** extensions are authored in **their own repo** with the
  *identical* internal structure. They reach a user either by being vendored
  into `extensions/` for a build, or installed directly into an existing
  `dist/<harness>/.claude/extensions/<bundle>/`. `requiresBundle` (below) lets a
  third-party extension declare a dependency on `core` or another bundle.

#### The manifest

`discoverExtensions()` loads each `extensions/<name>/extension.ts`:

```ts
export default {
  name: "ops-pro",
  version: "1.0.0",
  numberRanges: { operation: ["4.50", "4.99"] }, // claimed stage-number range(s)
  requiresBundle: [], // e.g. ["compliance@^1"]
  contributes: {
    stages: "stages/", // new stages (own tree)
    agents: "agents/",
    scopes: "scopes/",
    rules: "rules/",
    sensors: "sensors/",
    overlays: "contributions/", // per-stage contributions (see §4)
  },
} satisfies ExtensionManifest;
```

The bundle lives in its own tree (`extensions/ops-pro/`), reviewable as one unit.

### Layer 3 — Variant-aware packaging + drift guard

Today `coreDirs`/`harnessFiles` are unconditional enumerations
(`harness/claude/manifest.ts:26-39`) and `--check` assumes one deterministic
build == one committed tree per harness, with an ORPHAN scan
(`scripts/package.ts:363-369`) that would flag any extension file.

**Fix:** the packager builds _base_ and _base+bundle_ variants. Each bundle's
projected output is committed as a **separate delta** under
`dist/<harness>/extensions/<bundle>/`. The drift guard byte-pins each variant
independently — no count explosion, extension stays optional, ORPHAN scan
becomes bundle-aware (files under a known bundle delta are not orphans).

### Layer 4 — A real activation predicate (`when:`) — IMPLEMENTED (`producer-in-plan`)

The reserved `when:` key is now an accepted, validated structured predicate.

**As-built:** `when:` is a single-key map; the key is in `WHEN_PREDICATE_KEYS`
(schema) and the value is a kebab-case artifact slug. The one shipped predicate:

- **`{producer-in-plan: X}`** — the stage is EXECUTE under a scope only if some
  stage producing artifact `X` is itself EXECUTE on that scope's resolved plan;
  otherwise SKIP. This promotes the old `validateScope` "producer off-path"
  *advisory* into a real compile-time gate, and is a structured replacement for
  the freeform prose `condition:` field.

**Evaluation is at COMPILE, baked into `scope-grid.json`** — the runtime stays
read-only (`nextInScopeStage` reads `mapping.stages[slug] === "EXECUTE"`).
`transposeScopeGrid` stays a pure transpose; a new `applyPredicates` pass runs a
per-scope **fixpoint** after it (greatest fixpoint: a stage is SKIPped only when
no producer of its artifact is EXECUTE; transitive chains cascade; self-sustaining
producing-cycles stay EXECUTE). The lib-side transpose fallback refuses to run
when a stage carries `when:` and no compiled grid exists (directs to
`aidlc-graph compile`) rather than mis-resolving.

**`{bundle-active}` is intentionally NOT implemented** — it is redundant with the
Layer 3 delta model: a bundle's stages only exist in its committed delta, and
there is no runtime activation signal, so "bundle active" is already a
compile/install fact. The schema accommodates it as a future `WHEN_PREDICATE_KEYS`
entry if a genuine need appears.

Fixture: `extensions/ops-min/stages/operation/ops-min-verify.md` carries
`when: {producer-in-plan: ops-min-deploy-record}` and lists `[enterprise,
feature]`; its producer is enterprise-only, so verify is EXECUTE under enterprise
and SKIP under feature — the predicate flip.

### Layer 5 — Bundle-aware tests

Replace the ~15 hand-authored literal rosters (the `32`/`13`/`9` counts, plus the
**stale `11`-agent literals** in `t04`/`t46`/`t110` that already disagree with
the `13` in `t01`/`t61`/`t66`) with one computed-from-source roster partitioned
by bundle: "core ships exactly N (frozen); each bundle exactly M." This also
fixes the existing 11-vs-13 drift by giving counts a single source.

## 4. The per-stage contribution seam (the core of "modify existing stages")

A **contribution** (a.k.a. overlay) is a file shipped by a bundle that declares
_additive deltas_ to a named existing stage. It lives at
`extensions/<bundle>/contributions/<phase>/<slug>.md` and never edits the base
stage.

```yaml
---
target: nfr-requirements # existing stage slug
bundle: ops-pro
when: { bundle-active: ops-pro } # inert when bundle off
adds:
  produces:
    - ops-pro/operational-nfr-requirements # namespaced (see §5)
  consumes:
    - artifact: core/business-logic-model
      required: false
  sensors:
    - ops-pro/operational-nfr-sections
  required_sections: # machine-checked (requires §6 sensor upgrade)
    - "Operational NFRs"
  fragments:
    - anchor: after-step:3 # deterministic insertion point
      kind: steps
      order: 100 # cross-bundle ordering (see §5)
      file: fragments/ops-nfr-steps.md
    - anchor: questions
      kind: questions
      order: 100
      file: fragments/ops-nfr-questions.md
---
```

### Merge point & semantics

The compiler merges base stage + all _active_ contributions into the effective
`stage-graph.json` node, at the same compile pass where `resolveRulesForStage`
already runs (`compileStageGraph`, around `aidlc-graph.ts:1117`). Merge rules:

- **Structural surfaces** (`produces`, `consumes`, `requires_stage`, `sensors`,
  `required_sections`) — set **union**. The artifact registry already derives
  from the union of all `produces[]` (`artifactsRegistry`,
  `aidlc-graph.ts:855-866`), so this is commutative and order-independent.
- **Prose surfaces** (`fragments` of kind `steps`/`questions`) — appended at the
  declared `anchor`, ordered by `order` then bundle name (see §5.2). The agent
  loads base body + ordered fragments at runtime, exactly as it loads
  concatenated rules today.
- **No override, ever.** A contribution can only _add_. Conflicts (e.g. two
  bundles claiming the same anchor+order, an unsatisfiable edge) are compile
  errors with bundle attribution (§5.3).

### Surface-by-surface map

| Upstream change ops needs                     | Today's seam                                       | Mechanism                                                                          |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Inject NFR **policy/guardrails** into a phase | ✅ rules-by-phase (edit-free)                      | Ship `aidlc-phase-<p>.md` additions from the bundle. **Works on Layer 0–1 alone.** |
| Stage **asks new questions**                  | ❌ body prose only                                 | `fragments` of kind `questions`                                                    |
| Stage **produces extra artifact**             | ❌ `produces[]` + body prose                       | `adds.produces` (DAG half) + `fragments` of kind `steps` (emit half)               |
| Stage **requires new sections**               | ⚠️ tool counts ≥2 H2; per-stage override is prose  | `adds.required_sections` + §6 sensor upgrade to make it enforced                   |
| Add a **verification** to a stage             | ⚠️ new sensor authorable, wiring edits `sensors[]` | `adds.sensors` (per-stage attachment, no frontmatter edit)                         |
| Add **DAG edges**                             | ✅ logical-name string match                       | `adds.consumes` / `adds.requires_stage` — no body edit for the consume side        |

## 5. Multi-tenant guards (safe for independent authors)

Single-author additive is easy. Independent authors who never coordinate need
four guards that do not exist today.

### 5.1 Namespacing (artifacts + number ranges)

- **Artifacts:** contributed logical names MUST be bundle-prefixed
  (`ops-pro/runbook-spec`); `core/*` is reserved. Extend the existing
  `ARTIFACT_SLUG_RE` validation (`aidlc-stage-schema.ts:245-246`) to enforce the
  namespace rule. Prevents two bundles silently aliasing a name like `cost-model`.
- **Stage numbers:** a bundle _claims_ a range in its manifest
  (`numberRanges`); the compiler rejects overlaps between bundles and between a
  bundle and core. Prevents two extensions fighting over `4.8`.

### 5.2 Deterministic fragment ordering

The DAG layer merges order-independently, but **body fragments are sequential
prose the agent reads in order** — the one non-commutative surface. Two bundles
inserting at the same anchor are ordered by explicit `order:` then bundle name
(lexical), never by load order. Documented and validated.

### 5.3 Cross-bundle conflict attribution

The compiler validates the **fully-merged** graph and reports _which bundle_
introduced an unsatisfiable edge. `validateScope` already walks consumes
(`aidlc-graph.ts:811+`); it grows bundle-attribution so a third party sees
`ops-pro requires compliance/audit-trail, not present` rather than a generic
orphan.

### 5.4 Bundle dependencies + versioning

If `ops-pro` legitimately builds on `compliance`, that's a manifest-declared
dependency (`requiresBundle: ["compliance@^1"]`), checked at discovery — the same
way harness manifests declare their shape, extended to bundle-to-bundle. Enables
an ecosystem to layer.

## 6. The honest caveat — structural vs prose contributions

Two surfaces are **agent-interpreted prose, not machine-parsed data**:

- **Required sections:** the tool only counts `≥2 H2`
  (`core/tools/aidlc-sensor-required-sections.ts:75`); the per-stage override is
  prose the LLM reads, not data the tool enforces.
- **Questions:** pure body prose; the protocol states stages list "topic areas
  and example questions… guidance, not a script" (`stage-protocol.md:257`).

So a contributed required-section or question is, today, **advisory** — nothing
verifies a stranger's contribution. Make this an explicit, documented tier
distinction:

- **Structural contributions** (`produces`/`consumes`/`requires_stage`/`sensors`)
  — machine-merged and validated; full guarantee.
- **Prose contributions** (`questions`/`steps`) — composed and ordered but
  agent-interpreted; best-effort.

To make contributed required-sections genuinely _enforced_, promote per-stage
required-sections to real machine-checked data the sensor consults (a per-stage
section list, bundle-contributable). Decide explicitly per surface: enforced or
guided. Authors must know which guarantee they get.

## 7. Worked example — the operation phase as first consumer

The operations phase is the **first consumer** of the mechanism, not a special
case in it.

**Factual correction to the original premise:** NFRs are captured in
**construction** today (`nfr-requirements`, `nfr-design`, both
`for_each: unit-of-work`, under `core/aidlc-common/stages/construction/`), not
inception. Inception's `requirements-analysis` captures NFRs only as loose prose.
So "operations needs operational NFRs" means extending the construction NFR
stages (and/or adding earlier capture), which is precisely the upstream-modify
case.

`extensions/ops-pro/` contains:

- **New stages** — `extensions/ops-pro/stages/operation/*.md`, numbered in the
  claimed `4.50–4.99` range, gated `when: {bundle-active: ops-pro}`, owning their
  agents.
- **New agents** (only if a role isn't covered by `aidlc-operations-agent` /
  `aidlc-aws-platform-agent` / `aidlc-quality-agent`).
- **Phase rules** — `extensions/ops-pro/rules/aidlc-phase-construction.md`
  additions injecting operational-NFR guardrails. **This part works on Layer 0–1
  alone** (rules-by-phase is already edit-free).
- **Contributions** — `contributions/construction/nfr-requirements.md` adding
  operational-NFR questions (`fragments`/questions), an extra produced artifact
  `ops-pro/operational-nfr-requirements` (`adds.produces` + `fragments`/steps),
  and an enforced `Operational NFRs` section (`adds.required_sections` + §6
  upgrade).
- **Optional consumes** on existing operation stages, gated by
  `when: {producer-in-plan: …}` instead of `required: false` side-effects.

Net: **zero edits to `core/`, zero hand-edits to `dist/`, drift guard green**,
fully reversible by disabling the bundle.

## 8. Phasing / minimal viable subset

1. **Layer 0** — deterministic compile. Non-negotiable; standalone value.
2. **Layer 1** — `bundle:` identity. Cheap; unlocks everything.
3. **Ship ops phase rules + new stages** on 0+1, gated by a scope, to deliver the
   operations phase quickly.
4. **Layers 2–4 + §4 contribution seam** — make it first-class and repeatable;
   migrate the scope-gate to `when: {bundle-active}`.
5. **§5 multi-tenant guards + Layer 5 tests** — make it safe for third parties.
6. **§6** — promote enforced surfaces per explicit decision.

Layers 0–1 + phase rules + new stages is enough for the operation phase itself.
Layers 2–5 + §4–6 are what make the mechanism _generic for other authors_.

## 9. Evidence index (verified file:line references)

- Rules-by-phase additive seam: `resolveRulesForStage`, `aidlc-graph.ts:463-476`;
  strict-additive model comment `aidlc-graph.ts:270-284`; rule scope union
  `aidlc-graph.ts:286-296`. **No per-stage rule attachment exists** — only
  org/team/project/phase.
- `number`/`name` seed + throw: `aidlc-graph.ts:1032-1034`, `1092-1100`; spec for
  intended derivation `stage-definition.md:69-78`.
- Packager seed stash/restore: `scripts/package.ts:114-152`, `202-218`, `314-337`;
  `COMPILED_DATA` line 116.
- Harness discovery (pattern to mirror): `scripts/package.ts:66-71`; manifest
  shape `scripts/manifest-types.ts:70-99`; enumerated `coreDirs`
  `harness/claude/manifest.ts:26-39`.
- Drift guard + ORPHAN scan: `scripts/package.ts:342-407` (orphan 363-369); graph
  `compile --check` `aidlc-graph.ts:1239-1265`.
- Scope grid is a pure transpose: `transposeScopeGrid`, `aidlc-graph.ts:982-996`;
  valid scopes from disk `validScopes`, `aidlc-lib.ts:1051-1056`.
- Reserved `when:` and other keys: `RESERVED_KEYS` in `aidlc-stage-schema.ts`;
  future-home note in `validateScope` `aidlc-graph.ts:811+`.
- Artifacts are logical names: `docs/reference/16-artifact-vocabulary.md:22-25`,
  `49-53`; registry derivation `artifactsRegistry`, `aidlc-graph.ts:855-866`;
  slug regex `aidlc-stage-schema.ts:245-246`.
- NFR stages (construction, not inception): `nfr-requirements.md` /
  `nfr-design.md` under `core/aidlc-common/stages/construction/`;
  `performance-validation.md:9-28` shows operation→construction NFR consume.
- Required-sections sensor counts ≥2 H2: `aidlc-sensor-required-sections.ts:75`;
  per-stage override is prose `core/sensors/aidlc-required-sections.md:34-38`.
- Questions are runtime prose: `stage-protocol.md:257`, `262-280`.
- Stage immutability contract: `## Learn` compartment of any stage file ("Stage
  files are immutable framework artefacts").
- Count-pins to migrate (Layer 5): `tests/smoke/t01-file-structure.test.ts`
  (32 stages / 13 agents / path count); `tests/unit/t124`/`t125` (9 scopes);
  stale 11-agent literals `t04`/`t46`/`t110`; computed-count pins `t14`/`t05`/
  `t87`/`t129`/`t61`/`t66`/`t39-count`.
