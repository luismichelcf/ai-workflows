import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN-13-R6 §9.3 and §9.4 test 7 (and R31): the release workflow and the license, read as files.
//
// INTERFACE this file expects:
//   .github/workflows/release.yml
//     on: push of tags `v*`, and workflow_dispatch with a boolean input `dry-run`;
//     every `uses:` pinned by 40 hex;
//     a job on Windows that runs `pnpm check`, which the publishing job `needs`;
//     the packing job checks out with fetch-depth 0, runs `node scripts/seal.mjs ... --main ...`
//     (the ancestry and tree checks of tests/release-seal.test.ts) before `pnpm pack`, uploads the
//     package as a workflow artifact (what the dry-run leaves to rehearse), and the step with
//     `gh release create` uploads the .tgz and recipe.schema.json and is skipped in a dry-run.
//   LICENSE: the MIT text. package.json: version 1.0.0, license MIT, still private, and
//   `engine.json` among its `files`.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PINNED = /@[0-9a-f]{40}$/;

type Step = Record<string, any>;
type Job = Record<string, any>;

const RELEASE_PATH = '.github/workflows/release.yml';
const release = () => parse(read(RELEASE_PATH)) as Record<string, any>;
const jobsOf = (workflow: Record<string, any>) => Object.entries((workflow['jobs'] ?? {}) as Record<string, Job>);
const stepsOf = (job: Job) => (job['steps'] ?? []) as Step[];
const runOf = (step: Step) => (typeof step['run'] === 'string' ? step['run'] : '');

function runsOnWindows(job: Job): boolean {
  const runsOn = JSON.stringify(job['runs-on'] ?? '');
  if (/windows/i.test(runsOn)) return true;
  const matrix = JSON.stringify(job['strategy']?.['matrix'] ?? {});
  return /matrix\./.test(runsOn) && /windows/i.test(matrix);
}

const needsOf = (job: Job): string[] => {
  const needs = job['needs'];
  if (typeof needs === 'string') return [needs];
  return Array.isArray(needs) ? needs.map(String) : [];
};

describe('R6 §9.4 test 7: the release workflow', () => {
  it('runs on a v* tag and has a dry-run by hand', () => {
    const on = release()['on'] as Record<string, any>;
    expect(on['push']?.['tags']).toContain('v*');
    const dryRun = on['workflow_dispatch']?.['inputs']?.['dry-run'];
    expect(dryRun, 'workflow_dispatch input dry-run').toBeDefined();
    expect(dryRun?.['type']).toBe('boolean');
  });

  it('pins every action by a full SHA', () => {
    const used = jobsOf(release()).flatMap(([, job]) => stepsOf(job).map((step) => step['uses']).filter((uses): uses is string => typeof uses === 'string'));
    expect(used.length).toBeGreaterThan(0);
    for (const uses of used) expect(uses, uses).toMatch(PINNED);
  });

  it('runs the gate on Windows too, and publishing waits for it', () => {
    const jobs = jobsOf(release());
    const windows = jobs.filter(([, job]) => runsOnWindows(job) && stepsOf(job).some((step) => /pnpm check/.test(runOf(step))));
    expect(windows.length, 'a Windows job that runs pnpm check').toBeGreaterThan(0);
    const publishing = jobs.filter(([, job]) => stepsOf(job).some((step) => /gh release create/.test(runOf(step))));
    expect(publishing).toHaveLength(1);
    const [, publisher] = publishing[0] as [string, Job];
    const windowsIds = windows.map(([id]) => id);
    expect(needsOf(publisher).some((id) => windowsIds.includes(id)), `needs ${JSON.stringify(needsOf(publisher))}`).toBe(true);
  });

  it('seals with the ancestry check before packing, from a full history', () => {
    const jobs = jobsOf(release());
    const packing = jobs.filter(([, job]) => stepsOf(job).some((step) => /pnpm pack/.test(runOf(step))));
    expect(packing).toHaveLength(1);
    const [, job] = packing[0] as [string, Job];
    const steps = stepsOf(job);
    const sealAt = steps.findIndex((step) => /node scripts\/seal\.mjs/.test(runOf(step)) && /--main/.test(runOf(step)));
    const packAt = steps.findIndex((step) => /pnpm pack/.test(runOf(step)));
    expect(sealAt, 'a step that runs node scripts/seal.mjs --main').toBeGreaterThanOrEqual(0);
    expect(sealAt).toBeLessThan(packAt);
    const checkout = steps.find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));
    expect(Number(checkout?.['with']?.['fetch-depth'])).toBe(0);
    expect(steps.some((step) => String(step['uses'] ?? '').startsWith('actions/upload-artifact@')), 'the package kept as an artifact').toBe(true);
  });

  it('uploads the package and the recipe schema, and never publishes in a dry-run', () => {
    const steps = jobsOf(release()).flatMap(([, job]) => stepsOf(job));
    const publish = steps.filter((step) => /gh release create/.test(runOf(step)));
    expect(publish).toHaveLength(1);
    const step = publish[0] as Step;
    expect(runOf(step)).toMatch(/\.tgz/);
    expect(runOf(step)).toContain('recipe.schema.json');
    expect(String(step['if'] ?? ''), 'the publish step is conditioned on not being a dry-run').toMatch(/dry-run|event_name/);
  });
});

