# DRIVER-PORT-PLAN — port the PRODUCER half of the AI-DLC evaluator to TS/Bun

Companion to `PORT-PLAN.md` (which ported the **scoring** half). This plan ports
the **producer**: a driver that runs an AIDLC workflow end-to-end against a real
AI assistant, with the assistant ⇄ HUMAN-SIMULACRUM conversation handled
automatically, writing a run folder the already-ported scorer then grades — so the
FULL produce→score loop runs in TS.

Source-of-truth (read-only, `origin/v2`):
`/Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/packages/cli-harness/src/cli_harness/`.
Every module cites the Python `file:line` it ports. All port files stay in the
ROOT spike `tmp/eval-js-judge/` (private, gitignored). NO tracked commits.

---

## Transport decision (DECIDED — user steer 2026-06-17: "use our already built SDK and TUI")

Three concerns, three mechanisms (determinism→tool, knowledge→LLM, judgement→human):

| Transport | Repo asset (reuse target) | Role | Live-run gate |
| --- | --- | --- | --- |
| **Claude SDK** | `tests/harness/sdk-drive.ts` (`driveAidlc`, `canUseTool` AskUserQuestion hook, `resolveDriveSdkSettings`, file readers) | **PRIMARY.** The DoD live-proof path. The human simulacrum (`human-analog.ts`) is the DYNAMIC answer source plugged into the existing `canUseTool` boundary (sdk-drive.ts:468-508). | `AIDLC_DRIVER_LIVE=1` |
| **Claude TUI** | `tests/harness/tui-drive.ts` (`answer-gate` loop, on-disk terminator) | **SECONDARY (best-effort, "if possible").** Gate-paced journey: take-Recommended-per-menu, terminate on `aidlc-state.md` `Status=Completed` (tui-drive.ts:1276-1509). The simulacrum here is the deterministic take-Recommended human-analog. Built + typecheck-clean; live run opt-in. | `AIDLC_DRIVER_TUI_LIVE=1` |
| Kiro / ACP | `tests/harness/kiro-acp-drive.ts` | **OUT.** User did not request it; the prompt says don't assume (gated AIDLC over ACP is documented-unreliable, kiro-acp-drive.ts:319-324). Flagged, not built. | — |

REUSE rule (hard): do NOT edit the tracked `tests/harness/*.ts` — the worktree
git status must stay clean. The SDK driver REUSES sdk-drive's EXPORTED helpers
(`resolveDriveSdkSettings`, `extractToolResultText`, `readStateFile`/`readStateField`,
`stateFilePathFor`/`auditFilePathFor`, the `Drive*`/`Captured*` types) and faithfully
REPLICATES its ~165-line `query`/`canUseTool` loop (sdk-drive.ts:459-624) with two
deltas the producer requires that `driveAidlc` does not expose: (a) the canUseTool
AskUserQuestion answer comes from `human-analog.ts` (dynamic), not a static
`AnswerScript`; (b) `maxTurns` is set high (Python uses 500, claude_code.py:293) and
an optional between-turns resume loop mirrors claude_code.py:316-420. This is "lift
the machinery," not "write from scratch." The TUI driver SHELLS to `tui-drive.ts`
as a subprocess (its public CLI), no edit.

---

## The seam (the produce→score contract) — VERIFIED

A collect()-complete run folder holds SIX YAMLs at its root
(reporting-collector.ts `collect()` reads each by name, :266-494):

| YAML | Written by | Status |
| --- | --- | --- |
| `run-meta.yaml` | DRIVER (normalizer) | **NEW (this port)** |
| `run-metrics.yaml` | DRIVER (normalizer) | **NEW (this port)** |
| `test-results.yaml` | DRIVER (post-run) | **ALREADY PORTED** — call `runPostEvaluation` (postrun.ts:485) |
| `quality-report.yaml` | SCORER (stage 3) | thin writer NEW — `asdict→atomicYamlDump` (scanner.py write_report:145-149) |
| `contract-test-results.yaml` | SCORER (stage 4) | thin writer NEW — `asdict→atomicYamlDump` (runner.py write_results:222-226) |
| `qualitative-comparison.yaml` | SCORER (stage 5) | **ALREADY PORTED** — `compareRuns(..., outputPath)` (qualitative.ts:444-447) |

Verified in `run_evaluation.py --evaluate-only` (:826-880): the scorer writes
quality-report (:849-850), contract-test-results (:857-863), qualitative-comparison
(:869-876). `collect()` TOLERATES absent YAMLs (returns null sections), so the
minimum DoD bar (real execution-cost + sensible qualitative score) needs only the
3 driver YAMLs + qualitative-comparison. The 2 thin scorer writers make the folder
GENUINELY 6-YAML collect()-complete and faithful to `run_cli_evaluation`.

