// shared-sandbox.ts — faithful TS port of the Python evaluator's Docker sandbox.
//
// A thin wrapper around `docker run` so generated code (post-run tests,
// contract-test servers) executes in an isolated container without access to
// the host filesystem, network credentials, or environment. All captured
// command output is scrubbed for credentials before being returned.
//
// Source of truth (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/src/shared/sandbox.py
//
// Faithful to sandbox.py:1-296.
//
// GATED (gap G5): the real Docker calls require a Docker daemon. The whole
// module is gated behind `isDockerAvailable()` at the call sites (postrun /
// contract own that gate). To keep the pure argv-construction + output-scrubbing
// logic testable WITHOUT Docker, every subprocess call routes through an
// injectable `spawnSync` seam (default: node:child_process.spawnSync). Tests
// inject a stub seam and assert the constructed argv, then verify scrubbing of
// captured output — all without a daemon.
//
// Porting notes (Python → TS):
//  - `os.getuid()`/`os.getgid()` (sandbox.py:118,209) are POSIX-only. Node's
//    `process.getuid`/`process.getgid` are `undefined` on non-POSIX (Windows),
//    so we call them via optional chaining. The `--user=uid:gid` mapping is a
//    Linux-container concept; the module is Docker-gated, and Docker on macOS/
//    Linux exposes POSIX uid/gid, so in practice these resolve. We document the
//    non-POSIX gate here rather than guess a fallback.
//  - `workspace.resolve()` (sandbox.py:121,212) → Node `path.resolve(workspace)`
//    (absolute, symlink-free-ish; matches Python's absolute-path normalization
//    for the bind-mount source).
//  - `subprocess.run(..., capture_output=True, text=True, timeout=...)` →
//    `spawnSync(argv[0], argv.slice(1), { encoding: "utf-8", timeout, ... })`.
//    Node's spawnSync surfaces a timeout via `error.code === "ETIMEDOUT"` (or a
//    non-null `signal`), distinct from Python's `TimeoutExpired` exception; we
//    translate that into the `timed_out` SandboxResult branch (sandbox.py:159-179).
//  - Type kept LOCAL to this module per the port rules (do not edit shared types.ts).

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { scrubCredentials } from "./shared-credential-scrubber.ts";

// ── injectable spawn seam ───────────────────────────────────────────────────
// Mirrors the subset of node:child_process.spawnSync's return that this module
// consumes. Production passes the real spawnSync; tests inject a stub so argv
// can be asserted and output scrubbing verified WITHOUT a Docker daemon.

/** Options forwarded to the spawn seam (subset of SpawnSyncOptions we use). */
export interface SpawnOptions {
  /** When set, the seam treats string output as text (Python `text=True`). */
  encoding?: "utf-8";
  /** Wall-clock timeout in milliseconds (Python `timeout` is SECONDS). */
  timeout?: number;
}

/**
 * Subset of node:child_process.SpawnSyncReturns<string> that this module reads.
 *
 * - `status`: process exit code, or null if killed by a signal/timeout
 *   (Python `result.returncode`).
 * - `signal`: kill signal name, or null.
 * - `stdout`/`stderr`: captured output. With `encoding: "utf-8"` these are
 *   strings; they may be null/undefined when nothing was captured.
 * - `error`: present when the child could not be spawned OR was killed by the
 *   timeout. We key on `error.code` (`"ETIMEDOUT"` for a timeout, `"ENOENT"`
 *   for a missing `docker` binary — Python's `FileNotFoundError`).
 */
export interface SpawnResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: (Error & { code?: string }) | null;
}

/** The seam signature: argv0 + args + options → SpawnResult. */
export type SpawnSeam = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnResult;

