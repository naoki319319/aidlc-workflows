// trend-fetcher.ts — data retrieval via the gh CLI.
//
// Faithful 1:1 port of trend_reports/fetcher.py (read in full).
// Source-of-truth (read-only worktree):
//   .../evaluator/packages/trend-reports/src/trend_reports/fetcher.py
//
// GATED-NETWORK. Every function shells the `gh` CLI via `subprocess.run`
// (fetcher.py:18,30,46,79,143,165,255). To run the control-flow logic as PURE TS
// tests, every gh invocation goes through an injectable `GhRun` seam that defaults
// to a real `spawnSync('gh', ...)` but can be replaced by a stub. This mirrors the
// Python tests' `patch("trend_reports.fetcher.subprocess.run", ...)`: the stub
// receives the full argv (so the test can assert flags like `--branch`/`--event`)
// and returns a {stdout, stderr, returncode} record, or throws GhNotFound to
// simulate Python's `FileNotFoundError` (the gh-not-installed case, fetcher.py:26).
//
// The filesystem side (mkdir + glob for the downloaded zip) runs for real against
// a tmp dir, exactly as the Python tests do (they write real zips under tmp_path
// and assert the returned Path) — only the subprocess boundary is mocked.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FetchError } from "./trend-models.ts";

// ── injectable gh seam (mirror fetcher.py subprocess.run) ────────────────────

/** Result of a gh invocation, mirroring subprocess.run's CompletedProcess. */
export interface GhResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

/**
 * Thrown by a GhRun seam to simulate Python's `FileNotFoundError` when the `gh`
 * binary is absent (fetcher.py:26 catches FileNotFoundError → FetchError).
 */
export class GhNotFound extends Error {
  constructor(message = "gh") {
    super(message);
    this.name = "GhNotFound";
    Object.setPrototypeOf(this, GhNotFound.prototype);
  }
}

/** Runs a gh argv (argv[0] === "gh") and returns its result. */
export type GhRun = (argv: string[]) => GhResult;

/** Default seam: real `spawnSync(argv[0], argv[1:])` with captured output. */
export const defaultGhRun: GhRun = (argv: string[]): GhResult => {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // spawnSync sets r.error (ENOENT) when the binary is missing — mirror Python's
  // FileNotFoundError so check_gh_available's catch path behaves identically.
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new GhNotFound(argv[0]);
  }
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    // spawnSync: status is null when killed by signal; map to a nonzero rc so
    // failures register (Python's returncode is never None on a completed run).
    returncode: r.status ?? 1,
  };
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** List of report*.zip-style matches under a dir (one level, like Path.glob). */
function globZips(dir: string, prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // Path.glob("report*.zip") / glob("*.zip"): startswith(prefix) && endswith .zip,
  // sorted by name (Python glob order is arbitrary but tests write a single zip).
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".zip"))
    .sort()
    .map((n) => join(dir, n));
}

/** Recursive *.zip walk, mirroring Path.rglob("*.zip") (fetcher.py:275). */
function rglobZips(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...rglobZips(full));
    } else if (ent.isFile() && ent.name.endsWith(".zip")) {
      out.push(full);
    }
  }
  return out;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Verify the gh CLI is installed and authenticated. (fetcher.py:15-37)
 *
 * Two subprocess calls: `gh version` then `gh auth status`. A GhNotFound from
 * the first → FetchError "gh CLI not found" (Python catches FileNotFoundError,
 * :26-27). A nonzero version rc → "gh CLI returned an error". A nonzero auth rc
 * → "gh CLI not authenticated".
 */
export function checkGhAvailable(gh: GhRun = defaultGhRun): void {
  // fetcher.py:17-27 — gh version inside the FileNotFoundError try.
  let result: GhResult;
  try {
    result = gh(["gh", "version"]);
  } catch (e) {
    if (e instanceof GhNotFound) {
      throw new FetchError("gh CLI not found. Install from https://cli.github.com/");
    }
    throw e;
  }
  if (result.returncode !== 0) {
    throw new FetchError(`gh CLI returned an error: ${result.stderr.trim()}`);
  }

  // fetcher.py:30-37 — gh auth status (NOT inside the FileNotFoundError try).
  result = gh(["gh", "auth", "status"]);
  if (result.returncode !== 0) {
    throw new FetchError("gh CLI not authenticated. Run 'gh auth login' first.");
  }
}

/** A release entry from `gh release list --json tagName,publishedAt`. */
export interface ReleaseEntry {
  tagName: string;
  publishedAt?: string;
  [k: string]: unknown;
}

/**
 * Fetch the list of releases, sorted by publishedAt ascending. (fetcher.py:40-67)
 */
