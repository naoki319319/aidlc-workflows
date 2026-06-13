---
name: aidlc-cloud-platform-skill
description: |
  The skill of designing for cloud-native platforms — managed services, IaC, serverless patterns, containers, multi-region, and cloud-specific operational patterns. Layers on top of infrastructure-design-skill with cloud-specific decision frameworks.
---

# Cloud Platform Design

## Definition

Design infrastructure that leverages cloud-native capabilities: managed services over self-hosted, infrastructure-as-code over manual provisioning, and platform services over custom implementations. The goal is to maximize operational leverage while maintaining portability where it matters.

## When Applied

- When the team's preference or intent specifies cloud deployment
- During infrastructure-design when managed services are candidates
- When designing IaC for any cloud provider

## Decision Framework: Build vs Managed

For every infrastructure concern, evaluate:

| Factor | Build (self-managed) | Managed service |
|---|---|---|
| Operational burden | High (patching, scaling, monitoring) | Low (provider handles) |
| Customization | Full control | Provider's configuration surface |
| Cost at low scale | Often cheaper (single instance) | Often more expensive (per-request/per-unit pricing) |
| Cost at high scale | Linear (more instances = more ops) | Often cheaper (economies of scale, no idle) |
| Portability | High (standard tech) | Low (provider-specific APIs) |
| Time to production | Slower (setup, hardening) | Faster (provision and go) |

**Default stance:** Use managed unless you have a specific reason not to (unusual requirements, cost at scale, portability mandate).

## Infrastructure as Code

### Principles

- **Everything in code** — no manual console clicks for production infrastructure
- **Immutable infrastructure** — replace, don't patch. Deploy new, cut over, destroy old
- **Environment parity** — dev/staging/prod from the same templates, different parameters
- **State management** — remote state, state locking, no local-only state
- **Drift detection** — automated checks that deployed matches declared

### Tool Selection

| Tool | Strength | Best for |
|---|---|---|
| CDK (AWS/CDKTF) | Full programming language, type safety, constructs | Teams that prefer code over config |
| Terraform | Multi-cloud, mature ecosystem, declarative | Multi-cloud or cloud-agnostic shops |
| Pulumi | Programming language + multi-cloud | Teams wanting CDK-like experience outside AWS |
| CloudFormation / ARM / Deployment Manager | Native to provider, no extra tooling | Simple single-cloud deployments |
| SAM / Serverless Framework | Serverless-first abstractions | Lambda/serverless-heavy architectures |

### Structure

```
infrastructure/
├── modules/          ← reusable components (database, network, compute)
├── environments/
│   ├── dev/
│   ├── staging/
│   └── prod/
├── shared/           ← cross-environment (DNS, IAM, shared VPC)
└── scripts/          ← deployment automation, drift checks
```

## Serverless Patterns

When to use serverless (functions/event-driven):

| Good fit | Poor fit |
|---|---|
| Event-driven, short-duration (<15min) | Long-running processes |
| Spiky/unpredictable traffic | Steady high throughput (cold starts matter) |
| Simple request-response | Complex orchestration with state |
| Cost-sensitive at low scale | Latency-sensitive (p99 < 50ms) |
| Prototype / MVP (fast to production) | Heavy compute (ML inference, video processing) |

### Composition patterns

- **API + Function** — API Gateway → Lambda → Database
- **Event fan-out** — Event source → Queue/Topic → N functions
- **Step function / workflow** — Orchestrated multi-step with branching and error handling
- **Scheduled** — Cron-triggered functions for batch/maintenance

## Container Patterns

When to use containers:

| Good fit | Poor fit |
|---|---|
| Long-running services | Simple event handlers (serverless is cheaper) |
| Complex dependencies (native libs, ML models) | Stateless transformations |
| Consistent latency requirements | Burst-only workloads (scale-to-zero matters) |
| Team has container expertise | Team has no container/orchestration experience |
| Need to run same image locally and in cloud | Prototype (overhead too high for speed) |

### Orchestration choice

- **Managed Kubernetes (EKS, GKE, AKS)** — when you need the full K8s API, have the team to operate it
- **Managed containers (ECS, Cloud Run, Azure Container Apps)** — when you want containers without K8s complexity
- **Plain Docker + VM** — when you have 1-3 services and orchestration is overkill

## Multi-Region Design

When required (latency, compliance, DR):

- **Active-passive** — primary region serves traffic, secondary on standby. Simple, higher RTO.
- **Active-active** — both regions serve traffic. Complex (data replication, conflict resolution), low RTO.
- **Follow-the-sun** — route by geography. Good for global users, complex data partitioning.

Key decisions:
- Data replication strategy (sync vs async, conflict resolution)
- DNS routing (latency-based, failover, geolocation)
- Deployment strategy (deploy to all regions simultaneously vs canary per region)

## Output Format

Extends infrastructure-design-skill output with:

```markdown
## Cloud Services Selected

| Concern | Service | Provider | Rationale | Alternative considered |
|---|---|---|---|---|
| Compute | ECS Fargate | AWS | No cluster management, team knows it | Lambda (too latency-sensitive) |
| Database | Aurora PostgreSQL | AWS | Managed, compatible, auto-scaling storage | RDS (no auto-scale storage) |
| Queue | SQS | AWS | Simple, reliable, no ops | Kafka (overkill for our throughput) |

## IaC Strategy

- Tool: [CDK / Terraform / etc.]
- Structure: [mono-stack / multi-stack / module-based]
- State: [remote, S3 + DynamoDB lock / Terraform Cloud / etc.]
- CI integration: [how IaC deploys are triggered]

## Serverless vs Container Decisions

| Component | Model | Reasoning |
|---|---|---|
| API handlers | Container (Fargate) | Consistent latency, complex deps |
| Event processors | Lambda | Spiky, short-duration, cheap at low volume |
| Scheduled jobs | Lambda + EventBridge | Cron-style, no idle cost |
```

## Principles

- **Managed by default** — only self-host when you have a reason (cost, customization, portability)
- **IaC from day 1** — no manual infrastructure that can't be reproduced
- **Least privilege everywhere** — IAM policies scoped to exactly what's needed
- **Cost visibility** — tag everything, set budgets, review monthly
- **Portable where it matters** — abstract at the application layer (repository pattern, queue interface), not at the infrastructure layer (multi-cloud IaC is usually premature)
