// driver-tui.ts — the PRODUCER (Claude TUI transport, best-effort SECONDARY).
//
// DRIVER-PORT-PLAN.md section D. The second transport for the producer half: it
// drives the SAME /aidlc workflow through the terminal UI rather than the SDK,
// for parity coverage where the SDK path is unavailable.
//
// SHELLS to the repo's tracked tui-drive harness as a SUBPROCESS via its PUBLIC
// CLI (tui-drive.ts:50-103 start/send/wait/capture/kill/answer-gate) — it NEVER
// imports tui-drive's internals (the tracked file stays unedited; only its
// documented command surface is used). The take-Recommended-per-menu answer-gate
// loop IS the deterministic human-analog simulacrum for this transport
// (tui-drive.ts:72-103, terminates on the on-disk `Status=Completed` signal).
//
// REUSE (no duplication): the workspace setup and the aidlc-docs extract/strip are
// SHARED with driver-sdk.ts via its exported setupWorkspace/extractAndStrip — the
// same claude_code.py:182-213 + :429-436 + orchestrator.py:56-65 logic, one copy.
//
// TOKEN TELEMETRY: a TUI run surfaces no usage dict, so tokenUsage is null →
// normalizeOutput emits the N/A-sentinel zero metrics (normalizer.ts:112-256, the
// `tokenUsage ?? {}` path makes every token/duration field default to 0).
//
// GATE: the live subprocess only runs when opts.live; the command-arg builders are
// pure functions exported for unit tests (assert the argv; never spawn claude).
//
// DETERMINISM: elapsedSeconds via performance.now() (monotonic, not Date), same as
// driver-sdk.ts.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setupWorkspace, extractAndStrip, type DriverResult } from "./driver-sdk.ts";

// The tracked tui-drive harness CLI (its PUBLIC entry point; not imported).
// Resolved relative to this module (tests/harness/eval/) → tests/harness/tui-drive.ts,
// so it is portable across checkouts/CI rather than a machine-specific absolute path.
const TUI_DRIVE_PATH = join(import.meta.dir, "..", "tui-drive.ts");

export interface DriveAidlcTuiOptions {
  visionPath: string;
  techEnvPath?: string;
  outputDir: string;
  distClaudePath: string;
  scope?: string; // default "mvp"
  testRun?: boolean; // default true (kept for prompt parity with driver-sdk)
  awsRegion?: string;
  /** tmux/node-pty session name passed to tui-drive (default "aidlc-run"). */
  session?: string;
  /** answer-gate per-gate / overall timeouts (tui-drive.ts:69). */
  perGateTimeoutMs?: number;
  overallTimeoutMs?: number;
  /**
   * GATE: the live subprocess sequence only runs when live === true. Default
   * false → the function throws before spawning, so a default test never spawns
   * claude. Tests assert the argv builders directly instead.
   */
  live?: boolean;
  /** Path to the tui-drive harness CLI (override only for tests). */
  tuiDrivePath?: string;
}

// ── command-arg builders (PURE — exported for unit tests) ─────────────────────
// Each returns the argv AFTER `bun <tui-drive.ts>`: [subcommand, ...flags].
// The shapes are read straight from tui-drive's documented CLI (tui-drive.ts:50-103).

// start --session <s> --cwd <workspace> -- claude  (tui-drive.ts:50-51)
// `--` separates tui-drive's own flags from the launched command argv.
export function buildStartArgs(session: string, workspace: string): string[] {
  return ["start", "--session", session, "--cwd", workspace, "--", "claude"];
}

// send --keys "/aidlc <intent> --scope <scope>" --literal  (tui-drive.ts:52-55)
// --literal sends the slash command verbatim (free text), Enter appended.
export function buildSendArgs(session: string, prompt: string): string[] {
  return ["send", "--session", session, "--keys", prompt, "--literal"];
}

