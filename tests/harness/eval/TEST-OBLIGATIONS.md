# TEST-OBLIGATIONS — complete per-test checklist

Every Python test obligation from the Phase-0 port-map (all 7 clusters), grouped
by its target TS test file (flat `src/*.test.ts`). Each row: Python test name →
one-line assertion → portability class. Tick these off as the ports land.

**Portability classes.** `pure` = deterministic logic, ports 1:1, no deps.
`gated-binary` = SUT shells a real binary (ruff/bandit/eslint/npm or uv+pytest);
runs pure ONLY with an injected exec/which stub, else skip. `gated-network` = SUT
shells `gh`; mock the spawn boundary (assert argv, simulate stdout/stderr/rc).
`skip-driver` = belongs to the CLI `__main__` driver, owned by whoever ports it.

**Flags used below.** ⚠FAILS = currently fails against the spike as written (pins
a drift the port must fix). ⏭FIXTURE = conditionally-skipped; self-skips when its
on-disk fixture/run-dir is absent.

**Grand total: 348** — **303 pure · 24 gated-network · 12 gated-binary · 9 skip-driver.**

---

## qualitative.test.ts → from test_document.py + test_scorer.py + test_comparator.py (47 pure)

> Single TS test file (all three Python files port into `qualitative.ts`). Could
> also split into `qualitative-document.test.ts` / `qualitative-scorer.test.ts` /
> `qualitative-comparator.test.ts` — keep all directly under `src/`.

### from test_document.py (15 pure)
- `TestClassifyPhase::test_inception_path` — classify_phase('inception/requirements/requirements.md')=='inception' — pure
- `TestClassifyPhase::test_construction_path` — classify_phase('construction/plans/code-gen-plan.md')=='construction' — pure
- `TestClassifyPhase::test_root_file` — classify_phase('some-doc.md')=='other' — pure
- `TestClassifyPhase::test_nested_inception` — classify_phase('inception/application-design/components.md')=='inception' — pure
- `TestLoadDocuments::test_loads_markdown_files` — finds 2 md files with correct relative paths from nested dirs — pure
- `TestLoadDocuments::test_skips_aidlc_state_and_audit` — aidlc-state.md & audit.md skipped; only real-doc.md loaded — pure
- `TestLoadDocuments::test_skips_empty_files` — empty + whitespace-only files skipped; only real.md loaded — pure
- `TestLoadDocuments::test_nonexistent_directory` — load_documents on missing dir → [] — pure
- `TestLoadDocuments::test_phase_assignment` — inception/construction/other assigned by path prefix — pure
- `TestPairDocuments::test_perfect_match` — identical ref/cand → 2 paired, no unmatched (scorer=None, pass-1 only) — pure
- `TestPairDocuments::test_unmatched_reference` — ref-only → unmatched_reference==['inception/extra.md'], 1 paired — pure
- `TestPairDocuments::test_unmatched_candidate` — cand-only → unmatched_candidate==['inception/new.md'], 1 paired — pure
- `TestPairDocuments::test_no_overlap` — disjoint paths → 0 paired, each side has its own unmatched — pure
- `TestPairDocuments::test_empty_inputs` — pair_documents([],[]) → all empty — pure
- `TestPairDocuments::test_pair_preserves_content` — paired reference/candidate retain distinct content — pure

### from test_scorer.py (24 pure)
- `TestTokenize::test_basic_tokenization` — content words kept, stopwords (the/shall) dropped — pure
- `TestTokenize::test_removes_stopwords` — all-stopword string → [] — pure
- `TestTokenize::test_removes_short_tokens` — len<=1 (x) dropped; go/api/test kept — pure
- `TestTokenize::test_handles_code_identifiers` — math_engine whole; routes/arithmetic → arithmetic token — pure
- `TestExtractHeadings::test_extracts_all_levels` — #/##/### all extracted lowercased — pure
- `TestExtractHeadings::test_no_headings` — body-only → [] — pure
- `TestExtractHeadings::test_strips_whitespace` — '#  Spaced Heading  ' → ['spaced heading'] — pure
- `TestExtractIdentifiers::test_camel_case` — MathEngine/ResponseModel → lowercased ids present — pure
- `TestExtractIdentifiers::test_snake_case` — math_engine/run_tests extracted — pure
- `TestExtractIdentifiers::test_paths` — src/sci_calc/routes/arithmetic.py contains src AND arithmetic — pure
- `TestCosineSimilarity::test_identical_counters` — cosine(c,c) > 0.99 — pure
- `TestCosineSimilarity::test_disjoint_counters` — no shared keys → 0.0 — pure
- `TestCosineSimilarity::test_partial_overlap` — strictly between 0 and 1 — pure
- `TestCosineSimilarity::test_empty_counter` — empty vs non-empty → 0.0 — pure
- `TestJaccardSimilarity::test_identical_sets` — jaccard(s,s)==1.0 — pure
- `TestJaccardSimilarity::test_disjoint_sets` — {a} vs {b} → 0.0 — pure
- `TestJaccardSimilarity::test_both_empty` — jaccard(empty,empty)==1.0 — pure
- `TestJaccardSimilarity::test_one_empty` — jaccard(empty,{a})==0.0 — pure
- `TestHeuristicScorer::test_identical_documents` — intent>.95, design>.95, completeness==1.0, overall>.95 — pure
- `TestHeuristicScorer::test_completely_different_documents` — intent<0.3, completeness<0.3 — pure
- `TestHeuristicScorer::test_similar_but_not_identical` — paraphrased same-heading → intent>0.3, completeness==1.0 — pure
- `TestHeuristicScorer::test_missing_sections_reduces_completeness` — cand missing 2/3 ref sections → completeness<=0.5 — pure
- `TestHeuristicScorer::test_scores_in_valid_range` — all four scores within [0.0,1.0] — pure
- `TestHeuristicScorer::test_relative_path_preserved` — score.relative_path from pair; phase from pair not path — pure

