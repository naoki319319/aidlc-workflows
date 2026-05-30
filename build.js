#!/usr/bin/env node
/**
 * build.js — Build the Kiro distribution from src/.
 *
 * Usage: node build.js [build|clean]
 *
 * Output: dist/kiro/.kiro/  (works for both Kiro IDE and Kiro CLI)
 *
 * Sources:
 *   src/kiro/agents/           → dist/kiro/.kiro/agents/
 *   src/kiro/aidlc-common/     → dist/kiro/.kiro/aidlc-common/
 *   src/skills/                → dist/kiro/.kiro/skills/
 *   src/kiro/hooks/            → dist/kiro/.kiro/hooks/
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const KIRO_SRC = path.join(SRC, "kiro");
const OUT = path.join(ROOT, "dist", "kiro", ".kiro");

// --- Helpers ---

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cpR(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function findFiles(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, predicate));
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// --- Commands ---

function clean() {
  rmrf(path.join(ROOT, "dist"));
  console.log("Cleaned dist/");
}

function build() {
  console.log("Building dist/kiro/ ...");

  // Wipe and recreate
  rmrf(path.join(ROOT, "dist", "kiro"));
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy platform-specific files from src/kiro/
  cpR(path.join(KIRO_SRC, "agents"), path.join(OUT, "agents"));
  cpR(path.join(KIRO_SRC, "aidlc-common"), path.join(OUT, "aidlc-common"));

  // 2. Copy shared skills from src/skills/
  cpR(path.join(SRC, "skills"), path.join(OUT, "skills"));

  // 3. Copy Kiro-specific hooks
  const hooksOut = path.join(OUT, "hooks");
  fs.mkdirSync(hooksOut, { recursive: true });
  const hooksSrc = path.join(KIRO_SRC, "hooks");
  if (fs.existsSync(hooksSrc)) {
    const hookFiles = fs.readdirSync(hooksSrc);
    for (const file of hookFiles) {
      if (file.startsWith(".")) continue;
      fs.copyFileSync(path.join(hooksSrc, file), path.join(hooksOut, file));
    }
  }

  // 4. Validate
  console.log("Validating ...");
  let failures = 0;

  // 4a. Every JSON and .kiro.hook file must parse
  const jsonFiles = findFiles(OUT, (name) => name.endsWith(".json") || name.endsWith(".kiro.hook"));
  for (const file of jsonFiles) {
    try {
      JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      console.error(`  FAIL: invalid JSON: ${file}`);
      failures++;
    }
  }

  // 4b. Every SKILL.md must have required frontmatter fields
  const skillFiles = findFiles(path.join(OUT, "skills"), (name) => name === "SKILL.md");
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const isOrchestrator = file.includes("aidlc-orchestrator");
    const requiredFields = isOrchestrator ? ["name"] : ["name", "phase", "stage"];

    for (const field of requiredFields) {
      const re = new RegExp(`^\\s*${field}:`, "m");
      if (!re.test(content)) {
        console.error(`  FAIL: ${file} missing frontmatter field '${field}'`);
        failures++;
      }
    }
  }

  // 4c. Process-checker must syntax-check
  const processChecker = path.join(OUT, "aidlc-common", "scripts", "aidlc-process-checker.js");
  try {
    execSync(`node --check "${processChecker}"`, { stdio: "pipe" });
  } catch (e) {
    console.error(`  FAIL: process-checker.js has syntax errors`);
    failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} validation failure(s).`);
    process.exit(1);
  }

  console.log("  → dist/kiro/.kiro/  (use for both Kiro IDE and Kiro CLI)");
}

// --- Main ---

const command = process.argv[2] || "build";

switch (command) {
  case "clean":
    clean();
    break;
  case "build":
    build();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: node build.js [build|clean]");
    process.exit(2);
}
