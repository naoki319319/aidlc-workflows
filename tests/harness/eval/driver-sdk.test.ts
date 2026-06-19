// driver-sdk.test.ts — PURE tests for driver-sdk.ts (claude_code.py port).
//
// Covers ONLY the deterministic helpers (DETERMINISM→tool): renderV2Prompt
// (prompt_template.py:118-135), deriveIntent (claude_code.py:86-100), matchAnswer
// (claude_code.py:269-285), isWorkflowComplete (claude_code.py:160-170), and
// findAidlcDocs (claude_code.py:103-113). The live SDK query()/canUseTool loop is
// the KNOWLEDGE→LLM concern — it is gated behind { live: true } / an injected drive
// seam and is NEVER exercised here (no model call, no query()). Every expectation
// was confirmed against the cited Python before being written.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInitialPrompt,
  deriveIntent,
  driveAidlcRun,
  findAidlcDocs,
  isWorkflowComplete,
  matchAnswer,
  renderV2Prompt,
  setupWorkspace,
} from "./driver-sdk.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "driver-sdk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── renderV2Prompt (prompt_template.py:118-135) ──────────────────────────────

test("renderV2Prompt appends --test-run when testRun is true", () => {
  expect(renderV2Prompt("Foo", "mvp", true)).toBe("/aidlc Foo --scope mvp --test-run");
});

test("renderV2Prompt omits --test-run when testRun is false", () => {
  expect(renderV2Prompt("Foo", "mvp", false)).toBe("/aidlc Foo --scope mvp");
});

test("renderV2Prompt strips the intent (prompt_template.py:131 intent.strip())", () => {
  expect(renderV2Prompt("  Build a calculator  ", "poc", true)).toBe(
    "/aidlc Build a calculator --scope poc --test-run",
  );
});

// ── deriveIntent (claude_code.py:86-100) ─────────────────────────────────────

test("deriveIntent uses the first H1 title when present", () => {
  const vision = "Some preamble\n\n# Scientific Calculator\n\nMore text.";
  expect(deriveIntent(vision)).toBe("Scientific Calculator");
});

test("deriveIntent falls back to the first non-empty line when no H1", () => {
  const vision = "\n\n   \nBuild a todo app\nsecond line";
  expect(deriveIntent(vision)).toBe("Build a todo app");
});

test("deriveIntent returns the default sentence for empty/whitespace vision", () => {
  expect(deriveIntent("\n   \n\t\n")).toBe("Build the project described in vision.md");
});

// ── matchAnswer (claude_code.py:269-285) ─────────────────────────────────────

test("matchAnswer: no options → the raw response (claude_code.py:273-274)", () => {
  expect(matchAnswer({ question: "free text?" }, "Use FastAPI everywhere")).toBe(
    "Use FastAPI everywhere",
  );
});

test("matchAnswer: first option whose label is a case-insensitive substring (claude_code.py:276-283)", () => {
  const q = { question: "kind?", options: [{ label: "Greenfield" }, { label: "Brownfield" }] };
  // response contains "brownfield" (lower-cased) → matches the second option.
  expect(matchAnswer(q, "This looks like a brownfield project")).toBe("Brownfield");
});

test("matchAnswer: no substring match → options[0].label (claude_code.py:284)", () => {
  const q = { question: "kind?", options: [{ label: "Greenfield" }, { label: "Brownfield" }] };
  expect(matchAnswer(q, "I cannot tell")).toBe("Greenfield");
});

test("matchAnswer: first-match-wins when several labels appear in the response", () => {
  // Python next(...) takes the FIRST option (in declaration order) whose label is
  // present — even if a later option's label also appears.
  const q = { question: "scope?", options: [{ label: "mvp" }, { label: "poc" }] };
  expect(matchAnswer(q, "go with poc not mvp")).toBe("mvp");
});

// ── isWorkflowComplete (claude_code.py:160-170) ──────────────────────────────

const COMPLETED_STATE = "# State\n\n- **Status**: Completed\n- **Next Stage**: None\n";
const IN_PROGRESS_STATE = "# State\n\n- **Status**: In Progress\n";

test("isWorkflowComplete: Status Completed AND a .py file present → true", () => {
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
  expect(isWorkflowComplete(COMPLETED_STATE, dir)).toBe(true);
});

test("isWorkflowComplete: Status Completed but no .py file → false (claude_code.py:170)", () => {
  writeFileSync(join(dir, "README.md"), "# docs\n");
  expect(isWorkflowComplete(COMPLETED_STATE, dir)).toBe(false);
});

test("isWorkflowComplete: a .py file present but Status not Completed → false", () => {
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
  expect(isWorkflowComplete(IN_PROGRESS_STATE, dir)).toBe(false);
});

