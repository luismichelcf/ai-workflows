# ai-workflows

A deterministic stage engine for coding agents. A pipeline is a list of stages; a stage advances
only when its **gate** — a predicate written in code — says so. The agent cannot skip a stage,
because nothing asks the agent whether it complied.

The engine is project-agnostic. Each repository brings its own recipe,
`.ai-workflows/pipeline.yml`, with its stages, gates, kinds and lanes, plus any blocks of its own.
Nothing about any particular project lives in here.

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

Requires Node 20 or later and git. From the root of the project's repository, one command:

```sh
pnpm dlx https://github.com/luismichelcf/ai-workflows/releases/download/v1.0.0/ai-workflows-1.0.0.tgz init
```

`init` runs straight from the sealed package, without installing it first, and then, in order:

1. **Installs the engine in the project** as a dev dependency pointing at the package of its own
   version, with the package manager its lock file names (`pnpm`, `npm` or `yarn`; `pnpm` when
   there is none). The manager is started by its absolute path, from the `PATH` folders outside
   the project, and without a shell. If the project already depends on another version of
   `ai-workflows`, `init` does not change it, says so and installs no hooks, because they would load
   that other engine. If the install fails, `init` stops with the reason.
2. **Writes what is missing, never overwriting**, and reports each file as created or already
   there: the example recipe (with the schema address of this version) and the judge's three
   workflows (judge, red test, review signal), each with its engine action pinned as
   `luismichelcf/ai-workflows@<sealed sha> # v1.0.0` and, in the judge, the `branches` input taken
   from the recipe. The three workflows are all or nothing: if one exists, none is written and the
   existing one is named; if writing one fails, none is left behind.
3. **Installs the hooks** of the three clients, as `hooks install --apply` does (below), only when
   step 1 left `node_modules/ai-workflows` carrying this same seal.

It ends with what it cannot do for you, in the recipe's language: adjust the install and test
steps of the red-test workflow to your project, add your required-check workflows to the judge's
`workflow_run` list, and the exact `gh variable set AI_WORKFLOWS_MODE` commands for `advisory` or
`off`. Turning the judge `on` and requiring its status is always a separate step of the owner.
Commit the files in a piece branch, not on the main branch. `init` refuses to run from a subfolder
of a repository.

- `init --judge-only` writes only the three workflows, taking `branches` from the recipe that
  already exists. It touches neither `package.json`, nor the lock file, nor the hooks: it is how a
  project that keeps an older engine as its dependency installs the v1 judge. The judge on GitHub
  never uses the project's dependency; it uses the action pinned by SHA.
- `init --package <path or address>` installs from that package instead of the release address,
  after checking that its seal is the same as the running `init`'s (otherwise it touches nothing).
  It serves to install without network and to rehearse a package before it is published.

**The seal.** A published package carries `engine.json` at its root: `{"version": "1.0.0", "sha":
"<40 hex>"}`, the commit the version was built from. `init` pins the workflows to that SHA. A
development copy has no seal: there `init` writes only the example recipe, never a workflow with a
placeholder or `HEAD`, and says why.

You can also add the engine by hand (`pnpm add <release address>`): nothing runs during your
install. Installing straight from the git repository is not supported: the package has to be
compiled first, and pnpm 10 refuses build scripts from git dependencies. The engine is not on npm
(the name is taken there); every version is a GitHub Release asset.

## Status

Version 1.0.0 closes [PLAN-13](docs/plans/PLAN-13.md) slices 1 to 6: the recipe, the blocks, the
judge on GitHub, the final stages, the negative suite against real GitHub and, in slice 6
([PLAN-13-R6](docs/plans/PLAN-13-R6.md)), working branches and promotions, the engine's own files,
hooks for Codex and OpenCode, `init` and the sealed release. A piece's progress can live in memory
(`createMemoryStore`) or on GitHub (`createGitStore` over `createGitHubStatePort`), so a run
survives its session and another terminal sees it.

The recipe is short enough for the owner to read without programming:

```sh
ai-workflows init       # see Install
ai-workflows validate   # rejects with file:line:column and the reason
ai-workflows explain    # the whole recipe in plain words, in the recipe's language
```

