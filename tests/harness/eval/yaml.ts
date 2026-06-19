// yaml.ts — PyYAML-faithful block-style serializer + atomic dump.
//
// Ports shared/io.py:atomic_yaml_dump, which writes YAML with PyYAML's
// `default_flow_style=False, sort_keys=False` (block style, insertion order).
// Bun.YAML.stringify emits FLOW style ({a: 1, b: 2}) and re-sorts nothing but
// looks nothing like a real run-folder YAML, so the port needs its own emitter.
//
// FIDELITY: matches PyYAML's block layout (2-space indent, sequences at the
// parent key's indent, dash-shared first line) and its plain/single/double
// scalar-style decisions for the value space the evaluator actually serializes
// (numbers, model strings, slash paths, timestamps, status strings, free-text
// notes, bools, null, lists of dicts). Byte-exact reproduction of PyYAML's
// single-quote line-folding for embedded newlines is a documented residual
// (README) — such strings are emitted double-quoted-with-escapes here, which is
// valid YAML and round-trips identically; the DoD requires field-name +
// insertion-order + nesting parity + a golden.yaml round-trip, not a byte diff.
//
// Reading uses Bun.YAML.parse (a faithful YAML 1.x parser) — only WRITING needed
// a custom path.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── float typing ────────────────────────────────────────────────────────────
// Python distinguishes int(100) from float(100.0); PyYAML emits "100" vs "100.0"
// accordingly. JS Number(100) === Number(100.0), so a field the Python evaluator
// types as float (pass_pct, coverage_pct, qualitative scores, latency_ms, …)
// must be tagged so the serializer renders the trailing ".0" when integral. Wrap
// such values with pyFloat(); the value still behaves as a number elsewhere via
// .valueOf(). A plain JS number renders as a Python int when integral.
export class PyFloat {
  constructor(public readonly value: number) {}
  valueOf(): number {
    return this.value;
  }
}
export function pyFloat(n: number | null | undefined): PyFloat | null {
  return n == null ? null : new PyFloat(n);
}

// ── PyYAML implicit-type resolvers (YAML 1.1, allow_unicode=False) ──────────
// A plain (unquoted) string that matches one of these would parse back as a
// non-string, so it must be quoted. Mirrors yaml.resolver.Resolver patterns.
const RE_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const RE_NULL = /^(?:~|null|Null|NULL|)$/;
const RE_INT =
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const RE_FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
// Timestamp resolver (date / datetime) — quote if it looks like one.
const RE_TIMESTAMP =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9])/;
const RE_VALUE_MERGE = /^(?:=|<<)$/;

function resolvesToNonString(s: string): boolean {
  return (
    RE_BOOL.test(s) ||
    RE_NULL.test(s) ||
    RE_INT.test(s) ||
    RE_FLOAT.test(s) ||
    RE_TIMESTAMP.test(s) ||
    RE_VALUE_MERGE.test(s)
  );
}

// Leading indicator chars that change meaning at the start of a plain scalar.
// NB: '-', '?', ':' are only indicators when followed by a space (handled
// separately), so they are NOT in this set — matching PyYAML (`-x` stays plain).
const LEADING_INDICATORS = new Set([
  ",", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`",
]);

function hasSpecialChar(s: string): boolean {
  // Chars that cannot appear in a plain or single-quoted scalar → force
  // double-quoted-with-escapes (control chars, and — with allow_unicode=False —
  // any non-ASCII codepoint, which PyYAML escapes).
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      // tab/newline included: PyYAML can fold these but we escape for round-trip
      // safety (documented residual).
      return true;
    }
    if (c > 0x7e) return true; // non-ASCII, allow_unicode=False → escaped
  }
  return false;
}

function isPlainSafe(s: string): boolean {
  if (s.length === 0) return false;
  if (resolvesToNonString(s)) return false;
  if (hasSpecialChar(s)) return false;
  if (s !== s.trim()) return false; // leading/trailing whitespace
  if (LEADING_INDICATORS.has(s[0]!)) return false;
  // '- ', '? ', ': ' leading indicator (dash/question/colon + space)
  if ((s[0] === "-" || s[0] === "?" || s[0] === ":") && s[1] === " ") return false;
  // flow/comment indicators anywhere
  if (s.includes(": ") || s.endsWith(":")) return false;
  if (s.includes(" #")) return false;
  return true;
}

function doubleQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).toUpperCase().padStart(2, "0")}`;
    else if (c > 0x7e && c <= 0xff) out += `\\x${c.toString(16).toUpperCase().padStart(2, "0")}`;
    else if (c > 0xff && c <= 0xffff) out += `\\u${c.toString(16).toUpperCase().padStart(4, "0")}`;
    else if (c > 0xffff) out += `\\U${c.toString(16).toUpperCase().padStart(8, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function renderScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof PyFloat) return renderFloat(v.value);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return renderNumber(v);
  if (typeof v === "bigint") return v.toString();
  const s = String(v);
  if (isPlainSafe(s)) return s;
  if (hasSpecialChar(s)) return doubleQuote(s);
  return `'${s.replace(/'/g, "''")}'`; // single-quoted, '' escape
}

