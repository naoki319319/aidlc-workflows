// shared-sandbox.test.ts — pure unit tests for the Docker sandbox port.
//
// No Python test file is in scope (sandbox.py is Docker-gated, gap G5). These
// tests cover the PURE logic the port adds value to: argv construction for
// `sandbox_run` / `sandbox_run_detached`, the two-tier availability probe, the
// resettable module memo, and credential-scrubbing of captured output — all via
// an injected stub spawn seam, so the suite runs WITHOUT a Docker daemon.
//
// Source of truth (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/src/shared/sandbox.py
//
// Each assertion cites the sandbox.py line(s) it pins.

import { afterEach, describe, expect, test } from "bun:test";
import { resolve as resolvePath } from "node:path";
import {
  isDockerAvailable,
  resetDockerAvailableMemo,
  sandboxIsRunning,
  sandboxLogs,
  sandboxRun,
  sandboxRunDetached,
  sandboxStop,
  type SpawnResult,
  type SpawnSeam,
} from "./shared-sandbox.ts";

// ── stub spawn seam ─────────────────────────────────────────────────────────
// Records every (command, args, options) call and returns a queued/static
// SpawnResult. No real process is spawned, so no Docker is required.
interface Recorded {
  command: string;
  args: string[];
  options: { encoding?: string; timeout?: number };
}

function makeSpawn(
  responses: SpawnResult | SpawnResult[],
): { seam: SpawnSeam; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const single = Array.isArray(responses) ? null : responses;
  const seam: SpawnSeam = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    if (queue) return queue.shift() ?? { status: 0 };
    return single!;
  };
  return { seam, calls };
}

const ok = (stdout = "", stderr = ""): SpawnResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr,
  error: null,
});

// is_docker_available caches in a module memo — reset before each probe test
// so each test drives a fresh two-tier probe (sandbox.py:30,44-46).
afterEach(() => {
  resetDockerAvailableMemo();
});

// ── sandbox_run argv — sandbox.py:111-143 ───────────────────────────────────
describe("sandboxRun argv construction", () => {
  test("builds the full default docker run flag set in order", () => {
    const { seam, calls } = makeSpawn(ok("hello", ""));
    sandboxRun("pytest -q", "/work/space", {}, seam);

    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    // sandbox.py:112-113 — argv0 docker, subcommand run.
    expect(command).toBe("docker");
    // sandbox.py:114-130 + 143 — foreground `--rm`, default memory/cpus, the
    // security/cache flags, then `image bash -c command`.
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    expect(args).toEqual([
      "run",
      "--rm",
      "--memory=2g", // sandbox.py:83 default
      "--cpus=2", // sandbox.py:84 default
      "--cap-drop=ALL", // sandbox.py:117
      `--user=${uid}:${gid}`, // sandbox.py:118
      "--workdir=/workspace", // sandbox.py:119
      "-v",
      `${resolvePath("/work/space")}:/workspace`, // sandbox.py:120-121
      "-e",
      "HOME=/tmp", // sandbox.py:124-125
      "-e",
      "UV_CACHE_DIR=/tmp/.cache/uv", // sandbox.py:126-127
      "-e",
      "NPM_CONFIG_CACHE=/tmp/.cache/npm", // sandbox.py:128-129
      "aidlc-sandbox:latest", // sandbox.py:78 default image
      "bash",
      "-c",
      "pytest -q", // sandbox.py:143
    ]);
  });

  test("default timeout 300s is passed to the seam as 300000ms", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", {}, seam);
    // sandbox.py:79 default timeout=300 (seconds) → ms for the Node seam.
    expect(calls[0]!.options.timeout).toBe(300_000);
    expect(calls[0]!.options.encoding).toBe("utf-8");
  });

  test("network=false appends --network=none after the cache env block", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", { network: false }, seam);
    // sandbox.py:132-133 — --network=none only when network is falsy.
    const args = calls[0]!.args;
    const idx = args.indexOf("--network=none");
    expect(idx).toBeGreaterThan(args.indexOf("NPM_CONFIG_CACHE=/tmp/.cache/npm"));
    expect(idx).toBeLessThan(args.indexOf("aidlc-sandbox:latest"));
  });

  test("network=true (default) omits --network=none", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", {}, seam);
    // sandbox.py:99,132 — network defaults True ⇒ no --network=none.
    expect(calls[0]!.args).not.toContain("--network=none");
  });

  test("env vars expand to -e KEY=VALUE pairs in insertion order", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", { env: { FOO: "1", BAR: "two" } }, seam);
    // sandbox.py:135-137 — each env entry → ["-e", "KEY=VALUE"].
    const args = calls[0]!.args;
    expect(args).toContain("FOO=1");
    expect(args).toContain("BAR=two");
    // The custom env -e flags come after the fixed HOME/cache -e flags.
    expect(args.indexOf("FOO=1")).toBeGreaterThan(args.indexOf("HOME=/tmp"));
  });

  test("ports expand to -p 127.0.0.1:host:container", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", { ports: { 8000: 80 } }, seam);
    // sandbox.py:139-141 — host-bound to 127.0.0.1.
    expect(calls[0]!.args).toContain("127.0.0.1:8000:80");
  });

  test("custom image / memory / cpus override the defaults", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxRun("true", "/w", { image: "x:1", memory: "512m", cpus: 4 }, seam);
    const args = calls[0]!.args;
    expect(args).toContain("--memory=512m"); // sandbox.py:115
    expect(args).toContain("--cpus=4"); // sandbox.py:116
    expect(args).toContain("x:1"); // sandbox.py:143
  });
});

