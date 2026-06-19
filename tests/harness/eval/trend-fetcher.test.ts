// trend-fetcher.test.ts — 1:1 mirror of trend_reports/tests/test_fetcher.py (24).
//
// Source-of-truth:
//   .../evaluator/packages/trend-reports/tests/test_fetcher.py
//
// Every Python test mocks `trend_reports.fetcher.subprocess.run`. Here that mock
// is the injectable `GhRun` seam: each test passes a stub `gh(argv)` returning a
// {stdout, stderr, returncode} record (or throwing GhNotFound for the
// FileNotFoundError case). The prerelease/release-bundle tests additionally patch
// the intra-module helpers (`fetch_workflow_runs`/`fetch_artifact_bundle`/
// `fetch_release_list`/`fetch_release_bundle`) via the `seams` object, exactly as
// the Python tests `patch("trend_reports.fetcher.fetch_*")`. All 24 run PURE.
//
// Python `_mock_run(stdout, stderr, returncode)` → makeGhResult below. Python
// side_effect lists (sequence of results) → a small queue stub (seqGh).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkGhAvailable,
  fetchReleaseList,
  fetchReleaseBundle,
  fetchWorkflowRuns,
  fetchArtifactBundle,
  fetchPrereleaseBundles,
  fetchReleaseBundles,
  GhNotFound,
  type GhResult,
  type GhRun,
} from "./trend-fetcher.ts";
import { FetchError } from "./trend-models.ts";

// _mock_run(stdout="", stderr="", returncode=0). (test_fetcher.py:24-29)
function makeGhResult(over: Partial<GhResult> = {}): GhResult {
  return { stdout: over.stdout ?? "", stderr: over.stderr ?? "", returncode: over.returncode ?? 0 };
}

// return_value=...: same result every call. (the common case)
function constGh(result: GhResult, sink?: { calls: string[][] }): GhRun {
  return (argv: string[]) => {
    if (sink) sink.calls.push(argv);
    return result;
  };
}

// side_effect=[r1, r2, ...] OR side_effect=Error: a queue stub. A function entry
// is invoked (lets us throw GhNotFound to simulate FileNotFoundError).
function seqGh(items: Array<GhResult | (() => GhResult)>): GhRun {
  let i = 0;
  return (_argv: string[]) => {
    const item = items[i++];
    if (item === undefined) throw new Error("seqGh exhausted");
    return typeof item === "function" ? item() : item;
  };
}