test("isWorkflowComplete: undefined state (no aidlc-state.md) → false", () => {
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
  expect(isWorkflowComplete(undefined, dir)).toBe(false);
});

test("isWorkflowComplete: a .py file only under a skipped dir (.venv) → false (claude_code.py:168)", () => {
  mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
  writeFileSync(join(dir, ".venv", "lib", "vendored.py"), "x = 1\n");
  expect(isWorkflowComplete(COMPLETED_STATE, dir)).toBe(false);
});

// ── findAidlcDocs (claude_code.py:103-113) ───────────────────────────────────

test("findAidlcDocs: workspace/aidlc-docs with a .md → that dir (claude_code.py:105-106)", () => {
  const docs = join(dir, "aidlc-docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "requirements.md"), "# reqs\n");
  expect(findAidlcDocs(dir)).toBe(docs);
});

test("findAidlcDocs: nested child dir's aidlc-docs when the root has none (claude_code.py:108-112)", () => {
  // workspace/aidlc-docs exists but is EMPTY (no *.md) → fall through to the child.
  mkdirSync(join(dir, "aidlc-docs"), { recursive: true });
  const childDocs = join(dir, "myproject", "aidlc-docs");
  mkdirSync(childDocs, { recursive: true });
  writeFileSync(join(childDocs, "design.md"), "# design\n");
  expect(findAidlcDocs(dir)).toBe(childDocs);
});

test("findAidlcDocs: skips dot-prefixed child dirs (claude_code.py:109)", () => {
  // A .hidden/aidlc-docs/*.md must NOT be selected (child loop skips dot dirs).
  const hidden = join(dir, ".hidden", "aidlc-docs");
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(hidden, "x.md"), "# x\n");
  expect(findAidlcDocs(dir)).toBeNull();
});

test("findAidlcDocs: no aidlc-docs anywhere → null (claude_code.py:113)", () => {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.py"), "x = 1\n");
  expect(findAidlcDocs(dir)).toBeNull();
});

// ── driveAidlcRun via an INJECTED drive seam (no live model) ─────────────────
// Proves the gated assembly without spending tokens: setup → fake drive → extract.
// Also pins the token-telemetry contract the live path must satisfy:
// total_tokens == input + output (claude_code.py:442), NOT input+output+cache —
// the field the baseline compares. (The regression this guards: a live run that
// folded 40M cache tokens into total_tokens, false-flagging a ~48000% blowup.)

test("driveAidlcRun: gated — throws without { live } or an injected drive seam", async () => {
  // A real (minimal) dist so setupWorkspace succeeds and we reach the GATE check —
  // the throw must be the gate, not a missing-dist ENOENT.
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "settings.json"), "{}\n");
  writeFileSync(join(dir, "vision.md"), "# Calc API\n");
  await expect(
    driveAidlcRun({
      visionPath: join(dir, "vision.md"),
      outputDir: join(dir, "out"),
      distClaudePath: dist,
    }),
  ).rejects.toThrow(/gated/);
});

test("driveAidlcRun: injected drive seam runs the assembly + threads telemetry (no model)", async () => {
  // A minimal dist tree to copy into workspace/.claude.
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "settings.json"), "{}\n");
  writeFileSync(join(dir, "vision.md"), "# Calc API\n\nBuild a calculator.\n");

  const out = join(dir, "out");
  // The fake drive: instead of the SDK, write the artifacts a completed run would
  // leave, and return telemetry with total_tokens == input + output (the contract).
  const input = 19556;
  const output = 183370;
  const result = await driveAidlcRun({
    visionPath: join(dir, "vision.md"),
    outputDir: out,
    distClaudePath: dist,
    drive: async ({ workspace }) => {
      // a generated source file (so isWorkflowComplete-style code exists) + docs
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "main.py"), "x = 1\n");
      mkdirSync(join(workspace, "aidlc-docs", "inception"), { recursive: true });
      writeFileSync(join(workspace, "aidlc-docs", "inception", "reqs.md"), "# Reqs\n");
      return {
        tokenUsage: {
          input_tokens: input,
          output_tokens: output,
          // The live path sets this EXACTLY to input + output (claude_code.py:442);
          // cache is carried separately and is NOT compared by the baseline.
          total_tokens: input + output,
          cache_read_tokens: 40_380_341,
          cache_write_tokens: 741_925,
          num_turns: 315,
          model: "opus[1m]",
        },
        finalSubtype: "success",
      };
    },
  });

  // Workspace was set up; vision was stripped after extract (orchestrator.py:56-65).
  expect(result.workspaceDir).toBe(join(out, "workspace"));
  expect(result.aidlcDocsDir).toBe(join(out, "aidlc-docs"));
  expect(result.success).toBe(true);
  expect(result.finalSubtype).toBe("success");
  // The contract: total_tokens is input+output, NOT inflated by cache.
  expect(result.tokenUsage?.total_tokens).toBe(input + output);
  expect(result.tokenUsage?.total_tokens).not.toBe(input + output + 40_380_341 + 741_925);
});