// ── sandbox_run output scrubbing — sandbox.py:154-179 ────────────────────────
describe("sandboxRun output scrubbing", () => {
  test("success: scrubs credentials in BOTH stdout and stderr; carries exit code", () => {
    const { seam } = makeSpawn({
      status: 1,
      signal: null,
      // sandbox.py:156-157 — both streams scrubbed.
      stdout: "key=AKIAIOSFODNN7EXAMPLE done",
      stderr: "err AKIAIOSFODNN7EXAMPLE here",
      error: null,
    });
    const res = sandboxRun("true", "/w", {}, seam);
    // sandbox.py:155 — exit_code = returncode.
    expect(res.exitCode).toBe(1);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(res.stdout).toContain("[REDACTED-AWS-ACCESS-KEY]");
    expect(res.stderr).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(res.stderr).toContain("[REDACTED-AWS-ACCESS-KEY]");
  });

  test("null/empty captured output scrubs to empty strings", () => {
    const { seam } = makeSpawn({ status: 0, signal: null, stdout: null, stderr: null, error: null });
    const res = sandboxRun("true", "/w", {}, seam);
    // sandbox.py:156-157 — scrub_credentials("") short-circuits to "".
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
  });

  test("timeout (ETIMEDOUT): exit_code null, timed_out true, partial output scrubbed", () => {
    const { seam } = makeSpawn({
      status: null,
      signal: null,
      stdout: "partial AKIAIOSFODNN7EXAMPLE",
      stderr: "stderr token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    const res = sandboxRun("true", "/w", {}, seam);
    // sandbox.py:159,174-178 — TimeoutExpired branch.
    expect(res.exitCode).toBeNull();
    expect(res.timedOut).toBe(true);
    expect(res.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(res.stdout).toContain("[REDACTED-AWS-ACCESS-KEY]");
    expect(res.stderr).toContain("[REDACTED-GITHUB-TOKEN]");
  });

  test("timeout via signal kill (status null, non-null signal) also maps to timed_out", () => {
    const { seam } = makeSpawn({
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      error: null,
    });
    const res = sandboxRun("true", "/w", {}, seam);
    expect(res.exitCode).toBeNull();
    expect(res.timedOut).toBe(true);
  });
});

// ── sandbox_run_detached — sandbox.py:182-246 ───────────────────────────────
describe("sandboxRunDetached", () => {
  test("builds the detached `-d --rm` argv and returns the trimmed container id (NOT scrubbed)", () => {
    // The container id is a 40-hex string — which would itself match the
    // API-KEY scrub pattern. sandbox.py:246 returns it UNscrubbed, proving the
    // detached path does not route stdout through scrub_credentials.
    const cid = "abcdef0123456789abcdef0123456789abcdef01"; // 40 hex
    const { seam, calls } = makeSpawn(ok(`${cid}\n`, ""));
    const out = sandboxRunDetached("uvicorn app:app", "/srv", { ports: { 8000: 8000 } }, seam);

    // sandbox.py:246 — stripped, unscrubbed container id.
    expect(out).toBe(cid);

    const args = calls[0]!.args;
    // sandbox.py:201-204 — detached prefix `-d --rm` (NOT plain `--rm`).
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
    expect(args).toContain("127.0.0.1:8000:8000"); // sandbox.py:230-232
    expect(args.slice(-4)).toEqual([
      "aidlc-sandbox:latest",
      "bash",
      "-c",
      "uvicorn app:app",
    ]); // sandbox.py:234
    // sandbox.py:238-243 — fixed 30s deadline for detached start.
    expect(calls[0]!.options.timeout).toBe(30_000);
  });

  test("throws RuntimeError-equivalent with stripped stderr on non-zero exit", () => {
    const { seam } = makeSpawn({
      status: 125,
      signal: null,
      stdout: "",
      stderr: "  no such image: x:1  \n",
      error: null,
    });
    // sandbox.py:244-245 — RuntimeError("Failed to start container: <stderr.strip()>").
    expect(() => sandboxRunDetached("true", "/w", {}, seam)).toThrow(
      "Failed to start container: no such image: x:1",
    );
  });
});

// ── is_docker_available two-tier probe + memo — sandbox.py:33-71 ─────────────
describe("isDockerAvailable", () => {
  test("two-tier success: docker info ok THEN alpine probe ok ⇒ true", () => {
    const { seam, calls } = makeSpawn([ok(), ok()]);
    expect(isDockerAvailable(seam)).toBe(true);
    // sandbox.py:50-54 then :62-66 — exactly two spawns, info then run-probe.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["info"]);
    expect(calls[1]!.args).toEqual([
      "run",
      "--rm",
      "--memory=6m",
      "--cpus=1",
      "alpine",
      "true",
    ]);
    expect(calls[0]!.options.timeout).toBe(10_000); // sandbox.py:53
    expect(calls[1]!.options.timeout).toBe(30_000); // sandbox.py:65
  });

  test("docker info non-zero ⇒ false, second tier NOT attempted", () => {
    const { seam, calls } = makeSpawn([{ status: 1, signal: null, error: null }]);
    expect(isDockerAvailable(seam)).toBe(false);
    // sandbox.py:55-57 — short-circuit before the alpine probe.
    expect(calls).toHaveLength(1);
  });

  test("docker binary missing (ENOENT) ⇒ false", () => {
    const { seam } = makeSpawn({
      status: null,
      signal: null,
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
    });
    // sandbox.py:68-69 — FileNotFoundError ⇒ unavailable.
    expect(isDockerAvailable(seam)).toBe(false);
  });

  test("info ok but alpine probe fails (cgroup/OCI) ⇒ false", () => {
    const { seam } = makeSpawn([ok(), { status: 1, signal: null, error: null }]);
    // sandbox.py:67 — available iff the resource-limited probe exits 0.
    expect(isDockerAvailable(seam)).toBe(false);
  });

  test("result is memoized: the seam is only invoked on the first call", () => {
    const { seam, calls } = makeSpawn([ok(), ok()]);
    expect(isDockerAvailable(seam)).toBe(true);
    const before = calls.length;
    // sandbox.py:44-46 — cached for the process lifetime.
    expect(isDockerAvailable(seam)).toBe(true);
    expect(isDockerAvailable(seam)).toBe(true);
    expect(calls.length).toBe(before);
  });

  test("resetDockerAvailableMemo re-runs the probe (test seam)", () => {
    const first = makeSpawn([ok(), ok()]);
    expect(isDockerAvailable(first.seam)).toBe(true);
    expect(first.calls.length).toBe(2);

    resetDockerAvailableMemo();

    const second = makeSpawn([{ status: 1, signal: null, error: null }]);
    // After reset, a fresh probe runs against the NEW seam and can flip.
    expect(isDockerAvailable(second.seam)).toBe(false);
    expect(second.calls.length).toBe(1);
  });
});

// ── sandbox_stop / is_running / logs — sandbox.py:249-295 ────────────────────
describe("sandboxStop", () => {
  test("graceful stop: docker stop -t <timeout> <id>, deadline timeout+5", () => {
    const { seam, calls } = makeSpawn(ok());
    sandboxStop("cid123", 10, seam);
    // sandbox.py:253-256.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["stop", "-t", "10", "cid123"]);
    expect(calls[0]!.options.timeout).toBe(15_000); // (10+5)*1000
  });

  test("force-kills on stop error", () => {
    const { seam, calls } = makeSpawn([
      { status: null, signal: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
      ok(),
    ]);
    sandboxStop("cid123", 10, seam);
    // sandbox.py:258-265 — fall back to docker kill <id>.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(["kill", "cid123"]);
    expect(calls[1]!.options.timeout).toBe(5_000);
  });
});

describe("sandboxIsRunning", () => {
  test("true iff exit 0 AND stdout trim == 'true'", () => {
    const { seam, calls } = makeSpawn(ok("true\n", ""));
    expect(sandboxIsRunning("cid", seam)).toBe(true);
    // sandbox.py:273 — docker inspect -f {{.State.Running}} <id>.
    expect(calls[0]!.args).toEqual(["inspect", "-f", "{{.State.Running}}", "cid"]);
  });

  test("false when stdout is 'false'", () => {
    const { seam } = makeSpawn(ok("false\n", ""));
    expect(sandboxIsRunning("cid", seam)).toBe(false);
  });

  test("false on spawn error (timeout/OS)", () => {
    const { seam } = makeSpawn({
      status: null,
      signal: null,
      error: Object.assign(new Error("oops"), { code: "ETIMEDOUT" }),
    });
    // sandbox.py:279-280.
    expect(sandboxIsRunning("cid", seam)).toBe(false);
  });
});

describe("sandboxLogs", () => {
  test("returns raw (UNscrubbed) stdout/stderr tuple", () => {
    // A credential in logs is returned AS-IS — sandbox.py:293 does not scrub.
    const { seam, calls } = makeSpawn(ok("out AKIAIOSFODNN7EXAMPLE", "err"));
    const [out, err] = sandboxLogs("cid", seam);
    expect(out).toBe("out AKIAIOSFODNN7EXAMPLE");
    expect(err).toBe("err");
    expect(calls[0]!.args).toEqual(["logs", "cid"]); // sandbox.py:289
  });

  test("returns ['', ''] on spawn error", () => {
    const { seam } = makeSpawn({
      status: null,
      signal: null,
      error: Object.assign(new Error("oops"), { code: "ETIMEDOUT" }),
    });
    // sandbox.py:294-295.
    expect(sandboxLogs("cid", seam)).toEqual(["", ""]);
  });
});