The recipe is strict YAML 1.2: duplicate keys, anchors, aliases, tags and unknown keys are
rejected, and `NO` stays text. Its JSON Schema (`schema/recipe.schema.json`, also published with
each release) is the same object `validate` enforces, so the editor and the engine agree. A
stage's `applies-if` is a structured condition (`touches-any`, `touches-none`, `kind-any`,
`kind-none`, `lane-any`), never an expression; a stage that does not apply is recorded as skipped
with its reason, and `status <piece>` lists it that way. The server check, the judge, is
described below.

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

The final stages ([PLAN-13-R4](docs/plans/PLAN-13-R4.md)):

| Block | Checks | Nature |
|---|---|---|
| `independent-review` | The flock's verdicts published on the piece's issue: one fresh approving verdict per angle, each from another session (and, by default, another model family) than every builder | execution record + attest |
| `approval-review` | The owner's last decisive review of the pull request (GitHub's "Approve" button) names a version the stage accepts | attest |
| `approval-comment` | The same with a comment `/<command> <code>`, for projects whose agents publish with the owner's own account | attest + recompute |
| `preview-deployment` | The newest deployment of this exact commit in an environment is successful, with an `https` address matching a pattern | recompute |
| `browser-qa` | The project's browser suite, run against that preview with a fresh environment, writes one passing report per criterion of the plan | recompute |
| `github-merge` | Pushes the judged commit, opens the pull request once (into the first branch of `branches.into`, the main branch without that section), arms auto-merge on that exact head (or joins the merge queue) and watches it to the end | recompute |
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
stage before merging, on the pull request and in the merge queue. Design:
[PLAN-13-R3](docs/plans/PLAN-13-R3.md), extended in [PLAN-13-R6](docs/plans/PLAN-13-R6.md).

**Install.** `init` writes its three workflows (see Install). By hand: copy
`templates/ai-workflows.yml`, `templates/ai-workflows-red-test.yml` and
`templates/ai-workflows-review-signal.yml` into `.github/workflows/`, replace `<ENGINE_SHA>` with
the full commit SHA of the engine version you use (never a tag: the judge refuses to run
unpinned) and, with working branches, add the `branches` input (below). Either way, adjust the
install steps of the red-test workflow to your project and add to `workflow_run.workflows` of the
judge the workflows that produce the checks your recipe requires. Then set the repository
variable to `advisory`, and, when the owner decides, to `on` and require the `ai-workflows` status
in the branch ruleset of every branch that receives pieces.

**Where a stage is checked.** Every pre-merge stage says it with `server:`, within what its block
allows, and `validate` enforces it:

| `server:` | What the judge does |
|---|---|
| `recompute` | Runs the block's server check again on the pull request's files, read from git objects (spec structure, benchmark sources without reachability, scope) |
| `require-check: <name>` | Requires that check green on the judged SHA (the pull request head, or the merge group SHA in the queue). For the engine's red test, `ai-workflows/red-test`, only a check run tied to the official workflow counts (below); for any other name, the newest check run or commit status with that name, from any app |
| `attestation` | Looks for the authenticated event: the owner's review or comment on the pull request (`approval-review`, `approval-comment`), or the verdicts published on the piece's issue (`independent-review`, `sandboxed-review`) |
| `local-only` | Only for post-merge stages or `required: false`: checked next to the agent only |

**Pieces.** `pieces:` tells the judge which branch is which piece (`branch: ["*/{piece}-*"]`,
`{piece}` being a number), which branches never merge (`exclude-branches`), and which line of the
piece's plan declares its kind (`declared-kind`). A branch without a piece is rejected. The
declared kind is the piece's word; paths still raise it.

**Provenance.** The judge runs with `pull_request_target` and `merge_group` (plus
`issue_comment`, `workflow_run` and `workflow_dispatch` to judge again), checks out only trusted
branches, and reads the pull request as git objects: it never checks out or runs its code, and it
never reads the state refs, the store or the providers. It refuses to judge when its workflow
does not come from the main branch (or, in the queue, from the queue branch).

### Working branches and promotions

A project whose daily work enters a branch other than the main one (say `staging`) declares it in
the recipe:

