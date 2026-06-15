# Feature Requirements: org-ai-kb + Reviewer-as-Verifier

> Two features to bring into the unified AI-DLC architecture (v2-unified branch).
> Based on learnings from the standalone Kiro implementation exploration.

---

## Feature 1: org-ai-kb — Multi-Intent, Multi-Repo Workspace Architecture

### Customer Requirement

Real development teams need to:

1. **Work on multiple things simultaneously** — a feature in flight, a bug fix on the side, a spike exploring something new. They shouldn't have to finish one workflow before starting another.
2. **Span multiple repositories in one intent** — a backend in one repo, a frontend in another, shared infra in a third. One development intent often crosses repo boundaries.
3. **Accumulate team knowledge** — preferences, conventions, and decisions learned during one intent should automatically apply to future intents. Teams shouldn't repeat themselves.
4. **Hand off units to different teams** — after design produces components and units, different teams should be able to pick up individual units and work them independently while sharing the design artifacts.

### Current Implementation

```
project-root/
├── .claude/ (or .kiro/)     ← framework installed INSIDE one project
└── aidlc-docs/
    └── aidlc-state.md       ← ONE active workflow
```

- **Single intent:** Only one workflow exists at a time. `--init --force` wipes the previous to start fresh.
- **Single project:** `$CLAUDE_PROJECT_DIR` is the anchor. The framework lives inside one repo.
- **No cross-intent persistence:** Learnings write to `.claude/rules/` (project-level), but a second project starts from a blank slate.
- **Multi-repo via worktrees:** Parallel units build in git worktrees within the same repo. Cross-repo coordination requires separate sessions.

### Gap

| What's needed | What exists | Gap |
|---|---|---|
| Multiple intents coexist | One intent at a time | Intent-namespacing, no-wipe init |
| Intent spans multiple repos | Framework anchored to one project | Workspace-over-project architecture |
| Team knowledge persists across intents | Rules persist per-project, not per-team | Team-level memory directory |
| Units handed to separate teams | Swarm runs in one session on one machine | Shared artifact distribution |

### How to Bridge

#### Architecture Change: Workspace as the Anchor

```
workspace/                                ← the developer opens THIS
├── org-ai-kb/<team>/                     ← team-level knowledge layer
│   ├── aidlc-docs/
│   │   ├── intent-001-quiz-game/         ← intent 1 (full state, audit, artifacts)
│   │   │   ├── aidlc-state.md
│   │   │   ├── audit.md
│   │   │   └── <phase>/<stage>/...
│   │   └── intent-002-auth-service/      ← intent 2 (coexists)
│   │       └── ...
│   ├── memory/                           ← persists across intents
│   │   ├── preferences.md                ← composition preferences per category
│   │   ├── corrections.md                ← NEVER/ALWAYS rules
│   │   └── templates/                    ← custom output format overrides
│   ├── repo-docs/                        ← reverse-engineering artifacts per repo
│   │   ├── repo-a/
│   │   └── repo-b/
│   └── knowledge/                        ← team knowledge (shared across intents)
├── repo-a/                               ← code repo (its own git)
├── repo-b/                               ← code repo (its own git)
└── .claude/ (or .kiro/)                  ← framework installation
```

#### Changes Required

| Component | Current | Change |
|---|---|---|
| `aidlc-utility.ts` (init) | Guards against existing `aidlc-state.md`, refuses to scaffold | Creates new `intent-NNN` directory without wiping. Auto-increments. |
| `aidlc-lib.ts` (resolveProjectDir) | Returns workspace root where `.claude/` lives | Returns the active intent directory. Reads from pointer file or discovers latest. |
| `aidlc-state.ts` | Reads/writes `aidlc-docs/aidlc-state.md` | Reads/writes `org-ai-kb/<team>/aidlc-docs/intent-NNN/aidlc-state.md` |
| `aidlc-orchestrate.ts` (engine) | Resolves state from one fixed path | Resolves state from the active intent path. Supports `--list-intents`, `--switch`. |
| Stage files (artifact paths) | `aidlc-docs/<phase>/<stage>/` | Same structure, but under the intent directory |
| Init stages (workspace-scaffold) | Creates flat `aidlc-docs/` tree | Creates `org-ai-kb/<team>/aidlc-docs/intent-NNN/` tree + ensures memory/ exists |
| Learnings ritual (§13) | Writes to `.claude/rules/aidlc-project-learnings.md` | Writes to `org-ai-kb/<team>/memory/corrections.md` (team-scoped, survives across intents) |
| Team discovery | N/A (single project) | If one team folder exists → use it. If multiple → ask. If none → default. |
| New utility commands | N/A | `--list-intents` (show all), `--switch <name>` (change active), `--resume` (offer to continue) |

