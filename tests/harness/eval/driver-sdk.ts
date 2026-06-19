// driver-sdk.ts — the PRODUCER (Claude SDK transport).
//
// FAITHFUL port of the claude-code adapter's v2 /aidlc path (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/cli-harness/src/cli_harness/adapters/claude_code.py
//   (claude_code.py:148-493 — the v2 agentic path; the v1 legacy monolith at
//    :224-237 is OUT of scope, claude_dist_path is always set here)
// PLUS render_v2_prompt (prompt_template.py:118-135), _find_aidlc_docs and the
// run-folder strip (orchestrator.py:56-65 _WORKSPACE_INPUT_FILES/_DIRS), and the
// AdapterResult shape (adapter.py:41-52).
//
// TRANSPORT REUSE (not a rewrite): this REPLICATES sdk-drive.ts's query()/canUseTool
// loop (sdk-drive.ts:459-668) with two producer-specific deltas the exported
// driveAidlc does NOT expose:
//   (a) the AskUserQuestion answer comes from human-analog.ts (DYNAMIC, model-driven)
//       rather than a static AnswerScript (claude_code.py:246-286);
//   (b) maxTurns is high (Python uses 500, claude_code.py:293) with an optional
//       BOUNDED between-turns resume loop (claude_code.py:316-420).
// We REUSE sdk-drive's EXPORTED helpers (resolveDriveSdkSettings for model/env,
// readStateFile, readStateField) — the tracked harness file
// is NOT edited. driveAidlc itself is single-shot from a static script, so it is
// unsuitable; we lift its proven machinery, not call it.
//
// THREE CONCERNS: the workspace setup / extract / completion checks are
// DETERMINISTIC (tool) and pure-testable (deriveIntent, renderV2Prompt, matchAnswer,
// findAidlcDocs, isWorkflowComplete are exported separately so no test touches the
// model). The model-driven gate answers (human-analog) are the KNOWLEDGE→LLM
// concern and sit behind opts.live / the injectable drive seam — the live SDK
// call NEVER runs in a default test.
//
// DETERMINISM: elapsedSeconds is measured with performance.now() (allowed — it is a
// monotonic counter, not Date/Date.now, mirroring time.monotonic() at
// claude_code.py:181,422). The injected generatedAt timestamp flows in run.ts.

import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  resolveDriveSdkSettings,
  readStateFile,
  readStateField,
} from "../sdk-drive.ts";
import { generateHumanResponse } from "./human-analog.ts";
import type { TokenUsage } from "./normalizer.ts";

// _WORKSPACE_INPUT_FILES / _WORKSPACE_INPUT_DIRS (orchestrator.py:22-23) — input
// scaffolding that adapters copy into the workspace for the CLI tool to read;
// stripped after the run so the workspace holds only generated code.
const WORKSPACE_INPUT_FILES = ["vision.md", "tech-env.md"];
const WORKSPACE_INPUT_DIRS = ["aidlc-rules", ".kiro"];

// claude_code.py:52 — completion is signalled by Status: Completed. The shipped
// state line shape is `- **Status**: Completed` (sdk-drive readStateField reads it).
const STATE_STATUS_COMPLETED_RE = /^- \*\*Status\*\*:[ \t]*Completed\s*$/m;

// claude_code.py:160-170 — source-file extensions skipped from the "code exists"
// check belong to vendor/cache/framework dirs, not to the generated project.
const SOURCE_SKIP_DIRS = [".venv", "__pycache__", ".cache", ".claude"];

// ── DriverResult — mirrors AdapterResult (adapter.py:41-52) + token telemetry ──
export interface DriverResult {
  outputDir: string;
  workspaceDir: string;
  /** null when _find_aidlc_docs found nothing (claude_code.py:430-436). */
  aidlcDocsDir: string | null;
  /** The token_usage dict the normalizer consumes (claude_code.py:439-447). */
  tokenUsage: TokenUsage | null;
  elapsedSeconds: number;
  /** The SDK result event subtype ("success"/error subtype) (claude_code.py:338). */
  finalSubtype: string;
  /** success == subtype "success" AND aidlc-docs produced (claude_code.py:457). */
  success: boolean;
}

