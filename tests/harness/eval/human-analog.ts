// human-analog.ts — generates contextually appropriate responses to Kiro's questions.
//
// Ports human_analog.py (181 lines): the human-analog simulacrum that reads what
// Kiro actually said and replies as an informed human would — answering
// genuine-judgment questions from the vision + tech-env, replying "Approved.
// Continue." to progress/file-IO narration, and falling back to "Approve &
// Continue." on any model failure (human_analog.py:11,178-180).
//
// Three-concerns split: extractFinalResponse + the two prompt builders are PURE
// and deterministic (the ONLY surface the test exercises); the model call is the
// KNOWLEDGE→LLM concern — it sits behind the caller's live gate (transport
// dispatch + a dynamic SDK import) and never runs in a default deterministic
// path, mirroring qualitative.ts:312-342's AgentSdkScorer.
//
// Transport delta vs Python (human_analog.py:153-176 boto3/invoke_model): Python
// splits system + user via Bedrock's `system`/`messages` fields. The default
// claude-agent-sdk transport here takes a SINGLE prompt with no separate system
// role, so the system prompt is PREPENDED to the user content with a clear
// separator (see buildPrompt + generateHumanResponse). The Bedrock variant
// (transport:"bedrock") preserves Python's system/messages split but is not on
// disk in this spike — it is structured + documented only, never imported.
//
// No round() / timestamp in the Python source, so neither pyutil's pyRound nor
// the generatedAt="" injection convention applies here.

import { readFileSync, statSync } from "node:fs";
import { pySplitlines } from "./pyutil.ts";

// human_analog.py:178-180 — the on-error fallback. Exported as a named const so
// the test can pin its exact spelling (note: "Approve & Continue." — distinct
// from the in-prompt "Approved. Continue." non-question reply at :44,:71).
export const APPROVAL_FALLBACK = "Approve & Continue.";

// human_analog.py:115 — default simulator model id. SIM_MODEL wins over
// JUDGE_MODEL (the shared judge override) over the hard-coded Bedrock inference
// profile.
const DEFAULT_MODEL =
  process.env.SIM_MODEL ?? process.env.JUDGE_MODEL ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

// human_analog.py:24-61 — VERBATIM. Mirrors the execution package's simulator
// system prompt so the human analog behaves consistently across the
// Bedrock-swarm and CLI/IDE harness paths (human_analog.py:22-23). {vision_content}
// and {tech_env_section} are the two substitution points.
const SYSTEM_PROMPT_TEMPLATE = `You are simulating a knowledgeable human project stakeholder in an AI-assisted software development workflow. An AI coding assistant (Kiro) is building a project and occasionally pauses to ask you specific questions or present decisions that require human judgment.

## Your role — answer questions, not file I/O

You ONLY respond substantively when Kiro asks a question that genuinely requires human judgment:
- Clarification questions about requirements or behaviour (e.g. "How should mode behave when all values are unique?", "Which error code for overflow?")
- Decisions about workflow composition (e.g. "Should we include NFR assessment?")
- Approval of a proposed workflow or phase plan

You do NOT respond substantively to:
- Reports of file writes, directory creation, or test runs (those are internal steps)
- Summaries of completed work where no question is asked
- Any message that is just Kiro narrating what it did

For those, simply reply: "Approved. Continue."

## The project vision

{vision_content}

{tech_env_section}
## How to answer questions

- Answer each question directly, using the vision and tech-env as your source of truth.
- Confirm Kiro's recommendations when they align with the tech-env; correct them when they conflict (e.g. if Kiro proposes Flask, say "Use FastAPI as specified in tech-env").
- For workflow composition questions, approve the minimal workflow unless the vision clearly requires more phases.
- Keep answers to 1-3 sentences per question. Be decisive — do not hedge.
- Do NOT ask questions back. Do NOT add scope (README, CI, docs, etc.).
- Do NOT declare the project "done" or "shipped" — that is Kiro's decision.
`;

// human_analog.py:63-71 — VERBATIM. {turn_output} substitution point.
const USER_TEMPLATE = `Kiro's latest message:
---
{turn_output}
---

Does this message ask a question or present a plan/workflow for your approval? If yes, answer it concisely. If no (it's just a progress update or file I/O report), reply only: "Approved. Continue."`;

// human_analog.py:84 ANSI regex — strip control/escape sequences (CSI, OSC, and
// any lone ESC+char) before block extraction. Recreated as a /g RegExp so
// String.replace strips ALL matches like Python's ansi_re.sub("", ...).
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b./g;

