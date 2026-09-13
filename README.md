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
pnpm add https://github.com/luismichelcf/ai-workflows/releases/download/v0.2.0/ai-workflows-0.2.0.tgz
```

Requires Node 20 or later. Installing straight from the git repository is not supported: the
package has to be compiled first, and pnpm 10 refuses build scripts from git dependencies.

## Status

Slices 1 to 4 are done: `engine`, `gates`, `providers` and `locks`. A piece's progress can live in
memory (`createMemoryStore`) or on GitHub (`createGitStore` over `createGitHubStatePort`), so a run
survives its session and another terminal sees it.

## Where progress lives on GitHub

```ts
const store = createGitStore({
  port: createGitHubStatePort({ owner: 'you', repo: 'project' }),
});
await runCommand(argv, { config, store, describeChange, leaseMs: 15 * 60_000 });
```

- Each piece has its own ref, `refs/ai-workflows/pieces/<piece>`, holding `status.json`,
  `journal.json`, `effects.json` and `lease.json`; each zone has `refs/ai-workflows/zones/<zone>`.
  Every ref also keeps `ref.json`, naming the piece or zone it belongs to: GitHub refuses a tree
  with no files, so releasing a lease must never leave a ref empty.
  None of them is a branch or a tag, so writing them fires no deployments and no push workflows.
  Branches and tags are refused as a namespace.
- Every write reads that ref's head, decides from that one read, commits on top of it and moves
  the ref only if nobody moved it first (GraphQL `updateRefs` with `beforeOid`). A lost race is
  re-read and retried with a growing, jittered pause; a stale status write fails with
  `StaleVersion`. Pieces never race each other, because they never share a ref.
- It talks to GitHub through `gh`, with the account `gh` is logged in to, never through a shell,
  and stops a call that has not answered in 60 seconds.
- Each write costs about six API calls, three of them creating content, and the engine renews its
  lease every third of `leaseMs`; `runCommand` refuses a lease under 30 seconds, and the engine
  refuses one that is not a positive number. Over GitHub use a lease of minutes: with 15 minutes a running
  piece renews every 5 minutes, about 36 content-creating requests an hour, well under GitHub's
  limit of 500 an hour for ten pieces at once.

## What it does not promise

- Nothing stops a repository administrator from changing or disabling the rules.
- A sign-off by comment proves which GitHub account wrote it, not which person.
- Anyone who can push to the repository can rewrite the state refs. The journal is not yet
  rebuilt from GitHub's own events, so a hand-edited state is believed.
- Leases compare clocks: a machine whose clock runs far ahead or behind can take a lease that is
  still alive. A controller that dies keeps its piece until its lease runs out.
- A lease does not fence effects: a gate still running after losing its lease can start one. The
  claim stops it from running twice, but the next holder may have to reconcile it.
- `gh` decides where the state goes: `GH_HOST`, `GH_TOKEN` and the logged-in account all apply.
  A rate limit is reported as a failure; the store does not wait for `Retry-After`.
- Every write adds a commit to its ref, and journals and effect tables are rewritten whole.
- The editor hooks are help, not a guarantee: they do not see MCP tools, and a determined agent
  can still reach the same result by other means. The server check is the mandatory layer.
