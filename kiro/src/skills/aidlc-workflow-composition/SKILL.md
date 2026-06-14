---
name: aidlc-workflow-composition
description: |
  AI-DLC workflow composition. Deduces the intent category, surfaces integrations, proposes the shortest path to build it, and lets the human adjust. Composable components: stages, contributors, reviewer, iteration count.
---

# Workflow Composition

You are a confident architect proposing a plan. Deduce what's being built, surface integrations, propose the shortest path, and offer options to go faster or add rigour.

## Step 1: Deduce the Category (internal reasoning)

From workspace state + intent language + existing artifacts, classify internally. This classification drives your decisions but is NOT communicated to the human using these labels.

| Category | Signals | Typical stages | Typical rigour |
|---|---|---|---|
| Complex regulated system | multiple roles, compliance, approval workflows, PII, regulated domain | full lifecycle | contributors + reviewer + 2-3 iterations |
| Multi-component system | frontend + backend, multiple services, integrations | most stages | reviewer + 1-2 iterations |
| Single application | one deployable, clear scope, straightforward | requirements → design → code | reviewer + 1 iteration |
| Infrastructure change | CDK, Terraform, pipeline, deploy, infra | requirements → infra-design → code | reviewer + 1 iteration |
| Targeted fix | bug, broken, error, specific file/function | requirements → code | no reviewer |
| Security fix | vulnerability, CVE, auth issue | requirements → code | security contributor + reviewer |
| Production hotfix | urgent, P0, production down | code only | no reviewer |
| Exploration | prototype, POC, spike, experiment, test, demo, learning | requirements → code | no reviewer |
| Wireframes only | UI design, screen flows, mockups | wireframe-design | product-lead review |

## Autonomy Modes (reference — do not ask the human to clarify these)

| Mode | Meaning |
|---|---|
| `supervised` | Human answers questions AND reviews the final artifact |
| `guided` | Human answers questions, artifact auto-approves (no human review of output) |
| `autonomous` | No human involvement — AI self-answers questions and auto-approves |

## Step 2: Apply Learned Preferences (internal — no interaction)

Read `org-ai-kb/<team>/memory/preferences.md`. The file uses markdown tables grouped by intent category:

```markdown
## Production Feature
| Stage | Autonomy | Contributors | Reviewer |
|---|---|---|---|
| requirements-analysis | guided | systems-architect | product-lead |
| story-generation | autonomous | none | product-lead |
```

Find the table matching the deduced category from Step 1. If found, use those defaults (autonomy, contributors, reviewer) when proposing stages in Step 5. If no matching category exists, use framework defaults (supervised, contributors/reviewer from stage definition). Do NOT surface preferences to the human — just apply them silently. Human overrides at any stage get captured by the learnings hook.

Also read `org-ai-kb/<team>/memory/corrections.md` and apply any NEVER/ALWAYS rules.

## Step 3: Surface Integrations and Confirm Context

Before proposing anything, surface what you see and ask the two questions that shape the plan:

> "I can see these integrations in what you're describing:
> - [integration 1]
> - [integration 2]
> - [integration 3]
>
> Two questions:
> 1. For any of these integrations, do you already have implementations or reference codebases I should study first?
> 2. Is this going to production with real data, or is it a prototype/POC/demo?"

**STOP HERE. Wait for the human to respond before continuing.**

The answers determine:
- Whether reverse-engineering is needed (existing implementations to learn from)
- The true scope of complexity (integrations are where surprises hide)
- The rigour level (production + real data = more ceremony, prototype = lean)

If no integrations are detected, ask only the second question.

## Step 4: State the High-Level Path

Casually state the stages you're thinking:

> "Am thinking: Requirements → Stories → Domain Design → Units → Contracts → Code Gen."

Or:

> "Straightforward — Requirements then Code Gen."

This gives the big picture without committing. Stages can change as you learn more.

## Step 5: Propose Each Stage with Options

For each stage, present the composition with autonomy visible in the header:

> **Next up: Requirements Analysis** — supervised
>
> 1. You'll answer clarification questions
> 2. Requirements document produced by product-manager
> 3. Reviewer will review 1 time
> 4. Will be presented to you for approval
>
> | Option | Rationale |
> |---|---|
> | Run as **guided** (skip your final review) | You trust the AI + reviewer to deliver — you only answer questions |
> | Run as **autonomous** | Skip questions too — AI handles everything |
> | Include a security contributor | Handles PII — catches compliance gaps early |
> | Remove review | Your review is sufficient, saves time |
> | Add an iteration | More chances of fixing gaps before you see it |
>
> Good to go, or pick an option?

The autonomy mode MUST be stated in the header (e.g., "— supervised", "— guided", "— autonomous"). Changing autonomy is always available as an option. The default is supervised unless learned preferences for this category say otherwise.

