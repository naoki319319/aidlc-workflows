# aidlc-architect-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-architect-agent |
| Model Override | **opus** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

The aidlc-architect-agent is the central design authority, handling the most
architecturally complex reasoning tasks across three phases of the lifecycle.
It runs on opus alongside the other seven high-judgment agents — the three
sonnet agents (delivery, pipeline-deploy, operations) produce dominantly
templated planning, CI/CD, and runbook output.

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| feasibility | Feasibility and Constraint Analysis | Assesses technical feasibility, identifies integration constraints, produces constraint registers and risk assessments |
| domain-design | Domain Design | Identifies the logical building blocks (components): a single `components` blueprint with stable `cmp-NNN` IDs, owned entities, boundaries, and dependency edges |
| units-generation | Units Generation | Decomposes the domain component model into implementable Units of Work with boundaries and the dependency DAG. Economic ordering (what ships first, why) is the delivery-planning stage's decision |
| contract-design | Contract Design | Defines the inter-unit API contracts (one spec per boundary, referencing the `cmp-NNN` on each side) so teams can build in parallel; conditional, auto-skipped for single-unit projects |
| functional-design | Functional Design | Creates detailed entity models (`ent-NNN`), business rules (`rule-NNN`), API specifications, and the functional spec, referencing the `cmp-NNN` components |
| nfr-design | NFR Design | Makes non-functional requirements concrete in one self-sufficient pass: measurable targets, tech-stack selection, and the patterns (caching, circuit breakers, resilience, security, observability) that satisfy them, in a single `nfr-specification` |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| intent-capture | Intent Capture and Framing | Provides technical context and feasibility perspective on the captured intent |
| reverse-engineering | Reverse Engineering (Synthesis step) | Receives code scan results from aidlc-developer-agent and synthesizes into a coherent architectural model |
| delivery-planning | Delivery Planning | Validates build order against architecture dependencies and component coupling |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-product-agent | Requirements, user stories, intent backlog |
| aidlc-developer-agent | Code scan results for reverse engineering synthesis |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-developer-agent | Unit of work specifications, API contracts, design patterns |
| aidlc-quality-agent | Test boundaries, NFR targets for validation |
| aidlc-aws-platform-agent | Infrastructure requirements derived from application design |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-architect-agent/`

| File | Content |
|------|---------|
| adr-template.md | Architecture Decision Record template and examples |
| architecture-guide.md | Architecture methodology and design process |
| architecture-patterns.md | Architectural style patterns (microservices, modular monolith, event-driven, serverless) |
| ddd-patterns.md | Domain-driven design patterns (bounded contexts, aggregates, entities, value objects) |
| nfr-design-guide.md | Non-functional requirements design methodology |
| nfr-design-patterns.md | Technical patterns for NFR implementation (caching, circuit breakers, resilience) |

### Team (Tier 2)

Path: `aidlc-docs/knowledge/aidlc-architect-agent/` (user-managed)

Scaffolded by the `--init` command. Populated by the team with project-specific
architecture context such as existing architecture diagrams, technology radar,
approved patterns, or constraints registers.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-architect-agent](../../guide/agents/architect-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-architect-agent.md`](../../../dist/claude/.claude/agents/aidlc-architect-agent.md)