#### Backward Compatibility

- A project with flat `aidlc-docs/aidlc-state.md` (old format) should still work — the resolver falls back to the flat path if no `org-ai-kb/` structure exists.
- Migration path: `--init --migrate` converts flat structure to namespaced.

#### Multi-Repo Design

The key insight: **the framework doesn't need to "know about" multiple repos.** It just needs to:
1. Live at workspace level (above the repos), not inside one repo
2. Let reverse-engineering run per-repo and store results in `org-ai-kb/<team>/repo-docs/<repo-name>/`
3. Let code-generation target specific repo directories (the stage just writes to `../../repo-a/src/`)
4. Let the human or orchestrator specify which repo(s) an intent touches

No worktree machinery needed for cross-repo. Each repo is already isolated (its own git). Parallel code-gen across repos = parallel sub-agents writing to different directories.

#### Multi-Team Unit Handoff

After design produces `units.md` + `contracts/`:
1. Each unit's artifacts are available under `org-ai-kb/<team>/aidlc-docs/intent-NNN/`
2. A receiving team clones `org-ai-kb` (it's a shared repo) or receives the artifact files
3. That team creates their own intent for their assigned unit
4. They consume the shared contracts as inputs to their functional-design stage
5. Integration testing happens when all units are complete (verifies contracts hold)

---

## Feature 2: Reviewer-as-Verifier (LLM Quality Judgment Layer)

### Customer Requirement

Teams want quality verification of AI-produced design artifacts that:

1. **Catches semantic issues** — not just "does the file have headings?" but "is this design actually complete and coherent?"
2. **Adapts to team formats** — doesn't reject valid documents because of heading-level choices or section naming
3. **Provides actionable feedback** — not "SENSOR_FAILED: missing heading" but "the entity schema references a component that doesn't exist in the upstream design"
4. **Runs at the right time** — on the final artifact, not on every intermediate draft save
5. **Has judgment** — can say "this validation failure is acceptable because we intentionally skipped that upstream stage"

### Current Implementation

```
PostToolUse hook (Write/Edit)
    → reads sensors_applicable for active stage
    → spawns sensor scripts per file match
    → results go to audit log + detail files
    → advisory only, never blocks
```

**Sensors:**
- `required-sections` — counts `##` headings (≥2 required)
- `upstream-coverage` — greps for upstream artifact names in the output
- `linter` — runs ESLint on code snippets
- `type-check` — runs tsc on TypeScript snippets

**Limitations:**
- Fires on every single write (intermediate drafts → wasted computation)
- Structural checks only (regex, heading count, word grep)
- No judgment — can't distinguish "intentionally different format" from "forgot a section"
- Can't catch semantic issues (broken cross-references, missing business rules, incomplete coverage)
- Team format changes require editing TypeScript sensor code
- Nobody reads the sensor output files

### Gap

| What's needed | What exists | Gap |
|---|---|---|
| Semantic quality judgment | Structural regex checks | LLM reviewer that understands content |
| Adapts to team formats | Hardcoded format expectations | Reviewer reads team templates and judges against them |
| Runs at the right time | Fires on every write | Runs once during review phase |
| Actionable feedback | "SENSOR_FAILED: <id>" | "The entity schema is missing X because Y — fix or justify" |
| Cross-reference validation | Greps for keywords | Domain-aware validators (ID resolution, dependency graph checks) |

### How to Bridge

#### Architecture: Two-Layer Verification

```
Layer 1: Sensors (keep — cheap, deterministic, catches the floor)
    → YAML parses? IDs unique? Code compiles? Files exist?
    → Zero tokens. Milliseconds. Fire-and-forget.

Layer 2: Reviewer-as-Verifier (add — quality judgment, catches the ceiling)
    → Is the design complete? Coherent? Traceable?
    → Separate agentic invocation. Runs validation tools. Returns verdict.
```

#### Changes Required

| Component | Current | Change |
|---|---|---|
| Stage files | No `## Validation Tools` section | Add section listing domain-specific validators per stage |
| Stage protocol | No reviewer-runs-tools concept | Add: "If validation tools listed, reviewer runs them and includes results in verdict" |
| New tools | N/A | `validate-domain-model.js`, `validate-entities.js`, `validate-rules.js` (domain-aware, cross-referencing) |
| Reviewer invocation | Reviewer is a "support agent" loaded inline (same context as lead) | Reviewer is a **separate agentic invocation** that reads artifacts, runs tools, returns a verdict file |
| Stage execution flow | `run-stage` → produce artifact → gate | `run-stage` → produce artifact → **reviewer invocation** → gate (reviewer verdict informs gate presentation) |
| Sensor system | Fires on every Write/Edit via PostToolUse hook | Keep for cheap structural checks. Reviewer handles quality/semantic checks. |

#### The Reviewer Invocation Model

```
1. Owner persona produces artifact (inline or subagent)
2. Orchestrator invokes reviewer as SEPARATE sub-agent:
   - Reviewer reads: artifact, stage definition, templates, upstream artifacts
   - Reviewer runs: validation tools listed in stage definition
   - Reviewer writes: <reviewer-name>-review.md (verdict + findings)
   - Reviewer returns
3. Orchestrator reads verdict:
   - "ready" → proceed to gate
   - "not-ready" → send back to owner for revision (iteration loop)
4. At gate: present artifact + reviewer verdict to human
```

#### What Sensors Still Do

Sensors remain for zero-cost structural checks that have no judgment component:
- Does YAML parse? (yes/no — no judgment needed)
- Does TypeScript compile? (yes/no)
- Are all stage outputs non-empty? (existence check)

These can still fire on Write/Edit because they're cheap (milliseconds, zero tokens) and catch genuine errors early (a broken YAML mid-stage is worth knowing about immediately).

#### What the Reviewer Adds

The reviewer adds judgment-based verification that sensors can't do:
- "Does components.yaml's dependency graph have cycles?" (domain logic)
- "Does every entity in entities.yaml trace back to a requirement?" (traceability)
- "Is the functional-spec.md consistent with the entities.yaml it summarizes?" (coherence)
- "Are there business rules that reference entities not in this unit?" (cross-reference)
- "Is the design complete enough to implement from, given the depth level?" (completeness)

#### Validator Tools (the reviewer's instruments)

| Tool | What it checks | Cross-references |
|---|---|---|
| `validate-domain-model.js` | components.yaml: unique IDs, valid deps, no cycles, entities have names | Internal consistency |
| `validate-entities.js` | entities.yaml: unique IDs, required fields, relationship refs | Upstream components.yaml |
| `validate-rules.js` | rules.yaml: unique IDs, required fields, valid category | Upstream entities.yaml |
| `validate-contracts.js` (future) | contracts/: endpoints defined, schemas present, error codes | Upstream units.md |
| `validate-infrastructure.js` (future) | infra-spec: all components mapped, networking defined | Upstream nfr-design |

Tools are the reviewer's **instruments** — they provide facts. The reviewer provides judgment about what those facts mean.

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| **P0** | Multi-intent (intent-namespacing, no-wipe init) | Medium (path refactoring across tools) | Eliminates the #1 UX pain ("I have to wipe my last workflow") |
| **P0** | Reviewer-as-verifier (separate invocation + validation tools) | Medium (stage protocol change + new tools) | Adds quality judgment that sensors can't provide |
| **P1** | Team memory (memory/ directory, preferences, corrections) | Small (directory convention + learnings redirect) | Knowledge compounds across intents |
| **P1** | Template override layer (memory/templates/ > framework defaults) | Small (one resolution check in stage protocol) | Team formats survive framework updates |
| **P2** | Multi-repo support (workspace-over-project) | Medium (framework install location + RE per-repo) | Enables intents spanning multiple repos |
| **P2** | Utility commands (--list-intents, --switch, --resume) | Small (new utility handlers) | QoL for multi-intent |
| **P3** | Multi-team unit handoff | Large (shared artifact distribution, per-team intent spawning) | Enterprise team coordination |

---

## Summary

| Question | Answer |
|---|---|
| What does the customer need? | Work on multiple things, span repos, accumulate knowledge, get quality feedback with judgment |
| What exists today? | Single intent, single project, structural-only sensors, no team persistence |
| What's the gap? | Intent isolation, workspace architecture, LLM-based quality review |
| How do we bridge it? | Intent-namespacing in the engine + reviewer as separate agentic invocation with domain-aware tools |
| Does this compromise the engine's determinism? | No — the engine still owns routing. These features add workspace structure and a verification layer, not alternative routing. |
| Timeline estimate | P0 items: 4-6 weeks. P1: 2 weeks. P2-P3: future iterations. |
