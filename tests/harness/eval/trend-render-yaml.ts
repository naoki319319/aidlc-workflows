// trend-render-yaml.ts — YAML data export for trend data (machine-readable
// output for CI gates).
//
// Faithful 1:1 port of trend_reports/render_yaml.py (read in full):
//   - render_trend_yaml(trend) (render_yaml.py:13-16)
//   - _serialize(obj)          (render_yaml.py:19-31)
//
// DISPATCH ORDER (render_yaml.py:21-31) is load-bearing and ported verbatim:
//   1. SemVer   → str(obj)  ('v0.1.0')
//   2. Enum     → obj.value
//   3. dataclass→ {field.name: _serialize(value)} in DECLARATION order
//   4. list     → [_serialize(item)]
//   5. dict     → {k: _serialize(v)}
//   6. else     → obj (passthrough)
//
// TRAP (render_yaml.py:21-26): SemVer is ITSELF a frozen dataclass, so the
// SemVer branch MUST precede the generic dataclass branch — otherwise it would
// serialize as {major, minor, patch} instead of the 'v'-string. We mirror that
// by checking `instanceof SemVer` first.
//
// PORT MAPPING of the Python type-dispatch onto the TS data model
// (src/trend-models.ts):
//   - SemVer is a real class instance here → `instanceof SemVer` (branch 1).
//   - Python Enum members carry a `.value`; in TS these enums (RunType,
//     InfraFailureReason) are *string-valued* enums, so a stored field already
//     holds the `.value` string (e.g. RunType.RELEASE === "release"). There is
//     no distinct Enum object to unwrap — branch 2 is therefore a no-op for the
//     TS representation and folds into the primitive-passthrough (branch 6),
//     yielding the identical emitted string.
//   - Python dataclasses become plain TS interface objects built by the
//     trend-models factories, which insert fields in DECLARATION order; so a
//     plain (non-array, non-SemVer) object IS the dataclass case (branch 3) and
//     Object.keys() preserves declaration/insertion order = YAML key order.
//   - list → array (branch 4); dict → also a plain object in TS (branch 5,
//     same handling as branch 3 — both emit {k: _serialize(v)}).
//   - null (Python None, e.g. semver=None / pr_number=None) passes through.
//
// Emission goes through dumpYaml (src/yaml.ts), which ports PyYAML's
// yaml.dump(default_flow_style=False, sort_keys=False, allow_unicode=True)
// block layout with insertion-order keys.

import { SemVer } from "./trend-models.ts";
import type { TrendData } from "./trend-models.ts";
import { dumpYaml } from "./yaml.ts";

/** Serialize TrendData to a YAML string. (render_yaml.py:13-16) */
export function renderTrendYaml(trend: TrendData): string {
  const data = serialize(trend);
  // PyYAML: default_flow_style=False, sort_keys=False, allow_unicode=True.
  return dumpYaml(data);
}

/**
 * Recursively convert SemVer, enums, dataclasses, lists, and dicts to plain
 * values for YAML emission. (render_yaml.py:19-31)
 *
 * Dispatch order matches the Python source exactly (see file header TRAP).
 */
export function serialize(obj: unknown): unknown {
  // 1. SemVer FIRST — it is a frozen dataclass too, so it must short-circuit
  //    before the generic-object branch (render_yaml.py:21-22).
  if (obj instanceof SemVer) {
    return obj.toString(); // str(obj) → 'vMAJOR.MINOR.PATCH'
  }
  // 2. Enum → obj.value (render_yaml.py:23-24). In TS these are string-valued
  //    enums, so the stored field already IS the .value string and is handled
  //    by the primitive passthrough below — no separate unwrap needed.

  // 4. list → [_serialize(item)] (render_yaml.py:27-28).
  if (Array.isArray(obj)) {
    return obj.map((item) => serialize(item));
  }
  // 3. dataclass / 5. dict — both are plain objects in TS and both emit
  //    {key: _serialize(value)} preserving key (declaration/insertion) order
  //    (render_yaml.py:25-30). null is NOT an object here (guarded).
  if (typeof obj === "object" && obj !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      out[k] = serialize((obj as Record<string, unknown>)[k]);
    }
    return out;
  }
  // 6. else → passthrough (primitives, null/undefined). (render_yaml.py:31)
  return obj;
}