function renderNumber(n: number): string {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".inf";
  if (n === -Infinity) return "-.inf";
  if (Object.is(n, -0)) return "-0.0";
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

// A value KNOWN to be a Python float — always carries a decimal point so an
// integral float (100.0) renders "100.0" not "100" (PyYAML behaviour).
function renderFloat(n: number): string {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".inf";
  if (n === -Infinity) return "-.inf";
  if (Object.is(n, -0)) return "-0.0";
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
}

// Render a container to block-style lines, each prefixed with `indent` spaces.
function renderBlock(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (Array.isArray(item) && item.length > 0) {
        const sub = renderBlock(item, indent + 2);
        lines.push(`${pad}- ${sub[0]!.slice(indent + 2)}`);
        for (let i = 1; i < sub.length; i++) lines.push(sub[i]!);
      } else if (isPlainObject(item) && Object.keys(item).length > 0) {
        const sub = renderBlock(item, indent + 2);
        lines.push(`${pad}- ${sub[0]!.slice(indent + 2)}`);
        for (let i = 1; i < sub.length; i++) lines.push(sub[i]!);
      } else {
        lines.push(`${pad}- ${renderScalar(item)}`);
      }
    }
    return lines;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const k of keys) {
      const val = (value as Record<string, unknown>)[k];
      const keyStr = renderScalar(k);
      if (Array.isArray(val)) {
        if (val.length === 0) lines.push(`${pad}${keyStr}: []`);
        else {
          lines.push(`${pad}${keyStr}:`);
          // Block sequences sit at the PARENT key's indent (PyYAML default).
          lines.push(...renderBlock(val, indent));
        }
      } else if (isPlainObject(val)) {
        if (Object.keys(val).length === 0) lines.push(`${pad}${keyStr}: {}`);
        else {
          lines.push(`${pad}${keyStr}:`);
          lines.push(...renderBlock(val, indent + 2));
        }
      } else {
        lines.push(`${pad}${keyStr}: ${renderScalar(val)}`);
      }
    }
    return lines;
  }
  // Top-level scalar document.
  return [`${pad}${renderScalar(value)}`];
}

// PyYAML yaml.dump(...) — block style, insertion order, trailing newline.
export function dumpYaml(data: unknown): string {
  if (Array.isArray(data) && data.length === 0) return "[]\n";
  if (isPlainObject(data) && Object.keys(data).length === 0) return "{}\n";
  return renderBlock(data, 0).join("\n") + "\n";
}

// shared/io.py:atomic_yaml_dump — temp file in target dir + rename into place.
export function atomicYamlDump(data: unknown, path: string): void {
  const tmp = join(dirname(path), `.${Math.abs(hashStr(path))}.tmp`);
  try {
    writeFileSync(tmp, dumpYaml(data), "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

// Deterministic temp-name suffix (no Date.now/random — keeps the port testable
// and resume-safe); collisions are harmless given the immediate rename.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
