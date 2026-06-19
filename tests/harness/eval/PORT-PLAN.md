# PORT-PLAN — Faithful TypeScript/Bun port of the AI-DLC evaluator SCORING pipeline

A faithful, line-cited port of the Python AI-DLC evaluator's **scoring pipeline**
(stages 2–6 + the trend gate + the shared substrate) into TypeScript on Bun,
living flat in `tmp/eval-js-judge/src/`. Every algorithm cites its Python
`file:line` source-of-truth on the read-only worktree
`/Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/packages/`.
The drivers (`execution/` Strands swarm, `cli-harness/`, `ide-harness/`,
`scripts/run_*.py`, `run.py`'s mode-dispatch) are explicitly **out of scope**.

**Parity bar (DoD).** The port is done when: (1) every in-scope Python test has a
1:1 TS mirror under `src/*.test.ts` and the suite is green via
`bun test tmp/eval-js-judge/src/*.test.ts`; (2) `tsc --strict` is clean across
`src/`; (3) a `golden.yaml` round-trips through the YAML serializer with
**field-name + insertion-order + nesting** parity (byte-identical PyYAML
formatting is a documented residual risk, NOT a blocker — the gate is a
`golden.yaml` round-trip spot-check, not a byte diff); (4) `evaluate-only`
scoring golden-vs-itself yields `overall_score == 1.0` and a mutated candidate
yields `< 1.0`; (5) baseline `compare` against a collector-produced current run
shows **no execution-cost false positives** (G3/G7 closed); (6) the port survives
an adversarial skeptic pass. LLM, Bedrock, external-binary, Docker, and gh-CLI
paths sit behind opt-in env gates with clean skips and never run in the default
deterministic tier.

---

## Architecture decisions

| Decision | Rationale |
| --- | --- |
| **Type-namespacing per Python package.** `collector.ts` defines its OWN dataclass shapes (ReportData/RunMeta/RunMetrics/TokenUsage/HandoffTiming/Artifacts/ContextSizeStats/TestResults/QualityReport/LintFinding/ContractCase/ContractResults/DocScore/PhaseScore/QualitativeResults). `trend-models.ts` defines trend's OWN RunData/RunMetrics/BaselineMetrics/etc. | The spike's `types.ts` has parallel-but-different shapes (spike `LintFinding` has a `column` collector's lacks; spike `ContractTestResults`/`CaseResult` add `skipped` collector omits; spike `QualityReport` keeps a nested `ToolResult`+`summary` Record where collector FLATTENS into `lint_total`/`security_total`/…; spike `DocumentScore.relative_path` vs collector `DocScore.path`). Reusing spike interfaces would break `render-md`/`render-html` field accesses. (port-map cluster `reporting` NOTES) |
| **TWO distinct `BaselineMetrics`, kept separate.** Reporting's flat ~52-attribute snapshot (baseline.py:20-88, 31-row compare table) vs trend's 9-field baseline (trend_reports/models.py:245-257, `document_scores` map). | They are different types with different fields and different consumers; the spike comment "flat ~31-metric BaselineMetrics" conflated the 52 attributes with the 31 compared rows — don't let "31" drop fields. (port-map `reporting` NOTES item 5) |
| **Flat `src/` layout, every test directly in `src/*.test.ts`.** Sub-areas use prefixed filenames: `trend-models.ts`/`trend-models.test.ts`, `shared-credential-scrubber.ts`/`.test.ts`, `reporting-collector.ts`, etc. | The DoD pins `bun test tmp/eval-js-judge/src/*.test.ts`, so all test files must sit directly in `src/`. Each Python `test_X.py` maps to a TS `X.test.ts` (or prefixed) mirroring it 1:1 for pure tests. |
| **`pyRound(n, ndigits)` matching Python round-half-to-even, used everywhere Python uses `round()`.** | Confirmed drift: `models.py:74,81,85-88` use banker's rounding; spike `qualitative.ts:165 round4 = Math.round(n*1e4)/1e4` is round-half-up, diverging at exact .5 ties in the 5th decimal (`round(0.123550,4)=0.1235` Python vs `0.1236` JS). Also `gate.py:64,77` (`:.1%`/`:+.3f`) and every `to_dict`. (port-map `qualitative` models.py fidelityRisks) |
| **YAML via `Bun.YAML` (built-in), preserving field-name + insertion-order + nesting parity.** | Python uses PyYAML `default_flow_style=False, sort_keys=False`. Bun.YAML is already used by the spike's `run.ts`. Byte-exact PyYAML scalar/quoting/null formatting is a documented residual risk, NOT a blocker; the DoD asks for field-name compatibility + a golden.yaml round-trip spot-check. (io.py:22-28; port-map `postrun-shared` io.py keyAlgorithms) |
| **Injectable exec/which seams on every binary-shelling module** (quantitative analyzers, postrun `_run_step`, contract server launch, trend fetcher) — default to real `spawnSync`/`Bun.spawn`. | Mirrors Python's `subprocess.run` / `shutil.which` patch points: every analyzer test mocks `subprocess.run`/`shutil.which`/`_tool_version`; the spike's `which`/`runTool` are module-private and must become dependency-injectable so parser-logic tests run pure with stubs. (port-map `quantitative` NOTES; `contracttest`; `trend-io` fetcher) |
| **`config.ts` as an in-scope support module** — RunnerConfig/ExecutionConfig/SandboxConfig subset citing config.py:54-78. | The faithful `postrun.ts` rewrite (`run_post_evaluation(run_folder, config, use_sandbox)`) and the contract sandbox path read `config.execution.post_run_timeout` (300s) and `config.execution.sandbox.{enabled,image,memory,cpus}` (`True`/`aidlc-sandbox:latest`/`2g`/`2`). (port-map `postrun-shared` DEPENDENCIES) |
| **LLM/Bedrock/external-binary/Docker/gh paths behind opt-in env gates with clean skips.** | Honors the three-concerns split (determinism→tool, knowledge→LLM, judgement→human). These never sit in the default tier (README §"If this graduates"). |

---

## Module map (in-scope Python source → TS target)

Status legend: **ported** = faithful on disk; **drifted** = on disk but materially
diverges (Phase 1 fixes); **partial** = some exports ported, rest missing;
**not-yet** = no TS yet.

| Python module (file) | Lines | TS target | Status | Key algorithms to preserve (py file:line) | # tests |
| --- | --- | --- | --- | --- | --- |
| qualitative/models.py | 98 | qualitative.ts + types | **drifted** | overall = intent*.4+design*.4+completeness*.2 (22-26); overall_score = mean of scored phases only (64-66); to_dict re-runs compute_overall then round(...,4) + renames relative_path→**path** (68-98) | (shared w/ scorer) |
| qualitative/document.py | 267 | qualitative.ts | **drifted** | `_INTENT_PREFIX ^intent-\d{3}-[^/]+/` (26); `_CONSTRUCTION_UNIT` → `\1_unit_/\2` (31,54); pass-1 phase from REFERENCE doc (212-266); pass-2 LLM (135-195) = G2, unported | 6 (test_document) |
| qualitative/scorer.py | 287 | qualitative.ts | **drifted** | 55-word STOPWORDS (19-74); design=.6*id_jaccard+.4*heading_jaccard (148); completeness branch (150-153); LLM unclamped + rubric prompt (282-284,176-191) | 24 (test_scorer) |
| qualitative/comparator.py | 104 | qualitative.ts | **drifted** | phase order (inception,construction,other)+extras (72-74); cwd-relative path rewrite (81-89); default LlmScorer + output_path YAML write (42-47,100-102) | 8 (test_comparator) |
| quantitative/models.py | 85 | quantitative.ts + types | **ported** | compute_summary security+semgrep merge w/ has_security_tool gate; conditional summary keys (59-83) | 4 (test_models) |
| quantitative/scanner.py | 189 | quantitative.ts | **drifted** | BFS depth-3 root-first (65-88); 18-entry `_SKIP_DIRS` (24-45); **project_root RELATIVE to workspace** (135); write_report/print_report unported | 9 (test_scanner) |
| quantitative/analyzers.py | 533 | quantitative.ts | **drifted** | `_tool_version` regex (35-55) UNPORTED; CPD os.walk excludes (447-467); `_resolve_pmd` (412-426); `?` sentinels; CPD XML defusedxml ns-strip (491-523) | 9 (test_analyzers) |
| reporting/collector.py | 451 | reporting-collector.ts | **not-yet** | executor‖orchestrator token fallback (263); pass_pct inline (343); errors filter k!='details' & int (314); semgrep_total/high computed (381-382); lint file→basename (359); `_parse_coverage` 2-regex (210-215) | 3 (test_collector) |
| reporting/baseline.py | 513 | reporting-baseline.ts | **partial** | `_classify` tol 0.001 + golden==0 pct edge (348); 31-row metrics_spec higher_is_better (365-482); extract phase routing (149-153); write/load nesting lockstep (160-229) | 19 (test_baseline) |
| reporting/render_md.py | 470 | render-md.ts | **drifted** (report.ts is a throwaway subset) | `_ms_to_human`/`_fmt_tokens`/`_fmt_val`/`_status_icon`/`_fmt_delta_val`/`_md_delta` (10-76); contract grouping parts[2] (266-269); verdict icons ≥0.8/≥0.6 (130,342); baseline cat transitions (417-456) | 7 (test_render md) |
| reporting/render_html.py | 700 | render-html.ts | **not-yet** | CSS verbatim incl `\2714`/`\2718` (10-126); `_esc` html.escape quote=True (129-130); `_score_ring` hardcoded 3.14159 (175-187); handoff bar width max(...,2) (358-368) | 8 (test_render html) |
| trend_reports/models.py | 293 | trend-models.ts | **not-yet** | SemVer parse start-anchored only (69); frozen+order→explicit compare; security_findings=-1 sentinel (191-192); every list/dict via default_factory (54,139-140,…) | 18 (test_models) |
| trend_reports/gate.py | 134 | gate.ts (rewrite imports) | **ported** (faithful 1:1) | infra-failure precedence (29-56); <2-run early return (117-118); MAIN/PR vs RELEASE scan window (122-131); qual tolerance −0.02 (72-73); contract strict-< (61) | 17 (test_gate) |
| trend_reports/sparkline.py | 104 | trend-sparkline.ts | **not-yet** | bucket min(int(...),7) clamp (22-24); all-equal→mid char '▅' (18-20); trend_arrow cascading thresholds (40-48); **int/float dispatch** format_number/format_delta (61,68,92) | 29 (test_sparkline) |
| trend_reports/render_yaml.py | 31 | trend-render-yaml.ts | **not-yet** | `_serialize` dispatch order **SemVer→Enum→dataclass** (21-26); fields() declaration order = key order (25-26); enum .value (23) | 6 (test_render_yaml) |
| trend_reports/collector.py | 579 | trend-collector.ts | **not-yet** | target_project split-on-'/' guard (107-110); error_count sum of 6 (158-167); design_similarity→accuracy, intent_similarity→clarity remap (281-291); detect_infra reason order (338-373); sort_runs sentinel (999,999,999) (505-514); re-read run-metrics 2× (422-427) | 54 (test_collector trend) |
| trend_reports/fetcher.py | 317 | trend-fetcher.ts (gated) | **not-yet** | 'no asset(s) match' soft-skip vs hard error (96-101); prerelease main-then-PR dedup (224-276); conclusion=='success' client-side filter (147-148) | 22 (test_fetcher) |
| trend_reports/render_md.py | 694 | trend-render-md.ts | **not-yet** | heatmap thresholds ≥.90/.70/<.70/<0 (307-314); `_md_table` ljust per-col (611-628); section-G token delta path split (541-543); `_fmt_vs` sign-flip lower_is_better (660-668) | 8 (test_render_md trend) |
| trend_reports/render_html.py | 1026 | trend-render-html.ts | **not-yet** | section-A card thresholds (272-289); delta coloring recognizes '+','-','−' U+2212 (377-393); bar width value/max*100 max(...,1) (649-655); html.escape (199,218); embedded entities (401-404) | 8 (test_render_html trend) |
| shared/credential_scrubber.py | 159 | shared-credential-scrubber.ts | **not-yet** | 9 ordered patterns, AWS-secret(40) BEFORE generic-hex (14-79); `\1=`/`://\1:` backrefs (62-72); redact_marker collapses ALL (107-109); list handling (146-154) | 16 (test_credential_scrubber) |
| shared/io.py | 37 | shared-io.ts | **not-yet** | atomic temp-in-dir + os.replace; default_flow_style=False + sort_keys=False (21-36) | (via callers) |
| shared/scenario.py | 201 | shared-scenario.ts | **not-yet** | field defaults double as remap keys + *_path resolvers (39-57,91-102); list_scenarios sort by DIR name (129); resolve two-stage + draft warn (170-200); warn-only vs hard-fail (81-114) | (no direct tests in map) |
| shared/sandbox.py | 296 | shared-sandbox.ts (gated, G5) | **not-yet** | two-tier docker probe + module memo (44-71); docker run flag set (111-143); scrub stdout+stderr on success+timeout (155-179) | (Docker-gated; indirect) |
| execution/post_run.py | 448 | postrun.ts (rewrite) | **drifted** | BFS depth-3 marker-at-enqueue (101-125); 4 parser regexes (239-322); parse_test_output total = sum of non-None (344-347); env hygiene HOME=cwd, strip VIRTUAL_ENV/CONDA_PREFIX (179-180); install-fail STILL runs tests (421-433); nested test-results.yaml output (397-443) | 41 (test_post_run) |
| execution/config.py (subset) | (54-78) | config.ts | **not-yet** | SandboxConfig enabled/image/memory/cpus (54-58); ExecutionConfig post_run_timeout=300 + sandbox (62-67); RunnerConfig.execution (71-78) | (support) |
| trend_reports/__main__.py (tests only) | — | trend-main.ts (driver) | **not-yet** (skip-driver) | `_resolve_formats`; `cmd_trend` local-bundle/run-dir guards | 7 (test_main, skip-driver) |
| run.py / scripts (entry) | — | run.ts (extend) | **drifted** | evaluate-only + run_comparison_report + run_trend_report orchestration over the now-faithful renderers + collector | (smoke) |

**In-scope Python source-file count: 26 modules** (24 ported as TS modules +
config subset + the `__main__`/entry surface). The `run.py` mode-dispatch and the
`scripts/run_*.py` drivers are out of scope; only the **evaluate-only scoring
slice** and the **comparison/trend report assembly** they delegate to are ported,
landing in the spike's own `run.ts`.

---

## Phase 1 — Audit & fix the already-ported modules

Each item is an actionable fix with the Python `file:line` and a parity tag:
**[B]** = byte-parity-critical (changes emitted YAML/text or a tested value),
**[C]** = cosmetic / behavioural-but-untested-by-its-cluster.

### qualitative.ts (models + document + scorer + comparator)
- **[B]** Replace `round4` (round-half-up) with `pyRound` (round-half-to-even)
  everywhere Python uses `round(...,4)` — `models.py:74,81,85-88`. Diverges at .5
  ties in the 5th decimal.
- **[B]** Add the `to_dict()`-equivalent serialization layer that **renames per-doc
  `relative_path`→`path`** (`models.py:84`). `test_to_dict_structure` asserts the
  `path` key; the spike's `QualitativeResult.phases[].documents[].relative_path`
  will not round-trip without it.
- **[B]** `compareRuns`: add the `output_path` param + YAML write
  (`comparator.py:100-102`, `mkdir parents + atomic_yaml_dump(result.to_dict())`).
  `test_yaml_output` cannot pass against the current spike (no YAML write at all).
- **[B]** `compareRuns`: store reference/candidate paths as **cwd-relative**
  (`comparator.py:81-89`, `resolve().relative_to(cwd)` with `ValueError`→original),
  not the raw absolute input paths the spike stores (`qualitative.ts:375-376`).
- **[C]** `compareRuns`: restore "LlmScorer-by-default + aws_profile/region/model_id
  plumbing" semantics OR document the deliberate scorer-injection (`comparator.py:15,42-47`).
  Keep the heuristic path the deterministic default; LLM behind a gate.
- **[B-test]** Add a NOT-in-Python test asserting the ported `STOPWORDS` set equals
  the Python 55-word frozenset exactly (`scorer.py:19-74`); the spike encodes them
  as a space-split string (`qualitative.ts:117`) where one typo silently shifts
  every cosine score and no existing test catches it.
- **[C/G2]** Leave LLM pass-2 (`document.py:135-195,237-264`) unported for now (G2,
  see Phase 3) — faithful for the Heuristic path because Python skips pass-2 when
  `bedrock_client is None` (`document.py:238`). When closing G2, also re-plumb
  `comparator.py:54-61` (scorer `_client`/`_model_id`) and the `unmatched_cand`
  re-filter (`document.py:259-264`).
- **[C/LLM-gated]** LLM scorer drifts (don't fix in the deterministic tier, but
  document): spike `clamp01` clamps LLM scores to [0,1] while Python passes floats
  through unclamped (`scorer.py:282-284`); spike `buildPrompt` drops the
  per-dimension rubric bullets + JSON-only instruction (`scorer.py:176-194`); spike
  has no boto3 timeout/retry config (`scorer.py:218-242`).

### quantitative.ts (scanner + analyzers; models is clean)
- **[B]** `_tool_version` is entirely UNPORTED (`analyzers.py:29-55`). Add it: try
  `[cmd,--version]` then `[uv,run,cmd,--version]`, regex `[\d]+\.[\d]+[\.\d]*` else
  first line. Wire it into ruff/bandit/semgrep/eslint/npm `version` fields AND the
  availability gate (Python gates on `version is None` BEFORE `_resolve_cmd`). The
  spike sets `version: cmd.join(' ')` — wrong on every available tool.
- **[B]** `scanner` `project_root`: write **relative-to-workspace** (or `.`),
  `scanner.py:135` — spike writes the ABSOLUTE root (`quantitative.ts:280`). Verified
  by `test_python_nested`.
- **[B]** Missing-field sentinels: Python defaults to `'?'` for code/file/test_id/path
  (`analyzers.py:117,128,182,184,368,380`); spike defaults to `''` (except npm code,
  which is correctly `'?'` at `quantitative.ts:181`).
- **[B]** CPD excludes: Python `os.walk`s the whole tree emitting `--exclude ./<relpath>`
  per nested match + prunes (`analyzers.py:447-467`); spike only checks top-level dirs
  (`quantitative.ts:204`). Different pmd invocation → potentially different findings.
- **[B]** CPD XML parse: hand-rolled regex (`quantitative.ts:212-227`) breaks on
  namespace-prefixed tags `<pmd-cpd:file>`; Python's defusedxml strips the namespace
  (`analyzers.py:491-523`). CPD `version` should be `null`, not `'pmd'` (`analyzers.py:439`).
- **[C/MEDIUM]** `_resolve_pmd`: honor configured `pmd_path` (expanduser+is_file) + try
  `pmd.bat` (`analyzers.py:412-426`); thread `pmd_path` through `scan_workspace`
  (`scanner.py:113,125-129`). The configured-PMD feature is dropped end-to-end.
- **[C]** Expose `which`/`runTool`/`toolVersion` as injectable seams so the 9
  analyzer tests run pure with stubs.

### contract.ts (spec + runner + server — host mode)
- **[B]** Boolean matching: `runner.py:59` `isinstance(.,(int,float))` is TRUE for
  bool (bool subclasses int) → expected booleans compared via `math.isclose`; spike
  `typeof==='number'` routes booleans to `deepEqual` (`contract.ts:85`). `{ok:true}`
  vs `{ok:1}` PASSES in Python, FAILS in spike. Fix the numeric branch to treat bools
  as numbers.
- **[B]** `loadSpec` empty-doc guard: Python `load_spec` does `yaml.safe_load(f) or {}`
  (`spec.py:64-65`); the spike's `loadSpec(doc)` takes a pre-parsed object and
  `loadSpec(undefined)` throws. Put the file-read + `or {}` fallback at the caller
  (run.ts), and guard `loadSpec(null/{})`.
- **[B]** `write_results` is UNPORTED (`runner.py:222-226`); needed by
  `test_roundtrip`. Add `asdict→Bun.YAML→file` (default_flow_style=False, sort_keys=False).
- **[C]** Non-GET null-body: Python sends `json=body` for ALL non-GET even when
  `body is None` (`runner.py:75-77`); spike sends nothing when `body==null`
  (`contract.ts:121`). Could change a 422-vs-400 server response.
- **[C]** Failure-message quoting: Python `!r` single-quotes strings
  (`runner.py:63`); spike `JSON.stringify` double-quotes (`contract.ts:90`). Tests
  substring-match so they pass; emitted text differs.
- **[C/host-gated]** Mid-loop `server.is_running` death check (`runner.py:174-188`) is
  absent; SIGTERM→wait→SIGKILL escalation (`server.py:389-405`) reduced to bare
  `proc.kill('SIGTERM')`; `_resolve_module`/`_discover_asgi_module`/`_find_project_root`
  module-resolution layer (`server.py:52-183`) unported; venv graceful-degrade +
  network-retry (`server.py:205-256`) unported; `waitReady` never drains stderr →
  pipe-deadlock risk + no `stderr[:2000]` tail (`server.py:349-369`). All host-mode
  launch concerns — document as gated; only the matcher/runner/spec are deterministic.

### baseline.ts (loadBaseline/classify/compare faithful; rest missing → Phase 2)
- **[C]** `n(v,d)=v==null?d:Number(v)` (`baseline.ts:27`) coerces explicit YAML `null`
  to default, but Python `.get(key,default)` only applies default when KEY IS ABSENT
  (`baseline.py:255-296`); an explicit `key: null` yields Python `None` but TS `0`.
  Low real-world risk (write_baseline never emits null), but a hand-edited golden.yaml
  diverges. Document; `coverage_pct` (`baseline.ts:62`) is the one field where the
  null-coalescing correctly matches Python.
- `extract_baseline`, `write_baseline`, `promote`, `compare_run_to_baseline` are
  ABSENT — added in Phase 2. `classify`/`compare`/`loadBaseline` verified faithful
  (31-row METRICS_SPEC + higher_is_better flags match `baseline.py:365-482`).

### gate.ts — faithful 1:1, NO logic drift
The control flow is faithful 1:1 to `gate.py` (all three regression branches, both
infra-failure paths, the non-infra fallback, `find_latest_and_previous`, the <2-run
early return, the MAIN/PR full-list scan). Only two changes:
- **[B]** Replace the inline `RunData`/`TrendData`/`GateResult` interfaces
  (`gate.ts:14-36`) + the local `pct` helper with imports from `trend-models.ts`
  (done in Phase 2 after the model lands). Align the `base()` factory (`gate.ts:71-79`)
  with `GateResult`'s dataclass defaults (`regressions` default `[]`).
- **[B]** Swap the formatter strings to `pyRound`-backed Python-style formatters:
  `gate.py:64` `:.1%` and `gate.py:77` `:+.3f` use round-half-to-even; spike
  `toFixed` is round-half-away-from-zero. Tests substring-match (pass), but exact
  strings can drift one ulp.

---

## Phase 2 — Build the not-yet-ported modules, ordered by dependency

Order is chosen so every module's dependencies land first. For each: Python
`file:line`, the dataclasses/functions to port, traps, and its test file.

1. **shared-io.ts** (`shared/io.py:12-36`) — `atomicYamlDump(data, path)`: temp file
   in target dir + `os.replace` (rename), Bun.YAML with block style + insertion order,
   best-effort unlink on failure. *Trap:* PyYAML scalar/quoting/null-as-`null`/multiline
   rendering is the byte-parity hazard — accept field-name parity, spot-check golden.
   No deps. Tests: exercised via callers (`test-baseline`, `test-runner`, `test-scanner`,
   `test-post-run` roundtrips).

2. **shared-credential-scrubber.ts** (`shared/credential_scrubber.py:14-158`) —
   `scrubCredentials(text, redactMarker?)` + `scrubDictValues(...)` + the 9
   `_CREDENTIAL_PATTERNS`. *Traps:* pattern ORDER (AWS-secret 40-char base64 #2 BEFORE
   generic-hex #6); `re.IGNORECASE` flags; `$1`/`$2` backrefs (`\1=`, `://\1:`);
   `redact_marker` collapses ALL 9 replacements to the literal marker (loses the `\1=`
   prefix); list handling scrubs dict/str items only, NOT nested-lists-in-lists
   (`:146-154`). No deps. Test: `shared-credential-scrubber.test.ts` (16 pure).

3. **reporting-collector.ts** (`reporting/collector.py:13-451`) — **the keystone.**
   Define collector's OWN ~14 dataclasses (RunMeta/TokenUsage/HandoffTiming/Artifacts/
   ContextSizeStats/RunMetrics/TestResults/LintFinding/QualityReport/ContractCase/
   ContractResults/DocScore/PhaseScore/QualitativeResults/ReportData). Port `_load_yaml`,
   `_parse_coverage` (two regexes verbatim, `:210-215`), `_parse_context_stats`, and
   `collect`. *Traps:* executor‖orchestrator token fallback (`:263`); errors filter
   `k!='details' and isinstance(v,int)` (`:314`); semgrep_total/high COMPUTED from
   findings not summary (`:381-382`); lint file→basename `Path(...).name` (`:359`);
   pass_pct inline + `or 0` null→0 (`:343`); `generated_at=now(UTC).isoformat(timespec='seconds')`
   → `YYYY-MM-DDTHH:MM:SS+00:00` format. Closes G3+G7. Deps: shared-io. Test:
   `reporting-collector.test.ts` (3: 2 pure + 1 skip-driver fixture).

4. **reporting-baseline.ts completions** (`reporting/baseline.py:91-155,158-232,300-305,508-513`)
   — add `extract_baseline` (ReportData→BaselineMetrics, phase routing inception/construction
   from `avg_overall`, `:149-153`, `promoted_at=now(UTC).isoformat`), `write_baseline`
   (NESTED dict execution/context_size/artifacts/unit_tests/contract_tests/code_quality/
   qualitative → atomic YAML, key nesting in lockstep with `load_baseline`, `:160-232`),
   `promote` (collect→extract→write, `:300-305`), `compare_run_to_baseline`
   (collect→extract→load_baseline→compare, `:508-513`). Apply the `n()` null-vs-absent
   fix from Phase 1 at the IO boundary. Deps: reporting-collector. Test: extend
   `reporting-baseline.test.ts` (19 total incl Promote + RealBaseline skip-driver).

5. **render-md.ts** (`reporting/render_md.py:10-470`) — faithful FULL rebuild (the
   spike's `report.ts` is a throwaway subset). Port `_ms_to_human`/`_fmt_tokens`/
   `_fmt_val`/`_status_icon`/`_fmt_delta_val`/`_md_delta` then `render_markdown(data: ReportData)`
   with ALL sections: header/metadata table/Run Overview/Token Usage/Context Size/
   Handoff Timeline/Artifacts/Unit+Contract+Quality detail/Qualitative (phase+per-doc+
   `<details>` notes + Unmatched CANDIDATE)/Errors/Baseline Comparison (grouped by
   category w/ pct + summary counts)/footer + `write_markdown`. *Traps:* contract
   grouping `parts[2] if >=3 else parts[0]` (`:266-269`); verdict icons ≥0.8/≥0.6
   (`:130,342`); category-transition lookahead (`:417-456`); `'| Dimension | Result |'`
   header (`:113`). Deps: reporting-collector, reporting-baseline, pyRound. Test:
   `reporting-render-md.test.ts` (the markdown half of test_render).

6. **render-html.ts** (`reporting/render_html.py:10-700`) — port CSS verbatim
   (preserve `\2714`/`\2718`, `:74-75`), `_esc` (html.escape quote=True → escape
   `& < > " '`), shared helpers, `_score_ring` (hardcoded `3.14159`, `:175-187`),
   `_progress_class` (≥0.9/≥0.7, different from `_score_color` ≥0.8/≥0.6), handoff bar
   width `max(duration/total*100, 2)` (`:358-368`), `render_html` + `write_html`. Deps:
   reporting-collector, reporting-baseline. Test: `reporting-render-html.test.ts` (HTML
   half of test_render).

7. **trend-models.ts** (`trend_reports/models.py:14-292`) — trend's OWN dataclasses +
   enums + exceptions. *Traps:* `SemVer.parse` regex START-anchored only `^v?(\d+)\.(\d+)\.(\d+)`
   (no `$`; `v1.2.3rc` passes, `1.2` fails, `:69`); frozen+order → explicit `compare()`/
   `lessThan()` (no operator overloading) + `Object.freeze` for the mutation-throws test;
   `CodeQualityMetrics.security_findings=-1` sentinel (`:191-192`); EVERY list/dict via a
   fresh `[]`/`{}` per instance (default_factory, `:54,139-140,181,196,218-219,257`);
   `InfraFailureReason` 7 string values are load-bearing (render_yaml emits `.value`).
   No deps. Test: `trend-models.test.ts` (18 pure).

8. **gate.ts rewrite** — delete the inline interfaces; import RunType/RunData/TrendData/
   GateResult from `trend-models.ts`; apply the `pyRound` formatter fix (Phase 1). Test:
   `gate.test.ts` (17; needs the trend factories helper — see Phase 2 note below).

9. **trend-sparkline.ts** (`trend_reports/sparkline.py:5-103`) — `SPARK_CHARS` 8-char
   ramp, `sparkline`, `trend_arrow`, `format_number`, `format_seconds_as_minutes`,
   `format_delta`, `format_pct`. **BIGGEST HAZARD:** `format_number`/`format_delta`
   dispatch on Python int-vs-float runtime type (`isinstance(n,int)`, `n!=int(n)`,
   `:61,68,92`). JS Number erases this — thread an explicit `isFloat`/precision intent
   (or `formatInt`/`formatFloat`) rather than infer from value; `Number.isInteger(5.0)`
   would misroute a "float" 5.0. *Traps:* bucket `min(int((v-lo)/span*7),7)` clamp
   (`:22-24`); all-equal → middle char '▅' index 4 (`:18-20`); trend_arrow cascading
   exclusive thresholds >0.05/>0.01/<-0.05/<-0.01 (boundary 0.05 falls to ↗, `:40-48`).
   No deps. Test: `trend-sparkline.test.ts` (29 pure).

10. **trend-render-yaml.ts** (`trend_reports/render_yaml.py:13-31`) — `render_trend_yaml`
    + `_serialize`. *Trap:* dispatch ORDER **SemVer→Enum→dataclass** (SemVer is itself a
    frozen dataclass; catch it first or it serializes as `{major,minor,patch}` instead of
    `'v0.1.0'`, `:21-26`); field iteration in declaration order = YAML key order; enum
    `.value`. Tests roundtrip via parse (not byte-compared). Deps: trend-models. Test:
    `trend-render-yaml.test.ts` (6 pure).

11. **trend-collector.ts** (`trend_reports/collector.py:38-579`) — `REQUIRED_YAML`,
    `extract_zip`, `find_yaml_files`, `_load_yaml`, `parse_run_meta`, `parse_run_metrics`,
    `parse_test_results`, `parse_contract_tests`, `parse_quality_report`,
    `parse_qualitative`, `classify_run`, `detect_infra_failure`, `_collect_from_run_dir`,
    `collect_from_zip`, `collect_from_directory`, `load_baseline`, `sort_runs`,
    `compute_deltas`, `collect_trend_data`. *Traps:* target_project `split('/')[1]` only
    when `'/' in vision_file` (`:107-110`); error_count = sum of 6 fields = 21 (`:158-167`);
    `design_similarity→accuracy`, `intent_similarity→clarity`, `Path(path).name`
    (`:281-291`); detect_infra reason order + `'failed'` substring vs blank→RUN_CRASHED
    (`:338-373`); sort_runs sentinel `(999,999,999)` + type_order {RELEASE:0,MAIN:1,PR:2}
    (`:505-514`); `_collect_from_run_dir` RE-READS run-metrics.yaml a 2nd time to backfill
    artifact counts (`:422-427`). Deps: trend-models, shared-io, a zip lib. Test:
    `trend-collector.test.ts` (54 pure, tmp-dir + real-YAML harness — no mocking).

12. **trend-fetcher.ts** (`trend_reports/fetcher.py:15-317`, **gated-network/binary**) —
    `check_gh_available`, `fetch_release_list`, `fetch_release_bundle`, `fetch_workflow_runs`,
    `fetch_artifact_bundle`, `fetch_prerelease_bundles`, `fetch_release_bundles`. Expose an
    injectable spawn seam mirroring Python's `subprocess.run` mock. *Traps:* 'no asset(s)
    match'/'no artifact' soft-skip vs hard-error substring on lowercased stderr (`:96-101`);
    prerelease main-then-PR-dedup via `seen_branches` (`:224-276`); `conclusion=='success'`
    client-side filter (`:147-148`); `fetch_prerelease_bundles` NEVER raises. Deps:
    trend-models. Test: `trend-fetcher.test.ts` (22, gated-network; mock the spawn boundary,
    assert argv + simulate stdout/stderr/returncode).

13. **trend-render-md.ts** (`trend_reports/render_md.py:17-694`) — `render_trend_markdown`
    + sections A-H + `_md_table` + `_build_heatmap_matrix` + `_fmt_vs`/`_fmt_time_vs`/
    `_fmt_token_vs`/`_fmt_token_delta`. *Traps:* heatmap thresholds ≥.90 plain / .70-.89
    italic / <.70 bold / <0 dash (`:307-314`); `_md_table` ljust per column (`:611-628`);
    section-G token delta `format_delta` if abs<1000 else `_fmt_token_delta` (`:541-543`);
    `_fmt_vs` sign-flip for lower_is_better (`:660-668`); `**YES**` literal in section F.
    Deps: trend-models, trend-sparkline, trend-collector (`compute_deltas`). Test:
    `trend-render-md.test.ts` (8 pure).

14. **trend-render-html.ts** (`trend_reports/render_html.py:17-1026`) — `render_trend_html`
    + `_CSS` (verbatim AWS Cloudscape palette) + `_html_header`/`_html_footer`/hero/nav +
    sections A-H + `_score_class`/`_delta_class`/`_html_table`/`_build_heatmap`/`_bl`/
    `_fmt_int_delta`/`_fmt_time_delta`/`_fmt_token_delta_html`/`_fmt_signed_number`.
    *Traps:* delta coloring recognizes '+','-','−' U+2212 (`:377-393`); bar width
    `value/max*100` with `max(...,default=1)` (`:649-655`); `_bl` returns '0' for zero
    baseline (only None→'—'), DIFFERENT from md's truthy '—'-on-falsy — do NOT unify;
    html.escape parity; embedded entities `&mdash;/&ndash;/&rsquo;/&amp;/&rarr;/&minus;/
    &ge;/&lt;` preserved verbatim. Deps: trend-models, trend-sparkline, trend-collector.
    Test: `trend-render-html.test.ts` (8 pure).

15. **shared-scenario.ts** (`shared/scenario.py:20-200`) — `Scenario` model + `load_scenario`
    + `list_scenarios` + `resolve_scenario`. *Traps:* field defaults double as overridable
    manifest keys + `*_path` resolvers after `.resolve()` (`:39-57,91-102`); list_scenarios
    sorts by DIR name NOT Scenario.name despite docstring (`:129`); resolve two-stage lookup
    + draft warning in BOTH branches (`:170-200`); warn-only for missing vision/golden-docs,
    hard-fail only for missing file + missing `name` (`:81-114`). Deps: shared-io (YAML
    load). Test: no direct test in the map; verify against fixtures.

16. **shared-sandbox.ts** (`shared/sandbox.py:20-295`, **gated, G5**) — `SandboxResult`,
    `is_docker_available` (two-tier `docker info` + real `alpine true` probe, **resettable**
    module memo for tests, `:33-71`), `sandbox_run` (docker flag set `:111-143`; scrub
    stdout+stderr on success+timeout `:155-179`), `sandbox_run_detached` (`-d`, returns
    container ID, NOT scrubbed), `sandbox_stop`, `sandbox_is_running`, `sandbox_logs`.
    *Traps:* `os.getuid()`/`os.getgid()` POSIX-only; `--user` mapping is Linux-container
    only — gate the whole module behind Docker availability. Deps: shared-credential-scrubber.
    Test: Docker-gated (no tests in the cluster; verified indirectly via postrun).

17. **config.ts** (`execution/config.py:54-78` subset) — `SandboxConfig`
    {enabled:true, image:'aidlc-sandbox:latest', memory:'2g', cpus:2},
    `ExecutionConfig` {post_run_timeout:300, sandbox}, `RunnerConfig` {execution}. No deps.
    Support module for postrun + contract sandbox.

18. **postrun.ts rewrite** (`execution/post_run.py:20-447`) — REWRITE `runPostRunTests`
    to `runPostEvaluation(run_folder, config, use_sandbox?)`. Add `_truncate` suffix
    `'\n... (output truncated)'` (`:128-131`); nested test-results.yaml output
    (status/project_type/project_root/install{command,exit_code,success,output,sandboxed,
    timed_out?}/test{...,parsed_results}, `:397-443`) via atomic YAML; `parse_test_output`
    all-None for unknown type + total = sum of non-None (`:334-347`); env hygiene HOME=cwd
    + strip VIRTUAL_ENV/CONDA_PREFIX (`:179-180`); install-fail STILL runs tests (`:421-433`);
    `shlex.split`+shell=false (not shell:true); sandbox branch when use_sandbox && docker
    (`:150-170`); REMOVE the cross-module `parseCoverage` bleed (belongs to collector).
    Keep the BFS + 4 parser regexes (already faithful). Deps: shared-io, shared-sandbox,
    shared-credential-scrubber (via sandbox), config. Test: `postrun.test.ts` (41 pure +
    2 gated-binary; two currently FAIL the spike: `test_unknown_project_type`,
    `test_long_text_truncated` — they pin the drifts above).

19. **run.ts entry-point parity** — extend the existing `evaluate-only` orchestrator to
    wire the now-faithful `render-md`/`render-html` (replacing the throwaway `report.ts`
    `ReportInputs` path), and add `run_comparison_report` + `run_trend_report` assembly
    over `reporting-collector`/`reporting-baseline`/`trend-collector`/`trend-render-*`/`gate`.
    Keep stages tolerant of missing inputs (skip with a note). This is the scoring slice
    that the Python `scripts/run_*.py` drivers delegate to — the drivers themselves stay
    out of scope. Test: smoke (`smoke.test.ts` extended) + the Phase-4 parity invariants.

**Phase-2 cross-cutting note — trend factories.** `tests/factories.py` (`make_run`,
`make_trend`) is imported by `test_gate.py:5` and the trend collector/render tests; it
was not in the read list. Port a `trend-factories.ts` helper FIRST (before gate.test/
trend-collector.test/trend-render-*.test): `make_run` auto-parses SemVer from label when
`run_type==RELEASE` and semver is None, computes `unit_tests.total = passed+failed`,
`contract failed = total-passed`, `pass_rate = passed/total`. Also: `test_render_md.py`
and `test_render_html.py` each define a LOCAL `_make_trend` (fixed baseline
unit_tests_passed=192, qualitative_overall=0.891, total_tokens=9840000, exec=1446.0,
ramps qualitative by 0.02/run) — port that local helper into each test file too.

---

## Phase 3 — Gap fixes G1–G6 mapped to concrete changes

- **G1 — Default scorer (DECIDED 2026-06-17).** `comparator.py:15,42-47` defaults the
  scorer to `LlmScorer` (Bedrock) when None. **Decision: the default LIVE judge is
  `AgentSdkScorer`** (claude-agent-sdk, repo's authenticated claude CLI, no API key —
  the only zero-config live path, repo-consistent with sdk-drive.ts). Keep `LlmScorer`
  (first-party SDK, needs `ANTHROPIC_API_KEY`) and add a Bedrock variant
  (`@anthropic-ai/bedrock-sdk`, `JUDGE_MODEL=claude-sonnet-4-5` + temperature 0) as
  opt-in alternates that mirror the Python's Bedrock transport. The deterministic test
  suite ALWAYS uses `HeuristicScorer`; every live-judge path stays behind an env gate
  with a clean heuristic fallback.
- **G2 — LLM pass-2 pairing.** `document.py:_MATCH_PROMPT (117-132)`, `_llm_match_documents
  (135-195)`, and the pass-2 block of `pair_documents (237-264)` are absent; `pairDocuments`
  takes no `bedrock_client`. Faithful for the Heuristic path (Python skips pass-2 when
  client is None, `:238`). When closing: add the pass-2 (gated-llm), re-plumb
  `comparator.py:54-61` scorer `_client`/`_model_id`, and fix the `unmatched_cand`
  re-filter + `exact_matched_cand` re-add (`:257-264`).
- **G3 + G7 — collector closes the execution-cost false positives.** `reporting-collector.ts`
  (Phase 2 step 3) reads a real run folder's six YAMLs into ReportData → BaselineMetrics with
  real token/wall-clock/handoff numbers, so lower-is-better metrics stop reading "improved"
  from zeroed fields. `run.ts run_comparison_report` uses `compare_run_to_baseline`
  (collector-backed) instead of the spike's `currentBaseline(inputs)` zeros (`run.ts:114-147`).
- **G4 — artifact-category exclusion in regression gating.** The shipped golden.yaml zeroes
  artifact-count fields (README G4). `run.ts run_comparison_report` (and any adopting gate)
  must exclude the Artifacts category from the 31-row compare tally OR the rows false-alarm.
  Implement as a category filter on `compare`'s deltas, citing the in-file golden comment.
- **G5 — sandbox + gating.** `shared-sandbox.ts` (Phase 2 step 16) + the contract-server
  sandbox branch + postrun sandbox branch, all behind a Docker-availability gate
  (`is_docker_available`, resettable memo). Never in the default tier.
- **G6 — binary wrapper faithful.** Stage 3 genuinely IS external binaries
  (ruff/bandit/semgrep/eslint/npm/pmd). The port re-implements the parsers via injectable
  exec/which seams; absent tools degrade to `{available:false}` exactly like Python. The
  `_tool_version` fix (Phase 1) makes the version field + availability gate faithful.

---

## Phase 4 — Parity verification plan

1. **Full suite green:** `bun test tmp/eval-js-judge/src/*.test.ts` — all pure +
   gated-with-stubs tests pass, gated-binary/llm/network/Docker tests skip cleanly when
   their tool/key is absent. The two spike-failing tests
   (`test_unknown_project_type`, `test_long_text_truncated`) now PASS post-rewrite.
2. **`tsc --strict` clean** across `src/`.
3. **golden.yaml round-trip:** load the committed
   `test_cases/sci-calc-v2/golden.yaml` → `BaselineMetrics` → `write_baseline` → reload;
   assert field-name + nesting + insertion-order parity (spot-check, not byte diff).
4. **Evaluate-only golden-vs-itself == 1.0:** `run.ts evaluate-only --heuristic` over
   `golden-aidlc-docs` vs itself → `overall_score == 1.0` across all phases.
5. **Mutated candidate < 1.0:** mutate a doc, re-run → `overall_score < 1.0`.
6. **Compare with no execution-cost false positives:** `run_comparison_report` using a
   collector-read run folder → Execution/Context Size rows do not false-alarm "improved"
   (G3/G7); Artifacts category excluded (G4).
7. **Adversarial skeptic pass:** re-audit each module against its Python source-of-truth;
   confirm pyRound usage, the `relative_path→path` rename, the cwd-relative path rewrite,
   the `?` sentinels, the CPD namespace handling, the int/float sparkline dispatch, and the
   `_serialize` SemVer-first order.
8. **README update:** revise the "Known gaps" section to reflect closed gaps (G2 if done,
   G3/G7 via collector, G5 sandbox) and the new module surface.

---

## Ordered work-list

1. Author `pyRound` + the YAML serializer wrapper (shared-io.ts) as the shared substrate.
2. shared-credential-scrubber.ts (+ test).
3. **Phase 1 audit-fixes** to qualitative.ts, quantitative.ts, contract.ts, baseline.ts
   (the drifts that don't depend on new modules: pyRound, `to_dict` rename, cwd-relative
   paths, YAML write, `_tool_version`, project_root-relative, `?` sentinels, bool-as-int,
   `_truncate` suffix is deferred to step 11's rewrite).
4. reporting-collector.ts (keystone; + test) — closes G3/G7.
5. reporting-baseline.ts completions (extract/write/promote/compare_run_to_baseline; + tests).
6. render-md.ts (faithful rebuild; + test).
7. render-html.ts (+ test).
8. trend-models.ts (+ test).
9. Rewrite gate.ts to import trend-models.ts; apply pyRound formatters; + trend-factories.ts.
10. trend-sparkline.ts (+ test), trend-render-yaml.ts (+ test).
11. trend-collector.ts (+ test).
12. trend-fetcher.ts (gated; + test).
13. trend-render-md.ts (+ test), trend-render-html.ts (+ test).
14. shared-scenario.ts; config.ts.
15. shared-sandbox.ts (gated, G5).
16. postrun.ts rewrite (nested YAML + sandbox + env hygiene + install-fail-still-runs; + test).
17. run.ts entry-point parity (evaluate-only renderers + run_comparison_report + run_trend_report).
18. G3/G4/G7 wiring in run_comparison_report; G1 (AgentSdkScorer default + Bedrock/Llm gated alternates); G2 (gated LLM pass-2) as follow-ups.
19. Phase 4 parity verification (suite green, tsc, golden round-trip, 1.0/<1.0, compare,
    skeptic pass, README).
