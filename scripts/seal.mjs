#!/usr/bin/env node
// PLAN-13-R6 §9.1, §9.3 and §9.4 test 6: the seal of a release.
//
//   node scripts/seal.mjs --main <ref> [--tag <tag>]
//
// Run with the package root as the working directory: it reads ./package.json and writes
// ./engine.json. With --tag (the release) the tag must be `v<package.json version>` and HEAD must
// be the commit of the tag. Without --tag (the dry-run of the reviewed commit) HEAD is sealed.
// Either way the sealed commit must be an ancestor of <ref> and its tree must equal the tree of
// the first commit of <ref>'s first-parent history that contains it (the merge of the PR), so a
// branch that was behind main, or a squash, is refused.
//
// Success: exit 0 and ./engine.json = {"version": "<version>", "sha": "<40 hex of HEAD>"}.
// Refusal: exit code other than 0, no engine.json, and a line on stderr that starts with
// `seal refused: ` and says why.
//
// PLAN-13-R6 §15 P4: <ref> must be a fully qualified branch ref, `refs/heads/…` or
// `refs/remotes/…`. Anything else (`main`, `origin/main`, `refs/tags/main`) is refused with a line
// that names both accepted forms, because git resolves a bare name to a tag first. The release
// workflow passes `refs/remotes/origin/<default branch>`: a tag push leaves no local main.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isAncestor(ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    stdio: 'ignore',
  }).status === 0;
}

function refuse(reason) {
  process.stderr.write(`seal refused: ${reason}\n`);
  process.exit(1);
}

/** `<ref>` must name a branch fully: `refs/heads/…` or `refs/remotes/…`, never a bare name. */
function isFullyQualifiedBranch(ref) {
  return /^refs\/(heads|remotes)\/.+/.test(ref);
}

function parseArgs(argv) {
  let main;
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--main') main = argv[++index];
    else if (arg === '--tag') tag = argv[++index];
    else refuse(`unknown argument ${arg}`);
  }
  if (main === undefined || main.length === 0) refuse('missing --main <ref>');
  if (!isFullyQualifiedBranch(main)) {
    refuse(
      `--main must be a fully qualified branch ref (refs/heads/… or refs/remotes/…), not "${main}"`,
    );
  }
  return { main, tag };
}

const { main, tag } = parseArgs(process.argv.slice(2));
const root = process.cwd();

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
} catch {
  refuse('cannot read package.json');
}
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  refuse('package.json has no version');
}

let head;
try {
  head = git('rev-parse', 'HEAD');
} catch {
  refuse('cannot read HEAD');
}

if (tag !== undefined) {
  const expected = `v${version}`;
  if (tag !== expected) refuse(`tag ${tag} is not ${expected}`);
  let tagCommit;
  try {
    tagCommit = git('rev-parse', `refs/tags/${tag}^{commit}`);
  } catch {
    refuse(`tag ${tag} does not exist`);
  }
  if (tagCommit !== head) {
    refuse(`HEAD ${head} is not the commit of tag ${tag} (${tagCommit})`);
  }
}

let firstParent;
try {
  firstParent = git('rev-list', '--first-parent', main).split('\n').filter(Boolean);
} catch {
  refuse(`cannot read ${main}`);
}
if (firstParent.length === 0) refuse(`${main} has no commits`);

// The first-parent history from the root: the first commit that contains HEAD is the merge that
// brings the reviewed commit into main.
let merge;
for (const commit of [...firstParent].reverse()) {
  if (isAncestor(head, commit)) {
    merge = commit;
    break;
  }
}
if (merge === undefined) refuse(`${head} is not an ancestor of ${main}`);

const headTree = git('rev-parse', `${head}^{tree}`);
const mergeTree = git('rev-parse', `${merge}^{tree}`);
if (headTree !== mergeTree) {
  refuse(`the tree of ${head} differs from the merge ${merge} that brings it into ${main}`);
}

writeFileSync(join(root, 'engine.json'), `${JSON.stringify({ version, sha: head })}\n`);
process.exit(0);