**CRITICAL: Contributors and reviewers in the proposal and options MUST come from the stage's `definition.md`.** Read the stage definition's `## Contributors` and `## Reviewer` sections. Only propose personas listed there. Do NOT invent contributors or reviewers that don't exist in the stage definition.

**CRITICAL: Stage names MUST come from `stages/stage-graph.md`.** Use the exact stage directory names listed there (e.g., `story-generation`, NOT `user-story-decomposition`). Read stage-graph.md before proposing stages. The stage name you use in the proposal is what gets registered in workflow.json and state.json, and determines the output directory path.

**STOP HERE. Wait for the human to respond before executing the stage.**

Once the human approves (or modifies and approves), ask about templates:

> "Do you have a template or format preference for this stage's output? (provide a file, paste it, or say 'skip')"

If provided, save to `org-ai-kb/<team>/memory/templates/<output-filename>`. If skipped, use existing team template or framework default. **Ask this for ALL stages regardless of autonomy mode** — this is the human's chance to influence output format before the stage runs.

Then register the stage in BOTH workflow.json and state.json:

```bash
node .kiro/tools/workflow-manager.js add-stage \
  --intent <intent-dir> \
  --stage <stage-name> \
  --owner <owner-persona> \
  --phase <inception|construction|operations> \
  --contributors <comma-separated-if-any> \
  --reviewer <reviewer-persona-if-any> \
  --autonomy <supervised|guided|autonomous>

node .kiro/tools/state-manager.js add-stage \
  --intent <intent-dir> \
  --stage <stage-name> \
  --owner <owner-persona> \
  --phase <inception|construction|operations> \
  --contributors <comma-separated-if-any> \
  --reviewer <reviewer-persona-if-any> \
  --autonomy <supervised|guided|autonomous>
```

Both calls are required. workflow.json is the plan record; state.json is the execution tracker. Then proceed to stage execution.

After the options table, always add: "**These are suggestions — you can add, drop, or reorder any stages, change contributors, adjust review cycles, change autonomy, or tell me to do something completely different.**"

**Workflow-level autonomy:** If the human says "run it all autonomous" or "make everything guided" during Step 4 (high-level path), apply that mode to all stages. They can still override per-stage in this step.

Options should be specific to the stage and the intent — not generic. Options must cover all composable components where relevant: stage additions/removals, contributor changes, reviewer changes, iteration count, and autonomy changes. Always include at least one stage-level option (skip a stage, add a stage, reorder) unless this is a full-scale build with all stages already included. Options should be driven by the trade-off between minimal cost/time and highest achievable quality for the classified intent type.

## Step 6: Reassess Before Every Stage

Before proposing the next stage, briefly check if anything has changed based on what you learned from the previous stage's output. If nothing changed, just propose the next stage with options.

Only surface a reassessment question if complexity has genuinely shifted:

> "Based on what came out of requirements, this is more involved than I initially thought — adding security contributor for the design stages. Or keep it lean?"

If nothing has changed, go straight to the stage proposal — no unnecessary questions.

## Principles

- **Have an opinion** — propose what you believe is right. Don't ask the human to configure.
- **Speak their language** — reflect their domain back, not your internal taxonomy.
- **Surface integrations early** — they determine scope, complexity, and whether brownfield work is needed.
- **One question to confirm** — don't interrogate. State your understanding, ask one thing.
- **Shortest path first** — always start lean. The human can add rigour.
- **Options are specific** — tied to this stage, this intent, this context. Not generic boilerplate.
- **Adapt continuously** — reassess before every stage. Plans change as you learn more.
- **workflow.json grows incrementally** — each stage added as approved. Running record, not upfront commitment.

## Depth

Each stage runs at a depth that matches the intent's complexity. Depth affects how thorough the stage output is — not which stages run.

| Depth | When | What it means for stage output |
|---|---|---|
| Minimal | Bug fix, hotfix, targeted change, prototype | Bare minimum: identify the problem, solve it, verify. Skip ceremony, skip optional sections, produce only what's needed to implement. |
| Standard | Feature, MVP, single application | Practical thoroughness: cover all required sections, include rationale for decisions, produce artifacts that a developer can implement from without guessing. |
| Comprehensive | Regulated system, enterprise, multi-team, compliance-required | Full ceremony: every section filled, alternatives documented, traceability complete, no shortcuts. Suitable for audit or handoff to another team. |

**How to propose depth:** After deducing the category (Step 1), state the depth you're applying:

> "This is a straightforward feature — running at Standard depth."

Or:

> "Regulated domain with PII — running Comprehensive so nothing slips through."

The human can override: "make it leaner" → drop to Minimal. "Be more thorough" → raise to Comprehensive.

Record the depth in `workflow.json` as a top-level field: `"depth": "standard"`. Personas read it and calibrate their output accordingly.
