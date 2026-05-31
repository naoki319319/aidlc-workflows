# AI-DLC Workflow

This workspace uses the AI-DLC multi-agent workflow framework.

## Entry Point

The orchestration skill is the main agent skill. Activate it for any development intent.

- Orchestration skill: `.claude/skills/orchestration/SKILL.md`
- Stage definitions: `.claude/stages/`
- Conventions: `.claude/conventions/`
- Tools: `.claude/tools/`
- Sub-agent personas: `.claude/agents/`

## How It Works

1. State your development intent
2. The orchestrator composes an adaptive workflow from the stage graph
3. Personas are invoked as sub-agents with: `stage:`, `status:`, `directory:`
4. Each persona self-directs using their skills and the work-method
5. Process checker validates outputs and reviews after each sub-agent completes

Read `.claude/skills/orchestration/SKILL.md` for the full orchestration protocol.