export function fetchReleaseList(repo: string, gh: GhRun = defaultGhRun): ReleaseEntry[] {
  const result = gh([
    "gh",
    "release",
    "list",
    "--repo",
    repo,
    "--json",
    "tagName,publishedAt",
    "--limit",
    "50",
  ]);
  if (result.returncode !== 0) {
    throw new FetchError(`Failed to list releases for ${repo}: ${result.stderr.trim()}`);
  }

  const releases = JSON.parse(result.stdout) as ReleaseEntry[];
  // releases.sort(key=lambda r: r.get("publishedAt", "")) — stable, ascending.
  releases.sort((a, b) => {
    const av = a.publishedAt ?? "";
    const bv = b.publishedAt ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return releases;
}

/**
 * Download the report zip for a single release tag. (fetcher.py:70-109)
 *
 * Returns the path to the downloaded zip, or null if the release has no matching
 * report*.zip asset. The 'no assets match' / 'no asset' substring on a LOWERCASED
 * stderr is a soft-skip (return null); any other nonzero rc is a hard FetchError.
 */
export function fetchReleaseBundle(
  repo: string,
  tag: string,
  destDir: string,
  gh: GhRun = defaultGhRun,
): string | null {
  const tagDir = join(destDir, tag);
  mkdirSync(tagDir, { recursive: true });

  const result = gh([
    "gh",
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "--pattern",
    "report*.zip",
    "--dir",
    tagDir,
  ]);
  if (result.returncode !== 0) {
    const stderr = result.stderr.trim();
    const lower = stderr.toLowerCase();
    // fetcher.py:98 — soft-skip on either substring (lowercased).
    if (lower.includes("no assets match") || lower.includes("no asset")) {
      return null;
    }
    throw new FetchError(`Failed to download report for ${tag}: ${stderr}`);
  }

  // fetcher.py:104 — Path(tag_dir).glob("report*.zip"); zips[0] or None.
  const zips = globZips(tagDir, "report");
  if (zips.length === 0) {
    return null;
  }
  return zips[0]!;
}

/** A workflow run from `gh run list --json ...`. */
export interface WorkflowRun {
  databaseId: number;
  headBranch?: string;
  conclusion?: string;
  event?: string;
  createdAt?: string;
  [k: string]: unknown;
}

/**
 * List recent successful workflow runs. (fetcher.py:112-148)
 *
 * Only runs with conclusion === "success" are returned (client-side filter,
 * :147-148). `branch`/`event` extend the argv when non-null.
 */
export function fetchWorkflowRuns(
  repo: string,
  opts: { branch?: string | null; event?: string | null; limit?: number } = {},
  gh: GhRun = defaultGhRun,
): WorkflowRun[] {
  const { branch = null, event = null, limit = 10 } = opts;
  const cmd = [
    "gh",
    "run",
    "list",
    "--repo",
    repo,
    "--status",
    "completed",
    "--json",
    "databaseId,headBranch,conclusion,event,createdAt",
    "--limit",
    String(limit),
  ];
  if (branch !== null && branch !== undefined) {
    cmd.push("--branch", branch);
  }
  if (event !== null && event !== undefined) {
    cmd.push("--event", event);
  }

  const result = gh(cmd);
  if (result.returncode !== 0) {
    throw new FetchError(`Failed to list workflow runs for ${repo}: ${result.stderr.trim()}`);
  }

  const runs = JSON.parse(result.stdout) as WorkflowRun[];
  return runs.filter((r) => r.conclusion === "success");
}

/**
 * Download a single artifact from a workflow run. (fetcher.py:151-202)
 *
 * Returns the path to the downloaded zip, or null if no matching artifact exists.
 * 'no artifact' / 'no valid' substring on LOWERCASED stderr → soft-skip (null);
 * any other nonzero rc → hard FetchError.
 */
export function fetchArtifactBundle(
  repo: string,
  runId: number,
  artifactName: string,
  destDir: string,
  gh: GhRun = defaultGhRun,
): string | null {
  const artifactDir = join(destDir, artifactName);
  mkdirSync(artifactDir, { recursive: true });

  const result = gh([
    "gh",
    "run",
    "download",
    String(runId),
    "--repo",
    repo,
    "--name",
    artifactName,
    "--dir",
    artifactDir,
  ]);
  if (result.returncode !== 0) {
    // fetcher.py:183 — stderr lowercased FIRST, then substring tested.
    const stderr = result.stderr.trim().toLowerCase();
    if (stderr.includes("no artifact") || stderr.includes("no valid")) {
      return null;
    }
    // fetcher.py:187-190 — error message uses the ORIGINAL (un-lowercased) stderr.
    throw new FetchError(
      `Failed to download artifact '${artifactName}' from run ${runId}: ${result.stderr.trim()}`,
    );
  }

  // fetcher.py:193 — artifact_dir.glob("*.zip"); zips[0] or None.
  const zips = globZips(artifactDir, "");
  if (zips.length === 0) {
    return null;
  }
  return zips[0]!;
}

/**
 * Fetch pre-release artifact bundles (main branch and PRs). (fetcher.py:205-280)
 *
 * NEVER raises on missing artifacts — pre-release data is optional. Phase A pulls
 * the latest main-branch artifact (first run that yields a zip, then break).
 * Phase B walks PR runs, dedups by headBranch via seen_branches (latest run per
 * branch), and shells `gh run download --pattern {prefix}pr*` directly.
 */
export function fetchPrereleaseBundles(
  repo: string,
  opts: { cachePrefix?: string; workDir?: string } = {},
  // Seams: gh boundary + the two intra-module helpers the Python tests patch
  // (`fetch_workflow_runs`, `fetch_artifact_bundle`) — fetcher.py tests mock
  // those module functions, not subprocess.run, for the prerelease tests.
  seams: {
    gh?: GhRun;
    fetchWorkflowRuns?: typeof fetchWorkflowRuns;
    fetchArtifactBundle?: typeof fetchArtifactBundle;
  } = {},
): string[] {
  const cachePrefix = opts.cachePrefix ?? "report-";
  let workDir = opts.workDir;
  if (workDir === undefined) {
    // fetcher.py:219-220 — tempfile.mkdtemp(prefix="trend-prerelease-").
    workDir = mkdtempSync(join(tmpdir(), "trend-prerelease-"));
  }
  const gh = seams.gh ?? defaultGhRun;
  const wfRuns = seams.fetchWorkflowRuns ?? fetchWorkflowRuns;
  const artifactBundle = seams.fetchArtifactBundle ?? fetchArtifactBundle;

  const zipPaths: string[] = [];

  // --- Phase A: main branch artifact --- (fetcher.py:224-239)
  try {
    const mainRuns = wfRuns(repo, { branch: "main", limit: 5 }, gh);
    if (mainRuns.length > 0) {
      const artifactName = `${cachePrefix}main`;
      for (const run of mainRuns) {
        const runId = run.databaseId as number;
        const zipPath = artifactBundle(repo, runId, artifactName, workDir, gh);
        if (zipPath !== null) {
          zipPaths.push(zipPath);
          break; // Only need the latest main artifact.
        }
      }
    }
    // else: no successful main-branch runs (no-op, matches the logger.info).
  } catch (exc) {
    // fetcher.py:238 — only FetchError is swallowed; re-raise anything else.
    if (!(exc instanceof FetchError)) throw exc;
  }

  // --- Phase B: PR artifacts --- (fetcher.py:242-278)
  try {
    const prRuns = wfRuns(repo, { event: "pull_request", limit: 20 }, gh);
    const seenBranches = new Set<string>();
    for (const run of prRuns) {
      const branch = (run.headBranch ?? "") as string;
      if (seenBranches.has(branch)) {
        continue; // Only the latest run per branch.
      }
      seenBranches.add(branch);

      const runId = run.databaseId as number;
      const artifactDir = join(workDir, `pr-run-${runId}`);
      mkdirSync(artifactDir, { recursive: true });

      const result = gh([
        "gh",
        "run",
        "download",
        String(runId),
        "--repo",
        repo,
        "--pattern",
        `${cachePrefix}pr*`,
        "--dir",
        artifactDir,
      ]);
      if (result.returncode !== 0) {
        continue; // No PR artifacts in this run.
      }

      for (const zp of rglobZips(artifactDir)) {
        zipPaths.push(zp);
      }
    }
  } catch (exc) {
    if (!(exc instanceof FetchError)) throw exc;
  }

  return zipPaths;
}

/**
 * Fetch report zips for all (or specified) releases. (fetcher.py:283-317)
 *
 * If tags is null/undefined, all releases are fetched. Returns a list of zip
 * paths (releases without a report asset are silently skipped). Raises a
 * FetchError when NO bundles are found (:312-315).
 */
export function fetchReleaseBundles(
  repo: string,
  opts: { tags?: string[] | null; workDir?: string } = {},
  // Seams: gh boundary + the two intra-module helpers the Python tests patch
  // (`fetch_release_list`, `fetch_release_bundle`).
  seams: {
    gh?: GhRun;
    fetchReleaseList?: typeof fetchReleaseList;
    fetchReleaseBundle?: typeof fetchReleaseBundle;
  } = {},
): string[] {
  const tags = opts.tags ?? null;
  let workDir = opts.workDir;
  if (workDir === undefined) {
    // fetcher.py:295-296 — tempfile.mkdtemp(prefix="trend-report-").
    workDir = mkdtempSync(join(tmpdir(), "trend-report-"));
  }
  const gh = seams.gh ?? defaultGhRun;
  const releaseList = seams.fetchReleaseList ?? fetchReleaseList;
  const releaseBundle = seams.fetchReleaseBundle ?? fetchReleaseBundle;

  let releases = releaseList(repo, gh);

  if (tags !== null && tags !== undefined) {
    const tagSet = new Set(tags);
    releases = releases.filter((r) => tagSet.has(r.tagName));
  }

  const zipPaths: string[] = [];
  for (const release of releases) {
    const tag = release.tagName;
    const zipPath = releaseBundle(repo, tag, workDir, gh);
    if (zipPath !== null) {
      zipPaths.push(zipPath);
    }
  }

  if (zipPaths.length === 0) {
    throw new FetchError(
      `No report bundles found for ${repo}. Ensure releases have report*.zip assets.`,
    );
  }

  return zipPaths;
}
