import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Real temporary git repositories for the tests of slice 2. Git is local, so the facts of a
// change, the validity of evidence and the retirement of an implementation are tested against
// the real thing, never a simulation.

const created: string[] = [];

/** Removes every repository made since the last call. Call it from `afterEach`. */
export function removeRepositories(): void {
  // Windows may still hold a file of a process that just ended: retry instead of failing.
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** A folder that is not a repository, removed like the others. */
export function emptyFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-empty-'));
  created.push(root);
  return root;
}

/**
 * A repository whose `main` has one commit with the given files (by default an app page and a
 * money file), checked out on branch `piece`.
 */
export function repository(files: Readonly<Record<string, string>> = {
  'app/page.tsx': 'export const page = 1;\n',
  'lib/calc/tax.ts': 'export const tax = 1;\n',
}): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-git-'));
  created.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'switch', '-q', '-c', 'piece');
  return root;
}

/** Commits everything in the working tree and returns the new SHA. */
export function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** Moves `main` forward with one commit that writes `files`, leaving `piece` checked out. */
export function advanceMain(root: string, files: Readonly<Record<string, string>>): string {
  git(root, 'switch', '-q', 'main');
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  const sha = commit(root, 'main moves');
  git(root, 'switch', '-q', 'piece');
  return sha;
}

/** Merges `main` into `piece` without editing anything; fails the test on a conflict. */
export function mergeMain(root: string): string {
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  return git(root, 'rev-parse', 'HEAD');
}
