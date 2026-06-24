// scripts/contribution-schema.ts — the §4 per-stage contribution format.
//
// A contribution lives at extensions/<bundle>/contributions/<phase>/<slug>.md and
// ADDITIVELY modifies an EXISTING core stage without editing the core file. The
// packager's mergeContributions pass (scripts/package.ts) parses these, unions
// the structural `adds` into the target stage's frontmatter, and splices the
// prose `fragments` into the stage body — all in the temp build tree before
// compile, so the result lands in the bundle's committed delta. Build-side
// (like extension-types.ts), not a runtime tool.
//
// File shape:
//   ---
//   target: nfr-requirements          # an existing core stage slug
//   bundle: ops-min                   # the owning bundle
//   adds:                             # structural — set-unioned into the stage node
//     produces: [ops-min-operational-nfr-requirements]   # each <bundle>- prefixed
//     consumes: [{artifact: foo, required: false}]
//     sensors: [required-sections]
//     requires_stage: [some-stage]
//     required_sections: ["Operational NFRs"]
//   fragments:                        # prose — appended into the stage body
//     - anchor: after-step:6
//       order: 100
//   ---
//   ## fragment: after-step:6
//   ### Step (ops-min): ...prose...
//
// Each `fragments` entry's prose is the body H2 block headed `## fragment: <anchor>`.

// Anchors with no parameter. `after-questions` lands a fragment after the
// stage's questions-generating step (the `### Step` whose heading mentions
// "Questions"); `end-of-steps` appends at the end of the `## Steps` block.
export const ALLOWED_ANCHORS = ["end-of-steps", "after-questions"] as const;
// Parameterised anchors (validated by regex, not the literal set):
//   after-step:<n> / before-step:<n> — relative to `### Step <n>`
//   in:<Compartment>                 — append within a named `## <Compartment>`
//                                      H2 block (e.g. in:Sensors, in:Learn)
const STEP_ANCHOR_RE = /^(after-step|before-step):\d+$/;
const COMPARTMENT_ANCHOR_RE = /^in:[A-Za-z][A-Za-z0-9 ]*$/;

export type ContributionConsume = {
  artifact: string;
  required: boolean;
  conditional_on?: string;
};

export type ContributionAdds = {
  produces: string[];
  consumes: ContributionConsume[];
  sensors: string[];
  requires_stage: string[];
  required_sections: string[];
};

export type Fragment = {
  anchor: string;
  order: number;
  /** The prose block (the body under `## fragment: <anchor>`). */
  body: string;
};

export type Contribution = {
  target: string;
  bundle: string;
  adds: ContributionAdds;
  fragments: Fragment[];
};

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

function anchorValid(anchor: string): boolean {
  return (
    (ALLOWED_ANCHORS as readonly string[]).includes(anchor) ||
    STEP_ANCHOR_RE.test(anchor) ||
    COMPARTMENT_ANCHOR_RE.test(anchor)
  );
}

// --- Parser (zero-dep, narrow — only the shapes the contribution format uses) ---

function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("Contribution file missing YAML frontmatter (---...---)");
  return { fm: m[1], body: m[2] ?? "" };
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse a `key: [a, b]` flow list OR a YAML block list under `key:`. Returns the
// raw string items (quote-stripped). Used for adds.produces/sensors/requires_stage/
// required_sections.
function parseStringList(lines: string[], start: number): { items: string[]; next: number } {
  const header = lines[start];
  const inline = header.match(/:\s*\[(.*)\]\s*$/);
  if (inline) {
    const items = inline[1]
      .split(",")
      .map((s) => stripQuotes(s))
      .filter((s) => s.length > 0);
    return { items, next: start + 1 };
  }
  // Block list: subsequent more-indented `- item` lines.
  const items: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+(.*\S)\s*$/);
    if (!m) break;
    items.push(stripQuotes(m[1]));
  }
  return { items, next: i };
}

