// driver-tui.test.ts — PURE tests for driver-tui.ts (tui-drive CLI arg builders).
//
// Covers ONLY the command-arg builders (DETERMINISM→tool): the exact argv each
// builder produces for the tui-drive harness CLI (tui-drive.ts:50-103). The live
// subprocess sequence is GATED behind { live: true } and is NEVER spawned here —
// no `bun tui-drive.ts` runs, no claude launches. Every argv shape was confirmed
// against tui-drive's documented CLI before being written.

import { expect, test } from "bun:test";
import {
  buildAnswerGateArgs,
  buildKillArgs,
  buildSendArgs,
  buildStartArgs,
} from "./driver-tui.ts";

// ── start (tui-drive.ts:50-51) ───────────────────────────────────────────────

test("buildStartArgs: start --session <s> --cwd <ws> -- claude", () => {
  expect(buildStartArgs("aidlc-run", "/tmp/run/workspace")).toEqual([
    "start",
    "--session",
    "aidlc-run",
    "--cwd",
    "/tmp/run/workspace",
    "--",
    "claude",
  ]);
});

// ── send (tui-drive.ts:52-55) ────────────────────────────────────────────────

test("buildSendArgs: send --keys <prompt> --literal (slash command sent verbatim)", () => {
  expect(buildSendArgs("aidlc-run", "/aidlc Build a calc --scope mvp")).toEqual([
    "send",
    "--session",
    "aidlc-run",
    "--keys",
    "/aidlc Build a calc --scope mvp",
    "--literal",
  ]);
});

// ── answer-gate (tui-drive.ts:68-95) ─────────────────────────────────────────

test("buildAnswerGateArgs: answer-gate with the Status=Completed on-disk terminator", () => {
  expect(buildAnswerGateArgs("aidlc-run", "/tmp/run/workspace")).toEqual([
    "answer-gate",
    "--session",
    "aidlc-run",
    "--project-dir",
    "/tmp/run/workspace",
    "--until-state-field",
    "Status=Completed",
  ]);
});

test("buildAnswerGateArgs: appends per-gate + overall timeout backstops when given (tui-drive.ts:69)", () => {
  expect(
    buildAnswerGateArgs("aidlc-run", "/tmp/run/workspace", {
      perGateTimeoutMs: 60000,
      overallTimeoutMs: 600000,
    }),
  ).toEqual([
    "answer-gate",
    "--session",
    "aidlc-run",
    "--project-dir",
    "/tmp/run/workspace",
    "--until-state-field",
    "Status=Completed",
    "--per-gate-timeout-ms",
    "60000",
    "--overall-timeout-ms",
    "600000",
  ]);
});

test("buildAnswerGateArgs: only the provided timeout flag is appended", () => {
  expect(
    buildAnswerGateArgs("aidlc-run", "/tmp/run/workspace", { overallTimeoutMs: 600000 }),
  ).toEqual([
    "answer-gate",
    "--session",
    "aidlc-run",
    "--project-dir",
    "/tmp/run/workspace",
    "--until-state-field",
    "Status=Completed",
    "--overall-timeout-ms",
    "600000",
  ]);
});

// ── kill (tui-drive.ts:66-67) ────────────────────────────────────────────────

test("buildKillArgs: kill --session <s>", () => {
  expect(buildKillArgs("aidlc-run")).toEqual(["kill", "--session", "aidlc-run"]);
});
