# JS evaluator — full port of the v2 scoring pipeline + producer

A TypeScript/Bun port of the v2 `evaluator/`, faithful to the Python on
`origin/v2`, verified by a TS test suite that mirrors the Python's own tests.
Lives at `tests/harness/eval/`, alongside the SDK/TUI drivers it reuses.

## Quick start (for reviewers)

```bash
bun install                        # pulls @anthropic-ai/claude-agent-sdk + @anthropic-ai/sdk
bun test tests/harness/eval/       # → 481 pass, 1 skip, 0 fail (fully offline)
bun run typecheck                  # tsc clean (covers tests/** via tsconfig.tests.json)
```

No API key, network, or external corpus is required for the deterministic suite. A
handful of real-data tests read the read-only Python evaluator at
`.claude/worktrees/v2-inspect/evaluator/` (gitignored, not in a clone) and **self-skip**
when it is absent — hence the `1 skip`, not a failure. The live produce→score loop
(`run` mode) spends Bedrock tokens and is gated behind `AIDLC_DRIVER_LIVE=1`.

Two halves, both now ported:
1. **Scoring pipeline** (stages 2–6 + the trend gate/report + the shared
   substrate) — given a run folder, it grades it.
2. **Producer / driver** (`run` mode) — drives a real `/aidlc` workflow against
   an AI assistant with a HUMAN-SIMULACRUM answering gates automatically, writes
   a run folder, then scores it. The full **produce→score loop runs in TS**. See
   the "Producer / driver" section below and `DRIVER-PORT-PLAN.md`.

Source of truth for every algorithm: the Python evaluator on the read-only
`origin/v2` worktree at `.claude/worktrees/v2-inspect/evaluator/`. Every module
cites the Python `file:line` it ports, in its header and at non-obvious logic.

**Scope.** IN: the scoring pipeline (qualitative, quantitative, contract test,
reporting, trend-reports, the shared utilities, post-run tests, the LLM-free
entry surface) **+ the CLI producer** (`cli-harness/` human_analog + normalizer +
the claude-code/SDK driver, reusing the repo's `tests/harness/sdk-drive.ts` and
`tui-drive.ts`). OUT (infeasible in TS): `execution/` (the Strands multi-agent
swarm — welded to `strands-agents`); the EXPERIMENTAL `ide-harness/` adapters.
See `PORT-PLAN.md` (scoring) + `DRIVER-PORT-PLAN.md` (producer) for the module
maps and `TEST-OBLIGATIONS.md` for the per-test checklist.

## Status

- **482 tests** (481 pass, 1 self-skip) via `bun test tests/harness/eval/`; `tsc`
  clean (`bun run typecheck`, which covers `tests/**` via `tsconfig.tests.json`).
  (429 scoring + 53 producer: human-analog, normalizer, driver-sdk/tui pure helpers,
  pyutil — incl. the tech-env-binding tests. The 1 skip is a real-data test whose
  Python corpus is absent in a clone.)
- The TS suite mirrors the Python's pure-logic tests 1:1 across the in-scope
  packages (qualitative, quantitative, contracttest, reporting, trend-reports,
  shared, post-run); binary/LLM/Docker/gh paths are behind injected seams or
  opt-in gates that skip cleanly.
- Built and adversarially cross-checked: a Phase-4 skeptic pass differential-
  tested each high-risk module (TS vs the real Python on identical inputs) and
  the four reachable divergences it found were fixed and pinned in
  `parity-regressions.test.ts`.

## What's here (`src/`)