export interface DriveAidlcRunOptions {
  visionPath: string;
  techEnvPath?: string;
  outputDir: string;
  /** The dist/claude/.claude tree copied into workspace/.claude (claude_code.py:198-202). */
  distClaudePath: string;
  scope?: string; // default "mvp" (adapter.py:claude_scope)
  testRun?: boolean; // default true (adapter.py:claude_test_run)
  awsRegion?: string;
  model?: string;
  /** model id for the human-analog simulator (claude_code.py:265 scorer_model). */
  simModel?: string;
  maxTurns?: number; // default 500 (claude_code.py:293)
  timeoutMs?: number;
  /**
   * Bind the scenario's tech-env.md as a HARD constraint by appending
   * TECH_ENV_BINDING_DIRECTIVE after the leading `/aidlc …` command. Default
   * false = bare-faithful (matches today's behavior and the bare V2 prompt);
   * run.ts defaults it ON (the directive only actually appends when a tech-env
   * was copied, gated on hasTechEnv in setupWorkspace).
   */
  bindTechEnv?: boolean;
  /**
   * Override the composed prompt verbatim, mirroring `config.prompt_template`
   * (claude_code.py:218 — `config.prompt_template or render_v2_prompt(...)`).
   * When non-empty it wins over renderV2Prompt + any tech-env binding.
   */
  promptTemplate?: string;
  /**
   * GATE: the live SDK query() only runs when live === true. Default false →
   * the function throws before any model call, so a default test never spends
   * tokens. A caller can also inject `drive` to fake the in-the-loop turn.
   */
  live?: boolean;
  /**
   * Injectable drive seam (for tests / alternate transports): given the prompt +
   * resolved options, run the agentic turn(s) and return the telemetry. When
   * absent and live===true, the real SDK query loop runs.
   */
  drive?: DriveSeam;
}

/** The captured outcome of the agentic turn loop the drive seam produces. */
export interface DriveLoopResult {
  tokenUsage: TokenUsage;
  finalSubtype: string;
}

/** Signature of the in-the-loop transport (real SDK or a test fake). */
export type DriveSeam = (args: {
  initialPrompt: string;
  workspace: string;
  model?: string;
  env: Record<string, string>;
  maxTurns: number;
  simModel?: string;
  visionPath: string;
  techEnvPath?: string;
  timeoutMs?: number;
}) => Promise<DriveLoopResult>;

// ── pure helpers (separately exported — unit-testable without the model) ──────

// render_v2_prompt (prompt_template.py:118-135). `/aidlc {intent} --scope {scope}`
// with `--test-run` appended only when testRun. intent is .strip()'d (:131).
export function renderV2Prompt(intent: string, scope = "mvp", testRun = true): string {
  return `/aidlc ${intent.trim()} --scope ${scope}${testRun ? " --test-run" : ""}`;
}

// TECH_ENV_BINDING_DIRECTIVE — appended AFTER the leading `/aidlc …` slash command
// to make the scenario's tech-env.md a HARD constraint rather than the advisory
// hint a --test-run agent self-overrides.
//
// FAITHFUL PRECEDENT (not invention): the V1 EXECUTOR_SYSTEM_PROMPT
// (prompt_template.py:8-110) EXPLICITLY listed "Technical environment:
// `tech-env.md` (if present)" (prompt_template.py:22) and "Read the relevant rule
// file BEFORE starting each stage" (prompt_template.py:103, cf. :23,:27). The V2
// path (V2_ORCHESTRATOR_PROMPT, prompt_template.py:118) dropped that prose to keep
// the slash command parseable; re-introducing a tech-env-binding directive AFTER
// the slash command restores the V1 intent without disturbing the leading token.
// The human-analog simulator already enforces the same rule mid-run
// (human-analog.ts:68 / human_analog.py:55 — "if Kiro proposes Flask, say 'Use
// FastAPI as specified in tech-env'"); this directive front-loads it onto the
// conductor so the feasibility/stack question never gets self-answered against
// tech-env. Bound via the prompt because the adapter ALREADY supports a prompt
// override at this exact seam (claude_code.py:218 — `config.prompt_template or
// render_v2_prompt(...)`). Kept generic: it points the agent at the file, never
// naming a scenario's languages/frameworks.
const TECH_ENV_BINDING_DIRECTIVE =
  "Before any stack, feasibility, or technology decision, READ `workspace/tech-env.md`. " +
  "ADOPT the languages and frameworks it specifies, and treat its \"Do NOT Use\" entries as " +
  "HARD PROHIBITIONS — not advisory suggestions. When a stage would otherwise free-choose a " +
  "stack, defer to tech-env.md; do NOT self-answer the technology question against it.";

