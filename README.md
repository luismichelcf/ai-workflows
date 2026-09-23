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
pnpm add https://github.com/luismichelcf/ai-workflows/releases/download/v0.3.0/ai-workflows-0.3.0.tgz
```

Requires Node 20 or later. Installing straight from the git repository is not supported: the
package has to be compiled first, and pnpm 10 refuses build scripts from git dependencies.

## Status

Slices 1 to 4 are done: `engine`, `gates`, `providers` and `locks`. A piece's progress can live in
memory (`createMemoryStore`) or on GitHub (`createGitStore` over `createGitHubStatePort`), so a run
survives its session and another terminal sees it.

Version 1 (in progress, [PLAN-13](docs/plans/PLAN-13.md)) moves a project's process into a short
recipe, `.ai-workflows/pipeline.yml`, that the owner can read without programming:

```sh
ai-workflows init       # writes an example recipe
ai-workflows validate   # rejects with file:line:column and the reason
ai-workflows explain    # the whole recipe in plain words, in the recipe's language
```

The recipe is strict YAML 1.2: duplicate keys, anchors, aliases, tags and unknown keys are
rejected, and `NO` stays text. Its JSON Schema (`schema/recipe.schema.json`) is the same object
`validate` enforces, so the editor and the engine agree. A stage's `applies-if` is a structured
condition (`touches-any`, `touches-none`, `kind-any`, `kind-none`, `lane-any`), never an
expression; a stage that does not apply is recorded as skipped with its reason, and
`status <piece>` lists it that way. The server check arrives in slice 3.

## Blocks

A stage's `gate` names a **block**. Engine blocks are `uses: ai-workflows/<name>@<major>`;
project blocks live in `.ai-workflows/blocks/<name>/` with a `block.yml` manifest. Every block
declares the natures it may claim, the validity rules it accepts and its typed inputs, and
`validate` checks each stage against that manifest before anything runs.

| Block | Checks | Nature |
|---|---|---|
| `spec-structure` | Required sections, a labelled summary, identified criteria, no pending decisions | structure |
| `benchmark-sources` | Distinct sources per category, optional reachability; a written waiver skips it | structure |
| `sandboxed-review` | Runs a reviewer read-only, observes its identity, the tree before and after, and its verdict | recompute + attest |
| `red-test` | The new tests fail by their assertion, not by an import or the environment | recompute + execution record |
| `build-verify` | Tests green, untouched since the red run (also in history), and red again with only the implementation retired | recompute + execution record |
| `command` | A project command within a time limit; optionally reads a Vitest run | recompute |
| `scope-reconcile` | Records when the real files raise the kind (and so the lane) above what was declared | recompute |

`independent-review`, `approval-comment`, `preview-deployment`, `browser-qa`, `github-merge`,
`post-merge` and `cleanup` have manifests already and are built in slice 4; a recipe that uses
them validates, and running them blocks with that reason.

**Project blocks.** A *module* block (`kind: module`, `main: index.mjs`) is imported and called
with the same context as any gate — journal, locale, mode, cancellation signal and `runEffect` —
and may export `reconcile(operationId, context)` so an effect left in doubt by a crash is checked
against the outside world instead of repeated. It runs in the engine's process, so it only runs
next to the agent, never in the server check. A *command* block (`kind: command`, or `run:` in
the recipe) is a separate program with no effects: it reads the change as JSON on stdin and
prints exactly `{ "ok": true | false | "skipped", "reason", "evidence" }`. Anything else — a
non-zero exit, extra text, a missing or unknown key, running out of time, printing more than
1 MB — blocks the piece technically; it never passes. Command lines are split on spaces and never
reach a shell; `{tests}` and `{piece}` are the only placeholders.

**Processes.** A command block runs inside a group the operating system keeps together: a job
object on Windows (created suspended, no breakaway, killed as a whole) and a process group
elsewhere. When a piece is cancelled or the block ends, the engine empties the group and
confirms it is empty before letting go. If it cannot confirm that, the piece stays in quarantine
— no stage of it runs, from any controller, even after its lease expires — until the system
itself answers that the group is gone.

**Evidence and validity.** The engine seals every passing stage with what it judged — the
commit, the exact snapshot of the working tree (unsaved and new files included) and the
fingerprint of the piece's own changes — and a block cannot write that part. A stage keeps its
evidence while its `valid-while` rule holds (`same-sha` by default, `same-fingerprint`,
`same-fingerprint-or-clean-update`, `forever`). A clean update with the base only keeps a review
alive when the engine recorded it and git confirms it again on every read: a merge of exactly the
old head and a base commit whose tree is what a three-way merge produces. If the working tree
changes while a stage runs, or before a piece would be called done, the piece is blocked instead.

The facts of a change come from git, never from the piece: files, snapshot, fingerprint, and the
effective kind — forced by `from-paths`, else declared, then raised by `elevate` rules in order —
with the lane following the kind (`lanes:`). The recipe declares its kinds and lanes once
(`kinds.names`, `lanes`), and any other word is rejected. `labels` gives classes, kinds and lanes
the owner's words for `explain`.

`compileRecipe(recipe, deps)` turns a recipe into the engine's configuration. Wiring `run`,
`status` and `stop` of the command line to the recipe arrives in slice 4.

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