// ── buildInitialPrompt — tech-env binding (claude_code.py:218) ────────────────
// Pins the bound-prompt construction (driver-sdk.ts:186-201). The
// TECH_ENV_BINDING_DIRECTIVE is module-private (not exported), so its presence is
// asserted via observable substrings of the returned prompt — confirmed against the
// on-disk const text (driver-sdk.ts:171-175): it contains `tech-env.md`,
// `HARD PROHIBITIONS`, and `Do NOT Use`, and is joined with "\n\n" AFTER the leading
// `/aidlc …` slash command. The invariant in every path: the slash command stays the
// LEADING token (driver-sdk.ts:198 comment) so the conductor still parses it.

// Stable substrings of TECH_ENV_BINDING_DIRECTIVE (driver-sdk.ts:171-175).
const DIRECTIVE_FILE = "tech-env.md"; // :172 — READ `workspace/tech-env.md`
const DIRECTIVE_HARD = "HARD PROHIBITIONS"; // :174 — treat "Do NOT Use" as HARD PROHIBITIONS
const DIRECTIVE_DONOTUSE = "Do NOT Use"; // :173 — its "Do NOT Use" entries

test("buildInitialPrompt: bare prompt when bindTechEnv is false (no directive)", () => {
  // bindTechEnv off → the directive never appends, even with a tech-env present.
  const prompt = buildInitialPrompt({
    intent: "Foo",
    scope: "mvp",
    testRun: true,
    bindTechEnv: false,
    hasTechEnv: true,
  });
  expect(prompt).toBe("/aidlc Foo --scope mvp --test-run");
  expect(prompt).not.toContain(DIRECTIVE_FILE);
});

test("buildInitialPrompt: bare prompt when hasTechEnv is false even if bindTechEnv is true", () => {
  // The directive only appends when BOTH bindTechEnv AND hasTechEnv (driver-sdk.ts:199).
  const prompt = buildInitialPrompt({
    intent: "Foo",
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
    hasTechEnv: false,
  });
  expect(prompt).toBe("/aidlc Foo --scope mvp --test-run");
  expect(prompt).not.toContain(DIRECTIVE_HARD);
});

test("buildInitialPrompt: appends the directive when bindTechEnv AND hasTechEnv (driver-sdk.ts:199)", () => {
  const bare = "/aidlc Foo --scope mvp --test-run";
  const prompt = buildInitialPrompt({
    intent: "Foo",
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
    hasTechEnv: true,
  });
  // The slash command stays the LEADING token — the core invariant.
  expect(prompt.startsWith(bare)).toBe(true);
  // The directive's stable substrings are present (confirmed against driver-sdk.ts:171-175).
  expect(prompt).toContain(DIRECTIVE_FILE);
  expect(prompt).toContain(DIRECTIVE_HARD);
  expect(prompt).toContain(DIRECTIVE_DONOTUSE);
  // The join is exactly "\n\n" between the bare command and the directive.
  expect(prompt.startsWith(`${bare}\n\n`)).toBe(true);
  // And nothing precedes the slash command (no prefix sneaks in).
  expect(prompt.indexOf("/aidlc")).toBe(0);
});

test("buildInitialPrompt: a non-empty promptTemplate wins verbatim (claude_code.py:218)", () => {
  // `config.prompt_template or render_v2_prompt(...)` — the override is returned as-is,
  // regardless of bindTechEnv/hasTechEnv, and does NOT get `/aidlc` prepended.
  const template = "Do exactly this custom thing, no slash command.";
  const prompt = buildInitialPrompt({
    intent: "Foo",
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
    hasTechEnv: true,
    promptTemplate: template,
  });
  expect(prompt).toBe(template);
  expect(prompt).not.toContain("/aidlc");
  expect(prompt).not.toContain(DIRECTIVE_FILE);
});

test('buildInitialPrompt: an empty-string promptTemplate ("") falls through to renderV2Prompt', () => {
  // The guard is `args.promptTemplate && args.promptTemplate.length > 0` (driver-sdk.ts:195),
  // so an empty string is falsy-skipped → the renderV2Prompt + binding path still runs.
  const prompt = buildInitialPrompt({
    intent: "Foo",
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
    hasTechEnv: true,
    promptTemplate: "",
  });
  expect(prompt).not.toBe("");
  expect(prompt.startsWith("/aidlc Foo --scope mvp --test-run\n\n")).toBe(true);
  expect(prompt).toContain(DIRECTIVE_HARD);
});