Two consume paths (both ALREADY PORTED):
- `evaluate-only` (run.ts:115) — flag-driven, scores live from dirs, no YAMLs on disk.
- `compare` (run.ts:258) — folder-driven via `collect()`; needs the YAMLs on disk.

---

## The key insight (CONFIRMED on disk)

The "human simulacrum" is NOT a new driver loop. Under `--test-run` the `/aidlc`
skill auto-approves gates and the workflow runs largely in one agentic turn
(SKILL.md:78 "gates auto-approve and the learnings ritual is skipped"). When an
`AskUserQuestion` DOES fire, sdk-drive.ts already intercepts it via `canUseTool`
(sdk-drive.ts:469) and answers from a STATIC `AnswerScript`. The simulacrum port =
replace that static source with `human-analog.ts`, which reads the question +
vision and GENERATES the answer via a model (claude_code.py:246-286 routes exactly
this to `generate_human_response`, human_analog.py:109). Small, surgical, verified.

---

## Module map (Python source → TS target → reuse → tests)

### A. `human-analog.ts` ← `human_analog.py:1-181`
- Port `_SYSTEM_PROMPT_TEMPLATE` (24-61, verbatim — vision + tech-env binding,
  "Approved. Continue." for non-questions), `_USER_TEMPLATE` (63-71),
  `_extract_final_response` (74-106: ANSI-strip regex `\x1b[...]`, collect `> `
  response blocks incl. `━━━` separators, return last block `[:2000]`, fallback
  last 1500 chars), `generate_human_response` (109-180).
