import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN-13-R3 §3.1, §5 and §6 (SV-09): what the project installs. The privileged job never
// checks out or runs the pull request, every action is pinned by a full SHA, no step puts an
// expression inside a shell command, no workflow names a secret, and the red-test job cannot
// publish statuses. Also §3.1: the judge's modules never import the store, the providers or the
// process launcher (SV-08).

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const yamlOf = (path: string) => parse(read(path)) as Record<string, any>;

const ACTION = yamlOf('action.yml');
const JUDGE = yamlOf('templates/ai-workflows.yml');
const RED = yamlOf('templates/ai-workflows-red-test.yml');
const JUDGE_TEXT = read('templates/ai-workflows.yml');
const RED_TEXT = read('templates/ai-workflows-red-test.yml');
const ACTION_TEXT = read('action.yml');

const PINNED = /@[0-9a-f]{40}$/;
const PR_CODE = /pull_request\.head|merge_group\.head|refs\/pull|github\.head_ref|head_sha/;

function steps(job: Record<string, any>): Record<string, any>[] {
  return (job['steps'] ?? []) as Record<string, any>[];
}

describe('action.yml', () => {
  it('is a composite action with the inputs of §6', () => {
    expect(ACTION['runs']?.['using']).toBe('composite');
    expect(Object.keys(ACTION['inputs'] ?? {}).sort()).toEqual(['also-protect', 'context', 'mode', 'task', 'token']);
    expect(ACTION['inputs']?.['context']?.['default']).toBe('ai-workflows');
  });

  it('pins every action it uses by a full SHA', () => {
    const used = steps(ACTION['runs']).map((step) => step['uses']).filter((uses): uses is string => typeof uses === 'string');
    expect(used.length).toBeGreaterThan(0);
    for (const uses of used) expect(uses, uses).toMatch(PINNED);
  });

  it('never puts an expression inside a shell command', () => {
    for (const step of steps(ACTION['runs'])) {
      if (typeof step['run'] === 'string') expect(step['run'], step['name']).not.toContain('${{');
    }
  });

  it('checks out only the trusted commit, without keeping the token', () => {
    const checkouts = steps(ACTION['runs']).filter((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(String(step['with']?.['persist-credentials'])).toBe('false');
      expect(JSON.stringify(step['with'] ?? {})).not.toMatch(PR_CODE);
      // Only for the judge: the red-test task checks nothing out itself.
      expect(String(step['if'] ?? '')).toMatch(/judge/);
    }
  });

  it('passes the action ref to the judge through the environment', () => {
    expect(ACTION_TEXT).toMatch(/AI_WORKFLOWS_ACTION_REF:\s*\$\{\{\s*github\.action_ref\s*\}\}/);
  });

  it('with off, publishes green before installing anything', () => {
    const all = steps(ACTION['runs']);
    const firstInstall = all.findIndex((step) => /pnpm install|setup-node|action-setup/.test(`${step['run'] ?? ''}${step['uses'] ?? ''}`));
    const offStep = all.findIndex((step) => /motor apagado/.test(String(step['run'] ?? '')));
    expect(offStep).toBeGreaterThanOrEqual(0);
    expect(offStep).toBeLessThan(firstInstall);
  });

  it('closes with an error status if the judge fails', () => {
    const last = steps(ACTION['runs']).at(-1);
    expect(String(last?.['if'])).toMatch(/failure\(\)/);
    expect(String(last?.['run'])).toMatch(/state=error|state="error"|error/);
  });
});

describe('templates/ai-workflows.yml (the judge)', () => {
  it('listens to the five events of §3.2 and never to pull_request', () => {
    const on = JUDGE['on'] as Record<string, unknown>;
    expect(Object.keys(on).sort()).toEqual(['issue_comment', 'merge_group', 'pull_request_target', 'workflow_dispatch', 'workflow_run']);
    expect((on['workflow_dispatch'] as any)?.inputs?.pr).toBeDefined();
    expect((on['workflow_run'] as any)?.types).toEqual(['completed']);
    // edited: changing the target branch (or coming back to main) runs the judge again.
    expect([...((on['pull_request_target'] as any)?.types ?? [])].sort()).toEqual(['edited', 'opened', 'reopened', 'synchronize']);
    expect((on['workflow_run'] as any)?.workflows).toContain(RED['name']);
  });

  it('its job has exactly the permissions of §6, and is not named like a status', () => {
    const jobs = Object.values(JUDGE['jobs'] as Record<string, Record<string, any>>);
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as Record<string, any>;
    expect(job['permissions']).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'read',
      checks: 'read',
      actions: 'read',
      statuses: 'write',
    });
    expect(['ai-workflows', 'ai-workflows/advisory']).not.toContain(job['name']);
    expect(Object.keys(JUDGE['jobs'])).not.toContain('ai-workflows');
    expect(job['concurrency']?.['cancel-in-progress']).toBe(true);
  });

  it('uses the action pinned by a placeholder SHA, with the switch variable and the red-test workflow protected', () => {
    const job = Object.values(JUDGE['jobs'] as Record<string, Record<string, any>>)[0] as Record<string, any>;
    const step = steps(job).find((candidate) => String(candidate['uses'] ?? '').startsWith('luismichelcf/ai-workflows@'));
    expect(step?.['uses']).toBe('luismichelcf/ai-workflows@<ENGINE_SHA>');
    expect(step?.['with']?.['task']).toBe('judge');
    expect(String(step?.['with']?.['mode'])).toMatch(/\$\{\{\s*vars\.AI_WORKFLOWS_MODE\s*\}\}/);
    expect(String(step?.['with']?.['also-protect'])).toContain('.github/workflows/ai-workflows-red-test.yml');
  });

  it('checks out nothing of the pull request and names no secret', () => {
    expect(JUDGE_TEXT).not.toMatch(/secrets\./);
    const job = Object.values(JUDGE['jobs'] as Record<string, Record<string, any>>)[0] as Record<string, any>;
    for (const step of steps(job)) {
      if (String(step['uses'] ?? '').startsWith('actions/checkout')) {
        expect(JSON.stringify(step['with'] ?? {})).not.toMatch(PR_CODE);
      }
      if (typeof step['run'] === 'string') expect(step['run']).not.toContain('${{');
    }
  });

  it('on a comment, only runs for a pull request comment with a command, or an edit or deletion', () => {
    const job = Object.values(JUDGE['jobs'] as Record<string, Record<string, any>>)[0] as Record<string, any>;
    const condition = String(job['if']);
    expect(condition).toContain('github.event.issue.pull_request');
    expect(condition).toMatch(/contains\(github\.event\.comment\.body, '\/'\)/);
  });
});

