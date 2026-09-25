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

Version 1 (in progress, [PLAN-13](docs/plans/PLAN-13.md); its slice 5 tries every attempt to get
around the process on real GitHub, see below) moves a project's process into a short
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
`status <piece>` lists it that way. The server check, the judge, is described below.

## Blocks

A stage's `gate` names a **block**. Engine blocks are `uses: ai-workflows/<name>@<major>`;
project blocks live in `.ai-workflows/blocks/<name>/` with a `block.yml` manifest. Every block
declares the natures it may claim, the validity rules it accepts and its typed inputs, and
`validate` checks each stage against that manifest before anything runs.

| Block | Checks | Nature |
|---|---|---|
| `spec-structure` | Required sections, a labelled summary, identified criteria, no pending decisions | structure |
| `benchmark-sources` | Distinct sources per category, optionally that each source's domain answers; a written waiver skips it | structure |
| `sandboxed-review` | Runs a reviewer read-only, observes its identity, the tree before and after, and its verdict | recompute + attest |
| `red-test` | The new tests fail by their assertion, not by an import or the environment | recompute + execution record |
| `build-verify` | Tests green, untouched since the red run (also in history), and red again with only the implementation retired | recompute + execution record |
| `command` | A project command within a time limit; optionally reads a Vitest run | recompute |
| `scope-reconcile` | Records when the real files raise the kind (and so the lane) above what was declared | recompute |

The final stages (slice 4, [PLAN-13-R4](docs/plans/PLAN-13-R4.md)):

| Block | Checks | Nature |
|---|---|---|
| `independent-review` | The flock's verdicts published on the piece's issue: one fresh approving verdict per angle, each from another session (and, by default, another model family) than every builder | execution record + attest |
| `approval-review` | The owner's last decisive review of the pull request (GitHub's "Approve" button) names a version the stage accepts | attest |
| `approval-comment` | The same with a comment `/<command> <code>`, for projects whose agents publish with the owner's own account | attest + recompute |
| `preview-deployment` | The newest deployment of this exact commit in an environment is successful, with an `https` address matching a pattern | recompute |
| `browser-qa` | The project's browser suite, run against that preview with a fresh environment, writes one passing report per criterion of the plan | recompute |
| `github-merge` | Pushes the judged commit, opens the pull request once, arms auto-merge on that exact head (or joins the merge queue) and watches it to the end | recompute |
| `post-merge` | Named checks and a deployment of the merge commit are green | recompute |
| `cleanup` | Deletes the remote branch at the merged head; the folder and local branch are retired by `finish` after `done` | recompute |

Every external effect goes through `runEffect` with an operation id and a mark GitHub keeps (the
pull request body, the comment, the branch activity, the pull request timeline). After a crash the
engine reads that history: an act of the agents' own identity after the anchor of this attempt
confirms the effect — even if a person undid it since, which is then respected, never repeated —
and only the absence of that act together with a state compatible with "never happened" lets it
run again. Anything else leaves the stage technical, naming the effect.