// buildInitialPrompt — compose the prompt the producer feeds the conductor.
// Mirrors claude_code.py:218 (`config.prompt_template or render_v2_prompt(...)`):
//   - a non-empty promptTemplate is the OVERRIDE path → returned verbatim;
//   - otherwise renderV2Prompt(...) is the base, with the tech-env directive
//     appended (newline-separated, AFTER the leading `/aidlc …`) when binding is
//     requested AND a tech-env.md was actually copied into the workspace.
// Pure (no I/O): hasTechEnv is decided by the caller from the same isFile check
// setupWorkspace uses for the copy (driver-sdk.ts:262), so this stays unit-testable
// without touching the filesystem or the model.
export function buildInitialPrompt(args: {
  intent: string;
  scope: string;
  testRun: boolean;
  bindTechEnv: boolean;
  hasTechEnv: boolean;
  promptTemplate?: string;
}): string {
  // claude_code.py:218 — the prompt_template override wins outright.
  if (args.promptTemplate && args.promptTemplate.length > 0) return args.promptTemplate;
  const base = renderV2Prompt(args.intent, args.scope, args.testRun);
  // Append only when binding is on AND a tech-env was actually present; the slash
  // command stays the leading token in every path.
  if (args.bindTechEnv && args.hasTechEnv) return `${base}\n\n${TECH_ENV_BINDING_DIRECTIVE}`;
  return base;
}

// _vision_intent (claude_code.py:86-100) — first markdown H1 ("# ") title, else the
// first non-empty line, else the default sentence.
export function deriveIntent(visionContent: string): string {
  // pySplitlines is overkill here — Python uses str.splitlines() but the first-H1
  // / first-non-empty scan is line-prefix based; a plain split on \n with a \r
  // trim is sufficient and matches the .strip() the Python applies per line.
  const lines = visionContent.split("\n");
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("# ")) return stripped.slice(2).trim(); // [2:].strip()
  }
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return "Build the project described in vision.md";
}

// claude_code.py:269-285 — match the simulator's free-text response to a menu
// option. For each question: no options → use the raw response; else the FIRST
// option whose label (lower-cased) is a substring of the response (lower-cased),
// falling back to options[0].label.
export interface AskOption {
  label?: string;
}
export interface AskQuestion {
  question?: string;
  options?: AskOption[];
}
export function matchAnswer(question: AskQuestion, response: string): string {
  const options = question.options ?? [];
  if (options.length === 0) return response; // answers[qtext] = response (:274)
  const lowered = response.toLowerCase();
  // next((label for opt if opt.label.lower() in response.lower()), None) (:276-283)
  const matched = options.find(
    (o) => (o.label ?? "").toLowerCase() !== "" && lowered.includes((o.label ?? "").toLowerCase()),
  );
  // matched or options[0].label or response (:284)
  return matched?.label ?? options[0]?.label ?? response;
}

// Build the `answers` map for an AskUserQuestion input (claude_code.py:269-285):
// question-text → chosen label, from the simulator's single free-text response.
export function buildAnswers(questions: AskQuestion[], response: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    answers[q.question ?? ""] = matchAnswer(q, response);
  }
  return answers;
}

// claude_code.py:252-255 — render the AskUserQuestion menu as the simulator's
// turn_output: one "Q: <q> Options: [<labels>]" line per question, \n-joined.
export function renderQuestionsForSimulator(questions: AskQuestion[]): string {
  return questions
    .map((q) => {
      const labels = (q.options ?? []).map((o) => o.label ?? "");
      return `Q: ${q.question ?? ""} Options: [${labels.join(", ")}]`;
    })
    .join("\n");
}

// _find_aidlc_docs (claude_code.py:103-113) — workspace/aidlc-docs if it has any
// *.md, else the FIRST non-dot child dir's aidlc-docs that has any *.md, else null.
export function findAidlcDocs(workspace: string): string | null {
  const direct = join(workspace, "aidlc-docs");
  if (isDir(direct) && hasMarkdown(direct)) return direct; // (:105-106)
  // sorted(workspace.iterdir()) (:108) — children sorted by name.
  let children: string[];
  try {
    children = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const name of children) {
    const candidate = join(workspace, name, "aidlc-docs"); // (:110)
    if (isDir(candidate) && hasMarkdown(candidate)) return candidate; // (:111-112)
  }
  return null;
}

