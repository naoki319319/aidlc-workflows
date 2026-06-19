// shared-credential-scrubber.ts — faithful TS port of the Python evaluator's
// credential-scrubbing utilities. Pure-regex redaction of sensitive credentials
// from text (load-bearing once the sandbox captures command stdout/stderr).
//
// Source of truth (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/src/shared/credential_scrubber.py
//
// Faithful to credential_scrubber.py:14-158.
//
// Regex-translation notes (Python re → JS RegExp):
//  - `\b` word boundaries port verbatim.
//  - `re.IGNORECASE` → the JS `i` flag, applied PER-PATTERN exactly as Python
//    sets it (NOT blanket-applied) — credential_scrubber.py:48,56,63.
//  - Python `pattern.sub(repl, text)` replaces ALL matches; JS `.replace()` only
//    does so with the `g` flag, so every pattern carries `g`.
//  - Backref replacements `\1`/`\2` (credential_scrubber.py:64,70) → JS `$1`/`$2`.
//  - The multiline PEM rule uses `[\s\S]+?` (dotall-equivalent) — identical in JS
//    (credential_scrubber.py:55).
//
// Type kept LOCAL to this module per the port rules (do not edit shared types.ts).

// Each entry: (pattern, replacementTemplate, description).
// Ports the `_CREDENTIAL_PATTERNS` list — credential_scrubber.py:14-79.
// ORDER IS LOAD-BEARING: the AWS-secret 40-char base64 rule (#2) runs BEFORE the
// generic 32+-hex/api-key rule (#6), so a 40-char secret redacts as AWS-SECRET,
// not API-KEY.
type CredentialPattern = readonly [RegExp, string, string];

