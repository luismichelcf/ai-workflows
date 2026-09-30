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
