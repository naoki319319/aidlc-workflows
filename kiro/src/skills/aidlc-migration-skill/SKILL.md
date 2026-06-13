---
name: aidlc-migration-skill
description: |
  The skill of migrating systems — strangler fig, blue-green cutover, data migration, zero-downtime patterns, feature flags, and rollback strategy. Applied when the intent involves moving from one platform, architecture, or technology to another.
---

# Migration Design

## Definition

Plan and design the safe transition of a system from its current state to a target state — without losing data, breaking users, or requiring extended downtime. Migration is not just "rewrite and deploy" — it's a controlled, reversible, incremental transformation.

## When Applied

- When the intent says "migrate", "move", "upgrade", "replace", "replatform"
- When changing databases, frameworks, cloud providers, or architecture patterns
- When reverse-engineering reveals a system that needs modernization
- When splitting a monolith or merging services

## Migration Patterns

### 1. Strangler Fig

**When:** Incrementally replacing a legacy system feature-by-feature.

```
[Users] → [Router/Proxy]
                ├── feature A → [New System]  (migrated)
                ├── feature B → [New System]  (migrated)
                └── feature C → [Old System]  (not yet migrated)
```

Steps:
1. Place a routing layer in front of the old system
2. Build new implementation for one feature/route
3. Route that feature to new system
4. Verify (traffic comparison, shadow mode)
5. Repeat until old system has no traffic
6. Decommission old system

**Good for:** Web applications, API-based systems, microservice extraction.
**Bad for:** Tightly coupled batch systems, shared-database monoliths (need data migration first).

### 2. Blue-Green Deployment

**When:** Swapping the entire system at once with instant rollback capability.

```
[Load Balancer]
    ├── Blue (current production) ← traffic here
    └── Green (new version, idle) ← deploy here, test, then swap
```

Steps:
1. Deploy new version to green environment
2. Run smoke tests / synthetic traffic against green
3. Switch traffic (DNS, load balancer rule, or feature flag)
4. Monitor for errors
5. If problems → switch back to blue (instant rollback)
6. If stable → decommission blue

**Good for:** Stateless services, containerized deployments.
**Bad for:** Systems with persistent state that changes between blue and green (need data migration strategy).

### 3. Parallel Run (Shadow Mode)

**When:** You need confidence that new system behaves identically to old.

Steps:
1. Route production traffic to BOTH old and new system
2. Old system serves the response to users
3. New system processes the same request but discards the response
4. Compare outputs (log differences)
5. Fix discrepancies until outputs match
6. Cut over (new system serves responses)

**Good for:** Critical calculations, financial systems, anything where "slightly different" is unacceptable.
**Cost:** Double the compute during parallel phase.

### 4. Feature Flag Migration

**When:** Migrating internal implementation without changing external behavior.

Steps:
1. Implement new path behind a feature flag (off by default)
2. Enable for internal users / canary percentage
3. Gradually increase percentage while monitoring
4. At 100% → remove flag and old code path

**Good for:** Backend refactors, database switches, algorithm changes.
**Enables:** Gradual rollout, instant rollback (flip flag off), A/B comparison.

### 5. Data Migration

**When:** Moving data between schemas, databases, or formats.

| Strategy | How | When |
|---|---|---|
| Big bang | Stop writes, transform all data, start new system | Small datasets, acceptable downtime window |
| Dual-write | Write to both old and new, read from old, cut over reads later | Zero-downtime requirement, eventually consistent is OK |
| CDC (Change Data Capture) | Stream changes from old to new continuously | Large datasets, zero-downtime, near-real-time sync |
| ETL batch | Periodic bulk transform | Analytics/reporting migrations, non-real-time |

Key concerns:
- Data validation (old data → new schema — what doesn't fit?)
- Referential integrity across systems during transition
- Rollback plan (can you reverse the data migration?)
- Data freshness during transition window

## Migration Planning

### Assessment Phase

1. **Inventory** — what exists? (use reverse-engineering artifacts)
2. **Dependencies** — what connects to what? (internal and external)
3. **Risk map** — what's high-risk to migrate? (data, integrations, critical paths)
4. **Sequence** — what order minimizes risk? (leaf nodes first, shared dependencies last)

### Execution Strategy

| Factor | Incremental | Big bang |
|---|---|---|
| Risk per step | Low (small changes, reversible) | High (all at once) |
| Total duration | Long (weeks/months) | Short (one cut-over window) |
| Complexity | Higher (dual paths, routing, flags) | Lower (one switch) |
| Rollback | Easy (per feature) | Hard (all or nothing) |
| Testing | Continuous (each increment tested in prod) | One shot (must be thorough) |

**Default stance:** Incremental unless the system is small enough for big-bang without risk.

### Rollback Design

Every migration step must answer:
- How do we detect failure? (monitoring, alerts, health checks)
- How do we roll back? (feature flag, DNS swap, restore backup)
- How long can we wait before rollback is no longer possible? (point of no return)
- What data is at risk if we roll back? (writes during transition window)

## Output Format

```markdown
## Migration Strategy

**Pattern:** [Strangler Fig / Blue-Green / Parallel Run / Feature Flag / Hybrid]
**Duration estimate:** [weeks/months]
**Downtime:** [zero / planned window of X hours / rolling]
**Rollback:** [instant / within X minutes / requires data restore]

## Migration Sequence

| # | What migrates | Pattern | Risk | Rollback |
|---|---|---|---|---|
| 1 | [component/feature] | [strangler / flag] | [L/M/H] | [how] |
| 2 | [data store] | [CDC / dual-write] | [L/M/H] | [how] |
| 3 | [integration] | [parallel run] | [L/M/H] | [how] |

## Data Migration Plan

| Dataset | Size | Strategy | Validation | Point of no return |
|---|---|---|---|---|
| [users table] | [10M rows] | [CDC] | [row count + checksum] | [after 24h of dual-write] |

## Cutover Checklist

- [ ] New system passes all integration tests
- [ ] Parallel run shows <0.1% output divergence
- [ ] Rollback tested in staging
- [ ] Monitoring and alerts configured for new system
- [ ] Runbook written for rollback procedure
- [ ] Communication plan for users (if user-facing change)
- [ ] Point of no return identified and communicated

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [data loss during transition] | [L/M/H] | [H] | [dual-write + reconciliation job] |
```

## Principles

- **Reversibility is non-negotiable** — every step must have a rollback plan
- **Incremental over big-bang** — smaller steps, faster feedback, lower risk
- **Data is the hard part** — code migrations are easy; data migrations are where things break
- **Monitor the transition, not just the target** — the dangerous period is during migration, not after
- **Feature flags are your friend** — they make migrations gradual and reversible at the code level
- **Don't migrate what you can delete** — dead features, unused data, legacy integrations that nobody calls