### from test_comparator.py (8 pure)
- `TestCompareRuns::test_identical_runs` — identical 2-phase trees → overall>0.9, 2 phase_scores, no unmatched — pure
- `TestCompareRuns::test_unmatched_documents_tracked` — extra.md unmatched_reference, new-doc.md unmatched_candidate — pure
- `TestCompareRuns::test_empty_candidate` — empty cand dir → overall_score==0.0, 1 unmatched_reference — pure
- `TestCompareRuns::test_yaml_output` ⚠FAILS — output_path written; YAML has overall_score/phases/documents keys (spike writes NO YAML) — pure
- `TestCompareRuns::test_to_dict_structure` ⚠FAILS — to_dict shape: overall float, phases avg_*, documents path+*_similarity (spike lacks to_dict + 'path' rename) — pure
- `TestCompareRuns::test_phase_ordering` — construction-before-inception input → ordered ['inception','construction'] — pure
- `TestCompareRunsWithRealData::test_self_comparison_golden` ⏭FIXTURE — golden vs itself → overall>0.95, no unmatched, >=2 phases; skips if golden dir absent — pure
- `TestCompareRunsWithRealData::test_cross_run_comparison` ⏭FIXTURE — golden vs real run → overall>0.3, every phase avg_intent>0.0; skips if dirs absent — pure

**Recommended extra (not in Python):** assert ported STOPWORDS == Python's 55-word set exactly (`scorer.py:19-74`).

**File count: 47 (47 pure; 2 ⚠FAILS, 2 ⏭FIXTURE)**

---

## quantitative.test.ts → from test_models.py + test_scanner.py + test_analyzers.py (12 pure · 10 gated-binary)

### from test_models.py (4 pure)
- `test_compute_summary_lint_only` — lint_total=3/errors=2/warnings=1; no security/dup keys — pure
- `test_compute_summary_security_only` — security_total=2/high=1/low=1; no lint keys — pure
- `test_compute_summary_both` — empty lint+security available → all four totals 0 — pure
- `test_compute_summary_unavailable_tool` — unavailable lint → 'lint_total' NOT in summary (omitted, not zeroed) — pure

### from test_scanner.py (8 pure)
- `TestDetectProject::test_python_at_root` — pyproject.toml at root → ('python', root) — pure
- `TestDetectProject::test_python_nested` — package.json in app/ → ('node', nested) via BFS (name says python, asserts node) — pure
- `TestDetectProject::test_empty_workspace` — empty dir → None — pure
- `TestDetectProject::test_skips_venv` — .venv/pyproject.toml ignored → None — pure
- `TestDetectProject::test_skips_node_modules` — node_modules/package.json ignored → None — pure
- `TestScanWorkspace::test_no_project` — scan_workspace on empty dir → None — pure
- `TestScanWorkspace::test_python_project` — run_ruff/run_bandit MOCKED → project_type=python, lint.tool=ruff, security.tool=bandit, lint_total=0/security_total=0 — pure
- `TestWriteReport::test_roundtrip` — scan_workspace (mocked) → write_report → YAML reloads project_type=python, lint.tool=ruff, summary.lint_total=0 (needs write_report YAML emit) — pure

### from test_analyzers.py (10 gated-binary — inject which/runTool/toolVersion stubs)
- `TestRuff::test_not_installed` — which→None → not available, error 'ruff not found' — gated-binary
- `TestRuff::test_clean_output` — mocked stdout='[]' → available, 0 findings — gated-binary
- `TestRuff::test_findings_parsed` — 2 items → [0] E501 error, [1] W291 warning (E-prefix rule) — gated-binary
- `TestBandit::test_not_installed` — which→None → not available — gated-binary
- `TestBandit::test_clean_output` — results=[] → available, 0 findings — gated-binary
- `TestBandit::test_findings_parsed` — 1 result → code B608, severity 'high' (lowercased), cwe 'CWE-89' — gated-binary
- `TestEslint::test_not_installed` — which→None → not available (eslint/npx not found) — gated-binary
- `TestEslint::test_findings_parsed` — 2 messages → [0] sev 2→error, [1] sev 1→warning — gated-binary
- `TestNpmAudit::test_not_installed` — which→None → not available — gated-binary
- `TestNpmAudit::test_no_lockfile` — npm present, no lockfile → available, error 'no package-lock.json found' — gated-binary

**File count: 22 (12 pure · 10 gated-binary)**

---

## contract.test.ts → from test_runner.py + test_spec.py (17 pure)

### from test_runner.py (12 pure)
- `TestMatchBody::test_exact_match` — expected subset present (extra ignored key) → [] failures — pure
- `TestMatchBody::test_missing_key` — key in expected absent from actual → 1 failure "missing key 'result'" — pure
- `TestMatchBody::test_wrong_value` — value mismatch → 1 failure containing "'status'" — pure
- `TestMatchBody::test_nested_match` — nested dict subset → [] failures — pure
- `TestMatchBody::test_nested_mismatch` — nested value mismatch → 1 failure prefix 'error.code' — pure
- `TestMatchBody::test_float_tolerance` — 3.0 vs 3.0000000001 within rel_tol=1e-6 → [] (isClose) — pure
- `TestMatchBody::test_float_mismatch` — 3.0 vs 5.0 → 1 failure — pure
- `TestRunCase::test_get_success` — GET 200 matching body → passed, actual 200, no failures, latency set (stub fetch) — pure
- `TestRunCase::test_wrong_status` — GET 200 expected 404 → not passed, failure mentions 'status' — pure
- `TestRunCase::test_post_body_mismatch` — POST expected result 3 vs actual 99 → not passed, failure mentions 'result' — pure
- `TestRunCase::test_connection_error` — fetch rejection → not passed, result.error set — pure
- `TestWriteResults::test_roundtrip` — write_results YAML reloads total=3/passed=2/failed=1/server_started=True (needs YAML writer) — pure

