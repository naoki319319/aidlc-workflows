# Change Spec: Reviewer Agent Implementation

> A minimum viable reviewer mechanism for the unified AI-DLC architecture.

---

## Summary

Every stage can optionally declare a reviewer agent. The reviewer is a **separate sub-agent invocation** — not the main agent "wearing a hat," not a sensor, not a hook. It runs after the builder (main agent or sub-agent) produces the artifact, reviews it independently, and writes a verdict. If READY → proceed to gate. If NOT-READY → send back to builder for fixes.

---

## Design Principles

1. **No bias** — the reviewer does NOT inherit the builder's context/reasoning. It receives only the artifacts, the stage definition, and the Q&A. It forms its own judgment.
2. **Separate invocation** — always a sub-agent call. Never inline "wear the reviewer hat."
3. **Own skills and knowledge** — the reviewer persona has its own associated skills (e.g., architecture-review, requirements-review) that define what "good" looks like.
4. **Verdict in the document** — the reviewer appends a review section to the existing artifact (not a separate file). The verdict is visible alongside the content.
5. **Binary verdict** — READY or NOT-READY. No "advisory" middle ground. If not ready, specific gaps listed.
6. **Iteration cap** — maximum N review cycles (default 2) before escalating to human regardless.

---

## Flow

```
1. Builder (main agent inline OR sub-agent) produces artifact
2. Orchestrator invokes reviewer sub-agent:
   - Passes: stage definition, Q&A file, artifact file(s), validation tools list
   - Does NOT pass: builder's memory.md, builder's plan.md reasoning
3. Reviewer:
   a. Reads the artifact
   b. Runs any validation tools listed in stage definition
   c. Evaluates completeness, coherence, traceability against stage definition's ## Outputs
   d. Appends a ## Review section to the primary artifact:
      ```
      ## Review
      
      **Verdict:** READY | NOT-READY
      **Reviewer:** <persona-name>
      **Date:** <ISO timestamp>
      
      ### Findings
      - [finding 1]
      - [finding 2]
      
      ### Recommendation
      [what to fix, if NOT-READY]
      ```
   e. Returns to orchestrator
4. Orchestrator reads verdict:
   - READY → proceed to gate (present to human if supervised)
   - NOT-READY → send artifact + review back to builder → builder fixes → back to step 2
5. If iteration cap reached and still NOT-READY → proceed to gate with review findings noted
```

---

## Changes Required

### 1. Stage Definition Schema

**Add optional `reviewer:` field to stage frontmatter.**

Currently stages have: `lead_agent`, `support_agents`, `sensors`, `scopes`, etc.

Add:
```yaml
reviewer: aidlc-<role>-agent        # optional — if absent, no review step
reviewer_max_iterations: 2          # optional — default 2
```

**Files affected:**
- `core/aidlc-common/stages/inception/requirements-analysis.md` (and others that get a reviewer)
- `core/tools/aidlc-stage-schema.ts` (add reviewer field to schema validation)
- `core/tools/aidlc-graph.ts` (compile reviewer info onto stage graph node)

---

### 2. Reviewer Persona(s)

**Create reviewer agent(s) as `.md` files in `core/agents/`.**

Reviewers are distinct from builders. A reviewer has:
- Different stance (critical, gap-finding, standards-enforcing)
- Own skills (review methodology, not production methodology)
- No access to builder's reasoning (clean-room review)

**New files:**
- `core/agents/aidlc-architecture-reviewer-agent.md`
- `core/agents/aidlc-requirements-reviewer-agent.md`
- `core/agents/aidlc-code-reviewer-agent.md`

Or alternatively, one generic reviewer persona with different skills loaded per stage type. Design decision needed.