// tmp dir lifecycle (Python's tmp_path fixture).
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "trend-fetcher-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestCheckGhAvailable (test_fetcher.py:32-68)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestCheckGhAvailable", () => {
  it("test_gh_not_installed", () => {
    // side_effect=FileNotFoundError → throw GhNotFound from the seam.
    const gh: GhRun = () => {
      throw new GhNotFound();
    };
    expect(() => checkGhAvailable(gh)).toThrow(FetchError);
    expect(() => checkGhAvailable(gh)).toThrow(/gh CLI not found/);
  });

  it("test_gh_version_error", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "some error" }));
    expect(() => checkGhAvailable(gh)).toThrow(/gh CLI returned an error/);
  });

  it("test_gh_not_authenticated", () => {
    // [version succeeds, auth fails]
    const gh = seqGh([
      makeGhResult({ returncode: 0 }),
      makeGhResult({ returncode: 1, stderr: "not logged in" }),
    ]);
    expect(() => checkGhAvailable(gh)).toThrow(/not authenticated/);
  });

  it("test_success", () => {
    const gh = seqGh([makeGhResult({ returncode: 0 }), makeGhResult({ returncode: 0 })]);
    expect(() => checkGhAvailable(gh)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchReleaseList (test_fetcher.py:71-100)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchReleaseList", () => {
  it("test_success", () => {
    const releases = [
      { tagName: "v0.1.1", publishedAt: "2026-02-01" },
      { tagName: "v0.1.0", publishedAt: "2026-01-01" },
    ];
    const gh = constGh(makeGhResult({ stdout: JSON.stringify(releases) }));
    const result = fetchReleaseList("owner/repo", gh);
    // Sorted by publishedAt ascending.
    expect(result[0]!.tagName).toBe("v0.1.0");
    expect(result[1]!.tagName).toBe("v0.1.1");
  });

  it("test_error_raises", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "API error" }));
    expect(() => fetchReleaseList("owner/repo", gh)).toThrow(/Failed to list releases/);
  });

  it("test_empty_list", () => {
    const gh = constGh(makeGhResult({ stdout: "[]" }));
    const result = fetchReleaseList("owner/repo", gh);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchReleaseBundle (test_fetcher.py:103-139)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchReleaseBundle", () => {
  it("test_success", () => {
    const tagDir = join(tmp, "v0.1.0");
    mkdirSync(tagDir);
    writeFileSync(join(tagDir, "report-v0.1.0.zip"), "fake");

    const gh = constGh(makeGhResult({ returncode: 0 }));
    const result = fetchReleaseBundle("owner/repo", "v0.1.0", tmp, gh);
    expect(result).not.toBeNull();
    expect(result!.split("/").pop()).toBe("report-v0.1.0.zip");
  });

  it("test_no_assets_match", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "no assets match the pattern" }));
    const result = fetchReleaseBundle("owner/repo", "v0.1.0", tmp, gh);
    expect(result).toBeNull();
  });

  it("test_no_zip_on_disk", () => {
    // download succeeds (rc 0) but no zip was placed on disk → None.
    const gh = constGh(makeGhResult({ returncode: 0 }));
    const result = fetchReleaseBundle("owner/repo", "v0.1.0", tmp, gh);
    expect(result).toBeNull();
  });

  it("test_other_error_raises", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "network timeout" }));
    expect(() => fetchReleaseBundle("owner/repo", "v0.1.0", tmp, gh)).toThrow(
      /Failed to download report/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchWorkflowRuns (test_fetcher.py:142-183)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchWorkflowRuns", () => {
  it("test_success_filters_non_success", () => {
    const runs = [
      { databaseId: 1, conclusion: "success", headBranch: "main" },
      { databaseId: 2, conclusion: "failure", headBranch: "main" },
      { databaseId: 3, conclusion: "success", headBranch: "main" },
    ];
    const gh = constGh(makeGhResult({ stdout: JSON.stringify(runs) }));
    const result = fetchWorkflowRuns("owner/repo", {}, gh);
    expect(result.length).toBe(2);
    expect(result.every((r) => r.conclusion === "success")).toBe(true);
  });

  it("test_with_branch_filter", () => {
    const sink = { calls: [] as string[][] };
    const gh = constGh(makeGhResult({ stdout: "[]" }), sink);
    fetchWorkflowRuns("owner/repo", { branch: "main" }, gh);
    const cmd = sink.calls[0]!;
    expect(cmd).toContain("--branch");
    expect(cmd).toContain("main");
  });

  it("test_with_event_filter", () => {
    const sink = { calls: [] as string[][] };
    const gh = constGh(makeGhResult({ stdout: "[]" }), sink);
    fetchWorkflowRuns("owner/repo", { event: "pull_request" }, gh);
    const cmd = sink.calls[0]!;
    expect(cmd).toContain("--event");
    expect(cmd).toContain("pull_request");
  });

  it("test_error_raises", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "API error" }));
    expect(() => fetchWorkflowRuns("owner/repo", {}, gh)).toThrow(/Failed to list workflow runs/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchArtifactBundle (test_fetcher.py:186-222)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchArtifactBundle", () => {
  it("test_success", () => {
    const artifactDir = join(tmp, "report-main");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "report-main.zip"), "fake");

    const gh = constGh(makeGhResult({ returncode: 0 }));
    const result = fetchArtifactBundle("owner/repo", 123, "report-main", tmp, gh);
    expect(result).not.toBeNull();
    expect(result!.split("/").pop()).toBe("report-main.zip");
  });

  it("test_no_artifact", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "no artifact found" }));
    const result = fetchArtifactBundle("owner/repo", 123, "report-main", tmp, gh);
    expect(result).toBeNull();
  });

  it("test_no_zip_in_download", () => {
    const gh = constGh(makeGhResult({ returncode: 0 }));
    const result = fetchArtifactBundle("owner/repo", 123, "report-main", tmp, gh);
    expect(result).toBeNull();
  });

  it("test_other_error_raises", () => {
    const gh = constGh(makeGhResult({ returncode: 1, stderr: "server error" }));
    expect(() => fetchArtifactBundle("owner/repo", 123, "report-main", tmp, gh)).toThrow(
      /Failed to download artifact/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchPrereleaseBundles (test_fetcher.py:225-262)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchPrereleaseBundles", () => {
  it("test_no_runs_returns_empty", () => {
    // patch fetch_workflow_runs → [] (both phase A and B).
    const result = fetchPrereleaseBundles(
      "owner/repo",
      { workDir: tmp },
      { fetchWorkflowRuns: () => [] },
    );
    expect(result).toEqual([]);
  });

  it("test_fetch_error_returns_empty", () => {
    // patch fetch_workflow_runs → raises FetchError; swallowed → [].
    const result = fetchPrereleaseBundles(
      "owner/repo",
      { workDir: tmp },
      {
        fetchWorkflowRuns: () => {
          throw new FetchError("fail");
        },
      },
    );
    expect(result).toEqual([]);
  });

  it("test_main_artifact_found", () => {
    const mainZipDir = join(tmp, "report-main");
    mkdirSync(mainZipDir, { recursive: true });
    const mainZip = join(mainZipDir, "report-main.zip");
    writeFileSync(mainZip, "fake");

    // fetch_workflow_runs side_effect=[[main runs], []]; fetch_artifact_bundle → main_zip.
    const result = fetchPrereleaseBundles(
      "owner/repo",
      { workDir: tmp },
      {
        fetchWorkflowRuns: seqWorkflowRuns([
          [{ databaseId: 1, headBranch: "main" }],
          [],
        ]),
        fetchArtifactBundle: () => mainZip,
      },
    );
    expect(result.length).toBe(1);
    expect(result[0]).toBe(mainZip);
  });
});

// Helper: a side_effect-list stand-in for fetch_workflow_runs.
function seqWorkflowRuns(
  items: Array<Array<{ databaseId: number; headBranch?: string; [k: string]: unknown }>>,
): typeof fetchWorkflowRuns {
  let i = 0;
  return (() => {
    const item = items[i++];
    if (item === undefined) throw new Error("seqWorkflowRuns exhausted");
    return item;
  }) as unknown as typeof fetchWorkflowRuns;
}

// ─────────────────────────────────────────────────────────────────────────────
// TestFetchReleaseBundles (test_fetcher.py:265-293)
// ─────────────────────────────────────────────────────────────────────────────
describe("TestFetchReleaseBundles", () => {
  it("test_no_bundles_raises", () => {
    // fetch_release_list → 1 release; fetch_release_bundle → None → no bundles.
    expect(() =>
      fetchReleaseBundles(
        "owner/repo",
        { workDir: tmp },
        {
          fetchReleaseList: () => [{ tagName: "v0.1.0", publishedAt: "2026-01-01" }],
          fetchReleaseBundle: () => null,
        },
      ),
    ).toThrow(/No report bundles found/);
  });

  it("test_specific_tags_filter", () => {
    const fakeZip = join(tmp, "report.zip");
    writeFileSync(fakeZip, "fake");

    const result = fetchReleaseBundles(
      "owner/repo",
      { tags: ["v0.1.1"], workDir: tmp },
      {
        fetchReleaseList: () => [
          { tagName: "v0.1.0", publishedAt: "2026-01-01" },
          { tagName: "v0.1.1", publishedAt: "2026-02-01" },
        ],
        fetchReleaseBundle: () => fakeZip,
      },
    );
    expect(result.length).toBe(1);
  });
});
