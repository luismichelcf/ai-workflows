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

## Install

Each version is published as a built package attached to its GitHub Release. Install it by URL;
nothing runs during your install:

```sh
pnpm add https://github.com/luismichelcf/ai-workflows/releases/download/v0.1.0/ai-workflows-0.1.0.tgz
```

Requires Node 20 or later. Installing straight from the git repository is not supported: the
package has to be compiled first, and pnpm 10 refuses build scripts from git dependencies.

## Status

Slices 1 to 4 are done: `engine` with the in-memory store, `gates`, `providers` and `locks`.

Not built yet: the GitHub-backed store (labels, events and a journal in the branch). Until it
exists, `run` does not survive between sessions and other terminals cannot see a piece.

## What it does not promise

- Nothing stops a repository administrator from changing or disabling the rules.
- A sign-off by comment proves which GitHub account wrote it, not which person.
- The editor hooks are help, not a guarantee: they do not see MCP tools, and a determined agent
  can still reach the same result by other means. The server check is the mandatory layer.