describe('templates/ai-workflows-red-test.yml (SV-09)', () => {
  it('runs on pull_request and merge_group only', () => {
    expect(Object.keys(RED['on'] as Record<string, unknown>).sort()).toEqual(['merge_group', 'pull_request']);
  });

  it('its job is the check ai-workflows/red-test, cannot publish statuses and names no secret', () => {
    const jobs = Object.values(RED['jobs'] as Record<string, Record<string, any>>);
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as Record<string, any>;
    expect(job['name']).toBe('ai-workflows/red-test');
    expect(job['permissions']).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(RED['permissions'] ?? {}).toEqual({});
    expect(RED_TEXT).not.toMatch(/secrets\./);
  });

  it('checks out without keeping the token, with the whole history, and runs the red-test task', () => {
    const job = Object.values(RED['jobs'] as Record<string, Record<string, any>>)[0] as Record<string, any>;
    const checkout = steps(job).find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));
    expect(String(checkout?.['with']?.['persist-credentials'])).toBe('false');
    expect(Number(checkout?.['with']?.['fetch-depth'])).toBe(0);
    expect(String(checkout?.['uses'])).toMatch(PINNED);
    const engine = steps(job).find((step) => String(step['uses'] ?? '').startsWith('luismichelcf/ai-workflows@'));
    expect(engine?.['with']?.['task']).toBe('red-test');
  });
});

describe('SV-08 and §3.1: what the judge may import', () => {
  const FORBIDDEN = ['state', 'store-git', 'store-github', 'providers', 'exec'];

  it('no module of src/judge imports the store, the providers or the process launcher', () => {
    const dir = new URL('../src/judge/', import.meta.url);
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file), 'utf8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const target of imports) {
        const base = target.split('/').at(-1)?.replace(/\.js$/, '');
        expect(FORBIDDEN, `${file} imports ${target}`).not.toContain(base);
      }
    }
  });
});

describe('flock 1: the first step of the action', () => {
  const decide = String(steps(ACTION['runs']).find((step) => step['id'] === 'decide')?.['run'] ?? '');

  it('accepts only a number as the pull request of a dispatch or a comment', () => {
    expect(decide).toMatch(/\^\[0-9\]\+\$/);
  });

  it('reads the live target branch of the PR for a comment or a dispatch before publishing', () => {
    expect((decide.match(/base\.ref/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('for workflow_run, publishes only after finding an open PR on that head into main (or the queue)', () => {
    expect(decide).toMatch(/commits\/\$\{?sha\}?\/pulls/);
  });

  it('publishes error when it fails after knowing the SHA, so an old green never stays', () => {
    expect(decide).toMatch(/trap /);
  });

  it('reads the mode like the judge does: only the spaces around it are ignored', () => {
    expect(decide).not.toContain("tr -d '[:space:]'");
  });
});

describe('flock 1: the command never leaks the token', () => {
  it('a failed fetch is reported without the command line that carries the token', () => {
    const cli = readFileSync(new URL('../src/judge/cli.ts', import.meta.url), 'utf8');
    expect(cli).not.toMatch(/\|\|\s*error\.message/);
  });
});

describe('flock 2: templates and the first step', () => {
  it('the red-test workflow runs again when a PR changes its target branch', () => {
    const on = RED['on'] as Record<string, any>;
    expect([...(on['pull_request']?.types ?? [])].sort()).toEqual(['edited', 'opened', 'reopened', 'synchronize']);
  });

  it('for workflow_run, the step is armed before it reads the PRs of the SHA, so a failed read leaves error', () => {
    const decide = String(steps(ACTION['runs']).find((step) => step['id'] === 'decide')?.['run'] ?? '');
    const armedAt = decide.indexOf("armed='true'");
    const readAt = decide.search(/commits\/\$\{?sha\}?\/pulls/);
    expect(armedAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(armedAt);
    expect(decide).toMatch(/commits\/\$\{?sha\}?\/pulls[^\n]*--paginate/);
  });
});

describe('flock 2: off never blocks', () => {
  it('when the first step fails with the switch off, it does not publish an error', () => {
    const decide = String(steps(ACTION['runs']).find((step) => step['id'] === 'decide')?.['run'] ?? '');
    const start = decide.indexOf('on_exit() {');
    const body = decide.slice(start, decide.indexOf('trap ', start));
    expect(start).toBeGreaterThanOrEqual(0);
    // The trap looks at the mode: with off (or no value) nothing is published, so off can
    // always unjam a merge, even when GitHub answers badly.
    expect(body).toMatch(/\$mode/);
    expect(body).toMatch(/off/);
  });
});

describe('flock 4: the command says its verdict in the run log', () => {
  it('writes the summary to its standard output as well, not only to the step summary', () => {
    const cli = readFileSync(new URL('../src/judge/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/process\.stdout\.write\([^)]*summary/);
  });
});
