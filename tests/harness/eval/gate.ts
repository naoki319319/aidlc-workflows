// gate.ts — cross-run regression gate (trend_reports/gate.py).
//
// Pure decision logic, ported 1:1: contract pass-rate drop, new unit failures,
// qualitative drop > 0.02 — with the infra-failure skip path (a flaky/throttled
// latest run passes the gate with an annotation rather than false-alarming).
// No Bedrock, no network — input is committed report-bundle data.
//
// Types (RunType/RunData/TrendData/GateResult) come from trend-models.ts (the
// faithful models.py port); construction goes through makeGateResult so the
// dataclass defaults (regressions=[] fresh, labels="", infra flags off) match.
// Formatters use pyutil so the rendered strings are byte-identical to Python's
// f-strings: gate.py:64 "{:.1%}" → pyPercent; gate.py:76-77 "{:.3f}"/"{:+.3f}"
// → pyFixed/pySignedFixed (CPython round-half-to-even).

import { pyFixed, pyPercent, pySignedFixed } from "./pyutil.ts";
import {
  type GateResult,
  type RunData,
  RunType,
  type TrendData,
  makeGateResult,
} from "./trend-models.ts";

// gate.py:8-85 — check_regressions
export function checkRegressions(trend: TrendData): GateResult {
  let [latest, previous] = findLatestAndPrevious(trend);

  // gate.py:20-26
  if (latest === null || previous === null) {
    return makeGateResult(true, {
      regressions: [],
      latest_label: latest ? latest.label : "",
      comparison_label: previous ? previous.label : "",
    });
  }

  // gate.py:28-41 — If the latest run is an infra failure, skip regression checks
  if (latest.infra_failure.is_infra_failure) {
    return makeGateResult(true, {
      regressions: [],
      latest_label: latest.label,
      comparison_label: previous.label,
      infra_failure_detected: true,
      infra_failure_summary:
        `Latest run (${latest.label}) was an infrastructure failure: ` +
        `${latest.infra_failure.summary}. ` +
        "Regression check skipped — results are unreliable.",
    });
  }

  // gate.py:43-56 — If the comparison run is an infra failure, find an alternative
  if (previous.infra_failure.is_infra_failure) {
    const alt = findNonInfraPrevious(trend, latest);
    if (alt === null) {
      return makeGateResult(true, {
        regressions: [],
        latest_label: latest.label,
        comparison_label: "",
        infra_failure_detected: true,
        infra_failure_summary:
          "No non-infra-failure comparison run available. Regression check skipped.",
      });
    }
    previous = alt;
  }

  const regressions: string[] = []; // gate.py:58

  // gate.py:60-65 — Contract test regression
  if (latest.contract_tests.pass_rate < previous.contract_tests.pass_rate) {
    regressions.push(
      "Contract test pass rate decreased: " +
        `${pyPercent(previous.contract_tests.pass_rate, 1)} → ${pyPercent(latest.contract_tests.pass_rate, 1)}`,
    );
  }

  // gate.py:67-69 — Unit test failures appeared
  if (latest.unit_tests.failed > 0 && previous.unit_tests.failed === 0) {
    regressions.push(`Unit test failures appeared: ${latest.unit_tests.failed} failures`);
  }

  // gate.py:71-78 — Qualitative score regression (tolerance: 0.02)
  const scoreDelta = latest.qualitative.overall_score - previous.qualitative.overall_score;
  if (scoreDelta < -0.02) {
    regressions.push(
      "Qualitative score regressed: " +
        `${pyFixed(previous.qualitative.overall_score, 3)} → ${pyFixed(latest.qualitative.overall_score, 3)} ` +
        `(delta: ${pySignedFixed(scoreDelta, 3)})`,
    );
  }

  // gate.py:80-85
  return makeGateResult(regressions.length === 0, {
    regressions,
    latest_label: latest.label,
    comparison_label: previous.label,
  });
}

// gate.py:88-106 — _find_non_infra_previous
function findNonInfraPrevious(trend: TrendData, latest: RunData): RunData | null {
  // gate.py:90 — candidates = [r for r in trend.runs if r is not latest]
  const candidates = trend.runs.filter((r) => r !== latest);

  // gate.py:92-99 — both branches scan candidates in reverse for the most recent
  // non-infra RELEASE run (the run_type check is the same in if/else).
  for (let i = candidates.length - 1; i >= 0; i--) {
    const run = candidates[i]!;
    if (run.run_type === RunType.RELEASE && !run.infra_failure.is_infra_failure) {
      return run;
    }
  }

  // gate.py:101-104 — Fallback: any non-infra run
  for (let i = candidates.length - 1; i >= 0; i--) {
    const run = candidates[i]!;
    if (!run.infra_failure.is_infra_failure) {
      return run;
    }
  }

  return null; // gate.py:106
}

// gate.py:109-133 — find_latest_and_previous
export function findLatestAndPrevious(trend: TrendData): [RunData | null, RunData | null] {
  // gate.py:117-118
  if (trend.runs.length < 2) {
    return [trend.runs.length > 0 ? trend.runs[0]! : null, null];
  }

  const latest = trend.runs[trend.runs.length - 1]!; // gate.py:120

  if (latest.run_type === RunType.RELEASE) {
    // gate.py:122-126 — Find the previous release (scan runs[:-1] in reverse)
    for (let i = trend.runs.length - 2; i >= 0; i--) {
      if (trend.runs[i]!.run_type === RunType.RELEASE) {
        return [latest, trend.runs[i]!];
      }
    }
  } else {
    // gate.py:127-131 — Latest is main/PR; compare to the most recent release
    for (let i = trend.runs.length - 1; i >= 0; i--) {
      if (trend.runs[i]!.run_type === RunType.RELEASE) {
        return [latest, trend.runs[i]!];
      }
    }
  }

  // gate.py:133
  return [latest, trend.runs[trend.runs.length - 2]!];
}
