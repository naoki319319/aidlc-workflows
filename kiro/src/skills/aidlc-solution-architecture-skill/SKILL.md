---
name: aidlc-solution-architecture-skill
description: |
  The skill of solution architecture — thinking holistically about quality attributes, technology selection, architectural patterns, and non-functional requirements. Bridges the gap between what the system does (functional) and how well it does it (quality). Applied during NFR design, infrastructure design, and any stage requiring architectural trade-off reasoning.
---

# Solution Architecture

## Definition

Design the system's quality characteristics: how it performs, scales, recovers, secures, and operates — not just what it does. A solution architect sees the whole system as a living thing that must meet quality targets under real-world conditions, not just pass functional tests.

## Core Concerns

### Performance & Latency

- Define SLIs (Service Level Indicators): the metrics that matter
- Define SLOs (Service Level Objectives): the targets for those metrics
- Identify hot paths — which user journeys must be fast?
- Determine acceptable latency budgets per hop in the call chain
- Identify where caching, pre-computation, or async offloading applies

### Scalability

- Characterize the load profile: steady, bursty, seasonal, growing?
- Identify the scaling unit: what grows as load grows?
- Determine horizontal vs vertical scaling strategy per component
- Design for the 10x case: what breaks first if load 10x's overnight?
- Identify stateful vs stateless components — stateful ones are scaling bottlenecks

### Reliability & Availability

- Define availability targets (99.9%? 99.99%?)
- Design for failure: what happens when each dependency is down?
- Identify blast radius: if component X fails, what else breaks?
- Define retry, circuit-breaker, and fallback strategies
- Design data durability: what's the RPO (Recovery Point Objective)?
- Define RTO (Recovery Time Objective): how fast must recovery be?

### Security

- Identify trust boundaries: where does authenticated ≠ authorized?
- Define the authentication strategy (who are you?)
- Define the authorization model (what can you do?)
- Identify sensitive data flows — where does PII/secrets transit?
- Define encryption strategy: at rest, in transit, in use
- Identify compliance requirements (GDPR, HIPAA, SOC2, PCI-DSS)

### Observability

- Define the three pillars: logs, metrics, traces
- Identify what to alert on vs what to dashboard vs what to log
- Design correlation: how do you trace a request across services?
- Define SLO-based alerting: burn rate, error budget

### Cost

- Identify the cost drivers: what will this cost at scale?
- Design for cost efficiency: spot instances, reserved capacity, tiered storage
- Identify cost caps and alerts
- Trade off cost vs performance vs reliability explicitly

## Technology Selection

When selecting technologies, evaluate against:

1. **Fit for purpose** — does it solve the actual problem?
2. **Team familiarity** — can the team operate it without a learning curve that blocks delivery?
3. **Ecosystem maturity** — is it production-proven, actively maintained, well-documented?
4. **Operational burden** — what's the day-2 cost? (managed service vs self-hosted)
5. **Lock-in risk** — how hard is it to move away if this choice is wrong?
6. **Integration** — does it compose well with the rest of the stack?

Document decisions as: "We chose X because [criteria]. We rejected Y because [trade-off]."

## Architectural Patterns

Apply patterns when they solve a real quality concern, not for elegance:

| Pattern | Solves | Use when |
|---|---|---|
| CQRS | Read/write at different scales | Read-heavy workloads, different read/write models |
| Event sourcing | Audit, temporal queries, replay | Regulatory compliance, complex domain state |
| Saga / choreography | Distributed transactions | Multi-service operations that must be eventually consistent |
| Bulkhead | Blast radius containment | Multiple tenants, mixed-criticality workloads |
| Sidecar | Cross-cutting concerns | Observability, auth, rate-limiting without app changes |
| Strangler fig | Incremental migration | Replacing legacy system piece by piece |
| Backend-for-frontend | Client-specific APIs | Multiple clients with different data needs |

## Output Format

When this skill is applied to produce NFR design artifacts:

```markdown
## Quality Attributes

| Attribute | Target | Measure | Rationale |
|---|---|---|---|
| Availability | 99.9% | uptime over 30-day window | [why this level] |
| Latency (p95) | <200ms | API gateway to response | [user experience need] |
| Throughput | 1000 req/s | peak sustained | [growth projection] |
| Recovery | RTO 5min, RPO 0 | automated failover | [data criticality] |

## Technology Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Database | PostgreSQL | DynamoDB | [need complex queries, team knows SQL] |
| Compute | ECS Fargate | Lambda | [long-running processes, consistent latency] |
| Queue | SQS | Kafka | [simple fan-out, no replay needed, lower ops burden] |

## Architectural Patterns Applied

- [Pattern]: applied to [component/concern] because [quality attribute it addresses]

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [what could go wrong] | H/M/L | H/M/L | [what we'll do about it] |
```

## Principles

- **Quality attributes are measurable or they're wishes** — "fast" isn't a requirement, "p95 < 200ms" is
- **Every quality attribute has a cost** — surface the trade-off, don't pretend you get everything for free
- **Design for the failure case first** — the happy path is easy; resilience is the hard part
- **Technology serves architecture, not the reverse** — pick the pattern first, then find the tech that fits
- **Operational cost is part of the design** — a system nobody can operate in production isn't a good design
- **Security is not a layer you add later** — it's woven into every decision from the start
