// trend-sparkline.test.ts — 1:1 mirror of
// /Users/packeera/src/aidlc-workflows/.claude/worktrees/v2-inspect/evaluator/
//   packages/trend-reports/tests/test_sparkline.py (29 cases).
//
// INT/FLOAT INTENT: Python passes literal ints (42, 1500, 9_260_000, 0, 5, -3)
// and literal floats (0.891, 9.26e6, 0.5, 0.028). We preserve that exactly:
// int literals → plain JS numbers; float literals → pyFloat(...). See the
// module header for the dispatch rationale.

import { describe, expect, test } from "bun:test";
import { PyFloat } from "./yaml";
// A Python float literal (non-null) — the int/float intent seam. pyFloat() can
// return null for nullish input, so the tests use the bare constructor.
const pyFloat = (n: number): PyFloat => new PyFloat(n);
import {
  formatDelta,
  formatNumber,
  formatPct,
  formatSecondsAsMinutes,
  sparkline,
  trendArrow,
} from "./trend-sparkline";

// ── TestSparkline (test_sparkline.py:15-39) ─────────────────────────────────
describe("TestSparkline", () => {
  test("test_empty_list", () => {
    expect(sparkline([])).toBe("");
  });

  test("test_single_value", () => {
    const result = sparkline([5]);
    expect(result.length).toBe(1);
  });

  test("test_all_identical", () => {
    const result = sparkline([3, 3, 3, 3]);
    expect(Array.from(result).length).toBe(4);
    expect(new Set(Array.from(result)).size).toBe(1);
  });

  test("test_ascending", () => {
    const result = sparkline([1, 2, 3, 4, 5]);
    const chars = Array.from(result);
    expect(chars.length).toBe(5);
    expect(chars[0]! < chars[chars.length - 1]!).toBe(true);
  });

  test("test_two_values_min_max", () => {
    const result = sparkline([0, 100]);
    expect(Array.from(result).length).toBe(2);
  });

  test("test_negative_values", () => {
    const result = sparkline([-10, 0, 10]);
    expect(Array.from(result).length).toBe(3);
  });
});

// ── TestTrendArrow (test_sparkline.py:42-68) ────────────────────────────────
describe("TestTrendArrow", () => {
  test("test_empty_list", () => {
    expect(trendArrow([])).toBe("→");
  });

  test("test_single_value", () => {
    expect(trendArrow([5])).toBe("→");
  });

  test("test_strong_increase", () => {
    expect(trendArrow([100, 110])).toBe("↑");
  });

  test("test_strong_decrease", () => {
    expect(trendArrow([100, 90])).toBe("↓");
  });

  test("test_flat", () => {
    expect(trendArrow([100, 100.5])).toBe("→");
  });

  test("test_zero_first_positive_last", () => {
    expect(trendArrow([0, 10])).toBe("↑");
  });

  test("test_zero_both", () => {
    expect(trendArrow([0, 0])).toBe("→");
  });

  test("test_mild_increase", () => {
    expect(trendArrow([100, 103])).toBe("↗");
  });

  test("test_mild_decrease", () => {
    expect(trendArrow([100, 97])).toBe("↘");
  });
});

// ── TestFormatNumber (test_sparkline.py:71-91) ──────────────────────────────
describe("TestFormatNumber", () => {
  test("test_integer_small", () => {
    expect(formatNumber(42)).toBe("42");
  });

  test("test_integer_thousands", () => {
    const result = formatNumber(1500);
    expect(result).toContain("K");
  });

  test("test_integer_millions", () => {
    const result = formatNumber(9260000);
    expect(result).toContain("M");
  });

  test("test_float_small", () => {
    expect(formatNumber(pyFloat(0.891))).toBe("0.891");
  });

  test("test_float_millions", () => {
    const result = formatNumber(pyFloat(9.26e6));
    expect(result).toContain("M");
  });

  test("test_zero_int", () => {
    expect(formatNumber(0)).toBe("0");
  });
});

// ── TestFormatSecondsAsMinutes (test_sparkline.py:94-103) ────────────────────
describe("TestFormatSecondsAsMinutes", () => {
  test("test_zero", () => {
    expect(formatSecondsAsMinutes(0)).toBe("0.0m");
  });

  test("test_one_minute", () => {
    expect(formatSecondsAsMinutes(60)).toBe("1.0m");
  });

  test("test_fractional", () => {
    expect(formatSecondsAsMinutes(90)).toBe("1.5m");
  });
});

// ── TestFormatDelta (test_sparkline.py:106-120) ─────────────────────────────
describe("TestFormatDelta", () => {
  test("test_positive_int", () => {
    expect(formatDelta(5)).toBe("+5");
  });

  test("test_negative_int", () => {
    expect(formatDelta(-3)).toBe("-3");
  });

  test("test_zero_int", () => {
    expect(formatDelta(0)).toBe("+0");
  });

  test("test_positive_float", () => {
    expect(formatDelta(pyFloat(0.5))).toBe("+0.5");
  });

  test("test_custom_precision", () => {
    expect(formatDelta(pyFloat(0.028), 3)).toBe("+0.028");
  });
});

// ── TestFormatPct (test_sparkline.py:123-135) ───────────────────────────────
describe("TestFormatPct", () => {
  test("test_zero", () => {
    expect(formatPct(0.0)).toBe("0.0%");
  });

  test("test_full", () => {
    expect(formatPct(1.0)).toBe("100.0%");
  });

  test("test_partial", () => {
    expect(formatPct(0.5)).toBe("50.0%");
  });

  test("test_over_one", () => {
    const result = formatPct(1.5);
    expect(result).toContain("150");
  });
});
