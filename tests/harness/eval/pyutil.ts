// pyutil.ts — Python-semantics numeric helpers shared across the port.
//
// The Python evaluator rounds and formats with CPython's round-half-to-even
// ("banker's rounding"), operating on the TRUE decimal value of the IEEE-754
// double (CPython uses David Gay's dtoa). A naive `Math.round(x*1e4)/1e4` is
// round-half-AWAY and also corrupts the value via the `x*1e4` float multiply, so
// it diverges from Python at .5 ties (e.g. round(0.12345,4) is 0.1235 in Python
// because the stored double is fractionally ABOVE 0.12345, but float-scaling
// collapses it to an exact 1234.5 tie and yields 0.1234).
//
// pyRound() reproduces CPython round(x, ndigits) EXACTLY by decomposing the
// double into sign * mantissa * 2^exp (all exact) and rounding the exact rational
// (mantissa * 10^ndigits) / 2^-exp with BigInt arithmetic. Verified byte-for-byte
// against a 517-case CPython battery (see pyutil.test.ts).
//
// Ports the implicit round() at: qualitative/models.py:74,78-88 (to_dict),
// reporting/baseline.py (pct formatting), trend_reports/gate.py:64,77,
// trend_reports/sparkline.py format_number/format_delta, render_md/render_html.

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer); // little-endian view: [0]=low, [1]=high

// Decompose a finite double into exact (sign, mantissa, exp) such that
// value === sign * Number(mantissa) * 2**exp, with mantissa a BigInt.
function decompose(x: number): { sign: bigint; mantissa: bigint; exp: number } {
  _f64[0] = x;
  const lo = _u32[0]!;
  const hi = _u32[1]!;
  const sign = hi & 0x80000000 ? -1n : 1n;
  let exp = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0);
  if (exp === 0) {
    // subnormal: value = mantissa * 2^-1074
    exp = -1074;
  } else {
    // normal: implicit leading 1 bit; value = (2^52 + frac) * 2^(exp-1075)
    mantissa |= 1n << 52n;
    exp = exp - 1075;
  }
  return { sign, mantissa, exp };
}

// CPython round(x, ndigits) — round-half-to-even on the exact value of x.
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (ndigits < 0) {
    // Not needed by the port (always ndigits >= 0); fall back to scaled even
    // rounding for completeness.
    const p = Math.pow(10, -ndigits);
    return pyRound(x / p, 0) * p;
  }
  const { sign, mantissa, exp } = decompose(x);
  const P = 10n ** BigInt(ndigits);

  let roundedAbs: bigint;
  if (exp >= 0) {
    // x * 10^n is an exact integer: mantissa * 2^exp * P
    roundedAbs = mantissa * (1n << BigInt(exp)) * P;
  } else {
    // x * 10^n = (mantissa * P) / 2^(-exp); round the rational half-to-even.
    const N = mantissa * P;
    const D = 1n << BigInt(-exp);
    const q = N / D;
    const r = N % D;
    const twiceR = r * 2n;
    if (twiceR < D) {
      roundedAbs = q;
    } else if (twiceR > D) {
      roundedAbs = q + 1n;
    } else {
      // exact tie → round to even
      roundedAbs = q % 2n === 0n ? q : q + 1n;
    }
  }

  if (roundedAbs === 0n) return sign < 0n ? -0 : 0;
  // result = sign * roundedAbs / 10^ndigits, as the nearest double (matches
  // CPython, which returns the nearest double to the rounded decimal).
  const result = Number(roundedAbs) / Number(P);
  return sign < 0n ? -result : result;
}

// Python f"{x:.Nf}" — fixed-point with N decimals, round-half-to-even, sign on
// negatives only. Reproduces e.g. trend gate's "{:.3f}".
export function pyFixed(x: number, ndigits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const r = pyRound(x, ndigits);
  // r is already rounded to ndigits places, so toFixed performs no further
  // rounding — it only pads. Use Math.abs to control the sign explicitly so
  // -0.0 renders as "-0.000" like Python.
  const neg = r < 0 || Object.is(r, -0);
  const body = Math.abs(r).toFixed(ndigits);
  return neg ? `-${body}` : body;
}

// Python f"{x:+.Nf}" — always-signed fixed-point (e.g. gate.py:77 "{:+.3f}").
export function pySignedFixed(x: number, ndigits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const r = pyRound(x, ndigits);
  const neg = r < 0 || Object.is(r, -0);
  const body = Math.abs(r).toFixed(ndigits);
  return neg ? `-${body}` : `+${body}`;
}

// Python f"{x:.Np%}" — percent with N decimals (value*100, round-half-to-even,
// trailing '%'). Reproduces gate.py:64 "{:.1%}".
export function pyPercent(x: number, ndigits = 1): string {
  return `${pyFixed(x * 100, ndigits)}%`;
}

// CPython str.splitlines() — split on the FULL set of Unicode line boundaries and
// drop the trailing empty element a terminating break would produce:
//   "a\n".splitlines()    == ["a"]       (1)
//   "a\nb".splitlines()   == ["a", "b"]  (2)
//   "".splitlines()        == []          (0)
//   "a\x0cb".splitlines() == ["a", "b"]  (form-feed is a boundary)
// CPython's boundary set: \n \r \r\n \v(\x0b) \f(\x0c) \x1c \x1d \x1e
// \x85(NEL) \u2028(LS) \u2029(PS). Ports human_analog.py:90 (extractFinalResponse
// block split) and normalizer.py:205 (total_lines_of_code) — both call
// .splitlines(), so a plain split("\n") under-splits on CR/CRLF/FF/NEL inputs.
// Every boundary written as an escape so none is ambiguous (a literal U+2028/9 in
// source is itself a JS line terminator and would break the file).
const _SPLITLINES_RE = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
export function pySplitlines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(_SPLITLINES_RE);
  // A trailing boundary yields a final "" — CPython keeps no trailing empty.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
