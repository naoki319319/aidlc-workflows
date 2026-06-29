# Construction Phase -- Stage Reference (3.1-3.6)

## Phase Overview

The Construction phase transforms design artifacts from Inception into working,
tested software. It covers six stages (3.1 through 3.6) that span functional
design, non-functional design, infrastructure design, code
generation, build/test verification, and CI pipeline configuration.

Construction is the fourth of five phases in the AI-DLC methodology. It is
driven by the **execution plan** produced during Delivery Planning (Stage 2.9).
The plan determines which stages execute, which are skipped, and in what order
units are built.

All stages follow `stage-protocol.md` for approval gates, question format,
completion messages, and state tracking.

---

## Bolt-by-Bolt Construction

Construction executes **Bolt by Bolt**, driven by `bolt-plan.md` (Bolt
sequence + walking-skeleton marker) from stage 2.9 and the dependency DAG
from stage 2.7. A [Bolt](../../guide/glossary.md) is one pass through stages
3.1–3.4 for a Unit or small group of dependency-linked Units. Stages 3.5
(Build and Test) and 3.6 (CI Pipeline) run **once** at the end across all
Bolts.

```
Bolt 1 (walking skeleton) — always gated:
  Questions (3.1–3.3 across the Bolt's Units in QUESTION-ONLY mode)
  → Answers gate (Bolt-level)
  Design artifacts (3.1–3.3 in ARTIFACT-ONLY mode)
  Code generation (3.4 per Unit via Task delegation)
  → Walking-skeleton gate
  → Ladder prompt (fires once): "autonomous" or "gated"
  → Write Construction Autonomy Mode to state

Bolt 2..N — autonomy mode governs the gate:
  (Parallel-eligible Bolts run as a batch; single batch-level gate covers
   every Bolt in it.)
  Questions → Answers gate (Bolt-level) → Design → Code-gen → Bolt/batch
  gate (skipped if autonomous). Failure always halts and asks.

After all Bolts:
  3.5 Build and Test (runs once across the full codebase)
  3.6 CI Pipeline    (runs once, conditional)
```

Each design stage file (3.1–3.3) supports QUESTION-ONLY and ARTIFACT-ONLY
execution modes — see the individual stage files for details. The per-Unit
approval gate inside `code-generation.md` is **suppressed by the
engine** during normal Bolt execution; a single Bolt-level (or
batch-level) gate replaces it. The per-Unit gate remains for direct-
invocation use (e.g., `/aidlc --stage code-generation`).

**Parallel batches.** When two or more Bolts share dependency-satisfaction
and don't depend on each other, the conductor dispatches their Code
Generation stages concurrently by issuing N `Task` calls in a single
assistant message. One batch-level gate covers them all. Audit events
(`BOLT_STARTED`, `BOLT_COMPLETED`) carry a `Batch=N` field so siblings are
recoverable from the log.
and don't depend on each other, the conductor dispatches their Code
Generation stages concurrently by issuing N `Task` calls in a single
assistant message. One batch-level gate covers them all. Audit events
(`BOLT_STARTED`, `BOLT_COMPLETED`) carry a `Batch=N` field so siblings are
recoverable from the log.

**Failure handling.** A Bolt failure always halts Construction regardless
of autonomy mode. Options are retry (re-run just the failed Bolt), skip
(mark `[S]` and continue — dependent Bolts may also fail), or abort.
Successful siblings in a parallel batch keep their `[x]` status and
artifacts. See `stage-protocol.md` §1 "Construction Bolt gates" and
SKILL.md §CONSTRUCTION Flow for the canonical specification.

---

## Stage Summary Table

| Stage | Name                  | Execution   | Condition                                                                                          | Lead Agent          | Support Agents    | Mode                       | Per-Unit |
|-------|-----------------------|-------------|----------------------------------------------------------------------------------------------------|---------------------|-------------------|-----------------------------|----------|
| 3.1   | Functional Design     | CONDITIONAL | New data models, complex business logic, or business rules need design                             | aidlc-architect-agent     | aidlc-developer-agent   | inline                      | Yes      |
| 3.2   | NFR Design            | CONDITIONAL | Quality attributes (performance, security, scalability, reliability), tech-stack selection, or NFR patterns need to be made concrete | aidlc-architect-agent     | aidlc-aws-platform-agent, aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent | inline                      | Yes      |
| 3.3   | Infrastructure Design | CONDITIONAL | Infrastructure services need mapping, deployment architecture required, or cloud resources needed   | aidlc-aws-platform-agent  | aidlc-devsecops-agent, aidlc-compliance-agent   | inline                      | Yes      |
| 3.4   | Code Generation       | ALWAYS      | Always executes for every unit in the execution plan                                               | aidlc-developer-agent     | (none)            | subagent (aidlc-developer-agent)  | Yes      |
| 3.5   | Build and Test        | ALWAYS      | Always executes once after all per-unit stages are finished                                         | aidlc-quality-agent       | aidlc-devsecops-agent   | inline                      | No       |
| 3.6   | CI Pipeline           | CONDITIONAL | Execute when CI pipeline needs creation or significant modification                                | aidlc-pipeline-deploy-agent| (none)           | inline                      | No       |

