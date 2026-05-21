# Open Issues — src/

Issues in the v2 AI-DLC source protocols and skills (`src/`).
For evaluator-specific issues see `ISSUES_EVALUATOR.md`.

---

## ISSUE-007: Builder skips clarification questions when intent is detailed (0.17 score)

**Status:** Open
**Area:** `src/aidlc-common/protocols/aidlc-builder-protocol.md`, `src/skills/aidlc-requirements-analysis/SKILL.md`
**Found during:** kiro v2 evaluation runs (2026-05-21)

### Description

When the vision document is highly detailed (as in the sci-calc benchmark), the builder declares "no clarification needed" and writes an empty or near-empty `requirements-analysis-questions.md`. This causes qualitative scores of 0.17 for that document vs the golden which has 7 substantive questions with trade-off analysis.

The builder protocol says to assess whether clarification is needed "based on available context and the validation-spec" — but gives no minimum bar. For a detailed spec, zero questions is a reasonable interpretation, but it diverges from what a human analyst would produce.

### Expected behaviour

Even with a detailed spec, the builder should produce a minimum set of questions covering genuine ambiguities (e.g. error handling edge cases, NFR thresholds, out-of-scope boundaries). The validation-spec should require at least N questions for skills where clarification is expected.

### Fix

Add to `aidlc-requirements-analysis/validation-spec.md`: a rule requiring at least 3 clarification questions unless the builder explicitly documents why zero questions are justified with specific references to spec sections that pre-answer each potential ambiguity.

---

## ISSUE-008: Code generation occasionally returns 400 instead of 422 for missing fields

**Status:** Open
**Area:** `src/skills/aidlc-code-generation/SKILL.md`
**Found during:** kiro v2 evaluation runs (2026-05-21)

### Description

Generated FastAPI apps occasionally return HTTP 400 for missing required fields instead of FastAPI's native 422 (Unprocessable Entity). This fails the contract test `add missing field → 422`.

Root cause: the builder generates custom input validation that raises a 400 `INVALID_INPUT` error, overriding FastAPI/Pydantic's automatic 422 validation. The tech-env specifies FastAPI and Pydantic but doesn't mandate that missing-field validation must use Pydantic's native behaviour (which returns 422 automatically).

### Fix

Add to `aidlc-code-generation/SKILL.md`: "Do not override FastAPI/Pydantic's automatic request validation for missing or malformed fields. Let Pydantic raise `RequestValidationError` which FastAPI converts to 422. Only use custom 400 errors for domain logic violations (e.g. divide by zero), not for missing input fields."

---

## ISSUE-001: Builder protocol missing audit-write responsibility

**Status:** Open
**Area:** `src/aidlc-common/protocols/aidlc-builder-protocol.md`
**Found during:** sci-calc evaluator run (2026-05-19)

### Description

`aidlc-builder-protocol.md` has no instruction telling the builder to append entries to `audit/intent-audit.md` after each step. The same gap exists in `aidlc-validator-protocol.md` for validation results.

`intent-bootstrap/SKILL.md` correctly initialises the audit file, and `aidlc-process-checker.js` (lines 872–877) enforces that audit entries exist for every completed stage — but the protocols never assign responsibility for writing them after bootstrap. The result is an audit log with only one entry regardless of how many skills ran.

### Expected behaviour

The builder protocol's §4 (State File Responsibilities) should include a parallel section for audit responsibilities: the builder appends one row per step completed; the validator appends one row for the validation result.

### Workaround in evaluator

Audit-write instructions added to builder and validator system prompts as a stopgap — see ISSUES_EVALUATOR.md EVAL-005.

---

## ISSUE-003: workflow-composition skips most inception skills for simple projects

**Status:** Open
**Area:** `src/skills/aidlc-workflow-composition/SKILL.md`
**Found during:** sci-calc evaluator runs (2026-05-19)

### Description

For the sci-calc benchmark (a well-scoped greenfield API), workflow-composition consistently composes a minimal workflow: bootstrap → requirements-analysis → code-generation only. Skills such as user-stories, application-design, units-generation, functional-design, nfr-assessment, nfr-design, and infrastructure-design are all omitted.

This may be correct behaviour for a simple project, but the benchmark golden baseline expects these skills to run. It is unclear whether the skill's selection criteria are calibrated correctly or whether the evaluator should force a fuller workflow for benchmarking purposes.

### Expected behaviour

Either: (a) workflow-composition selects a richer skill set for projects of sci-calc complexity, or (b) the evaluator provides a mechanism to override workflow composition with a fixed skill list for benchmarking.

---

## ISSUE-004: Builder does not stop after one step — chains through full skill flow