### from test_spec.py (5 pure)
- `test_load_openapi_spec` — full spec + 3 cases parse: app fields, title/version, methods upper-cased, body/expected_body/operation_id, 422 case (caller yaml-parses first) — pure
- `test_load_spec_defaults` — minimal spec → framework='fastapi', startup_timeout=15, port=0; 1 GET case null body — pure
- `test_load_spec_multiple_methods` — one path GET+POST both x-test-cases → 2 cases, methods {GET,POST} — pure
- `test_load_spec_no_test_cases` — operation without x-test-cases silently skipped → 0 cases — pure
- `test_load_real_openapi_spec` ⏭FIXTURE — real sci-calc-v2/openapi.yaml: title/version/module, >=60 cases, operation_ids include health/arithmetic_add/…; self-skips if absent — pure

**File count: 17 (17 pure; 1 ⏭FIXTURE)**

---

## reporting-collector.test.ts + reporting-baseline.test.ts + reporting-render-md.test.ts + reporting-render-html.test.ts → from test_collector.py + test_baseline.py + test_render.py (31 pure · 2 skip-driver)

### reporting-collector.test.ts ← test_collector.py (2 pure · 1 skip-driver)
- `test_collect_all_artifacts` — collect() over full 6-YAML folder: status, executor_model, handoffs=3, total_tokens=1050000, wall_clock=3600000, source_files=10, tests.passed=192, test_ok, coverage_pct=91.3, lint_total=2/errors=1, contracts passed=9/failed=1, qualitative overall=0.89, doc intent=0.95 — pure
- `test_collect_missing_artifacts` — collect() on empty folder → meta.status=='' and tests/quality/contracts/qualitative all None — pure
- `test_collect_real_run` ⏭FIXTURE — collect() against a real run dir (runs/20260218T…): handoffs=3, tests.passed=192, contracts.passed=88, qualitative>0.8; early-returns if absent — skip-driver

### reporting-baseline.test.ts ← test_baseline.py (16 pure; 1 ⏭FIXTURE)
- `TestExtractBaseline::test_extracts_all_fields` — extract_baseline maps: tests_passed=100/failed=2, contract_passed=48, lint_errors=3, qualitative_score=0.85, inception=0.88/construction=0.82 (phase routing), lines_of_code=2000, total_tokens=1050000 — pure
- `TestExtractBaseline::test_handles_missing_sections` — only meta → zeroed tests_passed/contract_passed/qualitative_score — pure
- `TestWriteAndLoad::test_roundtrip` — write_baseline→load_baseline round-trips all fields (tests_passed=192, contract_passed=88, lint_errors=5, qualitative=0.891, inception=0.89, loc=3522, total_tokens=9835935) — pure
- `TestWriteAndLoad::test_yaml_is_readable` — written golden.yaml parses with nested shape: raw['unit_tests']['passed']==10, 'qualitative' key present — pure
- `TestCompare::test_identical_runs` — compare(a,a) → improved==0, regressed==0, unchanged==31 — pure
- `TestCompare::test_improved_tests` — Tests Pass % 90→95 → 'improved', delta==5.0 — pure
- `TestCompare::test_regressed_quality` — Qualitative 0.9→0.7 → 'regressed', regressed>=1 — pure
- `TestCompare::test_fewer_lint_errors_is_improvement` — Lint Errors 10→3 (lower-is-better) → 'improved' — pure
- `TestCompare::test_more_lint_errors_is_regression` — Lint Errors 3→10 → 'regressed' — pure
- `TestCompare::test_fewer_tokens_is_improvement` — Total Tokens 10M→8M (lower-is-better) → 'improved' — pure
- `TestCompare::test_mixed_results` — mixed golden/current → improved>0 AND regressed>0 — pure
- `TestPromote::test_promote_creates_file` — promote(run,golden) writes golden.yaml, baseline.executor_model=='opus', load_baseline reads back (collect→extract→write e2e) — pure
- `TestReportIntegration::test_markdown_includes_comparison` — render_markdown w/ comparison contains 'Baseline Comparison','Improved','Regressed' — pure
- `TestReportIntegration::test_html_includes_comparison` — render_html w/ comparison contains 'Baseline Comparison','delta-improved','delta-regressed' — pure
- `TestReportIntegration::test_no_comparison_when_absent` — render_markdown w/o comparison does NOT contain 'Baseline Comparison' — pure
- `TestRealBaseline::test_load_real_golden` ⏭FIXTURE — load real sci-calc-v2/golden.yaml: contract_passed==total==88, tests_passed==total, 0<qualitative<=1; early-returns if absent — skip-driver

> Note: the 2 ⏭FIXTURE rows above (`test_collect_real_run`, `test_load_real_golden`)
> are the cluster's 2 skip-driver tests — they read real on-disk artifacts and self-skip.

### reporting-render-md.test.ts ← test_render.py TestMarkdown (6 pure)
- `TestMarkdown::test_contains_header` — output contains '# AIDLC Evaluation Report' — pure
- `TestMarkdown::test_contains_verdict_table` — contains '## Verdict','192/192','88/88' — pure
- `TestMarkdown::test_contains_token_usage` — contains '## Token Usage' and 'Executor' — pure
- `TestMarkdown::test_contains_qualitative_score` — contains '0.891' and 'Inception' — pure
- `TestMarkdown::test_contains_lint_findings` — contains '`E501`' and '`I001`' — pure
- `TestMarkdown::test_write_to_file` — write_markdown writes >500 chars incl header — pure

### reporting-render-html.test.ts ← test_render.py TestHTML (8 pure)
- `TestHTML::test_contains_doctype` — contains '<!DOCTYPE html>' — pure
- `TestHTML::test_contains_verdict_cards` — contains '192/192','88/88','badge-pass' — pure
- `TestHTML::test_contains_score_ring` — contains 'ring-container' and '89%' (0.891) — pure
- `TestHTML::test_contains_handoff_timeline` — contains 'Handoff Timeline' and 'executor' — pure
- `TestHTML::test_contains_qualitative_bars` — contains 'phase-bars' and 'inception' — pure
- `TestHTML::test_contains_lint_findings` — contains 'E501' and 'I001' — pure
- `TestHTML::test_self_contained` — contains '<style>' and 'Inter' (inline CSS, font name) — pure
- `TestHTML::test_write_to_file` — write_html writes >2000 chars incl doctype — pure