---

## Stage 3.1: Functional Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.1                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | New data models, complex business logic, or business rules need design. Skip if simple logic changes with no new business logic. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-developer-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | unit-of-work.md, unit-of-work-story-map.md, requirements.md, components blueprint (domain-design), contracts (contract-design) |
| Outputs           | `aidlc-docs/construction/{unit-name}/functional-design/` -- entities.md, rules.md, api-specification.md, functional-spec.md |

### Purpose

Design the business logic, domain model, and rules for a single unit of work.
The aidlc-architect-agent leads with the aidlc-developer-agent providing technical
feasibility input.

### Inputs

- Unit definition from `aidlc-docs/inception/units-generation/unit-of-work.md`
- Assigned stories from `aidlc-docs/inception/units-generation/unit-of-work-story-map.md`
- Requirements from `aidlc-docs/inception/requirements-analysis/requirements.md`
- The `components` blueprint from `aidlc-docs/inception/domain-design/components.md`
  (the `cmp-NNN` component IDs entities and rules reference)
- Contracts from `aidlc-docs/inception/contract-design/` covering this unit's
  boundaries (if produced)

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-developer-agent persona and knowledge for technical implementation
   input. Apply aidlc-architect-agent as the primary perspective.

2. **Read Unit Context** -- Read the unit definition, assigned stories,
   requirements, and the `components` blueprint.