**Content:**
```markdown
---
name: aidlc-architecture-reviewer-agent
display_name: Architecture Reviewer
description: >
  Reviews technical design artifacts for completeness, coherence, and architectural soundness.
  Finds gaps, unstated assumptions, broken cross-references, and oversimplifications.
disallowedTools: Task
---

# Architecture Reviewer

You are a reviewer — not a builder. Your job is to find what's missing, 
what's inconsistent, and what will break later.

## You receive
- The stage definition (what SHOULD have been produced)
- The Q&A (what the human asked for)
- The artifact (what WAS produced)
- Validation tool results (if tools were run)

## You do NOT receive
- The builder's plan.md (their reasoning is not your concern)
- The builder's memory.md (their interpretations may bias you)

## Your job
- Check completeness against stage definition's ## Outputs
- Check coherence (does the artifact contradict itself?)
- Check traceability (can you trace outputs back to inputs?)
- Run validation tools if listed
- Write a verdict: READY or NOT-READY with specific findings
```

---

### 3. Stage Protocol Update

**Add a review step between "artifact produced" and "gate presentation."**

In `core/aidlc-common/protocols/stage-protocol.md`, add after the stage body completes:

```markdown
## Reviewer Step (if reviewer declared)

If the stage's frontmatter declares `reviewer:`:

1. Invoke the reviewer as a sub-agent (mode: subagent)
2. Pass to reviewer:
   - Stage definition file path
   - Q&A file path (questions.md with answers)
   - All artifact file paths (the stage's outputs)
   - Validation tools list from stage definition (if any)
3. Do NOT pass:
   - memory.md (builder's diary)
   - plan.md (builder's reasoning)
4. Wait for reviewer to return
5. Read the ## Review section appended to the primary artifact
6. If verdict = READY: proceed to §13 learnings ritual then gate
7. If verdict = NOT-READY and iterations < max:
   - Send artifact (with review findings) back to the builder
   - Builder addresses findings, updates artifact, removes/addresses review comments
   - Return to step 1 (re-invoke reviewer)
8. If verdict = NOT-READY and iterations >= max:
   - Proceed to gate with review findings noted
   - Present to human: "Reviewer found issues after N iterations. Presenting with unresolved findings."
```

**Files affected:**
- `core/aidlc-common/protocols/stage-protocol.md`

---

### 4. Orchestrator SKILL.md Update

**The orchestrator needs to know how to invoke the reviewer.**

In `harness/kiro/skills/aidlc/SKILL.md` (and `harness/claude/skills/aidlc/SKILL.md`), add to the `run-stage` handling:

After the stage body completes and before the learnings ritual:
- Check `directive.reviewer` (populated from compiled graph)
- If present: invoke reviewer sub-agent with the specified context
- Handle the READY/NOT-READY loop

**Files affected:**
- `harness/kiro/skills/aidlc/SKILL.md`
- `harness/claude/skills/aidlc/SKILL.md`

---

### 5. Engine Directive Update

**The `run-stage` directive should include reviewer info.**

Currently the directive has: `stage`, `stage_file`, `lead_agent`, `support_agents`, `gate`, `mode`, `memory_path`.

Add:
```json
{
  "reviewer": "aidlc-architecture-reviewer-agent",   // or null if no reviewer
  "reviewer_max_iterations": 2,
  "validation_tools": [                               // from stage definition
    "bun .kiro/tools/validate-entities.js --file entities.yaml --references components.yaml"
  ]
}
```

**Files affected:**
- `core/tools/aidlc-orchestrate.ts` (emit reviewer info in run-stage directive)
- `core/tools/aidlc-directive.ts` (add fields to RunStageDirective type)

---

### 6. Validation Tools

**Domain-specific validators that the reviewer runs.**

These already exist in our Kiro implementation. Port them to the unified architecture:

| Tool | Validates |
|------|-----------|
| `validate-domain-model.ts` | components — unique IDs, valid deps, no cycles |
| `validate-entities.ts` | entities — unique IDs, required fields, cross-refs |
| `validate-rules.ts` | rules — unique IDs, required fields, valid category |

**New files:**
- `core/tools/aidlc-validate-domain-model.ts`
- `core/tools/aidlc-validate-entities.ts`
- `core/tools/aidlc-validate-rules.ts`

---

### 7. Stage Definitions: Add Reviewer + Validation Tools

**Declare which stages have a reviewer and what tools the reviewer runs.**

Example for `requirements-analysis.md`:
```yaml
reviewer: aidlc-requirements-reviewer-agent
reviewer_max_iterations: 2
validation_tools: []   # no deterministic checks for prose requirements
```