// PLAN-13-R6 §15 (after the flock), what the release workflow adds:
//   P4: the seal step passes `--main "refs/remotes/origin/$<VAR>"`, where the step's env sets <VAR>
//       from `github.event.repository.default_branch` (a tag push leaves no local main, and a bare
//       name could resolve to a tag). The dry-run (`workflow_dispatch`) takes a string input `sha`,
//       the reviewed commit, and the packing job's checkout uses it as its `ref`.
//   Least privilege: top-level `permissions: { contents: read }`; only the job that runs
//       `gh release create` has `contents: write`; every actions/checkout sets
//       `persist-credentials: false`.
//   The release notes carry the one command `pnpm dlx <…>.tgz init`, and the packing job runs the
//       package-content test (`pnpm test:package`, or vitest with vitest.package.config.ts) before
//       `pnpm pack`.

const packingJob = (): Job => {
  const packing = jobsOf(release()).filter(([, job]) => stepsOf(job).some((step) => /pnpm pack/.test(runOf(step))));
  expect(packing).toHaveLength(1);
  return (packing[0] as [string, Job])[1];
};

describe('R6 §15 P4: the release seals against the remote main and the dry-run takes the reviewed SHA', () => {
  it('every --main of the seal step is refs/remotes/origin/ plus the default branch', () => {
    const steps = stepsOf(packingJob()).filter((step) => /node scripts\/seal\.mjs/.test(runOf(step)));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const mains = [...runOf(step).matchAll(/--main[ \t]+(\S+)/g)].map((match) => match[1] ?? '');
      expect(mains.length, runOf(step)).toBeGreaterThan(0);
      for (const main of mains) {
        const variable = /^"?refs\/remotes\/origin\/\$\{?(\w+)\}?"?$/.exec(main);
        expect(variable, main).not.toBeNull();
        const name = variable?.[1] ?? '';
        expect(String(step['env']?.[name] ?? ''), `env ${name}`).toMatch(/\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
      }
    }
  });

  it('the dry-run accepts the reviewed SHA and the packing job checks it out', () => {
    const sha = (release()['on'] as Record<string, any>)['workflow_dispatch']?.['inputs']?.['sha'];
    expect(sha, 'workflow_dispatch input sha').toBeDefined();
    expect(sha?.['type']).toBe('string');
    const checkout = stepsOf(packingJob()).find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));
    expect(String(checkout?.['with']?.['ref'] ?? ''), 'the checkout ref').toMatch(/inputs\.sha/);
  });
});

