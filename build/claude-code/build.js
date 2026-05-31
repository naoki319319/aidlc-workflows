#!/usr/bin/env node
/**
 * build/claude-code/build.js — Build the Claude Code distribution.
 *
 * Transforms:
 *   src/personas/*.yaml      → dist/claude-code/.claude/agents/*.json
 *   src/skills/              → dist/claude-code/.claude/skills/        (copy)
 *   src/stages/              → dist/claude-code/.claude/stages/        (copy)
 *   src/conventions/         → dist/claude-code/.claude/conventions/   (copy)
 *   src/tools/               → dist/claude-code/.claude/tools/         (copy)
 *   (generated)              → dist/claude-code/.claude/settings.json  (hooks)
 *   (generated)              → dist/claude-code/.claude/CLAUDE.md      (entrypoint)
 *
 * Usage: node build/claude-code/build.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist", "claude-code", ".claude");

// --- Helpers ---

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cpR(src, dest) {
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

function parseYaml(content) {
  const result = {};
  const lines = content.split("\n");
  let currentKey = null;
  let currentValue = "";
  let blockMode = null;

  function flush() {
    if (currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = currentValue.trim();
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = keyMatch[1];
      const valueAfterColon = keyMatch[2].trim();

      if (valueAfterColon === "|" || valueAfterColon === ">") {
        blockMode = valueAfterColon;
        currentValue = "";
      } else if (valueAfterColon === "" || valueAfterColon === "[]") {
        if (valueAfterColon === "[]") {
          result[currentKey] = [];
          currentKey = null;
        } else {
          if (i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
            result[currentKey] = [];
            blockMode = "array";
            currentValue = "";
          } else {
            blockMode = null;
            currentValue = "";
          }
        }
      } else {
        blockMode = null;
        currentValue = valueAfterColon;
      }
      continue;
    }

    if (blockMode === "array" && line.match(/^\s+-\s/)) {
      const item = line.replace(/^\s+-\s*/, "").trim();
      result[currentKey].push(item);
      continue;
    }

    if (blockMode === "|" || blockMode === ">") {
      if (line.match(/^\s/) || line === "") {
        currentValue += (blockMode === ">" && currentValue && line.trim() ? " " : "") +
          (blockMode === "|" ? line.replace(/^ {2}/, "") + "\n" : line.trim()) +
          (blockMode === ">" && line === "" ? "\n" : "");
      } else {
        flush();
        blockMode = null;
        i--;
      }
      continue;
    }
  }
  flush();
  return result;
}

function personaToAgent(yamlContent) {
  const persona = parseYaml(yamlContent);

  // Append generic skills to the prompt
  const genericSkillsDir = path.join(SRC, "skills", "generic");
  let genericSkillsContent = "";
  if (fs.existsSync(genericSkillsDir)) {
    for (const skillDir of fs.readdirSync(genericSkillsDir, { withFileTypes: true })) {
      if (!skillDir.isDirectory()) continue;
      const skillFile = path.join(genericSkillsDir, skillDir.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        genericSkillsContent += "\n\n" + fs.readFileSync(skillFile, "utf-8");
      }
    }
  }

  return {
    name: persona.name || "",
    description: (persona.description || "").trim(),
    prompt: yamlContent + genericSkillsContent,
    tools: ["read", "write", "shell"],
  };
}

// --- Main ---

console.log("Building dist/claude-code/ ...");

// Clean
rmrf(path.join(ROOT, "dist", "claude-code"));
fs.mkdirSync(OUT, { recursive: true });

// 1. Convert personas to agents
const agentsDir = path.join(OUT, "agents");
fs.mkdirSync(agentsDir, { recursive: true });

const personasDir = path.join(SRC, "personas");
if (fs.existsSync(personasDir)) {
  for (const file of fs.readdirSync(personasDir)) {
    if (!file.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(personasDir, file), "utf-8");
    const agent = personaToAgent(content);
    const jsonName = file.replace(".yaml", ".json");
    fs.writeFileSync(
      path.join(agentsDir, jsonName),
      JSON.stringify(agent, null, 2) + "\n"
    );
  }
}

// 2. Copy skills
cpR(path.join(SRC, "skills"), path.join(OUT, "skills"));

// 3. Copy stages
cpR(path.join(SRC, "stages"), path.join(OUT, "stages"));

// 4. Copy conventions
cpR(path.join(SRC, "conventions"), path.join(OUT, "conventions"));

// 5. Copy tools
cpR(path.join(SRC, "tools"), path.join(OUT, "tools"));

// 6. Generate settings.json with hooks
const settings = {
  hooks: {
    SubagentStop: [
      {
        hooks: [
          {
            type: "command",
            command: "echo '[AI-DLC] Sub-agent completed. Run process checker: node .claude/tools/process-checker.js <intent-dir>' >> .claude/agent.log"
          }
        ]
      }
    ]
  }
};
fs.writeFileSync(
  path.join(OUT, "settings.json"),
  JSON.stringify(settings, null, 2) + "\n"
);

// 7. Generate CLAUDE.md entrypoint
const claudeMd = `# AI-DLC Workflow

This workspace uses the AI-DLC multi-agent workflow framework.

## Entry Point

The orchestration skill is the main agent skill. Activate it for any development intent.

- Orchestration skill: \`.claude/skills/orchestration/SKILL.md\`
- Stage definitions: \`.claude/stages/\`
- Conventions: \`.claude/conventions/\`
- Tools: \`.claude/tools/\`
- Sub-agent personas: \`.claude/agents/\`

## How It Works

1. State your development intent
2. The orchestrator composes an adaptive workflow from the stage graph
3. Personas are invoked as sub-agents with: \`stage:\`, \`status:\`, \`directory:\`
4. Each persona self-directs using their skills and the work-method
5. Process checker validates outputs and reviews after each sub-agent completes

Read \`.claude/skills/orchestration/SKILL.md\` for the full orchestration protocol.
`;
fs.writeFileSync(path.join(OUT, "CLAUDE.md"), claudeMd);

// 8. Verify
console.log("Verifying ...");
let failures = 0;

// JSON files must parse
function findFiles(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, predicate));
    else if (predicate(entry.name)) results.push(full);
  }
  return results;
}

const jsonFiles = findFiles(OUT, (name) => name.endsWith(".json"));
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    console.error(`  FAIL: invalid JSON: ${file}`);
    failures++;
  }
}

// SKILL.md must have name:
const skillFiles = findFiles(path.join(OUT, "skills"), (name) => name === "SKILL.md");
for (const file of skillFiles) {
  const content = fs.readFileSync(file, "utf-8");
  if (!/^name:/m.test(content)) {
    console.error(`  FAIL: ${file} missing name: in frontmatter`);
    failures++;
  }
}

// process-checker.js must syntax-check
const checker = path.join(OUT, "tools", "process-checker.js");
if (fs.existsSync(checker)) {
  try {
    execSync(`node --check "${checker}"`, { stdio: "pipe" });
  } catch {
    console.error("  FAIL: process-checker.js has syntax errors");
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} verification failure(s).`);
  process.exit(1);
}

console.log("  → dist/claude-code/.claude/");
