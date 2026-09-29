import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PLAN-13-R5 §1.6: CN-07 runs the hook exactly as Claude Code would, which means the COMPILED
// engine behind `node_modules/ai-workflows/dist/bin.js`. The source is compiled once per test file
// into `.test-build/<random>/ai-workflows/dist` inside this repository, so the compiled code finds
// its own dependencies (`yaml`) in the repository's node_modules, and a project fixture points its
// `node_modules/ai-workflows` at it through a directory link, as an installed package would be.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface BuiltEngine {
  /** The folder that plays `node_modules/ai-workflows` (holds `dist/bin.js`). */
  readonly packageDir: string;
  /** Links `<project>/node_modules/ai-workflows` to the built package. */
  install(project: string): void;
  remove(): void;
}

export function buildEngine(): BuiltEngine {
  const top = join(REPO, '.test-build', randomBytes(6).toString('hex'));
  const packageDir = join(top, 'ai-workflows');
  const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', join(REPO, 'tsconfig.json'), '--outDir', join(packageDir, 'dist'), '--declaration', 'false', '--sourceMap', 'false'], {
    cwd: REPO,
    stdio: 'pipe',
  });
  return {
    packageDir,
    install(project) {
      mkdirSync(join(project, 'node_modules'), { recursive: true });
      // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
      symlinkSync(packageDir, join(project, 'node_modules', 'ai-workflows'), 'junction');
    },
    remove() {
      rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
