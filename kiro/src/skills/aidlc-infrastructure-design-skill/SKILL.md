---
name: aidlc-infrastructure-design-skill
description: |
  The skill of mapping logical system design to physical infrastructure — deployment topology, compute selection, networking, storage, security boundaries, scaling strategy, disaster recovery, and cost modeling. Platform-agnostic methodology; the actual vendor/target comes from team memory or the intent.
---

# Infrastructure Design

## Definition

Translate a logical system architecture into a deployable physical architecture. Decide where components run, how they connect, how data is stored, how the system scales, recovers, and is secured at the infrastructure level.

## When Applied

- During the infrastructure-design stage
- When the nfr-design specifies targets that constrain infrastructure choices
- When migrating between deployment targets

## Design Methodology

### 1. Compute Selection

For each unit/component, decide:

| Question | Options | Decision driver |
|---|---|---|
| Execution model? | Containers, VMs, serverless functions, bare metal | Workload characteristics (long-running vs event-driven, startup latency, state) |
| Orchestration? | Kubernetes, ECS, Nomad, systemd, none | Operational maturity, team skill, scale needs |
| Sizing? | Right-sized, auto-scaled, burst-capable | Traffic pattern (steady, spiky, seasonal) |
| Placement? | Single region, multi-region, edge | Latency requirements, compliance (data residency) |

### 2. Networking

- Define network boundaries (VPC, subnets, security groups / firewall rules)
- Map communication patterns: which components talk to which, over what protocol
- Decide on service mesh / load balancing / API gateway
- Define ingress/egress rules — what's public, what's internal-only
- DNS strategy: internal service discovery vs external resolution

### 3. Storage

For each data concern:

| Data type | Storage class | Decision factors |
|---|---|---|
| Relational (structured, queries) | RDBMS (PostgreSQL, MySQL, Aurora) | ACID needs, query complexity, joins |
| Document (flexible schema) | Document store (DynamoDB, MongoDB, Cosmos) | Scale, access patterns, schema evolution |
| Cache (hot data, sessions) | In-memory (Redis, Memcached) | Latency, eviction policy, persistence needs |
| Files/objects (media, uploads) | Object store (S3, GCS, Blob) | Size, access frequency, lifecycle |
| Events/streams | Broker (Kafka, SQS, EventBridge) | Ordering, replay, fan-out, retention |
| Search | Search engine (OpenSearch, Elasticsearch) | Full-text, facets, analytics |

### 4. Security Boundaries

- Define trust zones: public, DMZ, private, restricted
- Map each component to its trust zone
- Define network policies between zones
- Identify encryption requirements: at rest, in transit, key management
- Secrets management: how are credentials stored and rotated?
- IAM: principle of least privilege per component

### 5. Scaling Strategy

- Identify scaling triggers (CPU, memory, queue depth, request count)
- Define scaling policies (target tracking, step, schedule-based)
- Identify scaling bottlenecks (databases, external APIs, shared state)
- Design for scale-to-zero where applicable (cost optimization)
- Define scaling limits (min/max instances, cost caps)

### 6. Disaster Recovery

- Define RTO (Recovery Time Objective) and RPO (Recovery Point Objective)
- Design backup strategy: frequency, retention, cross-region
- Define failover mechanism: active-passive, active-active, pilot light
- Identify single points of failure and their mitigation
- Document recovery runbook (what to do when things break)

### 7. Cost Model

- Estimate steady-state cost per component
- Identify cost scaling curve (what happens at 2x, 10x load?)
- Identify cost optimization opportunities (reserved, spot, savings plans)
- Set cost alerts and budgets
- Document cost-vs-performance trade-offs made

## Output Format

```markdown
## Deployment Topology

[Mermaid architecture diagram showing components, their placement, and connections]

## Component-to-Infrastructure Mapping

| Component | Compute | Region | Scaling | Notes |
|---|---|---|---|---|
| [CMP-001] | [ECS Fargate / Lambda / EC2] | [region] | [auto-scale policy] | [why this choice] |

## Network Design

| Zone | Components | Ingress | Egress |
|---|---|---|---|
| Public | API Gateway, CDN | Internet | Private zone |
| Private | Services, Workers | Public zone | Data zone, Internet (NAT) |
| Data | Databases, Caches | Private zone only | None |

## Storage Design

| Data concern | Technology | Rationale | Backup |
|---|---|---|---|
| [user data] | [PostgreSQL RDS] | [ACID, complex queries] | [daily snapshot, 30d retention] |

## Security

| Zone boundary | Control | Encryption |
|---|---|---|
| Internet → Public | WAF + API key / OAuth | TLS 1.3 |
| Public → Private | Security group, IAM | mTLS |

## DR Strategy

- RTO: [target]
- RPO: [target]
- Failover: [mechanism]
- Backups: [schedule]

## Cost Estimate

| Component | Monthly (steady) | At 10x | Optimization |
|---|---|---|---|
| [compute] | [$X] | [$Y] | [spot/reserved] |
```

## Principles

- **Logical before physical** — understand what the system needs to do before deciding where it runs
- **Constraints drive decisions** — latency, compliance, cost, team skills narrow the options; don't pick tech first
- **Blast radius awareness** — every design choice has a failure radius; contain it
- **Cost is a first-class concern** — an architecture nobody can afford isn't a good architecture
- **Operational simplicity over theoretical elegance** — fewer moving parts = fewer things to break at 3am
