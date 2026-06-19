// config.test.ts — smoke test for the ported RunnerConfig default tree.
//
// No Python test file targets config directly (it's a support module), so this
// asserts the default tree matches the Python dataclass defaults verbatim
// (execution/config.py:14-78, focus 54-78) plus the load_config /
// _merge_dict_into_dataclass loading behaviour (config.py:81-119).

import { describe, expect, test } from "bun:test";
import {
  defaultExecutionConfig,
  defaultRunnerConfig,
  defaultSandboxConfig,
  loadConfig,
} from "./config.ts";

describe("defaultRunnerConfig — Python dataclass defaults (config.py:14-78)", () => {
  test("aws defaults (config.py:14-17)", () => {
    const c = defaultRunnerConfig();
    expect(c.aws).toEqual({ profile: null, region: null });
  });

  test("models default to bedrock + claude-opus-4-6 (config.py:20-29)", () => {
    const c = defaultRunnerConfig();
    expect(c.models.executor).toEqual({
      provider: "bedrock",
      model_id: "global.anthropic.claude-opus-4-6-v1",
    });
    expect(c.models.simulator).toEqual({
      provider: "bedrock",
      model_id: "global.anthropic.claude-opus-4-6-v1",
    });
  });

  test("aidlc defaults (config.py:32-38)", () => {
    const c = defaultRunnerConfig();
    expect(c.aidlc).toEqual({
      rules_source: "git",
      rules_repo: "https://github.com/awslabs/aidlc-workflows.git",
      rules_local_path: null,
      rules_ref: "v2",
      rules_version: "v2",
    });
  });

  test("swarm defaults — float timeouts (config.py:41-46)", () => {
    const c = defaultRunnerConfig();
    expect(c.swarm).toEqual({
      max_handoffs: 200,
      max_iterations: 200,
      execution_timeout: 14400.0,
      node_timeout: 3600.0,
    });
  });

  test("runs default output_dir (config.py:49-51)", () => {
    const c = defaultRunnerConfig();
    expect(c.runs).toEqual({ output_dir: "./runs" });
  });

  // config.py:54-59 — the SandboxConfig defaults the task pins explicitly.
  test("sandbox defaults: enabled/image/memory/cpus (config.py:54-59)", () => {
    const c = defaultRunnerConfig();
    expect(c.execution.sandbox).toEqual({
      enabled: true,
      image: "aidlc-sandbox:latest",
      memory: "2g",
      cpus: 2,
    });
    // factory returns the same shape standalone.
    expect(defaultSandboxConfig()).toEqual({
      enabled: true,
      image: "aidlc-sandbox:latest",
      memory: "2g",
      cpus: 2,
    });
  });

  // config.py:62-68 — ExecutionConfig defaults (post_run_timeout=300, etc.).
  test("execution defaults: enabled/command_timeout/post_run_tests/post_run_timeout (config.py:62-68)", () => {
    const c = defaultRunnerConfig();
    expect(c.execution.enabled).toBe(true);
    expect(c.execution.command_timeout).toBe(120);
    expect(c.execution.post_run_tests).toBe(true);
    expect(c.execution.post_run_timeout).toBe(300);
    // standalone factory carries a fresh sandbox.
    expect(defaultExecutionConfig().sandbox).toEqual(defaultSandboxConfig());
  });

  // config.py:71-78 — full RunnerConfig.execution subtree the postrun +
  // contract-sandbox paths actually read.
  test("RunnerConfig.execution full subtree (config.py:71-78)", () => {
    const c = defaultRunnerConfig();
    expect(c.execution).toEqual({
      enabled: true,
      command_timeout: 120,
      post_run_tests: true,
      post_run_timeout: 300,
      sandbox: {
        enabled: true,
        image: "aidlc-sandbox:latest",
        memory: "2g",
        cpus: 2,
      },
    });
  });

  // config.py:73-78 — every field via field(default_factory=...) → fresh nested
  // instances; mutating one tree must not leak into another.
  test("default_factory gives fresh nested objects per call (config.py:28-29,73-78)", () => {
    const a = defaultRunnerConfig();
    const b = defaultRunnerConfig();
    expect(a.execution.sandbox).not.toBe(b.execution.sandbox);
    expect(a.models.executor).not.toBe(b.models.executor);
    a.execution.sandbox.cpus = 99;
    a.models.executor.model_id = "mutated";
    expect(b.execution.sandbox.cpus).toBe(2);
    expect(b.models.executor.model_id).toBe("global.anthropic.claude-opus-4-6-v1");
  });
});

describe("loadConfig — _merge_dict_into_dataclass (config.py:81-119)", () => {
  test("no overrides → defaults (config.py:107)", () => {
    expect(loadConfig()).toEqual(defaultRunnerConfig());
  });

  test("nested dict recurses into nested dataclass (config.py:88-89)", () => {
    const c = loadConfig({ execution: { sandbox: { memory: "4g", cpus: 8 } } });
    expect(c.execution.sandbox.memory).toBe("4g");
    expect(c.execution.sandbox.cpus).toBe(8);
    // siblings untouched.
    expect(c.execution.sandbox.image).toBe("aidlc-sandbox:latest");
    expect(c.execution.post_run_timeout).toBe(300);
  });

  test("None/null value is skipped, default preserved (config.py:90)", () => {
    const c = loadConfig({ execution: { post_run_timeout: null } });
    expect(c.execution.post_run_timeout).toBe(300);
  });

  test("unknown key warn-and-ignored (config.py:84-86)", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warned.push(String(msg));
    };
    try {
      const c = loadConfig({ bogus_key: 1, execution: { also_bogus: true } });
      // unknown keys ignored; config still the default tree.
      expect(c).toEqual(defaultRunnerConfig());
      expect((c as unknown as Record<string, unknown>)["bogus_key"]).toBeUndefined();
    } finally {
      console.warn = orig;
    }
    expect(warned.some((w) => w.includes("bogus_key"))).toBe(true);
    expect(warned.some((w) => w.includes("also_bogus"))).toBe(true);
  });

  test("cli overrides apply on top of yaml (config.py:116-117)", () => {
    const c = loadConfig(
      { execution: { command_timeout: 60 } },
      { execution: { command_timeout: 90, post_run_tests: false } },
    );
    expect(c.execution.command_timeout).toBe(90);
    expect(c.execution.post_run_tests).toBe(false);
  });

  test("leaf override replaces value (config.py:90-91)", () => {
    const c = loadConfig({ runs: { output_dir: "/tmp/runs" }, aidlc: { rules_ref: "main" } });
    expect(c.runs.output_dir).toBe("/tmp/runs");
    expect(c.aidlc.rules_ref).toBe("main");
    expect(c.aidlc.rules_version).toBe("v2");
  });
});
