---
name: aidlc-stage-execution
description: |
  AI-DLC stage execution. Defines how to drive each stage through its cycle — state transitions, persona invocation format, and rules. Read by the orchestrator when executing stages.
---

# Stage Execution

Drive each stage in the composed workflow through its cycle.

## Sequencing

For each stage:

1. Read **only** the current stage's `definition.md` (do NOT read all stage definitions upfront)
2. Verify inputs exist (outputs from prior stages)
3. **Stage brief + template check:**
   - Compose a brief statement explaining what will happen: inputs, outputs, what's needed from the human.
   - **If this stage's autonomy is guided or supervised:** Ask "Do you have a template or format preference for this stage's output? (provide file/paste, or skip)" If provided, save to `org-ai-kb/<team>/memory/templates/<output-filename>` for future use.
   - **If full autonomy:** Skip the template question (templates were requested once before the first stage — see below).
4. Drive the stage execution cycle (below)
5. After stage completes, update `state/state.json` outputs array with each output as `{"name": "<filename>", "locationRelativeToIntentRoot": "<path>/"}`
6. **Return to workflow composition** — after every stage completion, invoke `aidlc-workflow-composition` to propose the next stage. Do NOT auto-advance to the next stage mechanically. Composition proposes, human approves, then execution begins.

## Full-Autonomy Template Gate

When the entire workflow is set to full autonomy, there is ONE interaction point before execution begins:

> "You've chosen full autonomy — I'll run end-to-end without stopping. Before I begin: do you have any output templates to provide? (This is your only chance to influence formats — I won't stop between stages.)"

If the human provides templates, save them to `org-ai-kb/<team>/memory/templates/`. If they skip, use existing team templates or framework defaults. Then run all stages without interaction.

## Checkpoint

After each stage completes, update the checkpoint. This enables:

- **Re-entry** — loop back to a prior stage on rejection without losing progress
- **Resume** — resume from the last completed stage if interrupted
- **Visibility** — human can see what's done, in progress, and ahead

## State Transitions

Each row is one transition. The "Blocks on Human?" column determines whether the orchestrator must yield and wait for a human response before proceeding.

