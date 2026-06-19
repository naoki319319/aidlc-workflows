// config.ts — RunnerConfig tree the postrun + contract-sandbox paths read.
//
// Ports execution/config.py:14-90 — the dataclass defaults (AwsConfig,
// ModelConfig, ModelsConfig, AidlcConfig, SwarmConfig, RunsConfig,
// SandboxConfig, ExecutionConfig, RunnerConfig) plus the load_config /
// _merge_dict_into_dataclass loading path (config.py:81-119).
//
// Why a TS module: the faithful postrun rewrite (run_post_evaluation) reads
// config.execution.post_run_timeout (300) and config.execution.sandbox.{enabled,
// image,memory,cpus} (True / aidlc-sandbox:latest / 2g / 2); the contract
// sandbox path reads the same SandboxConfig (PORT-PLAN.md:354-357).
//
// FIDELITY NOTE on int-vs-float: Python types execution_timeout/node_timeout as
// float (config.py:45-46, 14400.0 / 3600.0) while command_timeout/post_run_timeout
// and cpus are int (config.py:59,65,67). JS Number erases this distinction, but a
// consumer serializing these to YAML must wrap the two SwarmConfig timeouts with
// pyFloat() (from yaml.ts) to emit "14400.0" not "14400" — see PyFloat. The values
// themselves are byte-identical numerically here; the smoke test asserts them.
//
// default_factory semantics (config.py:28-29,73-78): each RunnerConfig and every
// nested dataclass gets FRESH nested instances. defaultRunnerConfig() returns a
// freshly-built tree on every call so mutating one config never leaks into another.

// ── dataclass shapes (local to this module per PORT-PLAN type-namespacing) ──

// config.py:14-17
export interface AwsConfig {
  profile: string | null;
  region: string | null;
}

// config.py:20-23
export interface ModelConfig {
  provider: string;
  model_id: string;
}

// config.py:26-29
export interface ModelsConfig {
  executor: ModelConfig;
  simulator: ModelConfig;
}

// config.py:32-38
export interface AidlcConfig {
  rules_source: string;
  rules_repo: string;
  rules_local_path: string | null;
  rules_ref: string;
  rules_version: string;
}

// config.py:41-46 — execution_timeout/node_timeout are Python floats.
export interface SwarmConfig {
  max_handoffs: number;
  max_iterations: number;
  execution_timeout: number;
  node_timeout: number;
}

// config.py:49-51
export interface RunsConfig {
  output_dir: string;
}

// config.py:54-59 — cpus is a Python int.
export interface SandboxConfig {
  enabled: boolean;
  image: string;
  memory: string;
  cpus: number;
}

// config.py:62-68 — command_timeout/post_run_timeout are Python ints.
export interface ExecutionConfig {
  enabled: boolean;
  command_timeout: number;
  post_run_tests: boolean;
  post_run_timeout: number;
  sandbox: SandboxConfig;
}

// config.py:71-78
export interface RunnerConfig {
  aws: AwsConfig;
  models: ModelsConfig;
  aidlc: AidlcConfig;
  swarm: SwarmConfig;
  runs: RunsConfig;
  execution: ExecutionConfig;
}

// ── default factories — one per dataclass, each returns a FRESH instance ─────
// Mirrors the field defaults + field(default_factory=...) wiring exactly.

// config.py:14-17
function defaultAwsConfig(): AwsConfig {
  return { profile: null, region: null };
}

// config.py:20-23
function defaultModelConfig(): ModelConfig {
  return { provider: "bedrock", model_id: "global.anthropic.claude-opus-4-6-v1" };
}

// config.py:26-29 — both default_factory=ModelConfig.
function defaultModelsConfig(): ModelsConfig {
  return { executor: defaultModelConfig(), simulator: defaultModelConfig() };
}

// config.py:32-38
function defaultAidlcConfig(): AidlcConfig {
  return {
    rules_source: "git",
    rules_repo: "https://github.com/awslabs/aidlc-workflows.git",
    rules_local_path: null,
    rules_ref: "v2",
    rules_version: "v2",
  };
}

// config.py:41-46
function defaultSwarmConfig(): SwarmConfig {
  return {
    max_handoffs: 200,
    max_iterations: 200,
    execution_timeout: 14400.0,
    node_timeout: 3600.0,
  };
}

// config.py:49-51
function defaultRunsConfig(): RunsConfig {
  return { output_dir: "./runs" };
}

// config.py:54-59
export function defaultSandboxConfig(): SandboxConfig {
  return { enabled: true, image: "aidlc-sandbox:latest", memory: "2g", cpus: 2 };
}

// config.py:62-68 — sandbox via default_factory=SandboxConfig.
export function defaultExecutionConfig(): ExecutionConfig {
  return {
    enabled: true,
    command_timeout: 120,
    post_run_tests: true,
    post_run_timeout: 300,
    sandbox: defaultSandboxConfig(),
  };
}

// config.py:71-78 — every field via default_factory → fresh nested instances.
export function defaultRunnerConfig(): RunnerConfig {
  return {
    aws: defaultAwsConfig(),
    models: defaultModelsConfig(),
    aidlc: defaultAidlcConfig(),
    swarm: defaultSwarmConfig(),
    runs: defaultRunsConfig(),
    execution: defaultExecutionConfig(),
  };
}

// ── load_config / _merge_dict_into_dataclass (config.py:81-119) ──────────────
// The Python recurses a dict into a dataclass instance: unknown keys are
// warn-and-ignored, nested dicts recurse into nested dataclasses, and None
// values are skipped (so an explicit null in YAML/overrides does NOT clobber a
// default — config.py:90).
//
// In TS the "is this a nested dataclass?" check (Python: hasattr(current,
// "__dataclass_fields__")) becomes "is the current value a plain object?" — the
// default tree only nests with plain objects (no arrays/PyFloat), so an object
// current + object value recurses; everything else is a leaf assignment.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// config.py:81-91 — recursively merge a dict into a dataclass instance.
function mergeDictIntoDataclass(dc: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    // config.py:84-86 — `if not hasattr(dc, key)`: unknown key → warn + ignore.
    if (!Object.prototype.hasOwnProperty.call(dc, key)) {
      console.warn(`Unknown config key ${JSON.stringify(key)} (ignored) — check for typos`);
      continue;
    }
    const current = dc[key];
    // config.py:88-89 — dict value into a nested dataclass → recurse.
    if (isPlainObject(value) && isPlainObject(current)) {
      mergeDictIntoDataclass(current, value);
    } else if (value !== null && value !== undefined) {
      // config.py:90-91 — skip None; otherwise set.
      dc[key] = value;
    }
  }
}

// config.py:94-119 — start from defaults, merge YAML data (if given), then merge
// CLI overrides (if given). The caller yaml-parses the file first (Bun.YAML.parse)
// and passes the parsed object as `yamlData` — mirroring Python's
// `yaml.safe_load(f) or {}` (config.py:113), so pass {} when the file is empty.
export function loadConfig(
  yamlData?: Record<string, unknown> | null,
  cliOverrides?: Record<string, unknown> | null,
): RunnerConfig {
  // config.py:107
  const config = defaultRunnerConfig();

  // config.py:109-114 — merge the parsed YAML config if provided.
  if (yamlData) {
    mergeDictIntoDataclass(config as unknown as Record<string, unknown>, yamlData);
  }

  // config.py:116-117 — apply CLI overrides on top.
  if (cliOverrides) {
    mergeDictIntoDataclass(config as unknown as Record<string, unknown>, cliOverrides);
  }

  return config;
}