**Cluster count: 33 (31 pure · 2 skip-driver; 2 ⏭FIXTURE = the skip-driver rows)**

---

## gate.test.ts + trend-models.test.ts + trend-sparkline.test.ts + trend-render-yaml.test.ts → from test_gate.py + test_models.py + test_sparkline.py + test_render_yaml.py (74 pure)

### gate.test.ts ← test_gate.py (17 pure — needs trend-factories.ts make_run/make_trend)
- `TestCheckRegressions::test_no_regressions_passes` — two releases, score improves → passed True, regressions [] — pure
- `TestCheckRegressions::test_contract_test_regression` — contract 88→85 → passed False, regression mentions 'contract' — pure
- `TestCheckRegressions::test_unit_test_failures_regression` — unit failed 0→5 → passed False, regression mentions unit/test — pure
- `TestCheckRegressions::test_qualitative_regression` — 0.90→0.85 (drop 0.05>0.02) → passed False, mentions 'qualitative' — pure
- `TestCheckRegressions::test_small_qualitative_drop_not_regression` — 0.90→0.885 (drop 0.015<0.02) → passed True — pure
- `TestCheckRegressions::test_fewer_than_two_runs_passes` — single run → passed True — pure
- `TestCheckRegressions::test_empty_runs_passes` — zero runs → passed True — pure
- `TestCheckRegressions::test_labels_set` — latest_label=='v0.1.1', comparison_label=='v0.1.0' — pure
- `TestFindLatestAndPrevious::test_empty_runs` — empty → (None, None) — pure
- `TestFindLatestAndPrevious::test_single_run` — one run → (r1, None), latest is r1 by identity — pure
- `TestFindLatestAndPrevious::test_two_releases` — latest r2, prev r1 — pure
- `TestFindLatestAndPrevious::test_latest_is_main` — latest MAIN → compares to most-recent release r2 — pure
- `TestFindLatestAndPrevious::test_latest_is_pr` — latest PR (pr_number=42) → compares to release r1 — pure
- `TestCheckRegressionsInfraFailure::test_latest_infra_failure_skips_regression` — latest infra → passed True, detected True, regressions [], summary 'infrastructure' — pure
- `TestCheckRegressionsInfraFailure::test_previous_infra_failure_finds_older_comparison` — middle infra → falls back to v0.1.0, passed True, comparison_label=='v0.1.0' — pure
- `TestCheckRegressionsInfraFailure::test_non_infra_failure_still_detects_regression` — normal score drop → passed False, detected False — pure
- `TestCheckRegressionsInfraFailure::test_all_runs_infra_failure_gate_passes` — only comparison candidate infra → passed True, detected True — pure

### trend-models.test.ts ← test_models.py (18 pure)
- `TestSemVer::test_parse_with_v_prefix` — parse('v1.2.3')==SemVer(1,2,3) — pure
- `TestSemVer::test_parse_without_v_prefix` — parse('0.1.5')==SemVer(0,1,5) — pure
- `TestSemVer::test_parse_large_numbers` — parse('v999.888.777')==SemVer(999,888,777) — pure
- `TestSemVer::test_parse_invalid_empty` — parse('') raises ValueError 'Cannot parse semver' — pure
- `TestSemVer::test_parse_invalid_text` — parse('abc') raises ValueError — pure
- `TestSemVer::test_parse_invalid_two_parts` — parse('1.2') raises (only 2 segments) — pure
- `TestSemVer::test_str` — str(SemVer(0,1,5))=='v0.1.5' — pure
- `TestSemVer::test_ordering` — (0,1,0)<(0,2,0), (0,1,5)<(0,1,6), (0,1,9)<(1,0,0) — pure
- `TestSemVer::test_equality` — SemVer(1,2,3)==SemVer(1,2,3) value equality — pure
- `TestSemVer::test_frozen` — assigning sv.major raises (frozen → readonly/Object.freeze throws) — pure
- `TestRunType::test_values` — RunType members release/main/pr — pure
- `TestExceptions::test_fetch_error_is_trend_report_error` — FetchError subclass of TrendReportError — pure
- `TestExceptions::test_collector_error_is_trend_report_error` — CollectorError subclass of TrendReportError — pure
- `TestDataclassDefaults::test_baseline_metrics_defaults` — unit_tests_passed 0, qualitative_overall 0.0, document_scores {} — pure
- `TestDataclassDefaults::test_gate_result_defaults` — GateResult(passed=True): regressions [], latest_label '', infra_failure_detected False, summary '' — pure
- `TestInfraFailure::test_defaults_no_failure` — not is_infra_failure, reasons [], summary '' — pure
- `TestInfraFailure::test_with_reasons` — 2 reasons → is_infra_failure True, len==2 — pure
- `TestInfraFailureReason::test_values` — all 7 string values exact (bedrock_throttled/…/metrics_missing) — pure

