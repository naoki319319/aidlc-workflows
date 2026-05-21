"""AIDLC Builder agent — executes a single skill step (clarification / planning / execution / fix)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import boto3
from botocore.config import Config as BotoConfig
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models.bedrock import BedrockModel

from aidlc_runner.config import ExecutionConfig, ModelConfig
from aidlc_runner.tools.file_ops import make_file_tools
from aidlc_runner.tools.rule_loader import make_rule_loader
from aidlc_runner.tools.run_command import make_run_command

BUILDER_SYSTEM_PROMPT = """\
You are the AIDLC Builder agent. You execute exactly ONE step of ONE AI-DLC skill per \
invocation, then hand back to the orchestrator.

## Protocol

Immediately load and read the builder protocol — it is the single source of truth for
your behaviour on every invocation:

  load_rule('aidlc-common/protocols/aidlc-builder-protocol.md')

Then load the skill files the orchestrator specified in its handoff message (SKILL.md and
validation-spec.md for the active skill), and follow the protocol exactly for the step you
were given (clarification / planning / execution / fix).

## Rules

- Read the skill's SKILL.md frontmatter flags (human-clarification, plan-creation) and
  apply them exactly as the builder protocol describes.
- Do NOT self-validate against validation-spec.md. That is the validator's job.
- Do NOT run scripts in the skill's scripts/ directory. Those are exclusively for the
  validator.
- Do NOT interact with the human directly. All human communication is routed through the
  orchestrator.
- Use real ISO 8601 timestamps (current date/time) when writing any state or audit entries.
- Write the state transition for YOUR step to intent-state.md BEFORE handing back.
- Append an audit row to the intent audit file (audit/intent-audit.md) for every step
  you complete. Use real ISO 8601 timestamps. One row per step — do not batch.
  The audit path is: aidlc-docs/<intent-dir>/audit/intent-audit.md
  Format: | <timestamp> | <skill> | <step> | <status> | <brief details> |
- IMMEDIATELY after completing your step, handoff back to the "orchestrator" with:
  - Your status: clarification-needed / plan-ready / complete
  - The exact paths to all files you wrote
  - Do NOT proceed to the next step or next skill — that is the orchestrator's decision.

## ABSOLUTE PROHIBITION

You MUST NOT proceed to the next step or the next skill on your own. Your job is exactly
one step per invocation. After that step is written to disk, hand back to "orchestrator".

## File paths

All framework files (skills/, aidlc-common/) are relative to the src/ directory in the
run folder. All intent artifacts (aidlc-docs/) are relative to the run folder root.
"""


def create_builder(
    run_folder: Path,
    rules_dir: Path,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    execution_config: ExecutionConfig | None = None,
) -> Agent:
    """Create the AIDLC Builder agent.

    Args:
        run_folder: Path to the run folder for this execution.
        rules_dir: Path to the v2 src/ directory containing skills/ and aidlc-common/.
        model_config: Model configuration for this agent.
        aws_profile: AWS profile name for Bedrock.
        aws_region: AWS region for Bedrock.
        callback_handler: Optional callback handler for progress reporting.
        execution_config: Optional execution config controlling run_command availability.

    Returns:
        Configured Strands Agent instance.
    """
    if execution_config is None:
        execution_config = ExecutionConfig()

    file_tools = make_file_tools(run_folder)
    rule_loader = make_rule_loader(rules_dir)
    tools = [*file_tools, rule_loader]

    if execution_config.enabled:
        run_cmd = make_run_command(run_folder, timeout=execution_config.command_timeout)
        tools.append(run_cmd)

    session_kwargs: dict = {}
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    if aws_region:
        session_kwargs["region_name"] = aws_region
    boto_session = boto3.Session(**session_kwargs)
    boto_client_config = BotoConfig(
        read_timeout=900,
        connect_timeout=30,
        retries={"max_attempts": 10, "mode": "adaptive"},
    )
    model = BedrockModel(
        model_id=model_config.model_id,
        boto_session=boto_session,
        boto_client_config=boto_client_config,
    )

    return Agent(
        name="builder",
        system_prompt=BUILDER_SYSTEM_PROMPT,
        model=model,
        tools=tools,
        callback_handler=callback_handler,
        conversation_manager=SlidingWindowConversationManager(window_size=20),
    )