Example for `application-design.md`:
```yaml
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
validation_tools:
  - "bun {{HARNESS_DIR}}/tools/aidlc-validate-domain-model.ts --file components.md"
```

**Files affected:**
- Every stage `.md` that should have a reviewer (design decision: which stages?)

---

### 8. Kiro Harness: Reviewer Agent Config

**For Kiro, the reviewer needs a `.json` agent config.**

```json
{
  "name": "aidlc-architecture-reviewer-agent",
  "description": "Reviews technical design artifacts for completeness and coherence.",
  "prompt": "...",
  "tools": ["read", "shell"],
  "resources": ["skill://.kiro/skills/aidlc-architecture-review/SKILL.md"]
}
```

Note: reviewer does NOT get "write" tool access to source code. Only "read" (to read artifacts) and "shell" (to run validation tools). It writes ONLY the review section to the artifact file.

**Files affected:**
- `harness/kiro/agents/aidlc-architecture-reviewer-agent.json` (new)
- `harness/kiro/agents/aidlc-requirements-reviewer-agent.json` (new)

---

## Design Decisions Needed

| Decision | Options | Recommendation |
|---|---|---|
| How many reviewer personas? | One generic reviewer with different skills per stage type / Multiple specialized reviewers | Multiple — a requirements reviewer thinks differently from an architecture reviewer |
| Which stages get a reviewer? | All / Only design stages / Configurable per stage | Configurable — declare in frontmatter. Start with inception + construction design stages. |
| Where does the review go? | Appended to primary artifact / Separate review.md file | Appended to artifact — keeps everything in one place, visible to human at gate |
| Does the reviewer have write access? | Full write / Write only to artifact / No write (returns verdict to orchestrator) | Write only to the artifact (append ## Review section). No other file writes. |
| What context does the reviewer get? | Everything / Artifacts + QnA only | Artifacts + Q&A + stage definition + validation tool results. NOT builder's plan/memory. |
| Does review happen for inline AND subagent modes? | Yes / Only subagent | Yes — both. The builder's mode doesn't affect whether review is needed. |

---

## Stages to Start With (MVP)

| Stage | Reviewer | Rationale |
|---|---|---|
| requirements-analysis | aidlc-requirements-reviewer-agent | Requirements are the foundation — gaps here cascade |
| application-design | aidlc-architecture-reviewer-agent | Architecture decisions are expensive to reverse |
| functional-design | aidlc-architecture-reviewer-agent | Business logic correctness matters |
| infrastructure-design | aidlc-architecture-reviewer-agent | Infra mistakes are expensive at deployment |
| code-generation | aidlc-code-reviewer-agent | Code quality directly affects the product |

Stages that likely DON'T need a reviewer (MVP):
- Initialization (deterministic, no artifacts to review)
- Intent capture (too early, too fluid)
- Market research, feasibility (exploratory, not prescriptive)
- Delivery planning (scheduling, not design)

---

## Iteration Loop Detail

```
Builder produces artifact (iteration 0)
    ↓
Reviewer reviews → NOT-READY (findings: A, B, C)
    ↓
Builder fixes A, B, C → updates artifact (iteration 1)
    ↓
Reviewer reviews → NOT-READY (finding: C still broken)
    ↓
Builder fixes C → updates artifact (iteration 2 = max)
    ↓
Reviewer reviews → READY
    ↓
Proceed to gate
```

If at iteration 2 the reviewer still says NOT-READY:
```
    ↓
Cap reached. Proceed to gate with:
"Reviewer found unresolved issues after 2 iterations: [findings]. Presenting for human decision."
```

The human then decides: approve anyway, request more fixes, or skip the stage.

---

## Non-Goals (Out of Scope for MVP)

- Reviewer modifying the artifact (it only appends a review section)
- Multiple reviewers per stage (one is sufficient for MVP)
- Reviewer-to-reviewer communication
- Reviewer accessing external resources (MCP servers, web)
- Reviewer running on every intermediate draft (it runs ONCE after builder is "done")
- Blocking the workflow on review failure (human always gets final say at gate)