```yaml
branches:
  into: [staging, main]            # receive pieces; the engine opens its PR into the first
  promotions:                      # moves from one branch to another: they are not pieces
    - { from: staging, to: main }
```

`into` is a non-empty list of plain branch names without repeats (no wildcards, no `refs/`);
without the section, only the main branch receives pieces. Both ends of a promotion must be in
`into`, and `from` cannot be `to`. `validate` rejects anything else with file:line:column, and
`explain` says it in plain words.

How the judge uses it:

- **The judge's YAML and the list come from the main branch.** `pull_request_target` always runs
  the main branch's workflow, and the `branches` list is read from the main branch's recipe, never
  from the target's: a branch cannot declare itself judged. The decide step needs the list before
  the engine is built, so `init` writes it into the judge workflow as the `branches` input; the
  judge compares that input with the main branch's recipe and publishes an error («the judge
  workflow and the recipe do not declare the same branches») when they differ. Changing
  `branches.into` therefore means editing both files, which are the judge's own: that pull request
  needs the owner's attestation. A pull request into a branch outside the input gets no status.
- **The trusted base is the tip of the target branch.** A pull request into `staging` is judged
  with the recipe on the tip of `staging` and against its merge base with it: what will hold after
  merging. If that recipe is missing or invalid the verdict is technical, with the reason; the judge
  never falls back to the main branch's. Right before publishing, the judge reads the tip of each
  target branch again: if it moved, every pull request into that branch is judged again once with
  the new tip; if it moves again, the run publishes an error with the reason.
- **A promotion is not a piece.** A pull request whose head is the `from` of a declared pair, whose
  base is its `to`, and which comes from the same repository is judged only by the engine's own
  files (below): untouched, or attested by the owner for this head, it passes; touched without
  the attestation, it fails. From a fork, or without a declared pair, it is judged as a piece (and
  fails when its branch names none).
- **One verdict per SHA, the worst.** A status lives on a commit, not on a pull request. When
  several open pull requests share a head (one into `staging` and one into `main`, or a promotion
  and a piece), every run judges all of them, each with its own trusted base, and publishes the
  worst verdict (`failure` > `error` > `pending` > `success`) with the description of the worst.
  The judge listens to `closed`: when a pull request stops counting (closed, or retargeted outside
  `into`), the others with that head are judged again; when none is left, nothing is published,
  not even «juzgando».
- **The red test** of a pull request into a working branch runs against that branch's tip, with
  that branch's recipe.
- **The merge queue is judged only on the main branch.** A `merge_group` of another branch runs
  the YAML of the group's commit, whose provenance cannot be pinned the same way: it gets no status.
- **Protections.** `verifyProtections` (exported by the package) checks every branch of `into`.
  The judge has to be required on both ends of a promotion: no command checks the protection of
  `from`.
- **Next to the agent** (PLAN-13 R34), `run`, `sync` and the facts of each piece measure it
  against `into[0]`, the branch its pull request will enter.

### The judge's own files

A pull request that touches one of the judge's own files is rejected unless the recipe's `owner`
comments `/approve-judge-change <code>` with at least the first 16 characters of that exact head
(PLAN-13 R20). The owner copies the text the judge shows. What counts:

- **By path:** `.ai-workflows/**`, the judge's workflow, the paths of the input `also-protect`,
  and a fixed list that lives in the engine and is shared with `hooks install`, so the two never
  drift apart: `.claude/settings.json` and `.claude/settings.local.json`; `.codex/hooks.json` and
  `.codex/config.toml`; `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`,
  `.opencode/opencode.jsonc` and the folders `.opencode/plugins/`, `plugin/`, `tool/` and
  `tools/`; `.pnpmfile.cjs`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.yarn/releases/` and
  `.yarn/plugins/`; the red-test and review-signal workflows. Also `binding.gyp` at any depth and the
  build allow-list file that `.npmrc` names (read the way the `ini` reader reads it). Paths compare
  without case: on Windows a pull request that adds `.Claude/settings.json` overwrites the real one.
- **Package manifests by an allowlist of harmless changes.** In `package.json`, `package.yaml` and
  `package.json5` at any depth, and in `pnpm-workspace.yaml`, every change counts as touched
  **except**: dependency entries that do not name the engine and whose value is a registry range
  or version, a plain tag, or starts with `workspace:` or `catalog:`; `name` (other than the
  engine's), `version`, `description`, `keywords`, `author`, `contributors`, `license`,
  `repository`, `homepage`, `bugs`, `private`; scripts that do not run on install; and, in
  `pnpm-workspace.yaml`, catalog entries that are not the engine. A dependency taken from a file,
  link, git, a tarball, an address or an alias is touched, and so are the install-time scripts
  (`preinstall`, `install`, `postinstall`, `prepare` and the rest npm and pnpm run around an
  install), overrides, `packageManager`, workspaces and every other field (PLAN-13 R32). A member
  manifest that is added or deleted is compared against an empty one with the same rule.
- **Advanced YAML counts as touched.** A `package.yaml`, `pnpm-workspace.yaml` or `pnpm-lock.yaml`
  that uses any advanced feature of the format (directives, anchors or aliases, tags, keys that are
  not plain text, merge keys, more than one document, or that does not parse) counts as touched
  without being interpreted, because the judge and the installer could read it differently. A
  `__proto__` key anywhere counts as touched too.
- **The engine version.** In the lock files (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`)
  only the entries that decide what lands in `node_modules/ai-workflows` are compared — the key
  `ai-workflows`, whatever its value, in each importer, package, snapshot, override and patch rule
  — as sorted projections, so reformatting or reordering does not count. The engine's name compares
  without case. An alias under another key installs elsewhere and does not count.
- **Measured on what really enters.** Changes are taken against every merge base and against the
  merge tree on the trusted tip, so a later engine upgrade on the base does not mark an old pull
  request, and a conflict counts as touched. An unreadable file, one that is added or deleted, or a
  lock file over 50 MB counts as touched (a rejection that the attestation lifts, not a technical
  error); a failing git read is technical. No limit ever turns into a pass.

The published status keeps its short note with the attestation order; the list of what was touched
goes to the run's log.

### The red test

The `ai-workflows/red-test` check runs in its own workflow, with `pull_request` and
`merge_group`, read-only permissions and no secrets: each piece's new or changed tests must fail by
their assertion against its base (in the queue, the base of its own entry) and pass against the
head, with the dependencies installed from the head. It runs the pull request's code, so it
deserves the trust of any test suite check, not more.

A pull request could add a workflow of its own with a job named `ai-workflows/red-test` that just
turns green. So the judge counts a check run with that name only when it can tie that exact check
run to the official workflow ([PLAN-13-R6](docs/plans/PLAN-13-R6.md) §7): the check run belongs to
the GitHub Actions app; its check suite has exactly one Actions run, on the judged SHA; one of that
run's jobs points at that check run; the run's workflow path, read from the workflow itself and
never trimmed, is exactly the red-test workflow and that file exists on the trusted base; and the
run is for this pull request and its current base (`base.ref` the branch being judged, `base.sha`
its tip or an ancestor of it) or, in the queue, for the group's SHA. The newest check run that
passes the chain counts; the others are ignored and logged. A chain that cannot be read means
"not yet" (pending), never green. A commit status with that name no longer counts. A pull request
from a fork carries no pull request list in its run, so its red test waits with the reason.

### What wakes it again