// _is_workflow_complete (claude_code.py:160-170) — Status: Completed AND ≥1
// generated *.py source file under the workspace (excluding vendor/framework dirs).
// stateText is read separately (sdk-drive readStateFile) so the file-existence half
// is independently testable.
export function isWorkflowComplete(stateText: string | undefined, workspace: string): boolean {
  if (stateText === undefined || !STATE_STATUS_COMPLETED_RE.test(stateText)) return false; // (:162)
  // src_files = count of *.py not under .venv/__pycache__/.cache/.claude (:165-169)
  for (const f of rglobFiles(workspace)) {
    if (!f.endsWith(".py")) continue;
    if (SOURCE_SKIP_DIRS.some((skip) => f.includes(skip))) continue;
    return true; // src_files > 0 (:170)
  }
  return false;
}

// ── workspace setup / extract — SHARED with driver-tui.ts (do not duplicate) ──

/**
 * Set up the run workspace exactly as claude_code.py:182-213:
 *   - mkdir outputDir + outputDir/workspace (:182-185)
 *   - copy vision → workspace/vision.md, tech-env → workspace/tech-env.md (:189-193)
 *   - copy distClaudePath tree → workspace/.claude (:198-202)
 *   - write workspace/.claude/settings.local.json {env:{AWS_REGION}} when given (:207-213)
 * Returns { workspace, intent, prompt } so both transports share one path.
 */