// Default seam delegates to the real node:child_process.spawnSync. The
// `capture_output=True` of Python is `stdio: ["ignore", "pipe", "pipe"]`; we
// rely on spawnSync's default piping with an encoding to capture text.
const defaultSpawn: SpawnSeam = (command, args, options) => {
  const r = nodeSpawnSync(command, args as string[], {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout as unknown as string | null,
    stderr: r.stderr as unknown as string | null,
    error: r.error as (Error & { code?: string }) | null,
  };
};

// ── SandboxResult — sandbox.py:20-27 ────────────────────────────────────────
/** Outcome of a sandboxed command execution. */
export interface SandboxResult {
  /** Exit code; null when the run timed out (Python `exit_code: int | None`). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Defaults to false; true only on the timeout branch (sandbox.py:27,178). */
  timedOut: boolean;
}

// ── module memo for is_docker_available — sandbox.py:30,44-71 ────────────────
// RESETTABLE so tests can clear the cached probe result between runs.
let _dockerAvailable: boolean | null = null;

/** Reset the cached Docker-availability probe (test seam; not in Python). */
export function resetDockerAvailableMemo(): void {
  _dockerAvailable = null;
}

/**
 * Check whether Docker can actually run containers.
 *
 * Two-tier probe (sandbox.py:33-71): first `docker info`; if that succeeds,
 * spawn a trivial resource-limited container (`docker run --rm --memory=6m
 * --cpus=1 alpine true`) to catch cgroup v2 / OCI runtime errors that plain
 * `docker info` misses. The result is cached for the process lifetime.
 *
 * @param spawn injectable seam (default: real spawnSync) so tests can drive
 *   both tiers without a daemon.
 */
export function isDockerAvailable(spawn: SpawnSeam = defaultSpawn): boolean {
  // sandbox.py:44-46 — return the memo when already probed.
  if (_dockerAvailable !== null) return _dockerAvailable;

  try {
    // sandbox.py:50-54 — `docker info`, 10s timeout.
    const info = spawn("docker", ["info"], { timeout: 10_000 });
    // sandbox.py:68 — FileNotFoundError ⇒ docker binary missing ⇒ unavailable.
    if (info.error && info.error.code === "ENOENT") {
      _dockerAvailable = false;
      return _dockerAvailable;
    }
    // sandbox.py:55-57 — non-zero `docker info` ⇒ unavailable.
    if (info.status !== 0) {
      _dockerAvailable = false;
      return _dockerAvailable;
    }

    // sandbox.py:62-66 — verify a resource-limited container actually starts.
    const run = spawn(
      "docker",
      ["run", "--rm", "--memory=6m", "--cpus=1", "alpine", "true"],
      { timeout: 30_000 },
    );
    if (run.error && run.error.code === "ENOENT") {
      _dockerAvailable = false;
      return _dockerAvailable;
    }
    // sandbox.py:67 — available iff the probe container exits 0.
    _dockerAvailable = run.status === 0;
  } catch {
    // sandbox.py:68-69 — FileNotFoundError / TimeoutExpired ⇒ unavailable.
    _dockerAvailable = false;
  }

  return _dockerAvailable;
}

// ── shared docker-run flag set — sandbox.py:111-130 / 201-221 ────────────────
// Both sandbox_run and sandbox_run_detached build the SAME base flag set apart
// from the leading run mode (`--rm` foreground vs `-d --rm` detached). We
// factor the common construction so both stay byte-identical to the Python.

interface DockerRunOpts {
  image: string;
  network: boolean;
  env?: Record<string, string> | null;
  ports?: Record<number, number> | null;
  memory: string;
  cpus: number;
}

/**
 * Build the docker-run argv (everything AFTER the leading mode flags).
 *
 * Faithful to sandbox.py:115-143 (foreground) and :205-234 (detached) — the
 * only difference between the two Python builders is the `--rm` vs `-d --rm`
 * prefix, which the callers prepend. Here we emit:
 *   --memory=<m> --cpus=<c> --cap-drop=ALL --user=<uid>:<gid>
 *   --workdir=/workspace -v <abs-workspace>:/workspace
 *   -e HOME=/tmp -e UV_CACHE_DIR=/tmp/.cache/uv -e NPM_CONFIG_CACHE=/tmp/.cache/npm
 *   [--network=none?] [-e K=V ...] [-p 127.0.0.1:host:cont ...]
 *   <image> bash -c <command>
 */
function buildDockerRunArgs(
  command: string,
  workspace: string,
  opts: DockerRunOpts,
): string[] {
  // sandbox.py:118,209 — os.getuid()/os.getgid(); POSIX-only (see header note).
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  const args: string[] = [
    `--memory=${opts.memory}`,
    `--cpus=${opts.cpus}`,
    "--cap-drop=ALL",
    `--user=${uid}:${gid}`,
    "--workdir=/workspace",
    "-v",
    // sandbox.py:121,212 — workspace.resolve():/workspace bind-mount (rw).
    `${resolvePath(workspace)}:/workspace`,
    // sandbox.py:124-129,215-220 — writable HOME/cache for the mapped UID which
    // has no /etc/passwd entry inside the container.
    "-e",
    "HOME=/tmp",
    "-e",
    "UV_CACHE_DIR=/tmp/.cache/uv",
    "-e",
    "NPM_CONFIG_CACHE=/tmp/.cache/npm",
  ];

  // sandbox.py:132-133,223-224 — no network ⇒ --network=none.
  if (!opts.network) args.push("--network=none");

  // sandbox.py:135-137,226-228 — extra env vars (only these are visible).
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // sandbox.py:139-141,230-232 — port mappings, host-bound to 127.0.0.1.
  if (opts.ports) {
    for (const [hostPort, containerPort] of Object.entries(opts.ports)) {
      args.push("-p", `127.0.0.1:${hostPort}:${containerPort}`);
    }
  }

  // sandbox.py:143,234 — image then `bash -c <command>`.
  args.push(opts.image, "bash", "-c", command);

  return args;
}

// ── sandbox_run — sandbox.py:74-179 ─────────────────────────────────────────
/**
 * Run `command` inside a Docker container with `workspace` bind-mounted rw.
 *
 * Faithful to sandbox.py:74-179. Captured stdout AND stderr are scrubbed for
 * credentials on BOTH the success path (sandbox.py:154-158) and the timeout
 * path (sandbox.py:174-179).
 *
 * @param spawn injectable seam (default: real spawnSync).
 */
export function sandboxRun(
  command: string,
  workspace: string,
  opts: {
    image?: string;
    timeout?: number; // SECONDS (Python default 300) — sandbox.py:79
    network?: boolean;
    env?: Record<string, string> | null;
    ports?: Record<number, number> | null;
    memory?: string;
    cpus?: number;
  } = {},
  spawn: SpawnSeam = defaultSpawn,
): SandboxResult {
  // sandbox.py:78-84 — defaults: image/aidlc-sandbox:latest, 300s, network on,
  // memory 2g, cpus 2.
  const image = opts.image ?? "aidlc-sandbox:latest";
  const timeoutSec = opts.timeout ?? 300;
  const network = opts.network ?? true;
  const memory = opts.memory ?? "2g";
  const cpus = opts.cpus ?? 2;

  // sandbox.py:111-143 — full docker run argv (foreground: leading `--rm`).
  const dockerCmd: string[] = [
    "docker",
    "run",
    "--rm",
    ...buildDockerRunArgs(command, workspace, {
      image,
      network,
      env: opts.env,
      ports: opts.ports,
      memory,
      cpus,
    }),
  ];

  // sandbox.py:148-153 — subprocess.run(capture_output, text, timeout).
  // Python's `timeout` is seconds; Node's is ms.
  const r = spawn(dockerCmd[0]!, dockerCmd.slice(1), {
    encoding: "utf-8",
    timeout: timeoutSec * 1000,
  });

  // sandbox.py:159 — TimeoutExpired branch. Node signals a timeout kill via
  // error.code === "ETIMEDOUT" (or a non-null signal with no exit status).
  const timedOut =
    (r.error && r.error.code === "ETIMEDOUT") ||
    (r.status === null && r.signal != null);

  if (timedOut) {
    // sandbox.py:160-179 — scrub whatever partial output was captured; null
    // exit code; timed_out=True.
    return {
      exitCode: null,
      stdout: scrubCredentials(r.stdout ?? ""),
      stderr: scrubCredentials(r.stderr ?? ""),
      timedOut: true,
    };
  }

  // sandbox.py:154-158 — success path: scrub both streams; carry exit code.
  return {
    exitCode: r.status,
    stdout: scrubCredentials(r.stdout ?? ""),
    stderr: scrubCredentials(r.stderr ?? ""),
    timedOut: false,
  };
}

// ── sandbox_run_detached — sandbox.py:182-246 ───────────────────────────────
/**
 * Start a detached Docker container and return its container ID.
 *
 * Used for long-running processes (e.g. the uvicorn server in contract tests)
 * that must stay alive while the test client runs on the host. The returned
 * stdout (the container ID) is NOT scrubbed (sandbox.py:246) — it is an opaque
 * docker identifier, not user output. Throws if the container fails to start
 * (sandbox.py:244-245).
 *
 * @param spawn injectable seam (default: real spawnSync).
 */
export function sandboxRunDetached(
  command: string,
  workspace: string,
  opts: {
    image?: string;
    network?: boolean;
    env?: Record<string, string> | null;
    ports?: Record<number, number> | null;
    memory?: string;
    cpus?: number;
  } = {},
  spawn: SpawnSeam = defaultSpawn,
): string {
  // sandbox.py:186-191 — defaults (NO timeout param; detached uses a fixed 30s).
  const image = opts.image ?? "aidlc-sandbox:latest";
  const network = opts.network ?? true;
  const memory = opts.memory ?? "2g";
  const cpus = opts.cpus ?? 2;

  // sandbox.py:201-234 — detached argv: leading `-d --rm`.
  const dockerCmd: string[] = [
    "docker",
    "run",
    "-d",
    "--rm",
    ...buildDockerRunArgs(command, workspace, {
      image,
      network,
      env: opts.env,
      ports: opts.ports,
      memory,
      cpus,
    }),
  ];

  // sandbox.py:238-243 — 30s timeout, capture_output, text.
  const r = spawn(dockerCmd[0]!, dockerCmd.slice(1), {
    encoding: "utf-8",
    timeout: 30_000,
  });

  // sandbox.py:244-245 — non-zero exit ⇒ RuntimeError with stripped stderr.
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    throw new Error(`Failed to start container: ${stderr}`);
  }

  // sandbox.py:246 — return stripped stdout (the container ID), unscrubbed.
  return (r.stdout ?? "").trim();
}