### trend-sparkline.test.ts ← test_sparkline.py (33 pure)
- `TestSparkline::test_empty_list` — sparkline([])=='' — pure
- `TestSparkline::test_single_value` — sparkline([5]) length 1 — pure
- `TestSparkline::test_all_identical` — sparkline([3,3,3,3]) length 4, all chars identical — pure
- `TestSparkline::test_ascending` — sparkline([1..5]) length 5, first char < last char — pure
- `TestSparkline::test_two_values_min_max` — sparkline([0,100]) length 2 — pure
- `TestSparkline::test_negative_values` — sparkline([-10,0,10]) length 3 — pure
- `TestTrendArrow::test_empty_list` — trend_arrow([])=='→' — pure
- `TestTrendArrow::test_single_value` — trend_arrow([5])=='→' — pure
- `TestTrendArrow::test_strong_increase` — trend_arrow([100,110])=='↑' (+10%>5%) — pure
- `TestTrendArrow::test_strong_decrease` — trend_arrow([100,90])=='↓' (-10%<-5%) — pure
- `TestTrendArrow::test_flat` — trend_arrow([100,100.5])=='→' (+0.5% flat band) — pure
- `TestTrendArrow::test_zero_first_positive_last` — trend_arrow([0,10])=='↑' (first==0, last>0) — pure
- `TestTrendArrow::test_zero_both` — trend_arrow([0,0])=='→' — pure
- `TestTrendArrow::test_mild_increase` — trend_arrow([100,103])=='↗' (+3% in 1-5%) — pure
- `TestTrendArrow::test_mild_decrease` — trend_arrow([100,97])=='↘' (-3% in -1..-5%) — pure
- `TestFormatNumber::test_integer_small` — format_number(42)=='42' (int branch) — pure
- `TestFormatNumber::test_integer_thousands` — format_number(1500) contains 'K' — pure
- `TestFormatNumber::test_integer_millions` — format_number(9260000) contains 'M' — pure
- `TestFormatNumber::test_float_small` — format_number(0.891)=='0.891' (non-integral float <1000 → 3dp) — pure
- `TestFormatNumber::test_float_millions` — format_number(9.26e6) contains 'M' — pure
- `TestFormatNumber::test_zero_int` — format_number(0)=='0' (int branch — needs int/float intent) — pure
- `TestFormatSecondsAsMinutes::test_zero` — format_seconds_as_minutes(0)=='0.0m' — pure
- `TestFormatSecondsAsMinutes::test_one_minute` — (60)=='1.0m' — pure
- `TestFormatSecondsAsMinutes::test_fractional` — (90)=='1.5m' — pure
- `TestFormatDelta::test_positive_int` — format_delta(5)=='+5' — pure
- `TestFormatDelta::test_negative_int` — format_delta(-3)=='-3' — pure
- `TestFormatDelta::test_zero_int` — format_delta(0)=='+0' (sign always) — pure
- `TestFormatDelta::test_positive_float` — format_delta(0.5)=='+0.5' (float, default precision 1) — pure
- `TestFormatDelta::test_custom_precision` — format_delta(0.028, precision=3)=='+0.028' — pure
- `TestFormatPct::test_zero` — format_pct(0.0)=='0.0%' — pure
- `TestFormatPct::test_full` — format_pct(1.0)=='100.0%' — pure
- `TestFormatPct::test_partial` — format_pct(0.5)=='50.0%' — pure
- `TestFormatPct::test_over_one` — format_pct(1.5) contains '150' — pure

### trend-render-yaml.test.ts ← test_render_yaml.py (6 pure)
- `TestRenderTrendYaml::test_roundtrip` — dump→safe_load: repo, runs len 1, label v0.1.0, unit_tests.passed 175 survive — pure
- `TestRenderTrendYaml::test_run_type_serialized_as_value` — run_type emitted as 'release' (enum .value) — pure
- `TestRenderTrendYaml::test_empty_runs` — empty runs → parsed['runs']==[] — pure
- `TestRenderTrendYaml::test_output_is_string` — render_trend_yaml returns a str — pure
- `TestRenderTrendYaml::test_infra_failure_serialized` — is_infra_failure True, reasons contains 'bedrock_throttled', summary 'test' — pure
- `TestRenderTrendYaml::test_infra_failure_reason_serialized_as_value` — reasons → ['bedrock_service_unavailable','run_failed'] (enum values in order) — pure

**Cluster count: 74 (74 pure)**

---

## trend-collector.test.ts + trend-fetcher.test.ts + trend-render-md.test.ts + trend-render-html.test.ts + trend-main.test.ts → from test_collector.py + test_fetcher.py + test_render_md.py + test_render_html.py + test_main.py (69 pure · 24 gated-network · 7 skip-driver)