// parseContribution — parse a contribution .md into a Contribution. Throws on
// malformed structure; semantic validation is validateContribution.
export function parseContribution(raw: string): Contribution {
  const { fm, body } = splitFrontmatter(raw);
  const lines = fm.split(/\r?\n/);

  const adds: ContributionAdds = {
    produces: [],
    consumes: [],
    sensors: [],
    requires_stage: [],
    required_sections: [],
  };
  let target = "";
  let bundle = "";
  const fragMeta: Array<{ anchor: string; order: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const top = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const val = top[2];

    if (key === "target") target = stripQuotes(val);
    else if (key === "bundle") bundle = stripQuotes(val);
    else if (key === "when") {
      // Parsed but ignored — a contribution is active iff its bundle's variant
      // is being built (implicit bundle-active). No predicate to evaluate here.
    } else if (key === "adds") {
      // Nested block: indented `produces:`/`consumes:`/`sensors:`/... keys.
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j].match(/^\s+([a-z_]+):\s*(.*)$/);
        if (!sub) {
          // stop when we dedent back to a top-level key (non-indented, has colon)
          if (/^[a-z_]+:/.test(lines[j])) break;
          continue;
        }
        const subKey = sub[1];
        if (subKey === "consumes") {
          // object list: `- artifact: x` [`  required: bool`] [`  conditional_on: y`]
          let k = j + 1;
          for (; k < lines.length; k++) {
            const item = lines[k].match(/^\s+-\s+artifact:\s*(.*\S)\s*$/);
            if (item) {
              adds.consumes.push({ artifact: stripQuotes(item[1]), required: true });
              continue;
            }
            const reqLine = lines[k].match(/^\s+required:\s*(true|false)\s*$/);
            if (reqLine && adds.consumes.length > 0) {
              adds.consumes[adds.consumes.length - 1].required = reqLine[1] === "true";
              continue;
            }
            const condLine = lines[k].match(/^\s+conditional_on:\s*(.*\S)\s*$/);
            if (condLine && adds.consumes.length > 0) {
              adds.consumes[adds.consumes.length - 1].conditional_on = stripQuotes(condLine[1]);
              continue;
            }
            break;
          }
          j = k - 1;
        } else if (subKey in adds) {
          const { items, next } = parseStringList(lines, j);
          (adds as unknown as Record<string, string[]>)[subKey] = items;
          j = next - 1;
        }
      }
    } else if (key === "fragments") {
      // list of `- anchor: X` / `  order: N`
      let current: { anchor: string; order: number } | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[j].match(/^\s+-\s+anchor:\s*(.*\S)\s*$/);
        const o = lines[j].match(/^\s+order:\s*(\d+)\s*$/);
        if (a) {
          if (current) fragMeta.push(current);
          current = { anchor: stripQuotes(a[1]), order: 0 };
        } else if (o && current) {
          current.order = parseInt(o[1], 10);
        } else if (/^[a-z_]+:/.test(lines[j])) {
          break;
        }
      }
      if (current) fragMeta.push(current);
    }
  }

  // Resolve each fragment's prose from a `## fragment: <anchor>` body block.
  const fragments: Fragment[] = fragMeta.map((f) => ({
    anchor: f.anchor,
    order: f.order,
    body: extractFragmentBody(body, f.anchor),
  }));

  return { target, bundle, adds, fragments };
}

// Extract the prose under `## fragment: <anchor>` up to the next `## ` H2 (or EOF).
function extractFragmentBody(body: string, anchor: string): string {
  const lines = body.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() === `## fragment: ${anchor}`);
  if (headerIdx === -1) return "";
  const out: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

// --- Validator ---

export type ContributionContext = { coreSlugs: ReadonlySet<string>; bundle: string };

export function validateContribution(c: Contribution, ctx: ContributionContext): string[] {
  const errors: string[] = [];
  if (!c.target) errors.push("missing target");
  else if (!ctx.coreSlugs.has(c.target)) {
    errors.push(`target "${c.target}" is not a known core stage slug`);
  }
  if (c.bundle !== ctx.bundle) {
    errors.push(`bundle "${c.bundle}" must match the owning extension "${ctx.bundle}"`);
  }
  // Contributed artifacts are bundle-owned: kebab AND <bundle>- prefixed.
  for (const art of c.adds.produces) {
    if (!KEBAB_RE.test(art)) errors.push(`adds.produces "${art}" must be kebab-case`);
    else if (!art.startsWith(`${ctx.bundle}-`)) {
      errors.push(`adds.produces "${art}" must be prefixed "${ctx.bundle}-"`);
    }
  }
  for (const con of c.adds.consumes) {
    if (!KEBAB_RE.test(con.artifact)) {
      errors.push(`adds.consumes artifact "${con.artifact}" must be kebab-case`);
    }
  }
  for (const s of c.adds.sensors) {
    if (!KEBAB_RE.test(s)) errors.push(`adds.sensors "${s}" must be kebab-case`);
  }
  for (const f of c.fragments) {
    if (!anchorValid(f.anchor)) {
      errors.push(
        `fragment anchor "${f.anchor}" is not allowed ` +
          `(after-step:<n> | before-step:<n> | end-of-steps | after-questions | in:<Compartment>)`,
      );
    }
    if (!Number.isInteger(f.order)) errors.push(`fragment "${f.anchor}" order must be an integer`);
    if (!f.body) errors.push(`fragment "${f.anchor}" has no prose body (expected a "## fragment: ${f.anchor}" block)`);
  }
  return errors;
}
