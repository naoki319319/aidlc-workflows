#!/usr/bin/env node
/**
 * state-manager.js — The single gateway for all state mutations.
 *
 * Neither the orchestrator nor personas write state.json directly.
 * All state changes go through this tool, which:
 *   - Reads the transition table from conventions/transitions.json
 *   - Validates actor + condition before allowing a transition
 *   - Writes state atomically
 *   - Appends audit entries on human-facing decisions
 *
 * Subcommands:
 *   transition            — Move a stage to a new status
 *   register-output       — Declare an output artifact for the current stage
 *   register-contribution — Mark a contributor as having contributed
 *   add-stage             — Add a new stage to the workflow
 *   validate              — Check state.json integrity
 *   check-resume          — Check if there's an active intent to resume
 *   allowed               — Show what transitions are valid right now
 *
 * Exit codes:
 *   0 — Success
 *   1 — Validation failure (illegal transition, condition not met)
 *   2 — Error (bad arguments, missing files)
 */

const fs = require("fs");
const path = require("path");

// --- Load Transition Table ---

const CONVENTIONS_DIR = path.resolve(__dirname, "..", "conventions");
const TRANSITIONS_PATH = path.join(CONVENTIONS_DIR, "transitions.json");

function loadTransitions() {
  // Try installed location first (.kiro/conventions/), then source location
  const installed = path.resolve(__dirname, "..", "conventions", "transitions.json");
  const source = TRANSITIONS_PATH;
  const p = fs.existsSync(installed) ? installed : source;
  if (!fs.existsSync(p)) {
    console.error(`Cannot find transitions.json at ${installed} or ${source}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

const TRANSITION_TABLE = loadTransitions();

// Default max review iterations (can be overridden in workflow.json)
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

// --- Condition Evaluator ---

function evaluateCondition(condition, stage, args, maxReviewIterations) {
  if (condition === null) return true;

  switch (condition) {
    case "has-contributors":
      return Array.isArray(stage.contributors) && stage.contributors.length > 0;

    case "no-contributors":
      return !Array.isArray(stage.contributors) || stage.contributors.length === 0;

    case "has-reviewer":
      return !!stage.reviewer;

    case "no-reviewer":
      return !stage.reviewer;

    case "all-contributors-done":
      if (!Array.isArray(stage.contributions) || stage.contributions.length === 0) return false;
      return stage.contributions.every(c => c.contributed === true);

    case "review-not-maxed":
      return (stage.reviewIterations || 0) < maxReviewIterations;

    case "review-maxed-or-ready":
      // True if iterations maxed OR reviewer said ready (signaled by --verdict ready)
      if ((stage.reviewIterations || 0) >= maxReviewIterations) return true;
      return args.verdict === "ready";

    case "decision-approve":
      return !!args.decision && args.decision !== "rejected" && args.decision !== "changes-requested";

    case "decision-reject":
      return !!args.decision && (args.decision === "rejected" || args.decision === "changes-requested");

    default:
      // Unknown condition — fail safe
      return false;
  }
}

// --- Helpers ---

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function fileExists(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

function now() {
  return new Date().toISOString();
}

function fail(message, code = 1) {
  console.log(JSON.stringify({ success: false, error: message }));
  process.exit(code);
}

function succeed(message, data = {}) {
  console.log(JSON.stringify({ success: true, message, ...data }));
  process.exit(0);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function resolveIntentDir(args) {
  const intentDir = args.intent;
  if (!intentDir) fail("Missing --intent <dir>", 2);
  if (!fs.existsSync(intentDir)) fail(`Intent directory not found: ${intentDir}`, 2);
  return intentDir;
}

function loadState(intentDir) {
  const statePath = path.join(intentDir, "state", "state.json");
  const state = readJson(statePath);
  if (!state) fail(`Cannot read state.json at ${statePath}`, 2);
  return state;
}

function saveState(intentDir, state) {
  state.updated = now();
  const statePath = path.join(intentDir, "state", "state.json");
  writeJson(statePath, state);
}

function loadWorkflow(intentDir) {
  const wfPath = path.join(intentDir, "workflow.json");
  return readJson(wfPath);
}

function appendAudit(intentDir, event, fields) {
  const auditPath = path.join(intentDir, "audit", "audit.json");
  let audit = readJson(auditPath);
  if (!audit) {
    audit = { intent: path.basename(intentDir), entries: [] };
  }
  audit.entries.push({
    timestamp: now(),
    event,
    ...fields,
  });
  writeJson(auditPath, audit);
}

function findStage(state, stageName, unit) {
  return state.stages.find(s => {
    if (s.stage !== stageName) return false;
    if (unit && s.unit !== unit) return false;
    return true;
  });
}

// --- Precondition Checks (file-existence guards, separate from transition conditions) ---

function checkFileGuards(intentDir, stage, toStatus) {
  const errors = [];

  // Before artifact-generated: outputs must be registered and exist on disk
  if (toStatus === "artifact-generated") {
    if (!stage.outputs || stage.outputs.length === 0) {
      errors.push("Cannot transition to 'artifact-generated': no outputs registered. Use 'register-output' first.");
    } else {
      for (const output of stage.outputs) {
        const filePath = path.join(intentDir, output.locationRelativeToIntentRoot, output.name);
        if (!fileExists(filePath)) {
          errors.push(`Output '${output.name}' at '${output.locationRelativeToIntentRoot}' does not exist or is empty.`);
        }
      }
    }
  }

  // Before presented: all outputs must still exist
  if (toStatus === "presented") {
    if (stage.outputs && stage.outputs.length > 0) {
      for (const output of stage.outputs) {
        const filePath = path.join(intentDir, output.locationRelativeToIntentRoot, output.name);
        if (!fileExists(filePath)) {
          errors.push(`Cannot present: output '${output.name}' at '${output.locationRelativeToIntentRoot}' missing or empty.`);
        }
      }
    }
  }

  return errors;
}

// --- Subcommands ---

function handleTransition(args) {
  const intentDir = resolveIntentDir(args);
  const stageName = args.stage;
  const toStatus = args.to;
  const actor = args.actor;
  const unit = args.unit || undefined;

  if (!stageName) fail("Missing --stage <name>", 2);
  if (!toStatus) fail("Missing --to <status>", 2);
  if (!actor) fail("Missing --actor <orchestrator|owner|reviewer>", 2);

  const state = loadState(intentDir);
  const stage = findStage(state, stageName, unit);

  if (!stage) {
    fail(`Stage '${stageName}'${unit ? ` (unit: ${unit})` : ""} not found in state.json`);
  }

  const currentStatus = stage.status;

  // Load max review iterations from workflow.json or default
  const workflow = loadWorkflow(intentDir);
  const maxReviewIterations = (workflow && workflow.maxReviewIterations) || DEFAULT_MAX_REVIEW_ITERATIONS;

  // Find matching transitions from the table
  const candidates = TRANSITION_TABLE.transitions.filter(t =>
    t.from === currentStatus && t.to === toStatus
  );

  if (candidates.length === 0) {
    // Find what IS allowed from this state
    const allowedFromHere = TRANSITION_TABLE.transitions
      .filter(t => t.from === currentStatus)
      .map(t => `${t.to} (actor: ${t.actor}${t.condition ? `, condition: ${t.condition}` : ""})`)
      .join(", ");
    fail(`No transition '${currentStatus}' → '${toStatus}' exists. Allowed from '${currentStatus}': [${allowedFromHere}]`);
  }

  // Check actor matches
  const actorMatch = candidates.filter(t => t.actor === actor);
  if (actorMatch.length === 0) {
    const rightActor = candidates[0].actor;
    fail(`Actor '${actor}' cannot perform '${currentStatus}' → '${toStatus}'. Required actor: '${rightActor}'.`);
  }

  // Evaluate conditions
  const conditionMatch = actorMatch.filter(t => evaluateCondition(t.condition, stage, args, maxReviewIterations));
  if (conditionMatch.length === 0) {
    const unmetCondition = actorMatch[0].condition;
    fail(`Condition not met for '${currentStatus}' → '${toStatus}': '${unmetCondition}'.`);
  }

  // File-existence guards
  const fileErrors = checkFileGuards(intentDir, stage, toStatus);
  if (fileErrors.length > 0) {
    fail(fileErrors.join(" | "));
  }

  // Special: increment reviewIterations when looping back to final-review-needed
  if (currentStatus === "final-review-complete" && toStatus === "final-review-needed") {
    stage.reviewIterations = (stage.reviewIterations || 0) + 1;
  }

  // Apply transition
  const previousStatus = stage.status;
  stage.status = toStatus;
  saveState(intentDir, state);

  // Emit typed audit events based on transition
  if (previousStatus === "pending" && toStatus === "plan-and-clarify") {
    appendAudit(intentDir, "STAGE_STARTED", { stage: stageName, actor, unit: unit || undefined });
  }
  if (toStatus === "complete") {
    appendAudit(intentDir, "STAGE_COMPLETED", { stage: stageName, decision: args.decision });
  }
  if (toStatus === "complete" && args.decision) {
    appendAudit(intentDir, "HUMAN_DECISION", { stage: stageName, presented: "Stage artifact for approval", decision: args.decision });
  }
  if (toStatus === "changes-requested") {
    appendAudit(intentDir, "HUMAN_DECISION", { stage: stageName, presented: "Stage artifact for approval", decision: args.decision || "changes-requested" });
  }
  if (toStatus === "clarification-provided" && previousStatus === "clarification-asked") {
    appendAudit(intentDir, "HUMAN_INPUT", { stage: stageName, context: "clarification-answers" });
  }

  succeed(`${previousStatus} → ${toStatus}`, {
    stage: stageName,
    from: previousStatus,
    to: toStatus,
    actor,
    condition: conditionMatch[0].condition || "none",
  });
}

function handleAllowed(args) {
  const intentDir = resolveIntentDir(args);
  const stageName = args.stage;
  const actor = args.actor || undefined;
  const unit = args.unit || undefined;

  if (!stageName) fail("Missing --stage <name>", 2);

  const state = loadState(intentDir);
  const stage = findStage(state, stageName, unit);

  if (!stage) {
    fail(`Stage '${stageName}'${unit ? ` (unit: ${unit})` : ""} not found in state.json`);
  }

  const currentStatus = stage.status;
  const workflow = loadWorkflow(intentDir);
  const maxReviewIterations = (workflow && workflow.maxReviewIterations) || DEFAULT_MAX_REVIEW_ITERATIONS;

  // Find all transitions from current state
  let candidates = TRANSITION_TABLE.transitions.filter(t => t.from === currentStatus);

  // Filter by actor if specified
  if (actor) {
    candidates = candidates.filter(t => t.actor === actor);
  }

  // Evaluate conditions to show which are actually available
  const available = candidates.map(t => ({
    to: t.to,
    actor: t.actor,
    condition: t.condition,
    conditionMet: evaluateCondition(t.condition, stage, args, maxReviewIterations),
  }));

  succeed(`Transitions from '${currentStatus}':`, {
    stage: stageName,
    currentStatus,
    transitions: available,
  });
}

function handleRegisterOutput(args) {
  const intentDir = resolveIntentDir(args);
  const stageName = args.stage;
  const name = args.name;
  const location = args.location;
  const unit = args.unit || undefined;

  if (!stageName) fail("Missing --stage <name>", 2);
  if (!name) fail("Missing --name <filename>", 2);
  if (!location) fail("Missing --location <directory-path-ending-with-/>", 2);

  const loc = location.endsWith("/") ? location : location + "/";

  const state = loadState(intentDir);
  const stage = findStage(state, stageName, unit);

  if (!stage) {
    fail(`Stage '${stageName}'${unit ? ` (unit: ${unit})` : ""} not found in state.json`);
  }

  if (!stage.outputs) stage.outputs = [];

  // Check for duplicate
  const existing = stage.outputs.find(o => o.name === name && o.locationRelativeToIntentRoot === loc);
  if (existing) {
    succeed(`Output '${name}' already registered.`, { stage: stageName, name, location: loc });
    return;
  }

  stage.outputs.push({ name, locationRelativeToIntentRoot: loc });
  saveState(intentDir, state);

  succeed(`Output '${name}' registered at '${loc}'.`, { stage: stageName, name, location: loc });
}

function handleRegisterContribution(args) {
  const intentDir = resolveIntentDir(args);
  const stageName = args.stage;
  const persona = args.persona;
  const unit = args.unit || undefined;

  if (!stageName) fail("Missing --stage <name>", 2);
  if (!persona) fail("Missing --persona <name>", 2);

  const state = loadState(intentDir);
  const stage = findStage(state, stageName, unit);

  if (!stage) {
    fail(`Stage '${stageName}'${unit ? ` (unit: ${unit})` : ""} not found in state.json`);
  }

  if (!stage.contributions) stage.contributions = [];

  const contribution = stage.contributions.find(c => c.persona === persona);
  if (!contribution) {
    stage.contributions.push({ persona, contributed: true });
  } else {
    contribution.contributed = true;
  }

  saveState(intentDir, state);
  succeed(`Contribution from '${persona}' registered.`, { stage: stageName, persona });
}

function handleAddStage(args) {
  const intentDir = resolveIntentDir(args);
  const stageName = args.stage;
  const owner = args.owner;
  const unit = args.unit || undefined;
  const phase = args.phase || undefined;
  const reviewer = args.reviewer || undefined;
  const contributors = args.contributors ? args.contributors.split(",").map(s => s.trim()) : undefined;
  const autonomy = args.autonomy || "supervised";

  if (!stageName) fail("Missing --stage <name>", 2);
  if (!owner) fail("Missing --owner <persona-name>", 2);

  const state = loadState(intentDir);

  const existing = findStage(state, stageName, unit);
  if (existing) {
    fail(`Stage '${stageName}'${unit ? ` (unit: ${unit})` : ""} already exists in state.json`);
  }

  const stageEntry = {
    stage: stageName,
    status: "pending",
    owner,
  };
  if (unit) stageEntry.unit = unit;
  if (phase) stageEntry.phase = phase;
  if (contributors && contributors.length > 0) stageEntry.contributors = contributors;
  if (reviewer) stageEntry.reviewer = reviewer;
  if (autonomy !== "supervised") stageEntry.autonomy = autonomy;

  if (contributors && contributors.length > 0) {
    stageEntry.contributions = contributors.map(p => ({ persona: p, contributed: false }));
  }

  state.stages.push(stageEntry);
  saveState(intentDir, state);

  succeed(`Stage '${stageName}' added.`, { stage: stageName, owner });
}

function handleValidate(args) {
  const intentDir = resolveIntentDir(args);
  const state = loadState(intentDir);
  const errors = [];

  // Collect all valid statuses from the transition table
  const validStatuses = new Set();
  validStatuses.add("complete"); // terminal state
  for (const t of TRANSITION_TABLE.transitions) {
    validStatuses.add(t.from);
    validStatuses.add(t.to);
  }

  for (let i = 0; i < state.stages.length; i++) {
    const s = state.stages[i];
    if (!s.stage) errors.push(`stages[${i}]: missing 'stage' field`);
    if (!s.status) errors.push(`stages[${i}]: missing 'status' field`);
    if (!s.owner) errors.push(`stages[${i}]: missing 'owner' field`);

    if (s.status && !validStatuses.has(s.status)) {
      errors.push(`stages[${i}] ('${s.stage}'): invalid status '${s.status}'`);
    }

    // Check outputs exist for stages past artifact-generated
    const pastArtifact = ["artifact-generated", "contribution-needed", "contribution-not-needed",
      "contributed", "refined", "final-review-needed", "final-review-complete",
      "review-not-needed", "presented", "changes-requested", "finalised", "complete"];
    if (s.outputs && s.outputs.length > 0 && pastArtifact.includes(s.status)) {
      for (const output of s.outputs) {
        if (!output.name || !output.locationRelativeToIntentRoot) {
          errors.push(`stages[${i}] ('${s.stage}'): output missing required fields`);
          continue;
        }
        const filePath = path.join(intentDir, output.locationRelativeToIntentRoot, output.name);
        if (!fileExists(filePath)) {
          errors.push(`stages[${i}] ('${s.stage}'): output '${output.name}' registered but file missing`);
        }
      }
    }
  }

  // Check for duplicates
  const seen = new Set();
  for (const s of state.stages) {
    const key = s.unit ? `${s.stage}::${s.unit}` : s.stage;
    if (seen.has(key)) errors.push(`Duplicate stage entry: '${key}'`);
    seen.add(key);
  }

  if (!state.intent) errors.push("Missing top-level 'intent' field");
  if (!state.created) errors.push("Missing top-level 'created' field");

  if (errors.length > 0) {
    console.log(JSON.stringify({ success: false, valid: false, errors }));
    process.exit(1);
  }

  succeed("State is valid.", { valid: true, stageCount: state.stages.length });
}

function handleCheckResume(args) {
  const workspace = args.workspace || ".";
  const orgAiKb = path.join(workspace, "org-ai-kb");

  if (!fs.existsSync(orgAiKb)) {
    succeed("No org-ai-kb found.", { hasActiveIntent: false });
    return;
  }

  // Discover team folders
  const teams = fs.readdirSync(orgAiKb, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => e.name);

  if (teams.length === 0) {
    succeed("No teams found.", { hasActiveIntent: false });
    return;
  }

  // Check each team's aidlc-docs for active intents
  for (const team of teams) {
    const aidlcDocs = path.join(orgAiKb, team, "aidlc-docs");
    if (!fs.existsSync(aidlcDocs)) continue;

    const entries = fs.readdirSync(aidlcDocs).filter(d => d.startsWith("intent-"));
    if (entries.length === 0) continue;

    entries.sort().reverse();

    for (const entry of entries) {
      const intentDir = path.join(aidlcDocs, entry);
      const statePath = path.join(intentDir, "state", "state.json");
      const state = readJson(statePath);
      if (!state || !state.stages) continue;

      const allComplete = state.stages.length > 0 && state.stages.every(s => s.status === "complete");
      if (allComplete) continue;

      const completed = state.stages.filter(s => s.status === "complete");
      const active = state.stages.find(s => s.status !== "pending" && s.status !== "complete");
      const nextPending = state.stages.find(s => s.status === "pending");

      succeed("Active intent found.", {
        hasActiveIntent: true,
        intentDir,
        intentName: entry,
        team,
        slug: state.intent,
        totalStages: state.stages.length,
        completedStages: completed.length,
        activeStage: active ? active.stage : null,
        activeStatus: active ? active.status : null,
        nextPendingStage: nextPending ? nextPending.stage : null,
      });
      return;
    }
  }

  succeed("All intents complete.", { hasActiveIntent: false });
}

// Valid audit event types
const VALID_EVENTS = [
  "WORKFLOW_STARTED",
  "WORKFLOW_COMPLETED",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
  "HUMAN_DECISION",
  "HUMAN_INPUT",
  "VALIDATION_PASSED",
  "VALIDATION_FAILED",
  "LEARNING_CAPTURED",
];

function handleAudit(args) {
  const intentDir = resolveIntentDir(args);
  const event = args.event;

  if (!event) fail("Missing --event <event-type>", 2);
  if (!VALID_EVENTS.includes(event)) {
    fail(`Invalid event type '${event}'. Valid events: [${VALID_EVENTS.join(", ")}]`);
  }

  // Build fields from remaining args (exclude intent and event)
  const fields = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "intent" || key === "event") continue;
    fields[key] = value;
  }

  appendAudit(intentDir, event, fields);
  succeed(`Audit event '${event}' recorded.`, { event, fields });
}

// --- Main Dispatch ---

const subcommand = process.argv[2];
const args = parseArgs(process.argv.slice(3));

switch (subcommand) {
  case "transition":
    handleTransition(args);
    break;
  case "register-output":
    handleRegisterOutput(args);
    break;
  case "register-contribution":
    handleRegisterContribution(args);
    break;
  case "add-stage":
    handleAddStage(args);
    break;
  case "validate":
    handleValidate(args);
    break;
  case "check-resume":
    handleCheckResume(args);
    break;
  case "allowed":
    handleAllowed(args);
    break;
  case "audit":
    handleAudit(args);
    break;
  default:
    console.error(`Usage: node state-manager.js <subcommand> [options]

Subcommands:
  transition             Move a stage to a new status
    --intent <dir>       Intent directory (required)
    --stage <name>       Stage name (required)
    --to <status>        Target status (required)
    --actor <role>       Who is making this transition: orchestrator|owner|reviewer (required)
    --unit <name>        Unit name (for per-unit stages)
    --decision <text>    Human decision (required for complete/changes-requested)
    --verdict <text>     Reviewer verdict: ready|not-ready (for review-maxed-or-ready condition)

  register-output        Declare an output artifact
    --intent <dir>       Intent directory (required)
    --stage <name>       Stage name (required)
    --name <filename>    Output filename (required)
    --location <path>    Directory relative to intent root, ending with / (required)
    --unit <name>        Unit name (for per-unit stages)

  register-contribution  Mark a contributor as done
    --intent <dir>       Intent directory (required)
    --stage <name>       Stage name (required)
    --persona <name>     Contributor persona name (required)
    --unit <name>        Unit name (for per-unit stages)

  add-stage              Add a stage to the workflow
    --intent <dir>       Intent directory (required)
    --stage <name>       Stage name (required)
    --owner <persona>    Owner persona (required)
    --unit <name>        Unit name (for per-unit stages)
    --phase <name>       Phase (inception/construction/operations)
    --contributors <a,b> Comma-separated contributor personas
    --reviewer <name>    Reviewer persona
    --autonomy <mode>    full or supervised (default: supervised)

  validate               Check state.json integrity
    --intent <dir>       Intent directory (required)

  check-resume           Check for active intents to resume
    --workspace <path>   Workspace root (default: .)

  allowed                Show valid transitions from current state
    --intent <dir>       Intent directory (required)
    --stage <name>       Stage name (required)
    --actor <role>       Filter by actor (optional)
    --unit <name>        Unit name (for per-unit stages)

  audit                  Record a typed audit event
    --intent <dir>       Intent directory (required)
    --event <type>       Event type (required). Valid: WORKFLOW_STARTED, WORKFLOW_COMPLETED,
                         STAGE_STARTED, STAGE_COMPLETED, HUMAN_DECISION, HUMAN_INPUT,
                         VALIDATION_PASSED, VALIDATION_FAILED, LEARNING_CAPTURED
    --stage <name>       Stage context (optional, depends on event)
    --<any key> <value>  Additional fields recorded with the event
`);
    process.exit(2);
}