export function setupWorkspace(opts: {
  visionPath: string;
  techEnvPath?: string;
  outputDir: string;
  distClaudePath: string;
  scope: string;
  testRun: boolean;
  awsRegion?: string;
  /** Bind tech-env.md as a HARD constraint. Default false = bare-faithful (the
   *  TUI caller passes neither, so it keeps today's bare V2 prompt). */
  bindTechEnv?: boolean;
  /** Verbatim prompt override (claude_code.py:218 config.prompt_template). */
  promptTemplate?: string;
}): { workspace: string; intent: string; prompt: string } {
  // claude_code.py:182-185
  mkdirSync(opts.outputDir, { recursive: true });
  const workspace = join(opts.outputDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  // claude_code.py:189-193 — shutil.copy2(vision, workspace/vision.md) (+ tech-env).
  // hasTechEnv reuses this exact isFile check so the binding decision matches the
  // copy decision (buildInitialPrompt only appends the directive when present).
  copyFileSync(opts.visionPath, join(workspace, "vision.md"));
  const hasTechEnv = Boolean(opts.techEnvPath && isFile(opts.techEnvPath));
  if (hasTechEnv) {
    // opts.techEnvPath is defined here (hasTechEnv implies it).
    copyFileSync(opts.techEnvPath as string, join(workspace, "tech-env.md"));
  }

  // claude_code.py:198-202 — install .claude/ from the dist into the workspace.
  // shutil.copytree errors if the dst exists, so the Python rmtree's it first.
  const claudeDst = join(workspace, ".claude");
  if (existsSync(claudeDst)) rmSync(claudeDst, { recursive: true, force: true });
  cpSync(opts.distClaudePath, claudeDst, { recursive: true });

  // claude_code.py:207-213 — override the dist's pinned AWS_REGION via the
  // framework-sanctioned settings.local.json channel (indent=2 like json.dumps).
  if (opts.awsRegion) {
    writeFileSync(
      join(claudeDst, "settings.local.json"),
      JSON.stringify({ env: { AWS_REGION: opts.awsRegion } }, null, 2),
      "utf-8",
    );
  }

  // claude_code.py:216-218 — intent from the vision title, then the prompt via
  // buildInitialPrompt (mirrors `config.prompt_template or render_v2_prompt(...)`).
  const visionContent = readFileSync(opts.visionPath, "utf-8");
  const intent = deriveIntent(visionContent);
  const prompt = buildInitialPrompt({
    intent,
    scope: opts.scope,
    testRun: opts.testRun,
    bindTechEnv: opts.bindTechEnv ?? false, // bare-faithful default
    hasTechEnv,
    promptTemplate: opts.promptTemplate,
  });
  return { workspace, intent, prompt };
}

/**
 * Extract aidlc-docs and strip the input scaffolding, exactly as
 * claude_code.py:429-436 + orchestrator.py:56-65:
 *   - _find_aidlc_docs(workspace) → cpSync into outputDir/aidlc-docs (:430-436)
 *   - remove vision.md/tech-env.md + aidlc-rules/.kiro from workspace (orch:56-65)
 * Returns the destination aidlc-docs dir (null when none was found).
 */
export function extractAndStrip(workspace: string, outputDir: string): string | null {
  // claude_code.py:430-436 — locate and copy aidlc-docs to the run root.
  const srcDocs = findAidlcDocs(workspace);
  const dstDocs = join(outputDir, "aidlc-docs");
  if (srcDocs !== null) {
    if (existsSync(dstDocs)) rmSync(dstDocs, { recursive: true, force: true });
    cpSync(srcDocs, dstDocs, { recursive: true });
  }

  // orchestrator.py:56-65 — strip input files + dirs so workspace holds only code.
  for (const name of WORKSPACE_INPUT_FILES) {
    const p = join(workspace, name);
    if (isFile(p)) rmSync(p, { force: true });
  }
  for (const name of WORKSPACE_INPUT_DIRS) {
    const p = join(workspace, name);
    if (isDir(p)) rmSync(p, { recursive: true, force: true });
  }

  return srcDocs !== null && isDir(dstDocs) ? dstDocs : null;
}

// ── the live SDK drive loop (claude_code.py:303-420) ──────────────────────────
// REPLICATES sdk-drive.ts's query()/canUseTool loop with the producer deltas.
// Module-private; reached only through driveAidlcRun with live === true.

import { query } from "@anthropic-ai/claude-agent-sdk";

// claude_code.py:369-378 — lower-cased turn text containing any of these means the
// agent wrote questions/a plan and is waiting for human input → resume the loop.
const WAITING_SIGNALS = [
  "please provide your answers",
  "what do you think",
  "awaiting your",
  "your approval",
  "ready to proceed",
  "approve / request changes",
  "approval gate",
  "approve or request changes",
];

// claude_code.py:310 caps the resume loop at 20. Under --test-run the /aidlc skill
// auto-approves gates and the workflow completes in ONE turn (SKILL.md:78), so the
// resume loop is a SAFETY NET — kept small (3 extra turns) per the plan's
// "KEEP IT SIMPLE" steer. The Python resume-loop accumulation (claude_code.py:303-341
// sums usage across AssistantMessages and num_turns/cost across ResultMessages over
// the loop) collapses to the single terminal result event under --test-run, which is
// the authoritative total; we use THAT and only sum extra resume turns if they fire.
const MAX_RESUME_TURNS = 3;

const liveDrive: DriveSeam = async (args) => {
  let tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    num_turns: 0,
    total_cost_usd: 0,
    duration_api_ms: 0,
    model: args.model ?? "",
  };
  let finalSubtype = "";
  let resumeSessionId: string | undefined;
  let currentPrompt = args.initialPrompt;

  const abortController = new AbortController();
  const timer =
    args.timeoutMs && args.timeoutMs > 0
      ? setTimeout(() => abortController.abort(), args.timeoutMs)
      : undefined;

  try {
    // claude_code.py:316 — the resume loop (capped). Turn 1 is the /aidlc command.
    for (let resumeTurn = 0; resumeTurn <= MAX_RESUME_TURNS; resumeTurn++) {
      let turnText = "";

      // canUseTool — sdk-drive.ts:468-508 shape, with the AskUserQuestion answer
      // sourced DYNAMICALLY from the human-analog simulator (claude_code.py:246-286).
      const run = query({
        prompt: currentPrompt,
        options: {
          cwd: args.workspace,
          permissionMode: "bypassPermissions", // claude_code.py:291
          settingSources: ["project"], // claude_code.py:288 (is_v2)
          maxTurns: args.maxTurns,
          abortController,
          ...(args.model ? { model: args.model } : {}),
          ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          canUseTool: async (toolName, input) => {
            if (toolName === "AskUserQuestion") {
              const questions =
                (input as { questions?: AskQuestion[] }).questions ?? [];
              // claude_code.py:252-267 — render the menu, ask the simulator, match.
              const response = await generateHumanResponse({
                turnOutput: renderQuestionsForSimulator(questions),
                visionPath: args.visionPath,
                techEnvPath: args.techEnvPath,
                model: args.simModel,
              });
              const answers = buildAnswers(questions, response);
              return {
                behavior: "allow",
                updatedInput: { ...(input as object), answers },
              };
            }
            // Everything else passes through (claude_code.py:286).
            return { behavior: "allow", updatedInput: input };
          },
        },
      });

      for await (const msg of run as AsyncIterable<Record<string, unknown>>) {
        if (msg.type === "assistant") {
          // claude_code.py:324-332 — collect assistant text for the waiting check.
          const content = (msg as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string") {
                turnText += block.text;
              }
            }
          }
        } else if (msg.type === "result") {
          // claude_code.py:337-351 — the terminal event carries the authoritative
          // single-turn total under --test-run. Map SDK usage → TokenUsage.
          finalSubtype = typeof msg.subtype === "string" ? msg.subtype : "";
          const usage = (msg.usage ?? {}) as Record<string, number>;
          // Resume turns ADD to the running total (claude_code.py:334-341 sums);
          // under --test-run resumeTurn===0 is the only iteration so it is the total.
          const inputTokens = (tokenUsage.input_tokens ?? 0) + (usage.input_tokens ?? 0);
          const outputTokens = (tokenUsage.output_tokens ?? 0) + (usage.output_tokens ?? 0);
          tokenUsage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            // claude_code.py:442 — total_tokens is EXACTLY input + output (it does
            // NOT fold in cache). This is the field the baseline compares ("Total
            // Tokens" / "API Total Tokens", baseline.ts METRICS_SPEC); set it
            // explicitly so the normalizer does not default-sum cache_read/write
            // into it (which produced a false ~48000% regression vs the golden's
            // input+output total). Cache counts are kept separately below as richer
            // observable telemetry — they are NOT a compared metric (no cache row in
            // baseline.ts), so carrying the real SDK figures is faithful + harmless.
            total_tokens: inputTokens + outputTokens,
            cache_read_tokens:
              (tokenUsage.cache_read_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            cache_write_tokens:
              (tokenUsage.cache_write_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            num_turns:
              (tokenUsage.num_turns ?? 0) +
              (typeof msg.num_turns === "number" ? msg.num_turns : 0),
            duration_api_ms:
              (tokenUsage.duration_api_ms ?? 0) +
              (typeof msg.duration_api_ms === "number" ? msg.duration_api_ms : 0),
            total_cost_usd:
              (tokenUsage.total_cost_usd ?? 0) +
              (typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0),
            model: args.model ?? "",
          };
          if (typeof msg.session_id === "string") resumeSessionId = msg.session_id;
          break; // claude_code.py:351
        }
      }

      // ── completion detection (claude_code.py:353-420) ──
      // 1. Hard check: Status: Completed + code exists (claude_code.py:355-360).
      if (isWorkflowComplete(readStateFile(args.workspace), args.workspace)) break;
      // 2. SDK error / safety stop (claude_code.py:362-365).
      if (finalSubtype !== "success" && finalSubtype !== "") break;
      // 3. Agent waiting → resume with the simulator (claude_code.py:367-397).
      const lowered = turnText.toLowerCase();
      if (WAITING_SIGNALS.some((sig) => lowered.includes(sig))) {
        currentPrompt = await generateHumanResponse({
          turnOutput: turnText.slice(-3000), // claude_code.py:387
          visionPath: args.visionPath,
          techEnvPath: args.techEnvPath,
          model: args.simModel,
        });
        continue;
      }
      // 4. State incomplete but agent didn't ask → nudge (claude_code.py:399-415).
      const nextStage = stateField(args.workspace, "Next Stage");
      const inProgress = stateField(args.workspace, "In Progress");
      const hasState = nextStage !== undefined || inProgress !== undefined;
      const notDone =
        !["", "none"].includes((nextStage ?? "").toLowerCase()) ||
        !["", "none"].includes((inProgress ?? "").toLowerCase());
      if (hasState && notDone) {
        const detail = nextStage || inProgress || "the next stage";
        currentPrompt =
          `Continue the /aidlc workflow. The workflow is not yet complete ` +
          `(next: ${detail}). Run the forwarding loop until the engine reports done.`;
        continue;
      }
      // 5. No state, no waiting signal → stop the resume loop (claude_code.py:417-420).
      break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { tokenUsage, finalSubtype };
};

// stateField — read a single `- **<field>**: <value>` from aidlc-state.md via
// sdk-drive's readStateFile + readStateField (claude_code.py:72-83 _read_state_field).
function stateField(workspace: string, field: string): string | undefined {
  const text = readStateFile(workspace);
  if (text === undefined) return undefined;
  return readStateField(text, field);
}

// ── driveAidlcRun — the entry point (claude_code.py:172-493 _run_async) ───────
export async function driveAidlcRun(opts: DriveAidlcRunOptions): Promise<DriverResult> {
  const scope = opts.scope ?? "mvp";
  const testRun = opts.testRun ?? true;
  const maxTurns = opts.maxTurns ?? 500; // claude_code.py:293

  // claude_code.py:181 — time.monotonic() at start. performance.now() is the JS
  // monotonic counter (NOT Date) — allowed in the spike.
  const start = performance.now();

  // 1. Workspace setup (claude_code.py:182-218). bindTechEnv/promptTemplate thread
  //    the prompt-construction options through (claude_code.py:218 prompt_template).
  const { workspace, prompt } = setupWorkspace({
    visionPath: opts.visionPath,
    techEnvPath: opts.techEnvPath,
    outputDir: opts.outputDir,
    distClaudePath: opts.distClaudePath,
    scope,
    testRun,
    awsRegion: opts.awsRegion,
    bindTechEnv: opts.bindTechEnv,
    promptTemplate: opts.promptTemplate,
  });

  // 2. Resolve model/env via sdk-drive's helper (REUSE — sdk-drive.ts:342-377).
  const sdkSettings = resolveDriveSdkSettings(workspace, {
    model: opts.model,
    env: opts.awsRegion ? { AWS_REGION: opts.awsRegion } : undefined,
  });

  // 3. Drive the agentic turn(s). GATE: live SDK only when opts.live; a test may
  //    inject opts.drive to fake the loop without the model.
  const drive = opts.drive ?? (opts.live ? liveDrive : undefined);
  if (!drive) {
    throw new Error(
      "driveAidlcRun: live SDK call gated — pass { live: true } to run the model, " +
        "or inject { drive } to fake the turn loop. The model never runs in a default test.",
    );
  }

  const { tokenUsage, finalSubtype } = await drive({
    initialPrompt: prompt,
    workspace,
    model: sdkSettings.model,
    env: sdkSettings.env,
    maxTurns,
    simModel: opts.simModel,
    visionPath: opts.visionPath,
    techEnvPath: opts.techEnvPath,
    timeoutMs: opts.timeoutMs,
  });

  // 4. Extract aidlc-docs + strip inputs (claude_code.py:429-436 + orch:56-65).
  const aidlcDocsDir = extractAndStrip(workspace, opts.outputDir);

  // claude_code.py:422 — elapsed via the monotonic counter.
  const elapsedSeconds = (performance.now() - start) / 1000;

  // claude_code.py:456-457 — success == subtype "success" AND aidlc-docs produced.
  const success = finalSubtype === "success" && aidlcDocsDir !== null;

  return {
    outputDir: opts.outputDir,
    workspaceDir: workspace,
    aidlcDocsDir,
    tokenUsage,
    elapsedSeconds,
    finalSubtype,
    success,
  };
}

// ── tiny fs helpers (Path.is_dir / is_file / rglob parity) ───────────────────

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// any(dir.rglob("*.md")) (claude_code.py:106,111) — at least one *.md anywhere under.
function hasMarkdown(dir: string): boolean {
  for (const f of rglobFiles(dir)) {
    if (f.endsWith(".md")) return true;
  }
  return false;
}

// Path.rglob("*") restricted to files. Yields absolute paths. Mirrors
// normalizer.ts's rglobFiles (node:fs recursive readdir with withFileTypes).
function* rglobFiles(root: string): Generator<string> {
  if (!isDir(root)) return; // OSError on a missing/non-dir root ⇒ no files.
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    // With recursive:true, parentPath holds the directory of the entry.
    const dir = (e as { parentPath?: string; path?: string }).parentPath ?? root;
    yield join(dir, e.name);
  }
}