describe('R6 §15: the release workflow runs with the least privilege', () => {
  it('the top level only reads contents', () => {
    expect(release()['permissions']).toEqual({ contents: 'read' });
  });

  it('only the job that runs gh release create may write contents', () => {
    for (const [id, job] of jobsOf(release())) {
      const publishes = stepsOf(job).some((step) => /gh release create/.test(runOf(step)));
      const permissions = job['permissions'];
      const writes = permissions === 'write-all' || (typeof permissions === 'object' && permissions !== null && permissions['contents'] === 'write');
      expect(writes, id).toBe(publishes);
    }
  });

  it('no checkout keeps the token in the clone', () => {
    const checkouts = jobsOf(release()).flatMap(([, job]) => stepsOf(job).filter((step) => String(step['uses'] ?? '').startsWith('actions/checkout@')));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout['with']?.['persist-credentials']).toBe(false);
  });
});

describe('R6 §15: the release notes and the package-content test', () => {
  it('the notes give the one command pnpm dlx <package>.tgz init, not pnpm add', () => {
    const publish = jobsOf(release()).flatMap(([, job]) => stepsOf(job)).find((step) => /gh release create/.test(runOf(step)));
    const run = runOf(publish ?? {});
    expect(run).toMatch(/pnpm dlx [^\s`'"]+\.tgz init/);
    expect(run).not.toMatch(/pnpm add/);
  });

  it('the packing job runs the package-content test before pnpm pack', () => {
    const steps = stepsOf(packingJob());
    const testAt = steps.findIndex((step) => /pnpm (run )?test:package|vitest run --config vitest\.package\.config\.ts/.test(runOf(step)));
    const packAt = steps.findIndex((step) => /pnpm pack/.test(runOf(step)));
    expect(testAt, 'a step that runs pnpm test:package').toBeGreaterThanOrEqual(0);
    expect(testAt).toBeLessThan(packAt);
  });
});

describe('R31: license and version', () => {
  it('LICENSE holds the MIT text', () => {
    expect(existsSync(new URL('../LICENSE', import.meta.url))).toBe(true);
    const text = read('LICENSE');
    expect(text.split('\n')[0]?.trim()).toBe('MIT License');
    expect(text).toMatch(/Copyright \(c\) \d{4} \S/);
    expect(text).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
    expect(text).toContain('The above copyright notice and this permission notice shall be included in all');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it('package.json is 1.0.0, MIT, still private for npm, and ships engine.json', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, any>;
    expect(pkg['version']).toBe('1.0.0');
    expect(pkg['license']).toBe('MIT');
    expect(pkg['private']).toBe(true);
    expect(pkg['files']).toContain('engine.json');
  });
});

// Delta review of the flock fixes, finding M2: the gate that publishing waits for must test the
// same commit that is sealed and packed. On a dry-run the packing job checks out the `sha` input;
// every job it `needs` that runs `pnpm check` checks out that same ref (the same expression), not
// the dispatch branch.
describe('M2: the gate checks out the same ref as the packing job', () => {
  it('every gate job the packing job needs checks out the ref of the packing checkout', () => {
    const packing = packingJob();
    const packRef = stepsOf(packing).find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'))?.['with']?.['ref'];
    expect(String(packRef ?? ''), 'the packing checkout ref').toMatch(/inputs\.sha/);
    const jobs = new Map(jobsOf(release()));
    const gates = needsOf(packing)
      .map((id) => [id, jobs.get(id)] as const)
      .filter(([, job]) => job !== undefined && stepsOf(job).some((step) => /pnpm check/.test(runOf(step))));
    expect(gates.length, 'a gate job that runs pnpm check').toBeGreaterThan(0);
    for (const [id, job] of gates) {
      const checkout = stepsOf(job as Job).find((step) => String(step['uses'] ?? '').startsWith('actions/checkout@'));
      expect(checkout, `${id}: a checkout`).toBeDefined();
      expect(checkout?.['with']?.['ref'], `${id}: the checkout ref`).toBe(packRef);
    }
  });
});