// ── setupWorkspace — directive gated on a REAL tech-env + binding on ───────────
// Integration over the composed `prompt` (driver-sdk.ts:311-369). hasTechEnv is
// derived from the same isFile check the copy uses (driver-sdk.ts:334), so the
// directive appears only when a tech-env.md was actually copied. Mirrors the
// injected-drive-seam test's minimal dist + vision setup.

test("setupWorkspace: directive present only with a real tech-env AND bindTechEnv true", () => {
  // Minimal dist tree to copy into workspace/.claude (claude_code.py:198-202).
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "settings.json"), "{}\n");
  const visionPath = join(dir, "vision.md");
  writeFileSync(visionPath, "# Foo\n\nBuild a thing.\n");
  const techEnvPath = join(dir, "tech-env.md");
  writeFileSync(techEnvPath, "# Tech env\n\nUse FastAPI.\n");

  // (a) real tech-env + binding ON → directive appended, slash command still leading.
  const bound = setupWorkspace({
    visionPath,
    techEnvPath,
    outputDir: join(dir, "out-bound"),
    distClaudePath: dist,
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
  });
  expect(bound.intent).toBe("Foo"); // first H1 (deriveIntent)
  expect(bound.prompt.startsWith("/aidlc Foo --scope mvp --test-run")).toBe(true);
  expect(bound.prompt).toContain(DIRECTIVE_FILE);
  expect(bound.prompt).toContain(DIRECTIVE_HARD);

  // (b) real tech-env but binding OMITTED → bare-faithful default (driver-sdk.ts:364), no directive.
  const omitted = setupWorkspace({
    visionPath,
    techEnvPath,
    outputDir: join(dir, "out-omitted"),
    distClaudePath: dist,
    scope: "mvp",
    testRun: true,
  });
  expect(omitted.prompt).toBe("/aidlc Foo --scope mvp --test-run");
  expect(omitted.prompt).not.toContain(DIRECTIVE_FILE);

  // (b') real tech-env but bindTechEnv explicitly false → also bare.
  const off = setupWorkspace({
    visionPath,
    techEnvPath,
    outputDir: join(dir, "out-off"),
    distClaudePath: dist,
    scope: "mvp",
    testRun: true,
    bindTechEnv: false,
  });
  expect(off.prompt).toBe("/aidlc Foo --scope mvp --test-run");

  // (c) NO techEnvPath but bindTechEnv true → hasTechEnv false (nothing copied) → bare.
  const noTechEnv = setupWorkspace({
    visionPath,
    outputDir: join(dir, "out-no-techenv"),
    distClaudePath: dist,
    scope: "mvp",
    testRun: true,
    bindTechEnv: true,
  });
  expect(noTechEnv.prompt).toBe("/aidlc Foo --scope mvp --test-run");
  expect(noTechEnv.prompt).not.toContain(DIRECTIVE_FILE);
});

// ── driveAidlcRun threads bindTechEnv → setupWorkspace → buildInitialPrompt ────
// End-to-end via the injected drive seam (no model): capture args.initialPrompt and
// assert it carries the directive. Proves bindTechEnv flows all the way through.

test("driveAidlcRun: injected seam receives an initialPrompt bound with the directive", async () => {
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "settings.json"), "{}\n");
  const visionPath = join(dir, "vision.md");
  writeFileSync(visionPath, "# Foo\n\nBuild a thing.\n");
  const techEnvPath = join(dir, "tech-env.md");
  writeFileSync(techEnvPath, "# Tech env\n\nUse FastAPI.\n");

  let captured = "";
  await driveAidlcRun({
    visionPath,
    techEnvPath,
    outputDir: join(dir, "out"),
    distClaudePath: dist,
    bindTechEnv: true,
    drive: async ({ initialPrompt, workspace }) => {
      captured = initialPrompt;
      // Minimal completed-run artifacts so extract/assembly stays happy.
      mkdirSync(join(workspace, "aidlc-docs"), { recursive: true });
      writeFileSync(join(workspace, "aidlc-docs", "reqs.md"), "# Reqs\n");
      return {
        tokenUsage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          num_turns: 1,
          model: "opus[1m]",
        },
        finalSubtype: "success",
      };
    },
  });
  // The option threaded through to the prompt the seam was handed.
  expect(captured.startsWith("/aidlc Foo --scope mvp --test-run")).toBe(true);
  expect(captured).toContain(DIRECTIVE_FILE);
  expect(captured).toContain(DIRECTIVE_HARD);
});