// human_analog.py:74-106 — extract just the final assistant response block from a
// kiro-cli turn output. Kiro session logs interleave tool calls (file writes,
// shell runs) with assistant responses marked by "> " prefix lines; we extract
// the *last* contiguous response block, including any ━━━ approval-gate
// separators that follow it (human_analog.py:75-80,96).
export function extractFinalResponse(rawOutput: string): string {
  const text = rawOutput.replace(ANSI_RE, "");

  // Collect all ">" response blocks (human_analog.py:87-99).
  //
  // Python quirk (human_analog.py:92-94): on the FIRST "> " line of a block
  // (`current` empty) it does `blocks.append(current)` and THEN `current.append(...)`
  // — so `blocks` holds a REFERENCE to the same list `current` keeps mutating.
  // Every later line that extends `current` (>-line, separator, or blank) is
  // therefore reflected in the already-appended `blocks` entry; a NEW block only
  // begins on the next "> " line that finds `current` empty (which never happens
  // because `current` is never reset). Net effect: each contiguous run of >-lines
  // plus its trailing non-blank context lines and blank lines forms one block,
  // and the LAST such run wins. We replicate the resulting behavior directly:
  // start a fresh `current` whenever a "> " line arrives while `current` is empty,
  // push it into `blocks` once, and keep the live reference in `current`.
  // human_analog.py:90 — text.splitlines(). pySplitlines (pyutil.ts) matches
  // CPython's full line-boundary set, so CRLF/CR/FF/NEL turn output splits
  // identically (a plain split("\n") would leave a \r embedded in the block).
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of pySplitlines(text)) {
    if (line.startsWith("> ")) {
      if (current.length === 0) blocks.push(current); // push the live reference
      current.push(line.slice(2));
    } else if (current.length > 0 && line.trim()) {
      // Include ━━━ separator lines and approval-gate content that follows.
      current.push(line);
    } else if (current.length > 0 && !line.trim()) {
      current.push("");
    }
  }

  if (blocks.length > 0) {
    const lastBlock = blocks[blocks.length - 1]!.join("\n").trim();
    return lastBlock.slice(0, 2000); // human_analog.py:102-103
  }

  // Fallback: last 1500 chars (human_analog.py:105-106).
  return text.slice(-1500).trim();
}

// human_analog.py:132-140 — tech-env binding section. Empty string when no
// tech-env, else the binding-reference block with tech_env sliced [:2000].
function buildTechEnvSection(techEnv: string): string {
  if (!techEnv) return "";
  return (
    "## The technical environment\n\n" +
    "The following defines HOW the project must be built — languages, frameworks, " +
    "testing standards, and prohibited technologies. Use this as a binding reference:\n\n" +
    `---\n${techEnv.slice(0, 2000)}\n---\n`
  );
}

// human_analog.py:142-145 — fill the system template from vision[:2000] + the
// tech-env section. Pure: takes already-read file contents.
function buildSystemPrompt(vision: string, techEnv: string): string {
  return SYSTEM_PROMPT_TEMPLATE.replace("{vision_content}", vision.slice(0, 2000)).replace(
    "{tech_env_section}",
    buildTechEnvSection(techEnv),
  );
}

// human_analog.py:150-151 — extract the final response block then fill the user
// template. Pure.
function buildUserPrompt(turnOutput: string): string {
  const trimmedOutput = extractFinalResponse(turnOutput);
  return USER_TEMPLATE.replace("{turn_output}", trimmedOutput);
}

// human_analog.py:125-130 — read a file if it exists, else "". Mirrors
// `path.read_text(...) if path and path.is_file() else ""`.
function readIfFile(path: string | undefined): string {
  if (!path) return "";
  try {
    if (!statSync(path).isFile()) return "";
  } catch {
    return "";
  }
  return readFileSync(path, "utf-8");
}

export interface GenerateHumanResponseOptions {
  turnOutput: string;
  visionPath: string;
  techEnvPath?: string;
  model?: string;
  awsProfile?: string;
  awsRegion?: string;
  transport?: "agent-sdk" | "bedrock";
}

// human_analog.py:109-180 — generate a contextually appropriate human response to
// Kiro's turn output. KNOWLEDGE→LLM concern: this is the ONLY non-pure path and
// must sit behind the caller's live gate. On ANY error → APPROVAL_FALLBACK
// (human_analog.py:178-180).
export async function generateHumanResponse(opts: GenerateHumanResponseOptions): Promise<string> {
  try {
    const vision = readIfFile(opts.visionPath);
    const techEnv = readIfFile(opts.techEnvPath);
    const systemPrompt = buildSystemPrompt(vision, techEnv);
    const userContent = buildUserPrompt(opts.turnOutput);
    const model = opts.model ?? DEFAULT_MODEL;

    if (opts.transport === "bedrock") {
      // Bedrock variant — mirrors Python's invoke_model (human_analog.py:122-176)
      // with the system/messages split preserved. @anthropic-ai/bedrock-sdk is
      // NOT on disk in this spike, so this branch is structured + documented only
      // and is never wired (no dep added). When enabled it would build a
      // BedrockRuntime client (awsProfile/awsRegion → boto3.Session analog),
      // call messages.create({ model, max_tokens: 256, system: systemPrompt,
      // messages: [{ role: "user", content: userContent }] }) — Python
      // human_analog.py:163-172 — and return result.content[0].text.trim()
      // (human_analog.py:174). The opts.awsProfile/awsRegion fields exist for
      // exactly this branch (human_analog.py:153-161).
      throw new Error("bedrock transport not available in this spike (no @anthropic-ai/bedrock-sdk)");
    }

    // Default: claude-agent-sdk transport — uses the repo's claude CLI auth (no
    // ANTHROPIC_API_KEY required), mirroring qualitative.ts:312-342's
    // AgentSdkScorer for the import + result-extraction shape.
    //
    // Transport delta (see header): the agent SDK takes a SINGLE prompt with no
    // separate system role, so the system prompt is PREPENDED to the user content
    // with a clear separator instead of Python's Bedrock system/messages split
    // (human_analog.py:167-168).
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const prompt = `${systemPrompt}

---

${userContent}`;
    const run = query({
      prompt,
      options: { maxTurns: 1, ...(model ? { model } : {}) },
    });
    let text = "";
    for await (const m of run as AsyncIterable<any>) {
      if (m.type === "result" && typeof m.result === "string") text = m.result;
    }
    if (!text) throw new Error("no result text from agent SDK");
    return text.trim(); // human_analog.py:174
  } catch {
    // human_analog.py:178-180 — fall back to approval on any failure.
    return APPROVAL_FALLBACK;
  }
}