// answer-gate --session <s> --project-dir <workspace> --until-state-field
//   "Status=Completed"  (tui-drive.ts:68-95) — take-Recommended per menu,
// terminate on the on-disk Status=Completed signal.
export function buildAnswerGateArgs(
  session: string,
  workspace: string,
  opts: { perGateTimeoutMs?: number; overallTimeoutMs?: number } = {},
): string[] {
  const args = [
    "answer-gate",
    "--session",
    session,
    "--project-dir",
    workspace,
    "--until-state-field",
    "Status=Completed",
  ];
  // tui-drive.ts:69 — optional hang backstops; flags only added when provided.
  if (opts.perGateTimeoutMs !== undefined) {
    args.push("--per-gate-timeout-ms", String(opts.perGateTimeoutMs));
  }
  if (opts.overallTimeoutMs !== undefined) {
    args.push("--overall-timeout-ms", String(opts.overallTimeoutMs));
  }
  return args;
}

// kill --session <s>  (tui-drive.ts:66-67) — idempotent session teardown.
export function buildKillArgs(session: string): string[] {
  return ["kill", "--session", session];
}

// ── driveAidlcTui — the entry point (mirrors driver-sdk.ts:driveAidlcRun) ─────
export async function driveAidlcTui(opts: DriveAidlcTuiOptions): Promise<DriverResult> {
  const scope = opts.scope ?? "mvp";
  const testRun = opts.testRun ?? true;
  const session = opts.session ?? "aidlc-run";
  const tuiDrivePath = opts.tuiDrivePath ?? TUI_DRIVE_PATH;

  const start = performance.now();

  // Shared workspace setup (claude_code.py:182-213) — REUSED from driver-sdk.ts.
  const { workspace, prompt } = setupWorkspace({
    visionPath: opts.visionPath,
    techEnvPath: opts.techEnvPath,
    outputDir: opts.outputDir,
    distClaudePath: opts.distClaudePath,
    scope,
    testRun,
    awsRegion: opts.awsRegion,
  });

  // GATE: the subprocess sequence only runs live.
  if (!opts.live) {
    throw new Error(
      "driveAidlcTui: live TUI subprocess gated — pass { live: true } to spawn the " +
        "tui-drive harness against claude. Tests assert the argv builders instead.",
    );
  }

  // Spawn the tui-drive harness through `bun`, one subcommand per invocation
  // (start → send → answer-gate → kill), exactly as its CLI documents.
  let finalSubtype = "";
  try {
    runTuiDrive(tuiDrivePath, buildStartArgs(session, workspace));
    runTuiDrive(tuiDrivePath, buildSendArgs(session, prompt));
    const gate = runTuiDrive(
      tuiDrivePath,
      buildAnswerGateArgs(session, workspace, {
        perGateTimeoutMs: opts.perGateTimeoutMs,
        overallTimeoutMs: opts.overallTimeoutMs,
      }),
    );
    // answer-gate exits 0 when the terminator (Status=Completed) is met, 1 on a
    // timeout (tui-drive.ts:105). Treat 0 as success-equivalent to the SDK's
    // "success" subtype so DriverResult.success aligns across transports.
    finalSubtype = gate.status === 0 ? "success" : "tui-gate-timeout";
  } finally {
    // Always tear the session down (idempotent).
    runTuiDrive(tuiDrivePath, buildKillArgs(session));
  }

  // Shared extract + strip (claude_code.py:429-436 + orch:56-65) — REUSED.
  const aidlcDocsDir = extractAndStrip(workspace, opts.outputDir);

  const elapsedSeconds = (performance.now() - start) / 1000;

  return {
    outputDir: opts.outputDir,
    workspaceDir: workspace,
    aidlcDocsDir,
    // No usage telemetry from a TUI run → null (normalizer emits zero metrics).
    tokenUsage: null,
    elapsedSeconds,
    finalSubtype,
    success: finalSubtype === "success" && aidlcDocsDir !== null,
  };
}

// Run one tui-drive subcommand via `bun <tui-drive.ts> <args...>`, inheriting
// stdio so the TUI journey is visible. Returns the spawn result for exit-code
// inspection. Live-only; never reached in a default test (gated above).
function runTuiDrive(
  tuiDrivePath: string,
  args: string[],
): { status: number | null } {
  const r = spawnSync("bun", [tuiDrivePath, ...args], { stdio: "inherit" });
  return { status: r.status };
}