**Status:** Open
**Area:** `src/aidlc-common/protocols/aidlc-builder-protocol.md`, individual `src/skills/*/SKILL.md`
**Found during:** sci-calc-v2 golden master runs (2026-05-20)

### Description

The builder protocol is intended to be invoked once per step (clarification, planning, execution, fix) and return to the orchestrator after each. In practice the builder frequently chains through the entire skill flow — clarification → planning → execution — in a single invocation, bypassing the orchestrator's state-machine enforcement and skipping the validator entirely.

Root cause: `SKILL.md` files describe the end-to-end skill flow in full. When the builder reads the skill's `SKILL.md`, the complete flow description overrides the single-step constraint in the builder protocol. The builder follows the skill instructions and runs to completion in one pass.

Observed in ~50% of sci-calc-v2 runs (those with ≤9 handoffs and no validator in the sequence).

### Expected behaviour

The builder should execute exactly one step per invocation and return to the orchestrator with its status before the orchestrator decides the next step.

### Fix

`aidlc-builder-protocol.md` §2 needs a hard stop rule at the end of each subsection (2.1, 2.3, 2.4) making explicit: "After completing this step, STOP. Return to the orchestrator. Do not proceed to the next step regardless of what SKILL.md says about subsequent steps."

---

## ISSUE-005: Validator never invoked when builder chains through full flow

**Status:** Open
**Area:** `src/aidlc-common/protocols/aidlc-orchestrator-protocol.md`
**Found during:** sci-calc-v2 golden master runs (2026-05-20)

### Description

When the builder chains through the full skill flow in one pass (see ISSUE-004), it returns `complete` directly to the orchestrator. The orchestrator then marks the skill done and advances to the next skill without invoking the validator. Validation is effectively skipped on every run where ISSUE-004 occurs.

Even in runs where the builder correctly stops after execution, the orchestrator sometimes skips the validator — deciding the artifacts "look correct" without running the check.

Observed across the majority of sci-calc-v2 runs (only 7 of 15 completed runs show `validator` in the handoff sequence).

### Expected behaviour

`execution:complete` MUST always transition to `validation:pending` and invoke the validator before the orchestrator can advance state or present artifacts to the human.

### Fix

`aidlc-orchestrator-protocol.md` §3 loop pattern should include: "After EVERY builder execution step returns `complete`, you MUST invoke the validator before any other action. There are no exceptions. Skipping validation is a protocol violation."

---

## ISSUE-006: Workflow composition is highly nondeterministic — skill count varies from 2 to 8

**Status:** Open
**Area:** `src/skills/aidlc-workflow-composition/SKILL.md`
**Found during:** sci-calc-v2 golden master runs (2026-05-20)

### Description

Across 15 sci-calc-v2 runs, workflow-composition selected wildly different skill sets for the same input (same vision.md, tech-env.md):

- Minimum: 2 skills (requirements-analysis + code-generation)
- Maximum: 8 skills (requirements-analysis + user-stories + application-design + functional-design + nfr-assessment + nfr-design + code-generation + build-and-test)

The selection criteria in `aidlc-workflow-composition/SKILL.md` are subjective ("appropriate for the complexity") with no objective rules tying project characteristics to minimum required skills. This makes evaluation results incomparable across runs and makes the golden master difficult to build.

### Expected behaviour

For a given project classification (e.g. greenfield API with known tech-env), the workflow should select a consistent, defensible skill set. The composition rules should define minimum skill sets per project type, not leave it entirely to model judgment.

### Fix

Add a skill selection decision table to `aidlc-workflow-composition/SKILL.md` that maps project type + complexity indicators to a minimum required skill set. Allow the model to add optional skills beyond the minimum, but not drop required ones.

---

## ISSUE-002: Fake timestamps in state and audit files

**Status:** Open
**Area:** `src/` builder behaviour
**Found during:** sci-calc evaluator runs (2026-05-19)

### Description

Builder and orchestrator agents write placeholder timestamps (`2025-01-01T00:00:00Z`, `2025-01-22T10:00:00Z`) instead of real ISO 8601 wall-clock times. The state schema requires real timestamps but neither the builder protocol nor any skill's `SKILL.md` explicitly says to use the current time.

### Expected behaviour

All `created:` and `updated:` fields in `intent-state.md` and all `Timestamp` columns in `intent-audit.md` should reflect the actual execution time.

### Fix

Add an explicit instruction in `aidlc-builder-protocol.md` and `aidlc-orchestrator-protocol.md`: "Always use the current wall-clock time in ISO 8601 format for timestamps. Never use placeholder or example dates."