### trend-collector.test.ts ← test_collector.py (53 pure — tmp-dir + real-YAML harness, no mocking)
- `TestExtractZip::test_normal_extraction` — extract_zip returns subdir containing written file — pure
- `TestExtractZip::test_corrupt_zip_raises` — non-zip bytes → CollectorError 'Corrupt zip' — pure
- `TestFindYamlFiles::test_all_present` — all 6 YAML present → dict len 6 — pure
- `TestFindYamlFiles::test_none_present` — empty dir → empty dict — pure
- `TestFindYamlFiles::test_partial` — only run-meta.yaml → dict len 1 'run-meta' — pure
- `TestParseRunMeta::test_normal` — run_id, rules_ref, model (executor_model), target_project from vision_file split — pure
- `TestParseRunMeta::test_missing_config` — missing config → rules_ref & model default '' — pure
- `TestParseRunMetrics::test_normal` — total_tokens, exec_seconds (ms/1000), 1 agent, 1 handoff, max_context — pure
- `TestParseRunMetrics::test_empty` — empty YAML → total_tokens 0, exec_seconds 0.0 — pure
- `TestParseTestResults::test_normal` — passed/failed/total from test.parsed_results — pure
- `TestParseTestResults::test_none_values` — None passed/failed coerce to 0 (`x or 0`) — pure
- `TestParseContractTests::test_normal` — total/passed; one failing case; failure.endpoint==path — pure
- `TestParseContractTests::test_zero_total` — total 0 → pass_rate 0.0 (no div-by-zero) — pure
- `TestParseQualityReport::test_with_security` — lint_findings from summary, security_findings=1, scanner_available True — pure
- `TestParseQualityReport::test_without_security` — no security block → security_findings -1, scanner_available False — pure
- `TestParseQualitative::test_normal` — overall/inception/construction scores; 2 document_scores — pure
- `TestParseQualitative::test_empty_phases` — empty phases → inception/construction 0.0, no doc scores — pure
- `TestClassifyRun::test_release` — 'v0.1.5' → RELEASE, label 'v0.1.5', SemVer(0,1,5), pr None — pure
- `TestClassifyRun::test_main` — 'main' → MAIN, label 'main', semver None — pure
- `TestClassifyRun::test_pr` — 'pr-42' → PR, label 'PR #42', pr_number 42 — pure
- `TestClassifyRun::test_unknown_format` — 'some-branch' → RELEASE, raw label, semver None — pure
- `TestSortRuns::test_releases_sorted_by_semver` — releases sorted ascending by semver — pure
- `TestSortRuns::test_main_after_releases` — main ordered after release — pure
- `TestSortRuns::test_pr_after_main` — order release, main, PR — pure
- `TestSortRuns::test_empty_list` — empty → empty — pure
- `TestComputeDeltas::test_two_runs` — 1 delta: unit/qualitative/token deltas (20, ~0.05, 200000) — pure
- `TestComputeDeltas::test_empty_list` — empty → [] — pure
- `TestComputeDeltas::test_single_run` — single → [] — pure
- `TestLoadBaseline::test_file_exists` — unit_tests_passed, qualitative_overall, exec_seconds (ms/1000), document_scores map — pure
- `TestLoadBaseline::test_file_missing` — missing → empty BaselineMetrics (zeros) — pure
- `TestCollectFromZip::test_full_zip` — full zip → RunData label v0.1.5, RELEASE, 175 passed, qual 0.898 — pure
- `TestCollectFromZip::test_missing_run_meta_raises` — zip without run-meta → CollectorError 'run-meta.yaml missing' — pure
- `TestCollectFromZip::test_missing_optional_files_use_defaults` — only run-meta → optional models default to zeros — pure
- `TestCollectFromDirectory::test_full_directory` — full dir → RunData v0.1.5, 175 passed, qual 0.898 — pure
- `TestCollectFromDirectory::test_missing_run_meta_raises` — dir without run-meta → CollectorError 'run-meta.yaml missing' — pure
- `TestCollectFromDirectory::test_not_a_directory_raises` — file path → CollectorError 'Not a directory' — pure
- `TestCollectFromDirectory::test_nonexistent_path_raises` — nonexistent → CollectorError 'Not a directory' — pure
- `TestCollectFromDirectory::test_missing_optional_files_use_defaults` — minimal dir → optional models default zeros — pure
- `TestCollectTrendDataDirectoryDispatch::test_mix_of_zips_and_directories` — dispatch dir vs zip; 2 runs assembled — pure
- `TestDetectInfraFailure::test_clean_run_no_failure` — clean → not infra failure, reasons [] — pure
- `TestDetectInfraFailure::test_throttle_events_flagged` — throttle_events>0 → THROTTLED — pure
- `TestDetectInfraFailure::test_service_unavailable_flagged` — service_unavailable_events>0 → SERVICE_UNAVAILABLE — pure
- `TestDetectInfraFailure::test_model_error_flagged` — model_error_events>0 → MODEL_ERROR — pure
- `TestDetectInfraFailure::test_run_failed_status` — status 'Status.FAILED' → RUN_FAILED — pure
- `TestDetectInfraFailure::test_missing_status_means_crash` — empty status → RUN_CRASHED — pure
- `TestDetectInfraFailure::test_metrics_missing` — has_metrics_file False → METRICS_MISSING — pure
- `TestDetectInfraFailure::test_server_start_failed` — server_started False → SERVER_START_FAILED — pure
- `TestDetectInfraFailure::test_multiple_reasons` — multiple signals → >=3 reasons + summary 'Infrastructure failure detected' — pure
- `TestParseRunMetricsIndividualErrors::test_individual_error_fields_populated` — all 6 error fields parsed; error_count==21 — pure
- `TestParseRunMetricsIndividualErrors::test_missing_errors_default_to_zero` — missing errors block → all 0, error_count 0 — pure
- `TestParseContractTestsServerStarted::test_server_started_true` — server_started True, server_error None→'' — pure
- `TestParseContractTestsServerStarted::test_server_started_false` — server_started False, server_error 'Connection refused' — pure
- `TestParseContractTestsServerStarted::test_server_started_missing_defaults_true` — missing → True, server_error '' — pure

### trend-fetcher.test.ts ← test_fetcher.py (24 gated-network — mock the spawn boundary)
- `TestCheckGhAvailable::test_gh_not_installed` — FileNotFoundError → FetchError 'gh CLI not found' — gated-network
- `TestCheckGhAvailable::test_gh_version_error` — gh version nonzero → FetchError 'gh CLI returned an error' — gated-network
- `TestCheckGhAvailable::test_gh_not_authenticated` — auth status nonzero → FetchError 'not authenticated' — gated-network
- `TestCheckGhAvailable::test_success` — version+auth succeed → no raise — gated-network
- `TestFetchReleaseList::test_success` — releases sorted by publishedAt ascending — gated-network
- `TestFetchReleaseList::test_error_raises` — gh nonzero → FetchError 'Failed to list releases' — gated-network
- `TestFetchReleaseList::test_empty_list` — '[]' → [] — gated-network
- `TestFetchReleaseBundle::test_success` — download + report*.zip on disk → returns path — gated-network
- `TestFetchReleaseBundle::test_no_assets_match` — stderr 'no assets match' → None — gated-network
- `TestFetchReleaseBundle::test_no_zip_on_disk` — download ok but no zip → None — gated-network
- `TestFetchReleaseBundle::test_other_error_raises` — other stderr → FetchError 'Failed to download report' — gated-network
- `TestFetchWorkflowRuns::test_success_filters_non_success` — only conclusion=='success' (2 of 3) — gated-network
- `TestFetchWorkflowRuns::test_with_branch_filter` — cmd contains '--branch' and 'main' — gated-network
- `TestFetchWorkflowRuns::test_with_event_filter` — cmd contains '--event' and 'pull_request' — gated-network
- `TestFetchWorkflowRuns::test_error_raises` — gh nonzero → FetchError 'Failed to list workflow runs' — gated-network
- `TestFetchArtifactBundle::test_success` — download + *.zip in artifact dir → path — gated-network
- `TestFetchArtifactBundle::test_no_artifact` — stderr 'no artifact' → None — gated-network
- `TestFetchArtifactBundle::test_no_zip_in_download` — download ok but no zip → None — gated-network
- `TestFetchArtifactBundle::test_other_error_raises` — other stderr → FetchError 'Failed to download artifact' — gated-network
- `TestFetchPrereleaseBundles::test_no_runs_returns_empty` — no workflow runs → [] — gated-network
- `TestFetchPrereleaseBundles::test_fetch_error_returns_empty` — FetchError swallowed → [] (never raises) — gated-network
- `TestFetchPrereleaseBundles::test_main_artifact_found` — main run yields one artifact zip → len 1 — gated-network
- `TestFetchReleaseBundles::test_no_bundles_raises` — all releases lack bundle → FetchError 'No report bundles found' — gated-network
- `TestFetchReleaseBundles::test_specific_tags_filter` — tags filter narrows to matching release; len 1 — gated-network