const _CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // AWS Access Key ID (AKIA... format) — credential_scrubber.py:16-20
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED-AWS-ACCESS-KEY]", "AWS Access Key"],
  // AWS Secret Access Key (40 base64 characters) — credential_scrubber.py:22-26
  [/\b([A-Za-z0-9/+=]{40})\b/g, "[REDACTED-AWS-SECRET]", "AWS Secret Key"],
  // JWT tokens (three base64 segments separated by dots) — credential_scrubber.py:28-32
  [
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED-JWT-TOKEN]",
    "JWT Token",
  ],
  // GitHub Personal Access Token (ghp_...) — variable length — credential_scrubber.py:34-38
  [/\bghp_[a-zA-Z0-9]{30,60}\b/g, "[REDACTED-GITHUB-TOKEN]", "GitHub Token"],
  // GitHub OAuth Token (gho_...) — variable length — credential_scrubber.py:40-44
  [/\bgho_[a-zA-Z0-9]{30,60}\b/g, "[REDACTED-GITHUB-OAUTH]", "GitHub OAuth Token"],
  // Generic API keys (32-64 hex chars) — credential_scrubber.py:47-51 (re.IGNORECASE)
  [/\b[a-f0-9]{32,64}\b/gi, "[REDACTED-API-KEY]", "API Key"],
  // Private SSH keys (multiline PEM block) — credential_scrubber.py:53-60 (re.IGNORECASE)
  [
    /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----[\s\S]+?-----END\s+(?:RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----/gi,
    "[REDACTED-PRIVATE-KEY]",
    "Private Key",
  ],
  // Password-like patterns in connection strings or CLI args — credential_scrubber.py:62-66
  // (Python: r"(?i)(password|passwd|pwd)=[\'\"]?([^\s\'\";]+)" with re.IGNORECASE)
  [
    /(password|passwd|pwd)=['"]?([^\s'";]+)/gi,
    "$1=[REDACTED-PASSWORD]",
    "Password",
  ],
  // Connection string passwords (user:password@host format) — credential_scrubber.py:68-72
  [/:\/\/([^:@]+):([^@]+)@/g, "://$1:[REDACTED-PASSWORD]@", "Connection String Password"],
  // AWS Session Token (FwoGZXIv prefix) — credential_scrubber.py:74-78
  [
    /\bFwoGZXIv[A-Za-z0-9/+=]{100,}\b/g,
    "[REDACTED-AWS-SESSION-TOKEN]",
    "AWS Session Token",
  ],
];

// Escape `$` in a literal replacement so JS `.replace()` treats it as a literal
// (Python's re.sub treats redact_marker as a plain string with no backref
// interpretation in this branch). The default replacement templates above already
// use JS `$1`/`$2` deliberately and are NOT routed through this escaper.
function escapeReplacement(literal: string): string {
  return literal.replace(/\$/g, "$$$$");
}

/**
 * Remove sensitive credentials from text using pattern matching.
 *
 * Detects common credential formats (AWS keys, JWTs, API keys, private keys,
 * passwords) and replaces them with redaction markers.
 *
 * @param text The text to scrub for credentials.
 * @param redactMarker Optional custom redaction marker. If absent, uses
 *   pattern-specific markers like "[REDACTED-AWS-ACCESS-KEY]". When provided, ALL
 *   replacements collapse to the literal marker — including the backref-prefixed
 *   ones, which LOSE their "\1=" / "://\1:" prefix.
 *
 * Ports scrub_credentials — credential_scrubber.py:82-111.
 */
export function scrubCredentials(text: string, redactMarker?: string | null): string {
  // Python: `if not text: return text` — empty string (and falsy) short-circuits.
  if (!text) return text;

  let scrubbed = text;
  for (const [pattern, defaultReplacement] of _CREDENTIAL_PATTERNS) {
    // credential_scrubber.py:108 — `replacement = redact_marker if redact_marker
    // else default_replacement`. A custom marker is a LITERAL (escape `$`); the
    // default templates carry intentional `$1`/`$2` backrefs.
    const replacement = redactMarker
      ? escapeReplacement(redactMarker)
      : defaultReplacement;
    scrubbed = scrubbed.replace(pattern, replacement);
  }

  return scrubbed;
}

// Python truthiness for dict-value scrubbing: only `str` and `dict` and `list`
// instances are specially handled; every other scalar passes through unchanged.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Scrub credential values from a dictionary.
 *
 * Recursively processes object values, scrubbing credentials from strings.
 * Optionally targets specific keys (case-insensitive matching).
 *
 * @param data Object to scrub.
 * @param keysToScrub Optional set of key names to specifically target (e.g.
 *   {"password","token","secret"}). If absent, scrubs all string values.
 * @param redactMarker Optional marker forwarded to scrubCredentials.
 *
 * Ports scrub_dict_values — credential_scrubber.py:114-158.
 *
 * NOTE on list handling (credential_scrubber.py:146-154): list items that are
 * dicts are recursed, items that are strings are scrubbed, everything else
 * (including NESTED lists) passes through untouched.
 */
export function scrubDictValues(
  data: Record<string, unknown>,
  keysToScrub?: Set<string> | null,
  redactMarker?: string | null,
): Record<string, unknown> {
  // credential_scrubber.py:133-134 — lowercase the target key set once.
  let lowered: Set<string> | null = null;
  if (keysToScrub && keysToScrub.size > 0) {
    lowered = new Set<string>();
    for (const k of keysToScrub) lowered.add(k.toLowerCase());
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      // credential_scrubber.py:138-143 — if keys_to_scrub specified, only scrub
      // targeted keys (case-insensitive); otherwise scrub every string.
      if (lowered === null || lowered.has(key.toLowerCase())) {
        result[key] = scrubCredentials(value, redactMarker);
      } else {
        result[key] = value;
      }
    } else if (isPlainObject(value)) {
      // credential_scrubber.py:144-145 — recurse into nested dicts.
      result[key] = scrubDictValues(value, keysToScrub, redactMarker);
    } else if (Array.isArray(value)) {
      // credential_scrubber.py:146-154 — list comprehension: dict→recurse,
      // str→scrub, else→passthrough (nested lists are NOT recursed).
      result[key] = value.map((item) => {
        if (isPlainObject(item)) {
          return scrubDictValues(item, keysToScrub, redactMarker);
        }
        if (typeof item === "string") {
          return scrubCredentials(item, redactMarker);
        }
        return item;
      });
    } else {
      // credential_scrubber.py:155-156 — non-str scalars pass through.
      result[key] = value;
    }
  }

  return result;
}
