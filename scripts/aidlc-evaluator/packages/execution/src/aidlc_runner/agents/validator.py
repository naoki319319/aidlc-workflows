"""AIDLC Validator agent — validates skill artifacts against the validation spec."""

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

VALIDATOR_SYSTEM_PROMPT = """\
You are the AIDLC Validator agent. You validate the artifacts produced by the builder for
one AI-DLC skill step.

## Protocol

Immediately load and read the validator protocol — it is the single source of truth for
your behaviour on every invocation:

  load_rule('aidlc-common/protocols/aidlc-validator-protocol.md')

Then load the validation spec the orchestrator specified in its handoff message
(validation-spec.md for the active skill), and follow the protocol exactly.

## Rules

- Do NOT read the builder protocol or the skill's SKILL.md. You validate artifacts
  only — you do not need to know how they were produced.
- Do NOT fix artifacts. Validate and report findings only.
- Do NOT interact with the human directly.
- Run every script in the skill's scripts/ directory exactly once if that directory exists
  and you have access to run_command. Capture exit codes and include them in your report.
- Write the validation report to the skill output folder and include the machine-readable
  ---PROCESS-CHECK-DATA--- block at the end as specified in the validator protocol.
- Append an audit row to the intent audit file (audit/intent-audit.md) for the validation
  result. Use a real ISO 8601 timestamp.
  Format: | <timestamp> | <skill> | validation | <pass/fail> | <brief summary> |
- After completing validation, handoff back to the "orchestrator" with your status
  (pass / fail) and the validation report path.

## File paths

All framework files (skills/, aidlc-common/) are relative to the src/ directory in the
run folder. All intent artifacts (aidlc-docs/) are relative to the run folder root.
"""


def create_validator(
    run_folder: Path,
    rules_dir: Path,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    execution_config: ExecutionConfig | None = None,
) -> Agent:
    """Create the AIDLC Validator agent.

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
        name="validator",
        system_prompt=VALIDATOR_SYSTEM_PROMPT,
        model=model,
        tools=tools,
        callback_handler=callback_handler,
        conversation_manager=SlidingWindowConversationManager(window_size=20),
    )