A stage may say `required: false` (it is recorded and the piece goes on; tried again on every run
until `finish`; a surviving process group, an effect in doubt or a store failure still block) and
`retry: { attempts, wait-seconds }` (a rejection or an ordinary error is tried again; a skip, a
person's pending answer or an effect in doubt never is).

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

`compileRecipe(recipe, deps)` turns a recipe into the engine's configuration and re-checks it against
the manifests on its own; `deps.root` must be the top of the repository. Pass everything it
returns to `createEngine` — `config`, `describeChange`, `confirmFacts` (the final check before a
piece is done) and `confirmQuarantine` (without it a quarantined piece cannot be released).
The command line runs the recipe next to the agent (below).

The independence of a review is judged by provider and session: the same session under another
model is still the builder (PLAN-13 R18).

## The judge: the check on GitHub

Next to the agent the engine guides and stops every stage, but anyone can open a pull request from
the web or merge from another machine. The judge is a status check on GitHub that re-checks every
stage before merging, with the recipe of the main branch, on the pull request and in the merge
queue. Design: [PLAN-13-R3](docs/plans/PLAN-13-R3.md).

**Install.** Copy `templates/ai-workflows.yml`, `templates/ai-workflows-red-test.yml` and
`templates/ai-workflows-review-signal.yml` into `.github/workflows/`, replace `<ENGINE_SHA>` with
the full commit SHA of the engine version you use (never a tag: the judge refuses to run unpinned),
adjust the install steps of the red-test workflow to your project, and add to
`workflow_run.workflows` of the judge the workflows that produce the checks your recipe requires.
Then turn it on with the repository variable and, after that, require the `ai-workflows` status in
the branch ruleset.

**What wakes it again.** Besides the pull request's own events, two things judge a pull request
again without anyone asking ([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §2.6):

- *The owner's "Approve".* A `pull_request_review` would run the pull request's own YAML, so it is
  not a judge trigger. The review signal workflow listens to it instead, with no permissions and no
  steps that read the pull request, and the judge follows it through `workflow_run` (whose YAML is
  always the main branch's). The judge checks the signal's repository, path and event, takes the
  pull request number from it only as a hint, re-reads the pull request and judges its live head.
  A pull request can rewrite the signal and that version runs, but it gains nothing a pull request
  of the same repository does not already have: at worst the judge is not woken (the pull request
  keeps waiting) or a status is imitated (the accepted limit R13, reported as a trace). The signal
  is one of the judge's own files: a pull request that changes it needs `/approve-judge-change`.
  From a fork GitHub gives no pull request number: the next event or `workflow_dispatch` judges it.
- *A builder or verdict event on the piece's issue.* A new comment carrying the event mark, or any
  edit or deletion of a comment on an issue, makes the judge read the recipe of the main branch and
  judge every open pull request into the main branch whose branch names that piece, each on its own
  head, with the same guarantees before publishing as any other run. Editing any issue comment
  therefore costs a short run; one that finds no piece ends without publishing.

**Where a stage is checked.** Every pre-merge stage says it with `server:`, within what its block
allows, and `validate` enforces it:

| `server:` | What the judge does |
|---|---|
| `recompute` | Runs the block's server check again on the pull request's files, read from git objects (spec structure, benchmark sources without reachability, scope) |
| `require-check: <name>` | Requires that check — a check run or a commit status — green on the judged SHA (the pull request head, or the merge group SHA in the queue) |
| `attestation` | Looks for the authenticated event: the owner's review or comment on the pull request (`approval-review`, `approval-comment`), or the verdicts published on the piece's issue (`independent-review`, `sandboxed-review`) |
| `local-only` | Only for post-merge stages or `required: false`: checked next to the agent only |

**Pieces.** `pieces:` tells the judge which branch is which piece (`branch: ["*/{piece}-*"]`,
`{piece}` being a number), which branches never merge (`exclude-branches`), and which line of the
piece's plan declares its kind (`declared-kind`). A branch without a piece is rejected. The
declared kind is the piece's word; paths still raise it.

**Provenance.** The judge runs with `pull_request_target` and `merge_group` (plus
`issue_comment`, `workflow_run` and `workflow_dispatch` to judge again), checks out only the
live head of the main branch, and reads the pull request as git objects: it never checks out or
runs its code, and it never reads the state refs, the store or the providers. It refuses to judge
when its workflow does not come from the main branch (or, in the queue, from the queue branch), and
publishes nothing for a pull request into another branch. A pull request that touches
`.ai-workflows/`, the judge's workflow or the red-test workflow is rejected unless the recipe's
`owner` comments `/approve-judge-change <sha>` for that exact head.

**The red test.** The `ai-workflows/red-test` check runs in its own workflow, with
`pull_request` and `merge_group`, read-only permissions and no secrets: each piece's new or
changed tests must fail by their assertion against its base (in the queue, the base of its own
entry) and pass against the head, with the dependencies installed from the head. It runs the pull
request's code, so it deserves the trust of any test suite check, not more.

**The switch.** The repository variable `AI_WORKFLOWS_MODE`: `off` (or unset) publishes green
"motor apagado" without installing anything; `advisory` publishes green and the real verdict in
`ai-workflows/advisory`; `on` publishes the real verdict. Any other value is an error. Each pull
request is judged on its own, so one that fails technically does not block the others.

**Statuses.** passed → success, rejected → failure, waiting (for a check or the owner) → pending,
technical → error, with the stage that decided in the description and the detail in the run
summary. A run first replaces any earlier green with pending; before publishing it re-reads the
pull request's head and the main branch, and stays quiet if a newer run already published.

**Limits.** Any workflow in the repository can publish a status or a check with the judge's name
(accepted, PLAN-13 R13): the judge reports such statuses and check runs on the pull request, but
one that copies the link of a real judge run is not detected. A required check produced by an app
outside Actions does not trigger the judge again; the next event or `workflow_dispatch` does. If
GitHub's status API or Actions are down, nothing can be published, not even the green of `off`.
An approval whose commit GitHub no longer delivers after a force push has to be given again.

## Next to the agent: the command line

```sh
ai-workflows run <piece>        # runs the recipe for the piece of the current branch
ai-workflows status [piece]     # plain-language state
ai-workflows stop <piece> [why] # also: pause, resume — they work even with a broken recipe
ai-workflows build <piece> --provider P --model M [--effort E] --prompt <file>
ai-workflows review <piece> --angle A --provider P --model M [--effort E] --prompt <file>
ai-workflows sync <piece>       # takes GitHub's "Update branch" merge, only if it is a clean update
ai-workflows finish <piece>     # after done: retires the piece's worktree and local branch
ai-workflows doctor
```

`run`, `build`, `review` and `sync` refuse an invalid recipe or a piece that is not the one of the
current branch before touching anything. `build` and `review` run the coding CLI, observe its real
identity and publish a builder or verdict event on the piece's issue; `independent-review` reads
them. Progress lives in `refs/ai-workflows/*` of `origin` with a 15-minute lease.

**The agents' own GitHub identity (R21).** Declare `agent-account: "<app-slug>[bot]"` in the recipe
and everything the engine does on GitHub is done as a GitHub App, so the pull request is not the
owner's and the owner can press "Approve" (GitHub never lets an author approve their own pull
request). Setup, once:

1. In the organization (or account) settings: Developer settings → GitHub Apps → New GitHub App.
   No webhook. Repository permissions: Contents, Pull requests and Issues **read and write**;
   Checks, Commit statuses, Deployments and Actions **read-only**. Installable only on this account.
2. Note the App ID; generate a private key and keep the `.pem` **outside every repository**.
3. Install the app on the repositories it will work on.
4. On the machine that runs the engine: `AI_WORKFLOWS_APP_ID=<id>` and
   `AI_WORKFLOWS_APP_KEY_FILE=<absolute path to the .pem>`.

The engine signs a short JWT, mints an installation token for each call as needed and checks that
the key belongs to `agent-account`; the token travels only in the environment of one call. The
approval only means something if the owner's own GitHub session is **not** available on the
machine where the agents run — `doctor` warns when it is. Without `agent-account` the engine
acts as the account `gh` is logged in to, and `approval-comment` is the way to approve.

**Messages to the owner.** With `messages:` in the recipe (`summary: { file, section }`,
`max-length`, extra `banned-words`), the engine comments on the piece's issue when a piece starts,
waits for the owner's approval or decision, stops, or is merged: the three summary lines first,
never a banned word, never over the length, and never a raw technical reason. Each message is sent
once, and only if it is still true when it would go out.

If a pull request of the agents in the piece's branch lost its mark, the engine stops rather than
open a second one: continue the piece in a new branch that still names it (`feat/13-algo-2`).

## The hooks: help while the agent writes

The recipe declares which folders may be written without an active piece:

```yaml
hooks:
  papers: ["docs"]     # needs pieces:, like the judge
```

```sh
ai-workflows hooks install           # shows what it would write
ai-workflows hooks install --apply   # writes it
```

`--apply` adds a `PreToolUse` hook to `.claude/settings.json` (keeping everything else in the
file) and git hooks in `.ai-workflows/githooks/`, and points the repository's local
`core.hooksPath` there; it refuses a `core.hooksPath` of another tool, an invalid recipe or one
without `pieces:`, and writes no path of the machine. The Claude hook runs in direct form (`node`
with arguments, no shell), through a one-line loader that loads
`node_modules/ai-workflows/dist/bin.js`; if the engine is missing, broken or answers anything but
an answer, the loader exits 2 and Claude Code blocks the tool. `doctor` says whether the hooks are
installed.

What they decide ([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §1): every file is judged with the
working copy that holds it (its branch and its recipe), not the folder the session started in. A
branch that names a piece may write anything; an excluded branch is free to write and never merges;
any other branch, or a detached head, only the paper folders; the repository's own git folder
counts as the project. With a recipe that cannot be read only `.ai-workflows/` may change, and
nothing may publish on GitHub from the shell. Always, in any branch: no command or file may carry
an order only the owner writes (the `approval-comment` commands of the recipe and
`/approve-judge-change`), and no command may approve a pull request. A git that does not answer, a
request whose paths cannot be read, or an internal error is a refusal, never a pass.

**Limits.** The hooks are help, level A: `--no-verify`, the shell, MCP tools, another machine or a
false branch name get past them; the judge is the layer that holds (a pull request whose branch
names no piece, or a piece without its evidence, is refused). If `node` itself is missing, the
hook runs past its 30 seconds, or the process dies by a signal (out of memory), Claude Code lets
the tool through. With a broken recipe the shell rule stops comments, reviews and `gh api` writes;
other `gh` commands that write (`pr create`, `pr merge`, `pr edit`) are not judged there. Claude Code runs project hooks
only in a folder it trusts. Codex and OpenCode are not covered yet: their builders are covered by
the git hooks and the judge.

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

## The negative suite on GitHub

The attempts to get around the process (CN-01…CN-13, the server cases SV-01…SV-09, RC-06, RC-09)
are tried against a real test repository with the agents' app, the real merge queue and the judge
pinned to the commit under test ([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §2). They need
credentials, a person for the "Approve" button and Actions minutes, so the public CI never runs
them:

```sh
pnpm test:github            # the four files under tests/github/, one after another
pnpm test:github:report     # the same, then the report in docs/reports/suite-negativa-<date>.md
pnpm test:github:recover    # reconciles and releases the lock of an abandoned run
```

with `AI_WORKFLOWS_GITHUB_TEST_REPO`, `AI_WORKFLOWS_APP_ID`, `AI_WORKFLOWS_APP_KEY_FILE` and
`AI_WORKFLOWS_AGENT_ACCOUNT`. Every change to the test repository goes through one harness
(`tests/github/sandbox.ts`): one lock per run whose commit carries the snapshot and the journal,
the intention written before each change, a restoration that puts back only what the run itself
wrote last and never someone else's change, and a final check that keeps the lock when anything is
left. The report says «Completo» only when every case of the fixed manifest ran in that run, every
attempt was stopped, every positive control passed and the clean-up was verified; it names what
the owner did by hand and what the suite wrote with the owner's account (PLAN-13 R22).

## What it does not promise

- Nothing stops a repository administrator from changing or disabling the rules.
- A sign-off by comment proves which GitHub account wrote it, not which person.
- Anyone who can push to the repository can rewrite the state refs. The journal is not yet
  rebuilt from GitHub's own events, so a hand-edited state is believed next to the agent; the
  judge never reads it.
- Leases compare clocks: a machine whose clock runs far ahead or behind can take a lease that is
  still alive. A controller that dies keeps its piece until its lease runs out.
- A lease does not fence effects: a gate still running after losing its lease can start one. The
  claim stops it from running twice, but the next holder may have to reconcile it.
- `gh` decides where the state goes: `GH_HOST`, `GH_TOKEN` and the logged-in account all apply.
  A rate limit is reported as a failure; the store does not wait for `Retry-After`.
- Every write adds a commit to its ref, and journals and effect tables are rewritten whole.
- The editor hooks are help, not a guarantee: they do not see MCP tools, and a determined agent
  can still reach the same result by other means. The server check is the mandatory layer. The
  hook settings (`.claude/settings.json`) and the engine version in `package.json` are not files
  of the judge: a pull request can change them without the owner's attestation.
