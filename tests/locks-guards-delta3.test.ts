import { describe, expect, it } from 'vitest';

import { buildHooksConfig, decideToolUse, mergeHooksConfig, type HookGroup, type HookInput, type LockContext } from '../src/index.js';

// Third review of the part 4 fixes (13-sep-2026): rules that were promised and working, but
// that a mutation could remove with every test still green. Each case pins one of them.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };

const write = (file: string, cwd: string = root): HookInput => ({ toolName: 'Write', toolInput: { file_path: file, content: 'x' }, cwd });
const patch = (...lines: string[]): HookInput => ({
  toolName: 'apply_patch',
  toolInput: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
  cwd: root,
});

describe('paths', () => {
  it('a rooted path takes the drive of the cwd before the drive of the project', () => {
    // On D:, `\GitHub\Socialabs\src\a.ts` is D:\GitHub\Socialabs — not this project.
    expect(decideToolUse(write('\\GitHub\\Socialabs\\src\\a.ts', 'D:\\tmp'), noPiece).allow).toBe(true);
  });

  it('a .. inside an absolute Windows path is resolved, not refused', () => {
    expect(decideToolUse(write('C:\\GitHub\\Socialabs\\src\\..\\docs\\a.md'), noPiece).allow).toBe(true);
  });
});

describe('the Update block of a Codex patch', () => {
  it('a Move to keeps the block open, so an indented *** line after it is still context', () => {
    expect(decideToolUse(patch('*** Update File: docs/a.md', '*** Move to: docs/b.md', '@@', '  *** WARNING ***', '-a', '+b'), noPiece).allow).toBe(true);
  });

  it('an Add header closes the block, so an unknown indented *** line after it is refused', () => {
    expect(decideToolUse(patch('*** Update File: docs/a.md', '@@', '-a', '+b', '*** Add File: docs/c.md', '+x', '  *** Frobnicate'), noPiece).allow).toBe(false);
  });
});

describe('installing', () => {
  const command = 'node lock.js';
  const ours = buildHooksConfig('claude', command);
  const handlers = (config: unknown) => (config as { hooks: { PreToolUse: HookGroup[] } }).hooks.PreToolUse.flatMap((group) => group.hooks);

  it('a brand-new file shares nothing with our own entry', () => {
    const fresh = mergeHooksConfig(undefined, ours) as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
    fresh.hooks.PreToolUse[0]?.hooks.push({ type: 'command', command: 'otro' });

    expect(ours.hooks.PreToolUse[0]?.hooks).toHaveLength(1);
  });

  it('keeps only a timeout that is a positive whole number', () => {
    for (const timeout of ['30', 0, -5, 0.001, Number.NaN]) {
      const existing = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command, timeout }] }] } };

      expect(handlers(mergeHooksConfig(existing, ours)), String(timeout)).toEqual([{ type: 'command', command }]);
    }
    const kept = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command, timeout: 30 }] }] } };
    expect(handlers(mergeHooksConfig(kept, ours))).toEqual([{ type: 'command', command, timeout: 30 }]);
  });
});