// ── sandbox_stop — sandbox.py:249-265 ───────────────────────────────────────
/**
 * Stop a running container by ID (graceful, then force-kill on failure).
 *
 * Faithful to sandbox.py:249-265: `docker stop -t <timeout> <id>` with a
 * `timeout+5`s subprocess deadline; on TimeoutExpired/OSError, fall back to
 * `docker kill <id>` (5s). Node surfaces a spawn timeout via error.code, so we
 * retry the kill when the stop spawn errors.
 *
 * @param timeoutSec graceful-stop seconds (Python default 10) — sandbox.py:249.
 * @param spawn injectable seam (default: real spawnSync).
 */
export function sandboxStop(
  containerId: string,
  timeoutSec = 10,
  spawn: SpawnSeam = defaultSpawn,
): void {
  // sandbox.py:251-257 — graceful stop, deadline = timeout+5 seconds.
  const r = spawn(
    "docker",
    ["stop", "-t", String(timeoutSec), containerId],
    { timeout: (timeoutSec + 5) * 1000 },
  );
  // sandbox.py:258-265 — TimeoutExpired/OSError ⇒ force kill.
  if (r.error) {
    spawn("docker", ["kill", containerId], { timeout: 5_000 });
  }
}

// ── sandbox_is_running — sandbox.py:268-280 ─────────────────────────────────
/**
 * Check whether a container is still running.
 *
 * Faithful to sandbox.py:268-280: `docker inspect -f {{.State.Running}} <id>`
 * (5s); true iff exit 0 AND stripped stdout == "true". TimeoutExpired/OSError
 * ⇒ false.
 *
 * @param spawn injectable seam (default: real spawnSync).
 */
