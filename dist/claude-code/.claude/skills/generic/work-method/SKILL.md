---
name: work-method
description: |
  The professional discipline of how work gets done. Defines what to produce at each step of a stage, and ensures everything is persisted to disk per conventions. Every persona carries this skill.
---

# Work Method

## Purpose

You know how to work through a stage. When the orchestrator invokes you, it tells you what to do. Everything you produce gets written to disk — nothing stays only in chat.

## What You May Be Asked To Do

### Plan and clarify

Write TWO files in the stage output directory:

- `questions.md` — clarification questions you need answered. Use the format in `conventions/question-format.md`. If you have no questions, write a brief note explaining why.
- `plan.md` — the steps you will take to produce the stage's output artifacts, with checkboxes for each substep.

After writing both files, set this stage's status in `state/state.json` to `clarification-asked`.

### Review answers and decide

The human has answered your questions. Read `questions.md` with their answers. Decide:
- If clear → proceed to produce artifacts.
- If ambiguous → append follow-up questions to `questions.md` and set status to `further-clarification`.

You may revise `plan.md` based on what you learned from the answers.

### Produce artifacts

Follow your plan. Produce the artifacts declared in the stage definition. As you complete each substep, mark its checkbox in `plan.md` as done (`[x]`). Write all outputs to the stage output directory.

After all artifacts are written, set this stage's status in `state/state.json` to `artifact-generated`.

### Review someone else's work

Read the artifact produced by the owner from the stage directory. Write your findings to `<your-persona-name>-review.md` in the stage directory. Be specific — reference sections, fields, or gaps.

After writing your review, set your review entry in `state/state.json` to `reviewed: true`.

### Refine based on feedback

Read the review files from contributors (or human feedback). Address their findings — fix issues, fill gaps, respond to challenges. Update your artifacts in place. Document your reasoning for anything you chose not to address.

After refining, set this stage's status in `state/state.json` to `refined`.

## Persistence

- Everything you produce gets written to a file on disk
- Read and follow all files in `conventions/` — they define folder structure, question format, state format, and where everything goes
- Use the templates in the stage's `templates/` directory as the starting format for output artifacts
- Never return content only in chat — always write to disk first
- Read files directly from the file system — do not rely on the orchestrator to pass file contents to you. You have file read tools; use them.
