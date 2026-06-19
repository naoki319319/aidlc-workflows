// human-analog.test.ts — PURE tests for human-analog.ts (human_analog.py port).
//
// Covers extractFinalResponse (human_analog.py:74-106) ONLY plus the
// APPROVAL_FALLBACK constant pin (human_analog.py:178-180). The model path
// (generateHumanResponse) is the KNOWLEDGE→LLM concern: it is gated behind a
// live transport + dynamic SDK import and is NEVER exercised here — no live call
// in tests. Every expectation below was confirmed byte-identical against the
// real Python _extract_final_response before being written.
//
// Block-extraction quirk being relied on (human_analog.py:92-94): `current` is
// never reset, so `blocks` only ever holds the single live reference pushed on
// the first "> " line; everything from that line onward (later >-runs, trailing
// ━━━ separators, blank lines) accumulates into that one block, and tool noise
// BEFORE the first "> " line is excluded. The "last block wins" framing in the
// Python docstring (:79) reduces to "this single accumulating block wins".

import { expect, test } from "bun:test";
import { APPROVAL_FALLBACK, extractFinalResponse } from "./human-analog.ts";

// 1 — strips ANSI escape sequences before block extraction (human_analog.py:84-85).
test("extractFinalResponse strips ANSI escape sequences before block extraction", () => {
  // CSI color/bold codes wrap the "> " marker; after stripping, the line is a
  // valid response block line.
  const raw = "\x1b[31m\x1b[1m> red question line\x1b[0m\n> second";
  expect(extractFinalResponse(raw)).toBe("red question line\nsecond");
});

// 2 — the last response content wins; tool noise before the first "> " is dropped
// (human_analog.py:79,87-99). A second >-run later in the turn dominates the tail.
test("extractFinalResponse selects the last response content and drops pre-block tool noise", () => {
  const raw = [
    "Some tool output here",
    "[writing file foo.py]",
    "> First response line",
    "> still first",
    "[tool: ran tests]",
    "",
    "> Second response after blank",
    "> more of second",
    "Approve this plan?",
  ].join("\n");
  const out = extractFinalResponse(raw);
  // Leading tool noise excluded; the later response is present and last.
  expect(out.startsWith("Some tool output")).toBe(false);
  expect(out).toContain("Second response after blank");
  expect(out.endsWith("Approve this plan?")).toBe(true);
  expect(out).toBe(
    "First response line\nstill first\n[tool: ran tests]\n\nSecond response after blank\nmore of second\nApprove this plan?",
  );
});

// 3 — includes ━━━ separator lines that follow the last response block
// (human_analog.py:96 — non-empty non-">" lines append verbatim when current is set).
test("extractFinalResponse includes ━━━ separator lines following the last response block", () => {
  const raw = "> answer\n━━━ separator\nmore ctx";
  expect(extractFinalResponse(raw)).toBe("answer\n━━━ separator\nmore ctx");
});

// 4 — caps the returned block at 2000 chars (human_analog.py:103).
test("extractFinalResponse caps the returned block at 2000 chars", () => {
  const raw = "> " + "A".repeat(2500);
  expect(extractFinalResponse(raw).length).toBe(2000);
});

// 5 — empty/no-">"-block input → fallback returns last 1500 chars trimmed
// (human_analog.py:105-106).
test("extractFinalResponse falls back to the last 1500 chars when no \"> \" block exists", () => {
  const raw = "x".repeat(3000) + " TAIL";
  const out = extractFinalResponse(raw);
  expect(out.length).toBe(1500);
  expect(out.endsWith("TAIL")).toBe(true);
  // No "> " marker anywhere → fallback path, content is the raw tail.
  expect(out).toBe(("x".repeat(3000) + " TAIL").slice(-1500).trim());
});

// 6 — a plain question block round-trips its text (human_analog.py:94 — line[2:]).
test("extractFinalResponse round-trips a plain question block", () => {
  const raw = "> How should mode behave when all values are unique?";
  expect(extractFinalResponse(raw)).toBe("How should mode behave when all values are unique?");
});

// 7 — splits on CRLF/CR like Python's str.splitlines() (human_analog.py:90), NOT a
// bare split("\n"). A CRLF turn output must NOT leave a trailing \r embedded in the
// extracted block (verified byte-identical against the live Python on these inputs).
test("extractFinalResponse splits CRLF/CR line boundaries like Python splitlines()", () => {
  expect(extractFinalResponse("> answer\r\nmore ctx")).toBe("answer\nmore ctx");
  expect(extractFinalResponse("noise\r\n> q1\r\n> q2\r\napprove?")).toBe("q1\nq2\napprove?");
});

// Pin the on-error fallback constant (human_analog.py:178-180) — distinct from the
// in-prompt non-question reply "Approved. Continue." (human_analog.py:44,71).
test("APPROVAL_FALLBACK is exactly \"Approve & Continue.\"", () => {
  expect(APPROVAL_FALLBACK).toBe("Approve & Continue.");
});