export function sandboxIsRunning(
  containerId: string,
  spawn: SpawnSeam = defaultSpawn,
): boolean {
  const r = spawn(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", containerId],
    { encoding: "utf-8", timeout: 5_000 },
  );
  // sandbox.py:279-280 — any error (timeout/OS) ⇒ false.
  if (r.error) return false;
  // sandbox.py:278 — exit 0 AND stdout.strip() == "true".
  return r.status === 0 && (r.stdout ?? "").trim() === "true";
}

// ── sandbox_logs — sandbox.py:283-295 ───────────────────────────────────────
/**
 * Return [stdout, stderr] from a running or stopped container.
 *
 * Faithful to sandbox.py:283-295: `docker logs <id>` (10s); returns the raw
 * (UNscrubbed) captured streams. TimeoutExpired/OSError ⇒ ["", ""].
 *
 * @param spawn injectable seam (default: real spawnSync).
 */
export function sandboxLogs(
  containerId: string,
  spawn: SpawnSeam = defaultSpawn,
): [string, string] {
  const r = spawn("docker", ["logs", containerId], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  // sandbox.py:294-295 — any error ⇒ ("", "").
  if (r.error) return ["", ""];
  // sandbox.py:293 — return (stdout, stderr) as-is (no scrubbing here).
  return [r.stdout ?? "", r.stderr ?? ""];
}