### trend-render-md.test.ts ← test_render_md.py (8 pure)
- `TestRenderTrendMarkdown::test_output_is_string` — render_trend_markdown returns str — pure
- `TestRenderTrendMarkdown::test_contains_all_sections` — output contains all 8 section headings A-H — pure
- `TestRenderTrendMarkdown::test_contains_version_labels` — output contains both run labels — pure
- `TestRenderTrendMarkdown::test_empty_runs_no_crash` — empty runs → still returns a string — pure
- `TestRenderTrendMarkdown::test_single_run` — single run → label present — pure
- `TestInfraFailureBannerMd::test_no_banner_when_no_infra_failure` — no infra → no banner text — pure
- `TestInfraFailureBannerMd::test_banner_when_infra_failure` — infra → banner + label + reason value — pure
- `TestInfraFailureBannerMd::test_section_f_shows_infra_failure_column` — Section F shows 'Infra Failure' col + '**YES**' — pure

### trend-render-html.test.ts ← test_render_html.py (8 pure)
- `TestRenderTrendHtml::test_output_is_html` — output contains '<html' and '</html>' — pure
- `TestRenderTrendHtml::test_contains_section_anchors` — all 8 section-id anchors — pure
- `TestRenderTrendHtml::test_contains_version_labels` — both run labels — pure
- `TestRenderTrendHtml::test_empty_runs_no_crash` — empty runs → still emits '<html' — pure
- `TestRenderTrendHtml::test_self_contained` — embedded '<style>' (no external refs) — pure
- `TestInfraFailureBannerHtml::test_no_banner_when_no_infra_failure` — no infra → no infra-banner div — pure
- `TestInfraFailureBannerHtml::test_banner_when_infra_failure` — infra → infra-banner + label — pure
- `TestInfraFailureBannerHtml::test_section_f_shows_infra_badge` — Section F shows 'badge-infra' + 'INFRA FAIL' — pure

### trend-main.test.ts ← test_main.py (7 skip-driver — owned by whoever ports __main__)
- `TestResolveFormats::test_both` — _resolve_formats('both')=={md,html} — skip-driver
- `TestResolveFormats::test_all` — _resolve_formats('all')=={md,html,yaml} — skip-driver
- `TestResolveFormats::test_md` — _resolve_formats('md')=={md} — skip-driver
- `TestResolveFormats::test_html` — _resolve_formats('html')=={html} — skip-driver
- `TestResolveFormats::test_yaml` — _resolve_formats('yaml')=={yaml} — skip-driver
- `TestCmdTrendLocalBundle::test_missing_local_bundle_raises` — nonexistent local bundle → TrendReportError 'Local bundle not found' — skip-driver
- `TestCmdTrendLocalRunDir::test_missing_local_run_dir_raises` — nonexistent local run dir → TrendReportError 'Local run directory not found' — skip-driver

**Cluster count: 100 (69 pure · 24 gated-network · 7 skip-driver)**

---

## postrun.test.ts + shared-credential-scrubber.test.ts → from test_post_run.py + test_credential_scrubber.py (53 pure · 2 gated-binary)