- **Transport (G1-consistent):** default = claude-CLI auth via the claude-agent-sdk
  `query` (model knowledge→LLM, no API key — mirror `AgentSdkScorer`, qualitative.ts:312-342).
  Offer a Bedrock variant + `JUDGE_MODEL`/`SIM_MODEL` knob (default
  `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, human_analog.py:115) to mirror
  Python exactly. Fallback string EXACTLY `"Approve & Continue."` (human_analog.py:180).
- **Gate:** the model call sits behind the live flag; a clean deterministic
  fallback (the approval string) when unavailable — NEVER in a default deterministic path.
- **Tests:** `human-analog.test.ts` — pure `extractFinalResponse` cases (ANSI strip,
  last-block selection over multiple `> ` blocks, `━━━` inclusion, 2000-cap,
  empty→fallback-1500). The model path is gated/skipped.

### B. `normalizer.ts` ← `normalizer.py:11-239` (+ `orchestrator._normalize_run_folder` enrichment, orchestrator.py:26-104)
- `normalizeOutput(sourceDir, outputDir, adapterName, {modelHint, elapsedSeconds, tokenUsage, generatedAt})` →
  writes `run-meta.yaml` (:42-64) + `run-metrics.yaml` (:66-176). `_countWorkspaceFiles`
  (:181-220) + `_countDocFiles` (:223-239).
- **Collapse note:** Python normalizes (normalizer.py) THEN enriches (orchestrator.py:67-104:
  run_folder→relative, config.aws_profile/rules_source/rules_ref/rules_repo, recount
  workspace after stripping inputs). The TS port FOLDS the enrichment into one writer
  so the emitted `run-meta.yaml.config` carries `rules_source/rules_repo/rules_ref`
  (the fields collector reads at reporting-collector.ts:280-283) — documented.
- **Determinism:** `datetime.now(UTC).isoformat(timespec='seconds')` (normalizer.py:43)
  → INJECTED `generatedAt` param (Date.now is unavailable/banned in the spike — same
  convention as collect()/extractBaseline). `yaml.safe_dump(default_flow_style=False,
  sort_keys=False)` → `atomicYamlDump` (yaml.ts). Float fields none here (all ints).
- **Single-agent degradation (ACCEPTED + documented):** `per_agent` has ONLY
  `executor` (no simulator → simulator_tokens reads 0), `repeated_context` all-zero
  (:96-102), no `context_size` section (Strands-only), one synthetic handoff. This
  is EXACTLY how the Python CLI normalizer degrades — faithful, not a defect. The
  Strands swarm (execution/aidlc_runner) stays Python (welded to strands-agents).
- **Tests:** `normalizer.test.ts` — mirror `test_normalizer.py` 4 tests
  (run-meta `status`/`execution_time_ms`/`config.executor_model="cli:test"`;
  metrics workspace `source_files`/`test_files`; aidlc_docs `inception/construction/total`;
  token_usage maps `tokens.total`/`per_agent.executor`/`handoff_patterns...turn_count`/
  `model_params.executor.model_id`) + a `collect()` round-trip asserting field-name
  compatibility (the differential vs Python in Phase 4).

### C. `driver-sdk.ts` ← `claude_code.py:148-493` + `adapter.py` + `prompt_template.render_v2_prompt` (118-135)
- Workspace setup (claude_code.py:182-213): mkdir `outputDir/workspace`, copy vision.md
  (+ tech-env.md), copy `dist/claude/.claude` tree into workspace, write
  `.claude/settings.local.json` `{env:{AWS_REGION}}` to override the dist's pinned region.
- Prompt: `buildInitialPrompt(...)` mirrors `config.prompt_template or render_v2_prompt(...)`
  (claude_code.py:218) — a verbatim `promptTemplate` override wins; otherwise the base is
  `render_v2_prompt(intent, scope, testRun)` → `/aidlc {intent} --scope {scope} --test-run`
  (prompt_template.py:118-135); `intent` = first H1 / first non-empty vision line
  (`_vision_intent`, claude_code.py:86-100).
- **tech-env binding (faithful, not invention):** when `bindTechEnv` is on AND a tech-env.md
  was copied into the workspace, `buildInitialPrompt` appends `TECH_ENV_BINDING_DIRECTIVE`
  AFTER the leading `/aidlc …` token, making tech-env.md a HARD constraint instead of the
  advisory hint a `--test-run` agent self-overrides. Precedents: the V1 EXECUTOR_SYSTEM_PROMPT
  named "Technical environment: `tech-env.md`" (prompt_template.py:22) + "Read the relevant
  rule file BEFORE starting each stage" (prompt_template.py:103) — prose the bare V2 prompt
  dropped to keep the slash command parseable; the human simulacrum enforces the same rule
  mid-run (human_analog.py:55, "if Kiro proposes Flask, say 'Use FastAPI as specified in
  tech-env'"). Bound via the prompt because the adapter already exposes a `prompt_template`
  override at this exact seam (claude_code.py:218). The TUI transport stays bare-faithful (the
  binding is not threaded in — out of scope).
- Drive: REUSE sdk-drive's exported settings/file helpers + replicate the query loop
  (sdk-drive.ts:459-624) with `maxTurns` high + `canUseTool` AskUserQuestion → `human-analog.ts`
  (claude_code.py:246-286 answer-matching: lower-case label substring match, else option[0]).
- Token telemetry from the SDK `result` event (SDKResultSuccess, sdk.d.ts:3479): map
  `usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens`,
  `num_turns`, `duration_api_ms`, `total_cost_usd`, `session_id` into the `token_usage`
  dict normalizer.ts consumes (claude_code.py:333-447 → normalizer.py:79-138).
- Completion: `aidlc-state.md` `- **Status**: Completed` (claude_code.py:52,60-69) AND
  ≥1 generated source file (claude_code.py:160-170). Optional between-turns resume loop
  (waiting signals claude_code.py:369-415) — only if a single turn doesn't complete.
- Extract: `_find_aidlc_docs` (claude_code.py:103-113) → copy aidlc-docs to outputDir;
  strip vision/tech-env from workspace (orchestrator.py:56-65).
- **Gate:** the whole live run behind `AIDLC_DRIVER_LIVE=1` (costs tokens), clean skip.

### D. `driver-tui.ts` ← tui-drive.ts public CLI (best-effort)
- Subprocess-drive: `tui-drive start --session … --cwd <workspace> -- claude`,
  `send --keys "/aidlc <intent> --scope mvp" --literal`, then
  `answer-gate --project-dir <workspace> --until-state-field "Status=Completed"`
  (deterministic take-Recommended simulacrum). Extract + normalize identically to C.
  No tokens from a TUI run → normalizer writes the N/A-sentinel metrics (its zero path).
- **Gate:** `AIDLC_DRIVER_TUI_LIVE=1`. Built + typecheck-clean; live run opt-in.

### E. `run.ts` new `run` mode ← `orchestrator.run_cli_evaluation` (107-277)
- `bun src/run.ts run --vision <vision.md> [--tech-env …] [--golden-docs …] [--golden …]
  [--openapi …] [--cli claude-code|tui] [--scope mvp] [--out <run-folder>] [--no-bind-tech-env]`:
  - **tech-env binding flag (default ON):** `bindTechEnv = !flag("no-bind-tech-env")`, threaded
    into the SDK `driveAidlcRun` call so the binding directive (C) applies; `--no-bind-tech-env`
    restores the bare-faithful V2 prompt. Safe default-on — the directive only appends when a
    `--tech-env` is actually given (setupWorkspace gates on `hasTechEnv`). The TUI branch is
    bare-faithful (the flag is not threaded into `driveAidlcTui`).
  1. create timestamped run folder
  2. drive (C or D) → `aidlc-docs/` + `workspace/`
  3. `normalizeOutput` → run-meta + run-metrics (B)
  4. `runPostEvaluation(runFolder, defaultRunnerConfig(), false)` → test-results.yaml (D-ported)
  5. score: scanWorkspace→quality-report.yaml, runContractTests→contract-test-results.yaml,
     compareRuns(outputPath)→qualitative-comparison.yaml (the 2 thin writers + the ported scorer)
  6. self-verify: `collect(runFolder)` is complete; then hand to `compare`/render.
- REUSE only: `runPostEvaluation`, `defaultRunnerConfig`, `scanWorkspace`, `loadSpec`/
  `runContractTests`, `compareRuns`+`selectScorer`, `collect`, `compareRunToBaseline`,
  `renderMarkdown`/`writeHtml`. Do NOT duplicate.

### F. scorer-YAML writers (small, in run.ts or a tiny module)
- `writeQualityReport(quality, path)` ← scanner.py write_report (145-149): `asdict→atomicYamlDump`.
- `writeContractResults(contracts, path)` ← runner.py write_results (222-226): `asdict→atomicYamlDump`.
- Field names must match what `collect()` reads (reporting-collector.ts:393-461): lint/
  security/semgrep/duplication tool+available+findings+summary; contract total/passed/
  failed/errors/server_started/server_error/cases[]. PyFloat on float fields (latency_ms).

---

## OUT of scope (flag, don't expand)
- The Strands multi-agent SWARM (execution/aidlc_runner) — welded to `strands-agents`
  + Bedrock; infeasible. CONSEQUENCE: run-metrics.yaml is the degraded single-agent
  shape (above). Faithful to the CLI path.
- Kiro driver (transport decision above).
- EXPERIMENTAL IDE adapters (cursor/cline/copilot/windsurf/antigravity).
- v1 legacy monolith prompt path (claude_code.py:224-237) — only the v2 `/aidlc`
  skill path is in scope (claude_dist always set here).

---

## Ordered work-list
1. **Phase 1 (parallel, deterministic + pure):** `human-analog.ts` (+ pure test),
   `normalizer.ts` (+ test mirroring test_normalizer.py + collect round-trip),
   the 2 scorer-YAML writers (F). Each adversarially verified vs its Python file:line.
2. **Phase 2 (wire, in-the-loop):** `driver-sdk.ts` (reuse sdk-drive helpers +
   replicate loop + human-analog hook), `driver-tui.ts` (shell tui-drive answer-gate),
   `run.ts` `run` mode (E). Typecheck + unit-test the deterministic seams with stubs
   (no live model).
3. **Phase 3 (live proof, gated):** ONE real `run --cli claude-code` on sci-calc-v2,
   produce the folder, `collect()`-verify, `compare --run <folder> --golden golden.yaml`
   end-to-end. Capture output. Behind `AIDLC_DRIVER_LIVE=1`.
4. **Phase 4 (adversarial verify + README):** differential-check run-meta/run-metrics
   shapes vs Python `normalizer.py` on identical token_usage inputs (round-trip through
   collect()); confirm the single-agent degradation is the ONLY delta; add the
   README "Producer / driver" section.

## DoD (parity bar) — from the handoff
- ✓ `human-analog.ts` faithful (file:line), default claude-CLI auth + Bedrock knob, pure tests pass.
- ✓ SDK driver runs `/aidlc` against `dist/claude` for sci-calc-v2, gates answered by the
  simulacrum, writes run-meta + run-metrics + test-results + aidlc-docs + workspace (gated).
- ✓ `collect(runFolder)` complete; `compare --run … --golden …` produces real execution-cost
  numbers + a sensible qualitative score — full produce→score loop in TS.
- ✓ run-meta/run-metrics field-name + nesting compatible with Python normalizer (degradation documented).
- ✓ `bun test src/*.test.ts` green (433 + new); `bunx tsc --noEmit -p tsconfig.json` clean.
- ✓ README "Producer / driver" section: what runs in TS, the single-agent degradation, Strands stays Python.
