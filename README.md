# ai-workflows

A deterministic stage engine for coding agents. A pipeline is a list of stages; a stage advances
only when its **gate** — a predicate written in code — says so. The agent cannot skip a stage,
because nothing asks the agent whether it complied.

The engine is project-agnostic. Each repository brings its own `pipeline.config.ts` with its
stages, gates, lanes and models. Nothing about any particular project lives in here.

## Why

An agent that follows an instruction once has not proven that anything prevents it from skipping
it. Rules written in a prompt are advice; a gate is a control. See the full rationale, threat
model and acceptance criteria in the spec: `docs/plans/PLAN-997.md` of `luismichelcf/Socialabs`.

## What a gate may promise

Every gate declares the nature of its check, and never promises more:

| Nature | Meaning |
|---|---|
| **Recompute** | The engine produces the result again now. Prior evidence is irrelevant. |
| **Structure** | Checks the shape of a document, not its truth or sufficiency. |
| **Execution record** | A historical property, validated against the journal the engine wrote while observing it. |
| **Attest** | A human or model judgement, published as an authenticated event. |

## Status

Slice 1 in progress: `engine`, `state`, `run` / `status` / `validate`.