3. **Create Functional Design Plan** -- Analyze the unit's scope and create a
   questions file at
   `aidlc-docs/construction/{unit-name}/functional-design/functional-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Business logic workflows and algorithms
   - Domain models and entity relationships
   - Business rules, constraints, and validation logic
   - Data flow and transformations
   - Integration points with other units or external systems
   - Error handling and edge cases
   - Frontend components (component hierarchy, props/state, interaction flows,
     form validation)
   - Business scenarios (end-to-end user journeys, happy/unhappy paths,
     concurrency edge cases)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow (offer interaction mode choice, collect
   answers, write back to file). Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("mix of", "not sure", "depends", "probably")
   - Check for contradictions between answers
   - Flag missing details needed for artifact generation
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Generate Artifacts** -- Generate the following in
   `aidlc-docs/construction/{unit-name}/functional-design/`. Entities and rules
   carry stable IDs and **reference the `cmp-NNN` component IDs** from the
   upstream `components` blueprint they belong to:
   - **entities.md**: the structured entity model. Carries a fenced `yaml`
     block where every entity has a stable `ent-NNN` id, attributes (with
     types/constraints), relationships, lifecycle states, and the `cmp-NNN`
     component(s) that own it. A human-readable entity diagram + table
     accompanies the block.
   - **rules.md**: the structured business-rule model. Carries a fenced `yaml`
     block where every rule has a stable `rule-NNN` id, a trigger, enforcement
     logic, violation behaviour, and the `cmp-NNN`/`ent-NNN` it applies to.
   - **api-specification.md**: the provider-side interface for this unit --
     operations/events, request/response payloads, auth, errors, and
     versioning. Aligns with any `contracts` covering this unit's boundaries.
   - **functional-spec.md**: the human-readable view derived from the YAML
     blocks -- workflows, state machines, decision trees, and a rules summary.
     Includes frontend component flows when the unit has a UI.

6. **Update State** -- Update `aidlc-docs/aidlc-state.md`: mark Functional
   Design for {unit-name} as `[x]` completed and update "Current Status".

7. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                 | Description                                                              |
|--------------------------|--------------------------------------------------------------------------|
| entities.md              | Structured entity model (`ent-NNN` ids), attributes, relationships, lifecycle states, owning `cmp-NNN` |
| rules.md                 | Structured business-rule model (`rule-NNN` ids), triggers, enforcement, violation behaviour, applied `cmp-NNN`/`ent-NNN` |
| api-specification.md     | Provider-side interface -- operations/events, payloads, auth, errors, versioning |
| functional-spec.md       | Human-readable view -- workflows, state machines, decision trees, rules summary, frontend flows |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- The questions file is co-located with stage artifacts at
  `aidlc-docs/construction/{unit-name}/functional-design/functional-design-questions.md`.
- Frontend component flows are captured in functional-spec.md only when the
  unit includes frontend/UI work.
- All questions use the tri-mode interaction flow (Guide me / I'll edit the
  file / Chat).

---

## Stage 3.2: NFR Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.2                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | Quality attributes (performance, security, scalability, reliability), tech-stack selection, or NFR patterns need to be made concrete for this unit. Skip if no NFR work is needed and the stack is already determined. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-aws-platform-agent, aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent             |
| mode              | inline                                                                                            |
| Inputs            | requirements.md (NFR section), functional-design artifacts, components blueprint, RE technology-stack (if brownfield) |
| Outputs           | `aidlc-docs/construction/{unit-name}/nfr-design/` -- nfr-specification.md |

### Purpose

Make the unit's non-functional requirements concrete in a single pass:
measurable quality targets, the technology-stack selection, the architectural
patterns that satisfy each quality attribute, and the explicit trade-offs. This
stage is **self-sufficient** -- it captures whatever NFR targets are needed
here, reading whatever the upstream `requirements` already carries and
eliciting any missing targets in its own question step. There is no separate
NFR requirements stage. The aidlc-architect-agent leads, with the
aidlc-aws-platform-agent (platform/infra patterns), aidlc-devsecops-agent
(security posture), aidlc-compliance-agent (regulatory constraints), and
aidlc-quality-agent (testable quality-attribute scenarios) providing specialist
input.

### Inputs

- Requirements (especially the NFR section) from
  `aidlc-docs/inception/requirements-analysis/requirements.md`
- Functional design artifacts from
  `aidlc-docs/construction/{unit-name}/functional-design/`
- The `components` blueprint from
  `aidlc-docs/inception/domain-design/components.md` for the `cmp-NNN` ids the
  NFR posture annotates
- Technology-stack artifacts from reverse-engineering (if brownfield) for
  existing-stack constraints

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-aws-platform-agent (platform/infra patterns), aidlc-devsecops-agent
   (security requirements + posture), aidlc-compliance-agent (regulatory
   constraint mapping), and aidlc-quality-agent (testable quality-attribute
   scenarios) personas and knowledge for support input.

2. **Read Prior Artifacts** -- Read requirements (especially its NFR section),
   functional design artifacts, and the `components` blueprint for the
   `cmp-NNN` ids the NFR posture will annotate. If brownfield, read any
   technology-stack artifacts from reverse-engineering.

3. **Assess NFR Categories and Generate Questions** -- Assess the unit across
   the NFR categories (performance, security, scalability, reliability,
   observability) and select the tech stack. Create a questions file at
   `aidlc-docs/construction/{unit-name}/nfr-design/nfr-design-questions.md`
   using `[Answer]:` tags. Because this stage is self-sufficient, the questions
   cover BOTH the quantitative targets (what "good" means) AND the design
   choices (how to achieve it):
   - Quantifiable targets: response-time/latency budgets, throughput,
     availability SLO, durability, capacity/growth
   - Security posture: authn/authz model, data classification, encryption at
     rest/in transit, compliance controls
   - Resilience + scalability patterns: circuit breakers, retries/backoff,
     failover, horizontal/vertical scaling, partitioning, caching tiers
   - Tech-stack selection: languages, frameworks, datastores, infra tools --
     with rationale
   - Trade-offs: what is sacrificed for what, and why

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow. Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("fast enough", "highly available", "secure",
     "mix of", "depends")
   - Check for contradictions between targets
   - Flag missing quantitative targets
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Design the NFR Solution** -- Design concrete, measurable solutions per
   category, each tied to the targets from Step 4:
   - **Performance**: caching architecture, query/connection optimization,
     async patterns, CDN, performance budgets
   - **Security**: authn/authz architecture, encryption design, input
     validation, secrets management, audit logging, compliance controls
   - **Scalability**: scaling approach, load distribution, data
     partitioning/sharding, queue-based decoupling, capacity thresholds,
     auto-scaling rules
   - **Reliability**: circuit breakers, retry policies with backoff, health
     checks, graceful degradation, failover, backup/replication
   - **Tech stack + patterns**: the selected technologies and the architectural
     patterns that realize the above, with explicit trade-offs

6. **Generate Artifact** -- Generate
   `aidlc-docs/construction/{unit-name}/nfr-design/nfr-specification.md` -- the
   single NFR specification covering, in one document:
   - Measurable quality targets (the "requirements" half: SLOs, budgets,
     capacity)
   - Technology-stack decisions and rationale
   - Architectural patterns per quality attribute (the "design" half)
   - Trade-offs and constraints
   - NFR posture annotations keyed to the `cmp-NNN` components they constrain
     (so the `blueprint-shape` sensor can verify every referenced component
     resolves upstream)

7. **Update State** -- Update `aidlc-docs/aidlc-state.md`: mark NFR Design
   for {unit-name} as `[x]` completed and update "Current Status".

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact               | Description                                                                     |
|------------------------|---------------------------------------------------------------------------------|
| nfr-specification.md   | Measurable quality targets (SLOs, budgets, capacity), tech-stack decisions and rationale, architectural patterns per quality attribute, trade-offs, NFR posture keyed to `cmp-NNN` |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- Merged NFR Stage

NFR Requirements and NFR Design are now a **single self-sufficient stage**. The
prior split (a requirements stage producing five requirement artifacts feeding
a separate design stage) is collapsed into one pass that produces a single
`nfr-specification.md`. The stage elicits any missing NFR targets in its own
question step, so it no longer depends on an upstream NFR requirements stage.

---

## Stage 3.3: Infrastructure Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.3                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | Infrastructure services need mapping, deployment architecture required, or cloud resources needed. Skip if no infrastructure changes and infrastructure already defined. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-aws-platform-agent                                                                                |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent                                                           |
| mode              | inline                                                                                            |
| Inputs            | nfr-specification (nfr-design), components blueprint (domain-design), functional-spec (functional-design, optional), contracts (contract-design, optional) |
| Outputs           | `aidlc-docs/construction/{unit-name}/infrastructure-design/` -- infrastructure-specification.md |

### Purpose

Design the infrastructure, deployment architecture, monitoring, and CI/CD
pipeline for a single unit, consolidated into a single sectioned specification.
The aidlc-aws-platform-agent leads, with the aidlc-devsecops-agent ensuring
infrastructure security and the aidlc-compliance-agent checking data residency
and regulatory constraints.

### Inputs

- `nfr-specification` from
  `aidlc-docs/construction/{unit-name}/nfr-design/nfr-specification.md`
- The `components` blueprint from
  `aidlc-docs/inception/domain-design/components.md`
- `functional-spec` from
  `aidlc-docs/construction/{unit-name}/functional-design/functional-spec.md`
  (if exists)
- `contracts` from `aidlc-docs/inception/contract-design/` (if exists, for
  this unit's boundaries)

### Steps

1. **Load Personas** -- Load aidlc-aws-platform-agent (lead) persona and knowledge.
   Load aidlc-devsecops-agent (infrastructure security) and aidlc-compliance-agent
   (data residency, regulatory constraints) personas and knowledge for support input.

2. **Read Prior Artifacts** -- Read all prior design artifacts for context:
   nfr-specification, the `components` blueprint, functional-spec (if exists),
   and contracts (if exists).

3. **Generate Infrastructure Questions** -- Create a questions file at
   `aidlc-docs/construction/{unit-name}/infrastructure-design/infrastructure-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Deployment strategy (containerized, serverless, hybrid, multi-region)
   - Compute/storage/networking (sizing, topology, latency requirements)
   - Monitoring approach (metrics, logging, tracing, alerting thresholds)
   - CI/CD pipeline (build stages, deployment strategy, rollback procedures)
   - Secrets management (vault, environment variables, rotation policy)
   - Scaling policy (auto-scaling triggers, capacity limits, cost constraints)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow. Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("cloud-based", "auto-scale", "standard
     monitoring")
   - Check for contradictions between answers
   - Flag missing details needed for artifact generation
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Design Infrastructure** -- Design infrastructure across four areas:
   - **Deployment Architecture**: Compute model (containers, serverless, VMs),
     networking topology, storage strategy, environment layout
     (dev/staging/prod)
   - **Infrastructure Services**: Databases (type, sizing, replication), caches
     (strategy, eviction), message queues, search services, CDN, DNS, load
     balancers
   - **Monitoring & Observability**: Metrics collection, log aggregation,
     distributed tracing, alerting rules, dashboards, SLI/SLO tracking
   - **CI/CD Pipeline**: Build stages, test stages, deployment stages,
     environment promotion, rollback strategy, feature flags, artifact
     management

6. **Generate Artifact** -- Generate a single consolidated specification at
   `aidlc-docs/construction/{unit-name}/infrastructure-design/infrastructure-specification.md`.
   It folds what were previously five separate artifacts (deployment
   architecture, infrastructure services, monitoring design, CI/CD pipeline,
   shared infrastructure) into one spec, organised by section. Each
   infrastructure element **references the `cmp-NNN` component IDs** from the
   upstream `components` blueprint it provisions or supports. The spec carries
   a fenced `yaml` block where every provisioned element references the
   `cmp-NNN` component(s) it supports, validated by the `blueprint-shape`
   sensor. Sections:
   - **Deployment Architecture**: compute model, networking topology, storage
     strategy, environment layout, infrastructure-as-code approach, resource
     sizing -- each tied to the `cmp-NNN` it hosts.
   - **Infrastructure Services**: databases, caches, message queues, search
     services, CDN, DNS, load balancers, service discovery -- mapped to the
     `cmp-NNN` they back.
   - **Monitoring & Observability**: metrics and KPIs, log strategy, tracing
     configuration, alert definitions, dashboard specifications, SLI/SLO
     tracking.
   - **CI/CD Pipeline**: pipeline stages, build configuration, test automation
     integration, deployment strategy (blue-green, canary, rolling), rollback
     procedures, secrets management in CI/CD.
   - **Shared Infrastructure** (CONDITIONAL -- include when multiple units
     share infrastructure resources): shared databases, caches, message queues,
     networking, cross-unit service discovery, resource ownership and access
     boundaries.

7. **Update State** -- Update `aidlc-docs/aidlc-state.md`: mark
   Infrastructure Design for {unit-name} as `[x]` completed and update
   "Current Status".

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                        | Description                                                               |
|---------------------------------|---------------------------------------------------------------------------|
| infrastructure-specification.md | Single sectioned spec: deployment architecture, infrastructure services, monitoring & observability, CI/CD pipeline, and (conditional) shared infrastructure -- every element keyed to the `cmp-NNN` it supports |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- Consolidated Infrastructure Specification

This stage produces a **single `infrastructure-specification.md`** that folds
what were previously separate deployment architecture, infrastructure
services, monitoring, CI/CD pipeline, and (conditional) shared infrastructure
artifacts into one sectioned document. Consolidating into one spec keeps the
infrastructure view coherent and lets every element reference the `cmp-NNN`
components it provisions.

---

## Stage 3.4: Code Generation

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.4                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS (per-unit)                                                                                 |
| Condition         | Always executes for every unit in the execution plan.                                             |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-developer-agent                                                                                   |
| support_agents    | (none -- focused implementation)                                                                  |
| mode              | subagent (Task tool subagent_type: aidlc-developer-agent)                                               |
| Inputs            | ALL prior design artifacts for this unit                                                          |
| Outputs           | application code (workspace root) + `aidlc-docs/construction/{unit-name}/code-generation/` -- code-generation-plan.md, code-summary.md |

### Purpose

Generate all application code, tests, and configuration for a single unit of
work. This is the only stage that always executes for every unit regardless of
the execution plan. Code is written to the workspace root, never to
`aidlc-docs/`.

### Critical Rules

- Application code goes to workspace root, NEVER to `aidlc-docs/`
- Brownfield: modify files in-place. NEVER create duplicates like
  `ClassName_modified.java`
- Add `data-testid` attributes to interactive UI elements for test automation

### Inputs

- Functional design from
  `aidlc-docs/construction/{unit-name}/functional-design/` (if exists)
- NFR specification from
  `aidlc-docs/construction/{unit-name}/nfr-design/nfr-specification.md` (if exists)
- Infrastructure specification from
  `aidlc-docs/construction/{unit-name}/infrastructure-design/infrastructure-specification.md` (if exists)
- The `components` blueprint from `aidlc-docs/inception/domain-design/components.md`
- Unit definition from
  `aidlc-docs/inception/units-generation/unit-of-work.md`
- Story map from
  `aidlc-docs/inception/units-generation/unit-of-work-story-map.md`

### Steps

This stage has a **two-part structure**: planning followed by generation.

#### PART 1 -- Planning (Steps 1-3)

1. **Read All Unit Artifacts** -- Read all design artifacts for the current
   unit (functional design, NFR specification, infrastructure specification,
   the components blueprint, unit definition, story map).

2. **Create Code Generation Plan** -- Create a detailed plan at
   `aidlc-docs/construction/{unit-name}/code-generation/code-generation-plan.md`
   with checkboxes for each implementation step. Include story-to-code-step
   traceability -- map each plan step back to the user story it implements.

   **Recommended plan structure** (adapt if architecture warrants different
   ordering):

   ```
   Step 1:  Project structure setup (directories, config files, package.json/Cargo.toml/etc.)
   Step 2:  Data models / database schema / migrations
   Step 3:  Business logic layer (core domain logic, services)
   Step 4:  Business logic tests (unit tests for Step 3)
   Step 5:  API / endpoint layer (routes, controllers, handlers)
   Step 6:  API tests (unit + integration tests for Step 5)
   Step 7:  Repository / data access layer (queries, ORM config)
   Step 8:  Frontend components (if applicable -- UI components, pages, state)
   Step 9:  Frontend tests (component tests, interaction tests)
   Step 10: Configuration and environment setup (.env templates, build config)
   Step 11: Test configuration (vitest.config, jest.config, or equivalent)
   Step 12: Documentation (inline docs, API docs, README updates)
   ```

   This layer-by-layer approach ensures dependencies are built before
   dependents (data models before business logic, business logic before API).
   Deviate when the architecture requires it (e.g., event-driven systems,
   microservices with independent stacks).

   **Test files are MANDATORY in the plan.** The plan MUST include steps for:
   - Unit test files (one per component/module with key behavior coverage)
   - Test configuration (vitest.config, jest.config, or equivalent)

   If the plan omits test file steps, they must be added before presenting to
   the user. Tests are not deferred to Build and Test -- that stage verifies
   and extends, not creates from scratch.

   Number each plan step sequentially (Step 1, Step 2, etc.) for clear
   execution ordering and traceability.

3. **Plan Approval** -- Present the plan summary to the user and request
   approval:
   - "Approve Plan" -- proceed to code generation
   - "Request Changes" -- revise the plan

#### PART 2 -- Generation (Steps 4-7)

4. **Generate Code** -- Before delegating, display to the user:
   "Generating code for [N] plan steps. This may take several minutes
   depending on project complexity. I'll show a summary when complete."

   Delegate to Task tool with the aidlc-developer-agent subagent
   (subagent_type="aidlc-developer-agent").

   **Context passed to subagent:**
   - The lead agent's persona from `agents/aidlc-developer-agent.md` and knowledge
     from `.claude/knowledge/aidlc-developer-agent/` (included in the prompt
     since subagents cannot access conversation history)
   - Design artifacts for the CURRENT UNIT ONLY (not all units)
   - A 1-2 line summary of each inception-phase artifact with its file path
     (requirements summary, stories summary, components blueprint summary) -- the
     subagent can Read specific files if it needs full content
   - The approved code-generation-plan.md (full content)
   - Project workspace details (languages, frameworks, conventions from
     aidlc-state.md)
   - Instructions to execute each plan step sequentially and mark checkboxes
     as completed

   **Context budget:** Pass only the current unit's design artifacts, not all
   units. Summarize inception artifacts with file paths rather than embedding
   full content. The subagent generates all code, test files, and
   configuration artifacts in the workspace.

5. **Generate Code Summary** -- After subagent completes, create
   `aidlc-docs/construction/{unit-name}/code-generation/code-summary.md`
   documenting:
   - Files created/modified
   - Key implementation decisions
   - Test coverage summary
   - Any deviations from the plan

6. **Update State** -- Update `aidlc-docs/aidlc-state.md`: mark Code
   Generation for {unit-name} as `[x]` completed and update "Current Status".

7. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                  | Description                                                         |
|---------------------------|---------------------------------------------------------------------|
| code-generation-plan.md   | Detailed plan with checkboxes, story traceability, step sequencing  |
| code-summary.md           | Files created/modified, decisions, test coverage, plan deviations   |
| (application code)        | All source code, tests, and config written to workspace root        |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Two-part structure**: The planning phase (Steps 1-3) runs inline with user
  interaction and plan approval. The generation phase (Steps 4-7) delegates to
  the aidlc-developer-agent subagent via the Task tool. This is different from most
  Construction stages which run entirely inline.
- **Developer-agent subagent**: Code generation uses `subagent_type="aidlc-developer-agent"`
  (delegated via Task tool), not inline execution. This is the only
  Construction stage that uses a subagent. The subagent inherits the full
  session toolset (the aidlc-developer-agent declares no `tools:` allowlist),
  so it reaches Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion, and the
  inherited MCP tools.
- **Context budget**: Only the current unit's design artifacts are passed to
  the subagent. Inception-phase artifacts are summarized in 1-2 lines with
  file paths so the subagent can selectively Read what it needs.
- **Mandatory test file inclusion**: Test files MUST be part of the code
  generation plan. Stage 3.5 (Build and Test) verifies and extends tests but
  does not create them from scratch.
- **Brownfield awareness**: In brownfield projects, the subagent modifies
  existing files in-place rather than creating duplicates.

---

## Stage 3.5: Build and Test

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.5                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS (after ALL units complete)                                                                 |
| Condition         | Always executes once after all per-unit stages are finished.                                      |
| Per-Unit          | No (runs once for all units)                                                                     |
| Lead Agent        | aidlc-quality-agent                                                                                     |
| support_agents    | aidlc-devsecops-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | ALL code generation outputs across all units                                                      |
| Outputs           | `aidlc-docs/construction/build-and-test/` -- build-instructions.md, unit-test-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md, plus conditional test instruction files |

### Purpose

Generate test instructions across all test types, then actually execute the
build and tests via Bash. This stage operates across ALL units -- it is NOT
per-unit. The aidlc-quality-agent leads with the aidlc-devsecops-agent providing security
testing expertise.

### Inputs

- Code generation outputs across all units from
  `aidlc-docs/construction/*/code-generation/code-summary.md`
- NFR requirements across units (if they exist) for performance and security
  testing needs

### Steps

1. **Load Personas** -- Load aidlc-quality-agent (lead) persona and knowledge. Load
   aidlc-devsecops-agent persona and knowledge for security testing input.

2. **Analyze Testing Requirements** -- Read code generation outputs across all
   units. Review NFR requirements (if they exist) to identify performance and
   security testing needs. Catalog all test types required.

3. **Generate Build Instructions** -- Create
   `aidlc-docs/construction/build-and-test/build-instructions.md`:
   - Dependency installation steps
   - Environment setup (env vars, config files, local services)
   - Build commands (compile, bundle, transpile)
   - Build verification steps
   - Troubleshooting common build issues

4. **Generate Unit Test Instructions** -- Create
   `aidlc-docs/construction/build-and-test/unit-test-instructions.md`:
   - Test framework setup and configuration
   - How to run unit tests (commands, flags, filters)
   - Expected test coverage targets
   - Mocking/stubbing guidance
   - Test data management

5. **Generate Integration Test Instructions** -- Create
   `aidlc-docs/construction/build-and-test/integration-test-instructions.md`:
   - Test environment prerequisites (databases, services, queues)
   - How to run integration tests
   - Cross-unit interaction testing
   - External dependency handling (stubs, test doubles, sandboxes)
   - Test data setup and teardown

6. **Generate Performance Test Instructions** (CONDITIONAL) -- IF NFR
   performance requirements exist for any unit, create
   `performance-test-instructions.md`:
   - Load testing tools and configuration
   - Performance test scenarios mapped to NFR targets
   - Baseline measurements and benchmarks
   - Stress and soak test procedures
   - Performance regression detection

7. **Generate Security Test Instructions** (CONDITIONAL) -- IF NFR security
   requirements exist for any unit, create
   `security-test-instructions.md`:
   - Security scanning tools (SAST, DAST, dependency audit)
   - Authentication/authorization test scenarios
   - Input validation and injection testing
   - Compliance verification steps
   - Vulnerability assessment procedures

8. **Generate Additional Test Types** (CONDITIONAL) -- As applicable based on
   project architecture, create specifically named files:
   - **contract-test-instructions.md**: For microservice APIs --
     consumer-driven contracts, schema validation, API compatibility
   - **e2e-test-instructions.md**: For UI-driven applications -- browser
     automation, user journey tests, cross-browser verification
   - **accessibility-test-instructions.md**: For user-facing interfaces --
     WCAG compliance, screen reader testing, keyboard navigation

   All files go in `aidlc-docs/construction/build-and-test/`.

9. **Generate Build and Test Summary** -- Create
   `aidlc-docs/construction/build-and-test/build-and-test-summary.md`:
   - Overall build status and prerequisites
   - Test type inventory (which test types were generated)
   - Coverage expectations per unit
   - Readiness assessment (build-ready, test-ready, deployment-ready)
   - Known limitations or outstanding items

10. **Execute Build and Tests** -- Attempt to execute the build and test
    commands documented in the instruction files **via Bash**:

    a. **Build**: Run the build commands from build-instructions.md via Bash.
       Capture output.
    b. **Unit tests**: Run the unit test command from
       unit-test-instructions.md via Bash. Capture pass/fail counts.
    c. **Integration tests** (if applicable): Run integration test commands.
       Capture results.
    d. **Report results**: Create or update
       `aidlc-docs/construction/build-and-test/test-results.md` with:
       - Build status (success/failure + output)
       - Test results (total, passed, failed, skipped)
       - Failure details (test name, assertion, stack trace)
       - Coverage report (if test framework supports it)

    **Failure diagnosis loop (2 attempts):** On failure, if build or tests
    fail, attempt to diagnose and fix the issue:
    - Read the error output
    - Identify the failing code
    - Apply the fix
    - Re-run the failing step
    - If unable to fix after 2 attempts, log the failure in test-results.md
      and present the issue to the user at the approval gate

    **On success:** Update the Build and Test Summary with actual results (not
    just instructions).

11. **Update State** -- Update `aidlc-docs/aidlc-state.md`: mark Build and
    Test as `[x]` completed and update "Current Status". Mark CONSTRUCTION
    phase as complete.

12. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                          | Description                                                     | Condition          |
|-----------------------------------|-----------------------------------------------------------------|--------------------|
| build-instructions.md             | Dependency install, env setup, build commands, troubleshooting  | Always             |
| unit-test-instructions.md         | Test framework setup, run commands, coverage targets, mocking   | Always             |
| integration-test-instructions.md  | Prerequisites, cross-unit testing, external deps, data setup    | Always             |
| performance-test-instructions.md  | Load testing, NFR scenarios, baselines, stress/soak tests       | If NFR perf exists |
| security-test-instructions.md     | SAST/DAST, auth testing, injection testing, compliance          | If NFR sec exists  |
| contract-test-instructions.md     | Consumer-driven contracts, schema validation, API compat        | If microservices   |
| e2e-test-instructions.md          | Browser automation, user journeys, cross-browser                | If UI-driven       |
| accessibility-test-instructions.md| WCAG compliance, screen reader, keyboard nav                    | If user-facing UI  |
| build-and-test-summary.md         | Overall status, test inventory, coverage, readiness assessment  | Always             |
| test-results.md                   | Actual build/test execution results, pass/fail, coverage        | Always             |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Actual Bash execution**: This stage does not just document test
  instructions -- it actually runs the build and test commands via Bash and
  captures real results. This is one of the few stages that executes
  real commands against the codebase.
- **Failure diagnosis loop**: The stage attempts to automatically diagnose and
  fix failures, with a maximum of 2 attempts. If the fix fails after 2
  attempts, the failure is logged and surfaced to the user at the approval
  gate.
- **Conditional test types**: Performance tests, security tests, contract
  tests, E2E tests, and accessibility tests are only generated when relevant
  conditions are met (NFR requirements exist, microservice architecture,
  UI-driven application, user-facing interfaces).
- **Cross-unit scope**: Unlike stages 3.1-3.4 which are per-unit, Build and
  Test runs once across all code produced by all units. It validates the
  integrated codebase, not individual units.
- **Phase completion**: This stage (along with 3.6 if applicable) marks the
  end of the Construction phase. The state file is updated to mark
  CONSTRUCTION as complete.

---

## Stage 3.6: CI Pipeline

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.6                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (skip if CI already exists and is adequate)                                           |
| Condition         | Execute when CI pipeline needs creation or significant modification                               |
| Per-Unit          | No (runs once for all units)                                                                     |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | (none)                                                                                            |
| mode              | inline                                                                                            |
| Inputs            | Code generation output from Stage 3.4, build/test results from Stage 3.5                         |
| Outputs           | `aidlc-docs/construction/ci-pipeline/` -- ci-config.md, quality-gates.md, ci-pipeline-questions.md |

### Purpose

Configure the CI (Continuous Integration) pipeline with quality gates,
artifact management, and build/test automation. The aidlc-pipeline-deploy-agent
leads with no support agents.

### Inputs

- Build/test results from `aidlc-docs/construction/build-and-test/`
- Infrastructure design from `aidlc-docs/construction/infrastructure-design/`
  (if exists)
- Workspace profile for existing CI configuration

### Steps

1. **Load Agent Personas** -- Load aidlc-pipeline-deploy-agent persona and
   knowledge.

2. **Load Prior Context** -- Read build/test results, infrastructure design
   (if exists), and workspace profile for existing CI configuration.

3. **Generate Clarifying Questions** -- Create
   `aidlc-docs/construction/ci-pipeline/ci-pipeline-questions.md` with
   questions:
   - What CI tool is in use (CodePipeline, CodeBuild, GitHub Actions,
     Jenkins)?
   - What is the branch strategy?
   - What quality gates are required before merge?
   - What artifact repositories are used (ECR, CodeArtifact, S3)?

   Follow stage-protocol.md question flow.

4. **Collect and Analyze Answers** -- Validate CI choices against existing
   infrastructure and team capabilities.

5. **Generate Artifacts** -- Create CI pipeline configuration (buildspec.yml,
   workflow YAML, or equivalent), quality gate definitions, and artifact
   repository configuration.

6. **Phase Boundary Verification** -- Run Construction-to-Operation
   verification check:
   - Architecture-to-code-to-tests alignment
   - All code traces to design
   - Test coverage against acceptance criteria
   - Write results to `aidlc-docs/verification/phase-check-construction.md`

7. **Update State** -- Mark 3.6 CI Pipeline as `[x]` completed in
   `aidlc-docs/aidlc-state.md`.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                  | Description                                              |
|---------------------------|----------------------------------------------------------|
| ci-config.md              | CI pipeline configuration (buildspec, workflow YAML, etc.) |
| quality-gates.md          | Quality gate definitions for merge/promotion             |
| ci-pipeline-questions.md  | Clarifying questions with answers                        |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Phase boundary verification**: This is the last stage of the Construction
  phase. It performs the Construction-to-Operation phase boundary verification
  check (per stage-protocol-governance.md section 13), validating that architecture traces
  to code and code traces to tests. Results are written to
  `aidlc-docs/verification/phase-check-construction.md`.
- **Conditional execution**: This stage is skipped if the project already has
  an adequate CI pipeline. The execution plan from Delivery Planning determines
  whether it runs.
- **Post-unit execution**: Like Stage 3.5, this stage runs once after all
  per-unit work is complete, not per-unit.

---

## Phase Summary

The Construction phase transforms Inception designs into working software
through a phased construction flow:

**Per-unit stages (3.1-3.4):**
- 3.1 Functional Design -- Business logic, domain models, rules (architect-led)
- 3.2 NFR Design -- Measurable quality targets, tech-stack selection, and
  concrete patterns for each quality attribute, in one self-sufficient pass
  (architect-led)
- 3.3 Infrastructure Design -- Deployment, services, monitoring, CI/CD folded
  into one consolidated specification (aws-platform-led)
- 3.4 Code Generation -- Two-part planning + generation via subagent
  (developer-led)

**Post-unit stages (3.5-3.6):**
- 3.5 Build and Test -- Instruction generation + actual Bash execution with
  failure diagnosis (quality-led)
- 3.6 CI Pipeline -- CI configuration + phase boundary verification
  (pipeline-deploy-led)

**Key characteristics:**
- Stages 3.1-3.3 are CONDITIONAL; 3.4-3.5 ALWAYS execute; 3.6 is CONDITIONAL
- All conditional stages follow the execution plan from Delivery Planning
- Per-unit loop ensures one unit completes fully before the next begins
- NFR Requirements and NFR Design are merged into a single self-sufficient
  NFR Design stage producing one `nfr-specification.md`
- Infrastructure Design produces a single consolidated
  `infrastructure-specification.md` (deployment, services, monitoring, CI/CD,
  and conditional shared infrastructure as sections)
- Code generation uses the aidlc-developer-agent subagent with context budget controls
- Build and Test performs actual command execution and automated failure
  diagnosis
- CI Pipeline includes phase boundary verification before transitioning to
  Operation

**Deliberate deviations from upstream reference:**
- NFR: a single merged NFR Design stage produces one `nfr-specification.md`
  (the prior split requirements/design stages are collapsed)
- Functional Design: structured `entities.md`/`rules.md` blueprints (stable
  `ent-NNN`/`rule-NNN` ids referencing `cmp-NNN`) plus api-specification.md
  and functional-spec.md
- Infrastructure Design: a single consolidated `infrastructure-specification.md`
  folding deployment, services, monitoring, CI/CD, and shared infrastructure
- Plan/question file co-location with stage artifacts