### postrun.test.ts ← test_post_run.py (38 pure · 2 gated-binary)
- `TestDetectProject.test_pyproject_toml` — pyproject.toml → type=python, install 'uv', test 'pytest', root==tmp — pure
- `TestDetectProject.test_package_json` — package.json → type=node, install contains 'npm install' — pure
- `TestDetectProject.test_cargo_toml` — Cargo.toml → type=rust — pure
- `TestDetectProject.test_go_mod` — go.mod → type=go — pure
- `TestDetectProject.test_setup_py` — setup.py → type=python-legacy — pure
- `TestDetectProject.test_no_markers` — README.md only → None — pure
- `TestDetectProject.test_priority_pyproject_over_package_json` — both markers in root → python wins — pure
- `TestDetectProject.test_empty_directory` — empty dir → None — pure
- `TestDetectProject.test_subdirectory_detection` — marker in workspace/my-app/ → detected, root==subdir — pure
- `TestDetectProject.test_subdirectory_not_checked_when_root_has_marker` — root package.json beats subdir pyproject → node, root==tmp — pure
- `TestDetectProject.test_hidden_subdirectories_skipped` — marker in .cache/ → None (dot-dirs skipped) — pure
- `TestDetectProject.test_vendor_directories_skipped` — markers in .venv/node_modules/__pycache__ → None (_SKIP_DIRS) — pure
- `TestDetectProject.test_deeply_nested_project` — marker 2 levels deep → detected, root==nested — pure
- `TestDetectProject.test_max_depth_exceeded` — marker at a/b/c/d (depth 4) → None — pure
- `TestDetectProject.test_nonexistent_workspace` — missing dir → None — pure
- `TestDetectProject.test_shallowest_project_preferred` — BFS finds shallow app/ before deep → root==shallow — pure
- `TestParsePytest.test_all_passed` — '5 passed in 1.23s' → passed=5, failed=None — pure
- `TestParsePytest.test_mixed_results` — '3 passed, 2 failed, 1 error' → passed=3 failed=2 errors=1 — pure
- `TestParsePytest.test_with_skipped` — '10 passed, 1 skipped, 1 warning' → passed=10 skipped=1 (warning ignored) — pure
- `TestParsePytest.test_no_summary` — no summary line → passed=None — pure
- `TestParsePytest.test_short_form` — bare '5 passed' → passed=5 via fallback regex — pure
- `TestParseJest.test_jest_summary` — 'Tests: 2 failed, 5 passed, 7 total' → passed=5 failed=2 — pure
- `TestParseJest.test_jest_all_passed` — '10 passed, 10 total' → passed=10 failed=None — pure
- `TestParseJest.test_vitest_format` — 'Tests 5 passed | 2 failed (7)' → passed=5 failed=2 (fallback) — pure
- `TestParseJest.test_no_summary` — 'running tests...' → passed=None — pure
- `TestParseCargo.test_ok_result` — 'ok. 10 passed; 0 failed; 2 ignored' → passed=10 failed=0 skipped=2 — pure
- `TestParseCargo.test_failed_result` — 'FAILED. 8 passed; 2 failed; 0 ignored' → passed=8 failed=2 — pure
- `TestParseCargo.test_no_summary` — 'compiling...' → passed=None — pure
- `TestParseGo.test_mixed_results` — 2 PASS + 1 FAIL → passed=2 failed=1 — pure
- `TestParseGo.test_all_pass` — 2 PASS lines → passed=2 failed=0 — pure
- `TestParseGo.test_no_results` — 'building...' → passed=None — pure
- `TestParseTestOutput.test_total_computed` — parse_test_output('python','3 passed, 1 failed') → total==4 — pure
- `TestParseTestOutput.test_unknown_project_type` ⚠FAILS — unknown type → passed=None AND total=None (spike's parserFor defaults to pytest) — pure
- `TestTruncate.test_short_text_unchanged` — _truncate('hello',100)=='hello' — pure
- `TestTruncate.test_long_text_truncated` ⚠FAILS — 20k chars → <11000 AND contains 'truncated' (spike drops the suffix) — pure
- `TestTruncate.test_exact_limit` — exactly 10000 chars unchanged (<=limit) — pure
- `TestRunPostEvaluation.test_no_workspace` — no workspace/ dir → writes test-results.yaml status=='skipped' — pure
- `TestRunPostEvaluation.test_empty_workspace` — empty workspace → status=='skipped', reason 'no recognised' — pure
- `TestRunPostEvaluation.test_python_project_detected` — pyproject → result_path==<run>/test-results.yaml, YAML project_type=python + install/test command (real uv pip install) — gated-binary
- `TestRunPostEvaluation.test_result_yaml_schema` — YAML has status/project_type/project_root/install/test; install command + (exit_code or timed_out) + output; test command + parsed_results (real install/test) — gated-binary

### shared-credential-scrubber.test.ts ← test_credential_scrubber.py (15 pure)
- `TestScrubCredentials.test_aws_access_key` — AKIA… removed, [REDACTED-AWS-ACCESS-KEY] present — pure
- `TestScrubCredentials.test_aws_secret_key` — 40-char base64 secret removed, [REDACTED-AWS-SECRET] present — pure
- `TestScrubCredentials.test_jwt_token` — eyJ…eyJ… JWT removed, [REDACTED-JWT-TOKEN] present — pure
- `TestScrubCredentials.test_github_token` — ghp_… removed, [REDACTED-GITHUB-TOKEN] present — pure
- `TestScrubCredentials.test_password_in_connection_string` — user:mypassword123@ redacted via conn-string rule, [REDACTED-PASSWORD] present — pure
- `TestScrubCredentials.test_private_key` — PEM RSA block removed, [REDACTED-PRIVATE-KEY] present (multiline [\s\S]+?) — pure
- `TestScrubCredentials.test_api_key_hex` — 32-char hex removed, [REDACTED-API-KEY] present — pure
- `TestScrubCredentials.test_multiple_credentials` — AWS key + secret + ghp token all redacted in one text (order-dependent) — pure
- `TestScrubCredentials.test_preserves_safe_text` — non-sensitive text unchanged (no false positives) — pure
- `TestScrubCredentials.test_empty_string` — scrub_credentials('')=='' — pure
- `TestScrubCredentials.test_custom_redaction_marker` — redact_marker='***' overrides all replacements — pure
- `TestScrubDictValues.test_scrub_all_strings` — all str values scrubbed, int passthrough — pure
- `TestScrubDictValues.test_scrub_specific_keys` — keys_to_scrub={'token'} → only token scrubbed — pure
- `TestScrubDictValues.test_recursive_scrubbing` — nested outer.inner.secret scrubbed recursively — pure
- `TestScrubDictValues.test_list_values` — [str, safe-str, {nested}] → str & nested-dict scrubbed, safe str unchanged — pure

**Cluster count: 55 (53 pure · 2 gated-binary; 2 ⚠FAILS = test_unknown_project_type, test_long_text_truncated)**

---

## Grand total

| Target area | pure | gated-binary | gated-network | skip-driver | total |
| --- | --- | --- | --- | --- | --- |
| qualitative.test.ts | 47 | — | — | — | 47 |
| quantitative.test.ts | 12 | 10 | — | — | 22 |
| contract.test.ts | 17 | — | — | — | 17 |
| reporting (collector/baseline/render-md/render-html) | 31 | — | — | 2 | 33 |
| trend-core (gate/models/sparkline/render-yaml) | 74 | — | — | — | 74 |
| trend-io (collector/fetcher/render-md/render-html/main) | 69 | — | 24 | 7 | 100 |
| postrun + credential-scrubber | 53 | 2 | — | — | 55 |
| **TOTAL** | **303** | **12** | **24** | **9** | **348** |

**Flagged tests.**
- ⚠FAILS against the spike (pin drifts to fix): `test_yaml_output`,
  `test_to_dict_structure` (qualitative), `test_unknown_project_type`,
  `test_long_text_truncated` (postrun). **4 total.**
- ⏭FIXTURE conditionally-skipped (self-skip when on-disk fixture absent):
  `test_self_comparison_golden`, `test_cross_run_comparison` (qualitative),
  `test_load_real_openapi_spec` (contract), `test_collect_real_run`,
  `test_load_real_golden` (reporting — the 2 reporting skip-driver rows). The
  trend `test_main` 7 skip-driver tests are NOT fixture-gated; they are
  CLI-driver-owned.
