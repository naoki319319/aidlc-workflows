// trend-sparkline.ts — ASCII sparkline + human-readable number formatters.
//
// Faithful port of
// /Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/
//   packages/trend-reports/src/trend_reports/sparkline.py (sparkline.py:1-104).
//
// INT-vs-FLOAT DISPATCH (sparkline.py:61,68,92) — THE central porting hazard.
// format_number / format_delta branch on Python's RUNTIME numeric type:
//   - format_number: `isinstance(n, float) and n != int(n)` (:61) and the int
//     fall-through `isinstance(n, int)` (:68).
//   - format_delta:  `isinstance(delta, int)` → "{:+d}" else "{:+.Nf}" (:92).
// JS Number erases int-vs-float (5 === 5.0, and Number.isInteger(5.0) is true),
// so we thread an EXPLICIT intent instead of inferring from the value:
//   - a PLAIN JS number  ⇒ a Python int.
//   - a PyFloat wrapper (from yaml.ts) ⇒ a Python float.
// This lets every test_sparkline case pass the SAME literal the Python test
// passes: int literals (42, 1500, 9_260_000, 0, 5, -3) stay plain numbers;
// float literals (0.891, 9.26e6, 0.5, 0.028) are wrapped with pyFloat(...).
// (Inferring from the value would misroute a "float" 5.0 — Number.isInteger(5.0)
// is true — exactly the trap the PORT-PLAN flags at :279-281.)
//
// All Python f-string fixed-point formatting goes through pyFixed/pySignedFixed
// (CPython round-half-to-even), never JS toFixed (round-half-away).

import { pyFixed, pySignedFixed } from "./pyutil";
import { PyFloat } from "./yaml";

// A value carrying explicit Python int/float intent: a plain number is a Python
// int; a PyFloat wrapper is a Python float. (sparkline.py annotates these as
// `float | int`.)
export type PyNum = number | PyFloat;

// Unwrap a PyNum to its raw JS number (for arithmetic) and its Python type.
function unwrap(n: PyNum): { value: number; isFloat: boolean } {
  if (n instanceof PyFloat) return { value: n.value, isFloat: true };
  return { value: n, isFloat: false };
}

// sparkline.py:5 — the 8-char ramp ▁▂▃▄▅▆▇█ (one codepoint each).
// Use Array.from so indexing is by codepoint, matching Python str indexing.
export const SPARK_CHARS = Array.from("▁▂▃▄▅▆▇█");

// sparkline.py:8-25 — ASCII sparkline from numeric values.
//   >>> sparkline([1, 5, 3, 7, 2]) == '▁▆▃█▂'
export function sparkline(values: number[]): string {
  if (values.length === 0) return ""; // :14-15
  const lo = Math.min(...values); // :16
  const hi = Math.max(...values); // :17
  if (hi === lo) {
    // :18-20 — all equal → middle char (len // 2 == 4 → '▅') repeated.
    const mid = Math.floor(SPARK_CHARS.length / 2);
    return SPARK_CHARS[mid]!.repeat(values.length);
  }
  const span = hi - lo; // :21
  const last = SPARK_CHARS.length - 1; // 7
  // :22-24 — bucket = SPARK_CHARS[min(int((v-lo)/span*7), 7)].
  // Python int() truncates toward zero; (v-lo)/span*7 is always >= 0 here so
  // Math.trunc == Math.floor, but use Math.trunc to mirror int() exactly.
  return values
    .map((v) => SPARK_CHARS[Math.min(Math.trunc(((v - lo) / span) * last), last)]!)
    .join("");
}

// sparkline.py:28-48 — directional indicator from first-to-last change.
// Returns ↑ (up >5%), ↗ (up 1-5%), → (flat <1%), ↘ (down 1-5%), ↓ (down >5%).
export function trendArrow(values: number[]): string {
  if (values.length < 2) return "→"; // :34-35
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (first === 0) return last > 0 ? "↑" : "→"; // :37-38
  const pct = (last - first) / Math.abs(first); // :39
  // :40-48 — cascading EXCLUSIVE thresholds; the boundary 0.05 falls through
  // `> 0.05` to `> 0.01` and yields ↗ (not ↑).
  if (pct > 0.05) return "↑";
  if (pct > 0.01) return "↗";
  if (pct < -0.05) return "↓";
  if (pct < -0.01) return "↘";
  return "→";
}

// sparkline.py:51-70 — human-readable number formatting.
//   >>> format_number(9_260_000) == '9.26M'
//   >>> format_number(1446.0)    == '1446.0'   (float, integral, abs>=1000)
//   >>> format_number(0.891)     == '0.891'    (float, non-integral, abs<1000)
// Pass a plain number for a Python int; pyFloat(x) for a Python float.
export function formatNumber(n: PyNum): string {
  const { value, isFloat } = unwrap(n);
  // :61 — float, non-integral, abs<1000 → 3dp.
  if (isFloat && value !== Math.trunc(value) && Math.abs(value) < 1000) {
    return pyFixed(value, 3);
  }
  const absN = Math.abs(value); // :63
  if (absN >= 1_000_000) return `${pyFixed(value / 1_000_000, 2)}M`; // :64-65
  if (absN >= 1_000) return `${pyFixed(value / 1_000, 1)}K`; // :66-67
  if (!isFloat) return String(value); // :68-69 — int branch → str(n)
  return pyFixed(value, 1); // :70 — float fall-through → 1dp
}

// sparkline.py:73-79 — seconds → minutes string.
//   >>> format_seconds_as_minutes(1074.0) == '17.9m'
export function formatSecondsAsMinutes(seconds: number): string {
  return `${pyFixed(seconds / 60, 1)}m`;
}

// sparkline.py:82-94 — delta with sign prefix.
//   >>> format_delta(56)              == '+56'
//   >>> format_delta(-3)              == '-3'
//   >>> format_delta(0.028, prec=3)   == '+0.028'
// Pass a plain number for a Python int (→ "{:+d}"); pyFloat(x) for a Python
// float (→ "{:+.Nf}"). precision defaults to 1, matching the Python signature.
export function formatDelta(delta: PyNum, precision = 1): string {
  const { value, isFloat } = unwrap(delta);
  if (!isFloat) {
    // :92-93 — "{:+d}": always-signed integer ('+0' for 0).
    return value >= 0 ? `+${value}` : String(value);
  }
  return pySignedFixed(value, precision); // :94 — "{:+.Nf}"
}

// sparkline.py:97-103 — 0-1 ratio → percentage string.
//   >>> format_pct(0.965) == '96.5%'
export function formatPct(value: number): string {
  return `${pyFixed(value * 100, 1)}%`;
}