| # | From State | To State | State Setter | Activity | Blocks on Human? |
|---|---|---|---|---|---|
| 1 | pending | plan-and-clarify | Orchestrator | Invoke owner persona | NO |
| 2 | plan-and-clarify | clarification-asked | Owner | Wrote plan.md (and questions.md if questions exist) | NO |
| 3 | clarification-asked | clarification-provided | Orchestrator | Present plan and questions to human, write answers | **If supervised** |
| 4 | clarification-provided | further-clarification | Owner | Needs more answers (optional, may skip to #6) | NO |
| 5 | further-clarification | clarification-provided | Orchestrator | Present follow-up questions to human, write answers | **If supervised** |
| 6 | clarification-provided | artifact-generated | Owner | Produced output artifacts | NO |
| 7 | artifact-generated | contribution-needed | Orchestrator | Invoke contributors (skip to #10 if no contributors) | NO |
| 8 | contribution-needed | contributed | Contributors | All contributors wrote their contribution files | NO |
| 9 | contributed | refined | Owner | Addressed contributor feedback, updated artifacts | NO |
| 10 | refined | final-review-needed | Orchestrator | Invoke reviewer (skip to #13 if no reviewer) | NO |
| 11 | final-review-needed | final-review-complete | Reviewer | Returned verdict (READY or NOT-READY) | NO |
| 12a | final-review-complete (NOT-READY, iterations < max) | final-review-needed | Orchestrator | Increment reviewIterations, send back to owner then reviewer | NO |
| 12b | final-review-complete (READY) | presented | Orchestrator | Present artifact summary to human | NO |
| 12c | final-review-complete (NOT-READY, iterations >= max) | presented | Orchestrator | Bypass reviewer, present to human with unresolved findings noted | NO |
| 13 | presented | complete | Orchestrator | Record human's approval in audit, advance to next stage | **If supervised** |
| 14 | presented | changes-requested | Orchestrator | Record human's requested changes in audit | **If supervised** |
| 15 | changes-requested | finalised | Owner | Addressed human feedback, updated artifacts | NO |
| 16 | finalised | presented | Orchestrator | Re-present updated artifact to human | NO |

## Per-Stage Autonomy

Each stage in `workflow.json` has an `autonomy` property:

| Mode | Human Q&A | Human Review (gate) | Who decides contributors/reviewer |
|---|---|---|---|
| `full` | No — self-answered by owner's best judgment | No — auto-approved, immediately advances | AI decides during composition |
| `guided` | Yes — human answers clarification questions | No — auto-approved after artifact is produced | Human decides during composition |
| `supervised` | Yes — human answers clarification questions | Yes — blocks at `presented`, human must approve | Human decides during composition |

**Behaviour per mode:**

- **`full`** — The AI runs end-to-end. Questions are self-answered. The orchestrator decides whether to include contributors/reviewers (it may still use them for quality, but the human is not involved). The `presented` state is set for auditability but immediately advances to `complete`. Audit notes "auto-approved (full autonomy)."
- **`guided`** — The human answers clarification questions (plan is presented, questions block). But once the artifact is produced (and contributors/reviewers have done their internal work if assigned), it auto-advances to `complete` without presenting for human approval. The human shaped the plan but trusts the execution.
- **`supervised`** — Everything blocks on human. Questions are presented and answered by human. The final artifact is presented for human approval. The orchestrator must yield and wait at every human gate.

**Default:** If a stage has no `autonomy` property in workflow.json, default to `supervised`.

## Review Loop

When a reviewer is assigned, the cycle between owner and reviewer repeats until either:
1. The reviewer returns verdict "ready" — artifact proceeds to next step
2. The iteration cap (`maxReviewIterations` in workflow.json, default 3) is reached — reviewer is bypassed, artifact proceeds with unresolved findings noted

The `reviewIterations` counter in state.json tracks how many times the reviewer has returned "not-ready." Once the cap is reached, the reviewer does not participate again.

In `supervised` mode, after the review loop completes the artifact is presented to the human for approval. In `guided` and `full` modes, the artifact auto-advances to complete.

## Rules

1. **Transitions that block on human (in supervised mode) must NEVER be completed in the same turn as the preceding transition.** The orchestrator must yield and wait for a human message before proceeding.
2. **No row may be skipped** unless explicitly noted (e.g., "skip to #10 if no contributors").
3. **The orchestrator must NEVER write an audit entry recording a human decision until the human has actually responded in chat.**
4. **The `presented` state is always a hard stop in supervised mode** — the orchestrator presents a summary and waits. Period.
5. **Row 3 (clarification) is always a human gate in supervised and guided modes.** Even if the owner has no questions, the plan itself is presented for human approval or adjustment.
6. **The human can override autonomy at any time** by saying "stop" or "let me review that" — this implicitly switches the current stage to supervised.
7. **In full and guided autonomy modes**, the audit log must clearly distinguish auto-approved entries from actual human decisions. Use "auto-approved (full autonomy)" or "auto-approved (guided)" rather than recording a fabricated human decision.
8. Each actor only sets state for what THEY did — never for what someone else will do.
9. When re-invoking a persona, pass all relevant files from the stage directory as context.
10. **If a stage has no `autonomy` property in workflow.json, default to `supervised`.** Human gates always block unless explicitly opted out.

## Contributor Invocation

When a stage has multiple contributors, invoke ALL of them in a single turn (parallel sub-agent calls). Each contributor receives the same invocation format and writes independently to the stage directory. Wait for all to return before proceeding to the refinement step. Do not invoke them sequentially — issue all contributor invocations in one message.

## How to Invoke a Persona

Use this exact format — nothing more:

```
stage: <stage-name>
status: <current-status>
directory: <full-path-to-stage-directory>
```

The persona knows who it is. The work-method skill tells it what to do based on the status. The files in the directory provide all context. Do not add instructions, summaries, guidelines, or file contents to the invocation.

## Process Verification

The process checker (`tools/process-checker.js`) runs after sub-agent invocations. It checks only:

- If outputs are declared in state, do the files exist on disk?
- If reviews are declared and stage is past review, did all reviewers review?

It does not track state transitions. It does not check content quality.