Besides the pull request's own events, these judge a pull request again without anyone asking
([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §2.6, PLAN-13-R6 §6 and §8):

- *The owner's "Approve".* A `pull_request_review` would run the pull request's own YAML, so it is
  not a judge trigger. The review signal workflow listens to it instead, with no permissions and no
  steps that read the pull request, and the judge follows it through `workflow_run` (whose YAML is
  always the main branch's). The judge checks the signal's repository, path and event, takes the
  pull request number from it only as a hint, reads the pull request again and judges its live head
  with the recipe of its target branch. A pull request can rewrite the signal and that version
  runs, but it gains nothing a pull request of the same repository does not already have: at worst
  the judge is not woken (the pull request keeps waiting) or a status is imitated (the accepted
  limit R13, reported as a trace). The signal is one of the judge's own files. From a fork GitHub
  gives no pull request number: the next event or `workflow_dispatch` judges it.
- *A builder or verdict event on the piece's issue.* A new comment carrying the event mark, or any
  edit or deletion of a comment on an issue, makes the judge read the recipe of the main branch and
  judge every open pull request into a branch of `into` whose branch names that piece, together
  with every other open pull request that shares its head (one verdict per SHA, the worst). Before
  judging, it publishes `pending` «juzgando» on each of those heads (unless a newer official run
  already published there), so a run that dies afterwards leaves «juzgando», never the old green.
  Each pull request is judged on its own: an error in one publishes `error` there and the run goes
  on. Editing any issue comment therefore costs a short run; one that finds no piece ends without
  publishing.
- *Comments on a pull request* wake the judge only when they carry a command (`/…`) or were edited
  or deleted, and never when their author is an account of type `Bot`: the links Vercel, Supabase
  or the agents' app leave would otherwise each start a run. The owner's orders come from a `User`.

**The merge queue.** In a merge group the judge publishes only its verdict, never «juzgando», and
its runs for one group wait in line instead of cancelling each other: GitHub runs at most one per
group at a time and keeps at most one waiting, replaced by the newest, which never started and so
publishes nothing. The run that does start re-reads everything.

**The switch.** The repository variable `AI_WORKFLOWS_MODE`: `off` (or unset) publishes green
"motor apagado" without installing anything; `advisory` publishes green and the real verdict in
`ai-workflows/advisory`; `on` publishes the real verdict. Any other value is an error. Each pull
request is judged on its own, so one that fails technically does not block the others.

**Statuses.** passed → success, rejected → failure, waiting (for a check or the owner) → pending,
technical → error, with the stage that decided in the description and the detail in the run
summary. Outside the queue a run first replaces any earlier green with pending; before publishing
it re-reads the pull request's head and its target branch, and stays quiet if a newer run already
published.

### When something fails

- A required read that fails, a recipe that does not validate on the trusted base, or a branch tip
  that keeps moving publishes `error` with the reason, never a pass. A run cancelled by hand
  publishes nothing more: on a pull request its «juzgando» stays; in a merge queue group an earlier
  verdict of the same group SHA may stay (see Limits).
- If the judge cannot read the recipe after three attempts when a verdict on an issue is edited or
  deleted, it publishes `pending` «no pude leer la receta» on the head of **every** open pull request
  into the branches of its `branches` input: wider than the piece, but on the safe side (wait,
  never merge). Each of them leaves that state with its next event (a push, a comment, a check that
  ends) or, by hand, with `gh workflow run ai-workflows.yml -f pr=<number>`.
- If GitHub's status API or Actions are down, nothing can be published, not even the green of
  `off`.

### Limits

- Any workflow in the repository can publish a status or a check with the judge's name (accepted,
  PLAN-13 R13): the judge reports such statuses and check runs on the pull request, but one that
  copies the link of a real judge run is not detected. The same holds for a project's own required
  checks: a pull request can add a workflow with a job of the same name.
- The judge job installs its own dependencies on every run, pinned by their integrity in the
  lock file, from the action pinned by SHA, with their install scripts off and no key during the
  build (PLAN-13 R33). The remaining risk, a compromised build tool on the registry, is accepted
  for v1; a later version ships the judge already compiled.
- A required check produced by an app outside Actions does not trigger the judge again; the next
  event or `workflow_dispatch` does. Any `User` comment with a `/` wakes the judge (it fails
  closed; it costs minutes).
- If GitHub will not list the open pull requests after a verdict is deleted (three attempts), the
  old green may stay on the head.
- A change that entered a working branch while the judge was `off` or `advisory` reaches the
  promotion without a judgement per piece.
- Without a merge queue, the red test counts against the base the pull request was last updated
  from, even if the target branch moved since (as it always did on the main branch). With two open
  pull requests of the same head into different branches, the red-test chain cannot tell which one
  started the run.
- In a merge queue group, a run cancelled by hand while judging leaves in place an earlier verdict
  of the same group SHA (measured on GitHub, 1-oct-2026).
- An approval whose commit GitHub no longer delivers after a force push has to be given again.

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
them. Progress lives in `refs/ai-workflows/*` of `origin` with a 15-minute lease. With working
branches, each piece is measured against `into[0]`.

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
ai-workflows hooks install                                 # shows what it would write
ai-workflows hooks install --apply                         # writes it, for the three clients
ai-workflows hooks install --client claude|codex|opencode --apply   # only one client
```

`--apply` writes, keeping everything else in each file, and then names every path it wrote:

- **Claude Code:** a `PreToolUse` hook in `.claude/settings.json`, for the write and shell tools,
  run in direct form (`node` with arguments, no shell) through a one-line loader that loads
  `node_modules/ai-workflows/dist/bin.js`; if the engine is missing, broken or answers anything but
  an answer, the loader exits 2 and Claude Code blocks the tool.
- **Codex:** a `PreToolUse` handler in `.codex/hooks.json` for every tool (pattern `.*`), with a
  30-second timeout and its order in two forms (`command` and `commandWindows`). Reinstalling
  replaces an old handler of the engine and never touches the others.
- **OpenCode:** a whole plugin, `.opencode/plugins/ai-workflows.js`, recognized by a fixed header
  and never merged.
- **A loader on file,** `.ai-workflows/hook.cjs`, shared by Codex and OpenCode and found from the
  repository root (`git rev-parse --show-toplevel`), since neither client says where the project
  is.
- **Git hooks** in `.ai-workflows/githooks/`, with the repository's local `core.hooksPath` pointing
  there.

It refuses a `core.hooksPath` of another tool, an invalid recipe or one without `pieces:`, and
writes no path of the machine. Every file it writes is on the judge's list of own files. In
interactive Codex the owner approves the hook once in `/hooks`. `doctor` checks the three clients:
a missing or altered handler, a Codex timeout of 25 seconds or less, and `disableAllHooks` in
`.claude/settings.local.json`.

What they decide ([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §1), the same logic for the three clients
behind one translator each: every file is judged with the working copy that holds it (its branch
and its recipe), not the folder the session started in. A branch that names a piece may write
anything; an excluded branch is free to write and never merges; any other branch, or a detached
head, only the paper folders; the repository's own git folder counts as the project. With a recipe
that cannot be read only `.ai-workflows/` may change, and nothing may publish on GitHub from the
shell. Always, in any branch: no command or file may carry an order only the owner writes (the
`approval-comment` commands of the recipe and `/approve-judge-change`), and no command may approve
a pull request. In Codex and OpenCode, an unknown tool whose input carries something shaped like a
path is refused (known read-only tools pass). A git that does not answer, a request whose paths
cannot be read, or an internal error is a refusal, never a pass. Each client gets its refusal in
the form it honours: Claude Code an exit 2, Codex the JSON deny on standard output with exit 0,
OpenCode an error thrown by the plugin.

**On time.** A client that cuts a hook lets the tool through, so the editor hook answers before
its deadline even when git hangs: git calls share a budget of 20 seconds (10 at most each), run
with prompts and optional locks off, and are killed with their process tree when the time is up;
the decision runs in a child process under a watchdog, armed before the input is read, that writes
the refusal and exits at 25 seconds. Claude Code and Codex cut the hook at 30. The Codex order has
its own clock too (about 3 seconds for git and the rest up to about 27 for the loader, then a
refusal), and the OpenCode plugin throws when its process hangs, fails or cannot start. Git hooks
have 60 seconds.

**Limits, measured on Windows on 29-sep-2026.** The hooks are help, level A: `--no-verify`, the
shell, MCP tools, another machine or a false branch name get past them; the judge is the layer that
holds (a pull request whose branch names no piece, or a piece without its evidence, is refused).

- **Codex 0.159.0** ignores a deny given with exit 2 (the write went through, openai/codex#27833)
  and honours the JSON deny with exit 0 ("Command blocked by PreToolUse hook"); the engine always
  answers that way. `codex exec` skips hooks that were never approved, silently, unless it runs
  with `--dangerously-bypass-hook-trust`. Codex itself calls hooks a useful guardrail, not a
  complete boundary: a hook that fails or hangs lets the tool through, and nested calls of Code
  Mode run without hooks. Without `node` on the `PATH` the order cannot run, so it cannot deny.
- **OpenCode 1.18.30** blocks a tool when the plugin throws, and a subagent's (`task`) calls go
  through the plugin and are blocked too. If OpenCode does not load the plugin, nothing stops.
- **Writes through the shell** are not checked against the folder rule in any client (Codex often
  writes with the shell rather than its edit tool): the hook does not interpret the shell. Only the
  rule about the owner's orders and approvals reads it.
- If `node` itself is missing, the hook runs past its client's timeout, or the process dies by a
  signal (out of memory), the client lets the tool through. Claude Code runs project hooks only in
  a folder it trusts.

The shell rule does not parse the shell: it refuses, on the whole normalized text, a command that
names `gh`, a review and anything shaped like an approval (and, with a broken recipe, a command
that names `gh` and anything that publishes text on GitHub). It may refuse an innocent chain (run
the commands separately) and it stops a command written directly, in any number of lines, with
quotes, redirections, substitutions or `bash -c`; it does not stop one disguised on purpose (an
expansion that splits a word, globs, PowerShell concatenation, an encoded command piped to a
shell, a script file, a `gh` alias, another program such as `node -e` or `curl`). A shell command
over 64 KB is refused unread.

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

The attempts to get around the process (CN-01…CN-14, the server cases SV-01…SV-09 and SV-04s+,
RC-06, RC-09, and the slice 6 cases RAMA-1, RAMA-2, A-T3, B-T6 and BOT-1) are tried against a real
test repository with the agents' app, the real merge queue and the judge pinned to the commit under
test ([PLAN-13-R5](docs/plans/PLAN-13-R5.md) §2, [PLAN-13-R6](docs/plans/PLAN-13-R6.md) §11). They
need credentials, a person for the "Approve" button and Actions minutes, so the public CI never
runs them:

```sh
pnpm test:github            # the four files under tests/github/, one after another
pnpm test:github:report     # the same, then the report in docs/reports/
pnpm test:github:recover    # reconciles and releases the lock of an abandoned run
```

with `AI_WORKFLOWS_GITHUB_TEST_REPO`, `AI_WORKFLOWS_APP_ID`, `AI_WORKFLOWS_APP_KEY_FILE` and
`AI_WORKFLOWS_AGENT_ACCOUNT`; `AI_WORKFLOWS_SUITE_SLICE=6` runs only the slice 6 cases. Every
change to the test repository goes through one harness (`tests/github/sandbox.ts`): one lock per
run whose commit carries the snapshot and the journal, the intention written before each change, a
restoration that puts back only what the run itself wrote last and never someone else's change,
and a final check that keeps the lock when anything is left. A report says «Completo» only when
every case of its manifest ran, every attempt was stopped, every positive control passed and the
clean-up was verified; it names what the owner did by hand and what the suite wrote with the
owner's account (PLAN-13 R22). The reports are `docs/reports/suite-negativa-2026-09-29.md` (slices
1 to 5) and `docs/reports/evidencia-rebanada-6-2026-10-01.md` (slice 6).

## Releases

Merging is not a release. A version is a GitHub Release of this repository whose assets are the
built package (`ai-workflows-<version>.tgz`, with its `engine.json` seal) and `recipe.schema.json`:

1. The slice's pull request merges with a merge commit (never squash or rebase), with CI green on
   Linux and Windows, the review finished, and the branch up to date with `main`.
2. The release workflow is rehearsed by hand (`workflow_dispatch` with `dry-run` and the reviewed
   commit): it seals and packs without publishing, and `init --package` is tried in an empty
   repository.
3. The tag `v<version of package.json>` is created on the reviewed head commit. The release
   workflow, with every action pinned by SHA and write permission only in the job that publishes,
   runs the gate on Linux and Windows and seals only if the tagged commit is an ancestor of the
   remote `main` and its tree equals the tree of the merge commit that brought it in.
4. Releases of this repository are immutable and a ruleset protects the `v*` tags: a published
   version never changes, and a fix ships as a new version (`v1.0.1`).

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
- The editor hooks are help, not a guarantee: they do not see MCP tools or writes through the
  shell, and a determined agent can still reach the same result by other means. The server check
  is the mandatory layer; the files that install or switch off the hooks, and the engine version,
  are the judge's own files.

## License

[MIT](LICENSE).
