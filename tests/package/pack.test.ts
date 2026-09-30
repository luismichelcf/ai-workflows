import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readTgz, type TarEntry } from '../tgz.js';

// PLAN-13-R6 §9.4 test 8: the exact contents of the package, built by a real `pnpm pack` of a
// copy of this repository after the seal wrote engine.json (the release workflow does the same).
// Slow (compiles and packs): run with `vitest run --config vitest.package.config.ts`.
//
// INTERFACE this file expects: package.json `files` ships engine.json next to dist, schema,
// templates and action.yml; npm always adds package.json, README.md and LICENSE; nothing else.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEAL = { version: '1.0.0', sha: 'c0ffee0123456789abcdef0123456789abcdef01' };
const SKIP_TOP = new Set(['node_modules', '.git', '.claude', 'dist', '.test-build']);

const EXACT = [
  'package/LICENSE',
  'package/README.md',
  'package/action.yml',
  'package/engine.json',
  'package/package.json',
  'package/schema/recipe.schema.json',
  'package/templates/ai-workflows-red-test.yml',
  'package/templates/ai-workflows-review-signal.yml',
  'package/templates/ai-workflows.yml',
  'package/templates/pipeline.yml',
];

let top: string;
let entries: TarEntry[];

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), 'aiw-pack-'));
  const copy = join(top, 'engine');
  const out = join(top, 'out');
  mkdirSync(out);
  cpSync(REPO, copy, {
    recursive: true,
    filter: (source) => {
      const rel = relative(REPO, source);
      if (rel.length === 0) return true;
      const first = rel.split(/[\\/]/)[0] ?? '';
      return !SKIP_TOP.has(first) && !rel.endsWith('.tgz');
    },
  });
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'), 'junction');
  writeFileSync(join(copy, 'engine.json'), `${JSON.stringify(SEAL)}\n`);
  execFileSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(copy, 'tsconfig.json')], { cwd: copy, stdio: 'pipe' });
  const windows = process.platform === 'win32';
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', windows ? `"${out}"` : out], { cwd: copy, encoding: 'utf8', shell: windows });
  if (packed.status !== 0) throw new Error(`pnpm pack failed: ${packed.stderr}${packed.stdout}`);
  const archives = readdirSync(out).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error(`expected one package, found ${JSON.stringify(archives)}`);
  entries = readTgz(readFileSync(join(out, archives[0] as string)));
});

afterAll(() => {
  if (top !== undefined) rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('R6 §9.4 test 8: what pnpm pack puts in the package', () => {
  it('exactly engine.json, the four templates, the schema, the action, the license and the compiled engine', () => {
    const paths = entries.map((entry) => entry.path).sort();
    const outsideDist = paths.filter((path) => !path.startsWith('package/dist/'));
    expect(outsideDist).toEqual(EXACT);
    for (const needed of ['package/dist/bin.js', 'package/dist/index.js', 'package/dist/index.d.ts']) {
      expect(paths, needed).toContain(needed);
    }
  });

  it('nothing of tests/, no test build and no nested package', () => {
    for (const { path } of entries) {
      expect(path).not.toMatch(/(^|\/)tests\//);
      expect(path).not.toMatch(/\.test\.[jt]s$/);
      expect(path).not.toMatch(/\.test-build\//);
      expect(path).not.toMatch(/\.tgz$/);
    }
  });

  it('engine.json in the package is the seal, and the package says 1.0.0 and MIT', () => {
    const file = (path: string) => entries.find((entry) => entry.path === path)?.content.toString('utf8');
    expect(JSON.parse(file('package/engine.json') ?? 'null')).toEqual(SEAL);
    const pkg = JSON.parse(file('package/package.json') ?? '{}') as Record<string, unknown>;
    expect(pkg['version']).toBe('1.0.0');
    expect(pkg['license']).toBe('MIT');
  });
});
