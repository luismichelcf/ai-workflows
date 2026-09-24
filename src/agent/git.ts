import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { gitEnvironment } from '../git-env.js';
import type { RemoteGit } from './github.js';

// PLAN-13-R4 §4 and §8: the git side the agent binary drives, next to GitHub. Every command runs
// through `execFile` (never a shell, never a console) with a time limit and a wide buffer, and the
// environment has every `GIT_*` variable removed. The credential of the agents never reaches an
// argument, a URL or a log: it travels in the child's environment as an extra header.

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

/** Runs `git <args>` in `root`, returning its raw output and whether it exited zero. */
export function runGit(
  root: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  const options = {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8' as const,
    env: gitEnvironment(extraEnv),
  };
  return new Promise((resolve) => {
    execFile('git', [...args], options, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        ok: error === null,
      });
    });
  });
}

/** `git <args>` trimmed, throwing with git's own reason when it fails. */
export async function gitText(
  root: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(root, args, extraEnv);
  if (!result.ok) {
    const reason = result.stderr.trim() || `git ${args.join(' ')} failed`;
    throw new Error(reason);
  }
  return result.stdout.trim();
}

/** Whether `git <args>` exited zero; a failure to run at all throws rather than answering. */
export async function gitOk(
  root: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (await runGit(root, args, extraEnv)).ok;
}

/** The folder git considers the top of the repository. Throws outside a repository. */
export async function gitTopLevel(root: string): Promise<string> {
  return gitText(root, ['rev-parse', '--show-toplevel']);
}

/**
 * The main working copy of the repository, even from inside a linked worktree: the parent of the
 * common git directory. `finish` removes a worktree with its `cwd` in this copy, so a folder that
 * holds the running process is never the one being retired.
 */
export async function gitMainRoot(root: string): Promise<string> {
  const common = await gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return dirname(common);
}

export async function gitHead(root: string): Promise<string> {
  return gitText(root, ['rev-parse', 'HEAD']);
}

/** The current branch, or `undefined` on a detached head (never guessed). */
export async function gitCurrentBranch(root: string): Promise<string | undefined> {
  const result = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
  return result.ok ? result.stdout.trim() : undefined;
}

/** Whether the working tree has no changes at all. */
export async function gitIsClean(root: string): Promise<boolean> {
  return (await gitText(root, ['status', '--porcelain'])).length === 0;
}

/**
 * The tree id of the whole working state (HEAD + unsaved edits + new non-ignored files), computed
 * with a temporary index so the real one is never touched.
 */
export async function snapshotTree(root: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'aiw-index-'));
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(directory, 'index') };
    await gitText(root, ['read-tree', 'HEAD'], env);
    await gitText(root, ['add', '-A'], env);
    return await gitText(root, ['write-tree'], env);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export interface RemoteGitOptions {
  readonly root: string;
  /** `owner/name`: the push always goes to this repository on GitHub, never to whatever `origin` is. */
  readonly repository: string;
  /** The agents' installation token, minted per push; absent means the account `gh` is using. */
  readonly token?: () => Promise<string>;
}

/**
 * The real `RemoteGit` over `git`: push, delete and read the head of a remote branch. The token
 * arrives through `http.extraheader` in the child's environment — `GIT_CONFIG_count/KEY_0/VALUE_0`
 * — and never on the command line. The target is always `https://github.com/<repository>.git`:
 * the `origin` remote could point at another host, and the authenticated upload must not follow it.
 * The upload runs with `--no-verify`, so no hook of the piece can rewrite what the engine pushes.
 */
export function createRemoteGit(options: RemoteGitOptions): RemoteGit {
  const url = `https://github.com/${options.repository}.git`;

  const authEnv = async (): Promise<NodeJS.ProcessEnv | undefined> => {
    if (options.token === undefined) return undefined;
    const token = await options.token();
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: header,
    };
  };

  return {
    async branchHead(branch: string): Promise<string | undefined> {
      const extra = await authEnv();
      const result = await runGit(options.root, ['ls-remote', '--heads', url, branch], extra);
      if (!result.ok) {
        throw new Error(result.stderr.trim() || `git could not read the head of ${branch}`);
      }
      const line = result.stdout.trim().split('\n')[0];
      if (line === undefined || line.length === 0) return undefined;
      return line.split(/\s+/)[0];
    },

    async push(branch: string, sha: string): Promise<void> {
      const extra = await authEnv();
      const result = await runGit(
        options.root,
        ['push', '--no-verify', url, `${sha}:refs/heads/${branch}`],
        extra,
      );
      if (!result.ok) throw new Error(result.stderr.trim() || 'git push failed');
    },

    async deleteBranch(branch: string, sha: string): Promise<void> {
      const extra = await authEnv();
      const result = await runGit(
        options.root,
        ['push', '--no-verify', url, '--delete', `--force-with-lease=${branch}:${sha}`, branch],
        extra,
      );
      if (!result.ok) throw new Error(result.stderr.trim() || 'git could not delete the branch');
    },
  };
}