| Module | Ports (Python) | Notes |
| --- | --- | --- |
| `pyutil.ts` | `round()` / format-specs | `pyRound` = CPython round-half-to-even (BigInt-exact, 517-case battery); `pyFixed`/`pySignedFixed`/`pyPercent` |
| `yaml.ts` | `shared/io.py` | PyYAML **block-style** dumper + `atomicYamlDump`; `PyFloat`/`pyFloat` to render a Python float (`100.0` not `100`) |
| `types.ts` | stage dataclasses | shared stage-level interfaces |
| `postrun.ts` | `execution/post_run.py` | Stage 2; nested `test-results.yaml`, env hygiene, install-fail-still-runs, sandbox branch (G5) |
| `quantitative.ts` | `quantitative/{scanner,analyzers,models}.py` | Stage 3; injected exec/which seams; `_tool_version`, CPD ns-tolerant XML, `?` sentinels |
| `contract.ts` | `contracttest/{spec,runner,server}.py` | Stage 4; matcher + runner pure; bool-as-int matching; host launch python-bound |
| `qualitative.ts` | `qualitative/{document,scorer,comparator,models}.py` | Stage 5; heuristic + LLM scorers; `toDict` (per-doc key `path`, banker's rounding) |
| `reporting-collector.ts` | `reporting/collector.py` | reads a run folder's 6 YAMLs → `ReportData` (**closes G3/G7**) |
| `baseline.ts` | `reporting/baseline.py` | load/extract/write/promote/compare; 31-row diff; round-trips byte-identical to Python |
| `render-md.ts` / `render-html.ts` | `reporting/render_{md,html}.py` | consolidated report (replaced the spike's throwaway `report.ts`) |
| `trend-models.ts` | `trend-reports/models.py` | full `RunData`/`TrendData`/`SemVer`/`InfraFailure`/enums + factories |
| `gate.ts` | `trend-reports/gate.py` | regression gate (imports `trend-models.ts`); pyutil formatters |
| `trend-factories.ts` | `trend-reports/tests/factories.py` | `make_run`/`make_trend` test builders |
| `trend-sparkline.ts` | `trend-reports/sparkline.py` | sparkline + formatters; int/float intent via `PyFloat` |
| `trend-render-yaml.ts` | `trend-reports/render_yaml.py` | `_serialize` SemVer→Enum→dataclass order |
| `trend-collector.ts` | `trend-reports/collector.py` | build `TrendData` from run folders / release bundles (incl. a minimal zip reader) |
| `trend-fetcher.ts` | `trend-reports/fetcher.py` | release/Actions bundle fetch (gated on `gh`; injected spawn seam) |
| `trend-render-md.ts` / `trend-render-html.ts` | `trend-reports/render_{md,html}.py` | trend reports (byte-verified vs Python on fixtures) |
| `shared-credential-scrubber.ts` | `shared/credential_scrubber.py` | 9 ordered redaction patterns |
| `shared-scenario.ts` | `shared/scenario.py` | scenario manifest loader |
| `shared-sandbox.ts` | `shared/sandbox.py` | Docker isolation (G5; gated behind `is_docker_available`) |
| `config.ts` | `execution/config.py` (subset) | `RunnerConfig` tree + defaults |
| `run.ts` | `run.py` evaluate-only + `run_comparison_report.py` + `trend_reports.cmd_trend` + `cli-harness/orchestrator.run_cli_evaluation` | the entry surface — evaluate-only / compare / trend (LLM-free) **+ `run` (the PRODUCER loop, gated)** |
| `human-analog.ts` | `cli-harness/human_analog.py` | the HUMAN SIMULACRUM — dynamic gate answers from vision + tech-env (default claude-CLI auth, Bedrock/`SIM_MODEL` knob); `extractFinalResponse` pure-tested |
| `normalizer.ts` | `cli-harness/normalizer.py` (+ `orchestrator._normalize_run_folder`) | the driver's `run-meta.yaml` + `run-metrics.yaml` writers (single-agent shape) |
| `driver-sdk.ts` | `cli-harness/adapters/claude_code.py` (v2 `/aidlc` path) | PRIMARY producer transport — replicates `sdk-drive.ts`'s query/canUseTool loop with the human-analog gate answer; BINDS `tech-env.md` as a hard constraint by default (`--no-bind-tech-env` opts out) |
| `driver-tui.ts` | (DRIVER-PORT-PLAN §D) | SECONDARY producer transport — shells to `tests/harness/tui-drive.ts answer-gate` (take-Recommended simulacrum) |

## Run it

```bash
ABS=.claude/worktrees/v2-inspect/evaluator/test_cases/sci-calc-v2

# Stage 5 offline (heuristic scorer, no API key) — golden vs itself = 1.0:
bun tests/harness/eval/run.ts evaluate-only \
  --aidlc-docs "$ABS/golden-aidlc-docs" --golden-docs "$ABS/golden-aidlc-docs" --heuristic

# Stage 5 with the REAL LLM judge (default = AgentSdkScorer, repo's claude CLI auth):
bun tests/harness/eval/run.ts evaluate-only \
  --aidlc-docs <generated-aidlc-docs> --golden-docs "$ABS/golden-aidlc-docs"

# Compare a real run folder against the golden baseline (G3/G7 — real metrics):
bun tests/harness/eval/run.ts compare --run <run-folder> --golden "$ABS/golden.yaml"

# Trend report across releases (gated on `gh`; --local-run-dir works offline):
bun tests/harness/eval/run.ts trend --baseline "$ABS/golden.yaml" --gate

# PRODUCER — drive a real /aidlc run end-to-end, then score it (the FULL loop, in
# TS). LIVE: spends Bedrock tokens; GATED behind AIDLC_DRIVER_LIVE=1 (clean skip
# otherwise). Writes a collect()-complete run folder + a compare report:
AIDLC_DRIVER_LIVE=1 bun tests/harness/eval/run.ts run \
  --vision "$ABS/vision.md" --tech-env "$ABS/tech-env.md" \
  --golden-docs "$ABS/golden-aidlc-docs" --golden "$ABS/golden.yaml" \
  --openapi "$ABS/openapi.yaml" --cli claude-code --scope mvp --out <run-folder>
# The SDK driver BINDS tech-env.md as a HARD constraint by default; add
# --no-bind-tech-env to restore the bare-faithful V2 prompt.
# TUI transport (best-effort second path): --cli tui, gated on AIDLC_DRIVER_TUI_LIVE=1.

# The full test suite + typecheck:
bun test tests/harness/eval/
bun run typecheck
```

## Producer / driver — the full produce→score loop in TS

The `run` mode (`run.ts`, porting `cli-harness/orchestrator.run_cli_evaluation`)
closes the loop the scoring port deliberately left out. It:

1. **Drives** a real `/aidlc <intent> --scope mvp --test-run` against the shipped
   `dist/claude/.claude` surface via the Claude SDK (`driver-sdk.ts`, which
   REUSES `tests/harness/sdk-drive.ts`'s `query`/`canUseTool` machinery — the
   tracked harness file is never edited). A **second, best-effort transport**
   (`driver-tui.ts`) shells to `tests/harness/tui-drive.ts answer-gate`.
   The SDK driver **binds `tech-env.md` as a HARD constraint by default**: when a
   `--tech-env` is given, `buildInitialPrompt` appends a `TECH_ENV_BINDING_DIRECTIVE`
   AFTER the leading `/aidlc …` slash command, telling the conductor to READ
   tech-env.md and treat its "Do NOT Use" entries as hard prohibitions rather than
   the advisory hint a `--test-run` agent self-overrides. This is bound at the same
   seam the Python adapter already exposes — `config.prompt_template or
   render_v2_prompt(...)` (`claude_code.py:218`) — and restores the V1
   `EXECUTOR_SYSTEM_PROMPT`'s intent (which named "Technical environment:
   `tech-env.md`", `prompt_template.py:22`, and "Read the relevant rule file BEFORE
   starting each stage", `prompt_template.py:103`) that the bare V2 prompt dropped to
   keep the slash command parseable, plus the same rule the human simulacrum already
   enforces mid-run (`human_analog.py:55` — "if Kiro proposes Flask, say 'Use FastAPI
   as specified in tech-env'"). The directive only actually appends when a tech-env
   was copied into the workspace; `--no-bind-tech-env` restores the bare-faithful
   prompt. The **TUI transport stays bare-faithful** (the binding is not threaded
   into it — out of scope).
2. Answers every `AskUserQuestion` gate with the **HUMAN SIMULACRUM**
   (`human-analog.ts`): a model call that reads the question + vision + tech-env
   and answers as an informed human (faithful to `human_analog.py`), defaulting
   to the repo's claude-CLI auth (no API key), with a `SIM_MODEL`/Bedrock knob to
   mirror the Python exactly. Falls back to `"Approve & Continue."` on any error.
3. **Writes the run folder**: `run-meta.yaml` + `run-metrics.yaml` (`normalizer.ts`)
   + `test-results.yaml` (the already-ported `runPostEvaluation`), then runs the
   scorer (`scanWorkspace`→`quality-report.yaml`, `runContractTests`→
   `contract-test-results.yaml`, `compareRuns`→`qualitative-comparison.yaml`) — a
   **collect()-complete 6-YAML folder** — and hands it to `compare`.

**Three concerns kept separate:** the run-folder assembly + YAML writers +
completion detection are deterministic (tool); the simulacrum's answers + the
qualitative judge are knowledge (LLM, behind the live gate); which scenario /
transport is judgement (CLI flags). Every model path is behind an opt-in env gate
(`AIDLC_DRIVER_LIVE` / `AIDLC_DRIVER_TUI_LIVE`) with a clean skip — never in the
default deterministic test tier.

**Single-agent metrics degradation (faithful, not a defect).** A CLI driver is
ONE executor session, so the `run-metrics.yaml` it writes is the degraded
single-agent shape the Python CLI normalizer already emits: `tokens.per_agent`
has only `executor` (so the scorer reads `simulator_tokens` as 0),
`repeated_context` is all-zero, there is no `context_size` section, and a single
synthetic handoff covers the run. The per-agent handoff histogram + context-size
samples are **Strands-only** (`execution/metrics.py:282-373`) — that swarm stays
Python (welded to `strands-agents`), so reproducing them in TS is infeasible. The
scorer tolerates the zeros (it reads, doesn't require them). `run-meta`/
`run-metrics` are field-name + nesting compatible with `normalizer.py`: a
differential on identical `token_usage` inputs makes `run-metrics.yaml`
**byte-identical** and `run-meta.yaml` identical except for the four
`config.{aws_profile,rules_source,rules_ref,rules_repo}` enrichment fields the TS
writer folds in from `orchestrator._normalize_run_folder` (Python adds them in a
separate post-pass; `collect()` reads them from there).

## Verified

- `bun test tests/harness/eval/` → **481 pass, 1 skip**; `tsc` clean.
- **Full produce→score loop, live (gated):** `run --cli claude-code` drove a real
  `/aidlc` on the sci-calc-v2 vision against `dist/claude` — the simulacrum
  answered the AskUserQuestion gates (4+ `QUESTION_ANSWERED` audit events), the
  workflow reached `Status: Completed` (subtype `success`), and the driver wrote a
  collect()-complete run folder (all 6 YAMLs parsed). `compare --run … --golden …`
  then scored it end-to-end with **real** numbers — qualitative `0.55` (per-doc
  LLM judgments), real execution cost (Total Tokens `85,565 → 202,926`, a sane
  +137% vs the 40-run-median golden — `total_tokens` is `input+output` per
  `claude_code.py:442`, NOT the SDK's cache-inflated 41.3M; $30.50, 315 handoffs,
  3.8M ms), a real security scan (10 findings), and project-type detection
  (`node`) — proving the whole loop runs in TS.
- **Normalizer parity (differential):** TS `normalizeOutput` vs Python
  `normalize_output` on identical inputs → `run-metrics.yaml` **byte-identical**;
  `run-meta.yaml` identical bar the documented enrichment fold-in.
- `evaluate-only --heuristic` on the real golden corpus → golden-vs-itself
  `overall_score = 1.0000`; a mutated candidate scores `< 1.0` (e.g. 0.8750).
- `compare` against a run folder with a real `run-metrics.yaml` → the Execution
  rows carry **real** token/wall-clock/handoff numbers (e.g. `98,000 vs 85,565
  → regressed`), not zero-vs-zero "improved" false positives (**G3/G7 fixed**).
- `evaluate-only --heuristic` on the real golden corpus → golden-vs-itself
  `overall_score = 1.0000`; a mutated candidate scores `< 1.0` (e.g. 0.8750).
- `compare` against a run folder with a real `run-metrics.yaml` → the Execution
  rows carry **real** token/wall-clock/handoff numbers (e.g. `98,000 vs 85,565
  → regressed`), not zero-vs-zero "improved" false positives (**G3/G7 fixed**).
- `golden.yaml` load → extract → write → reload round-trips with full field-name
  + insertion-order + nesting parity; `writeBaseline` output is **byte-identical
  to Python `write_baseline`** (excluding the timestamp).
- Adversarial differential pass (TS vs real Python) across qualitative scoring,
  baseline diff, sparkline, contract matcher, trend collector, post-run parsers,
  and all four renderers — divergences classified and the reachable ones fixed.

## Known gaps / deltas from the Python

Closed since the initial spike:

- ~~**G1. LLM judge transport.**~~ The default LIVE qualitative scorer is now
  **`AgentSdkScorer`** (repo's authenticated `claude` CLI, no API key — the
  zero-config, repo-consistent path). `LlmScorer` (first-party SDK, needs
  `ANTHROPIC_API_KEY`) and a `JUDGE_MODEL` override remain as opt-in alternates.
  The deterministic test suite always uses `HeuristicScorer`.
- ~~**G3/G7. evaluate-only/compare baseline-diff false positives on
  execution-cost metrics.**~~ `reporting-collector.ts` now reads a run folder's
  real `run-metrics.yaml`; `compare` uses `compareRunToBaseline` (collector-
  backed), so lower-is-better execution metrics reflect real numbers.
- ~~**G4. golden.yaml artifact-count fields are zeroed.**~~ `run.ts` excludes the
  Artifacts category from the regression tally by default (`--include-artifacts`
  to re-enable), so the intentionally-zeroed golden rows no longer false-alarm.
- ~~**G5. Docker sandbox not ported.**~~ `shared-sandbox.ts` ports the Docker
  isolation model; `postrun.ts` routes the run-generated-code path through it
  behind an `is_docker_available` gate (host-mode otherwise). Untrusted-code
  execution is sandboxed when Docker is present.
- ~~**G6. Stage 3 = external binaries.**~~ The port re-implements the parsers via
  injectable exec/which seams; absent tools degrade to `{available:false}`
  exactly like Python, and `_tool_version` makes the version/availability gate
  faithful.

Still open / deliberate residuals:

- **G2. Qualitative LLM-assisted pairing (pass 2) not ported.** `document.py`'s
  optional Bedrock second pass that pairs docs which don't match by path is
  absent (`pairDocuments` does the exact-path pass only). This is **faithful for
  the heuristic path** — Python skips pass-2 when `bedrock_client is None` — and
  no test in scope exercises it. Closing it would add a gated-LLM pass and re-plumb
  the scorer client through the comparator.
- **Cross-language formatting residuals (unreachable with real evaluator data,
  or fundamental JS-runtime limits), documented by the adversarial pass:**
  - PyYAML folds an embedded-newline string into a single-quoted block scalar;
    the TS dumper emits it double-quoted-with-escapes. Both re-parse to the
    identical value; run YAML never carries newline-bearing scalar *keys*.
  - `NaN`/`inf` render lowercase in Python format-specs (`nan`, `inf`) vs JS
    `NaN`/`Infinity`; and `format_number(NaN/inf)` *raises* in Python (`int()`)
    but returns a string in TS. Only reachable on corrupt upstream data.
  - Integers beyond 2^53 lose precision in JS (`format_delta`, PR numbers); real
    token/LOC/PR counts are far below that.
  - `matchBody` failure strings: a JSON `1.0` parses to a Python float (`str` →
    `1.0`) but a plain JS number (`String` → `1`); CPython `repr()` quoting of
    strings/dicts/control-chars differs from the TS `pyRepr`. The pass/fail
    verdict is identical; only the human-readable failure text can differ.
  - Python regex classes `\w`/`\d`/`\s` are Unicode by default; the TS ports use
    ASCII classes. Affects only non-ASCII identifiers/digits/separators embedded
    in tool output or doc text — not present in real pytest/jest/cargo summaries
    or ASCII intent-folder names.
  - A malformed `pr-<non-numeric>` rules-ref *crashes* the Python trend
    collection (uncaught `ValueError`); the TS coerces via `parseInt` and
    proceeds. Real refs are `pr-<int>`.
- **Contract server launch is Python-toolchain-bound.** Host mode shells to
  `uv`+`uvicorn` because the generated app is Python; the `server.py` module-
  resolution/venv-degrade layer is left gated (the matcher/runner/spec — the
  deterministic core the tests cover — are fully ported).
