import { describe, expect, it } from 'vitest';

import {
  buildHooksConfig,
  decidePreCommit,
  decidePrePush,
  mergeHooksConfig,
  renderGitHook,
  type LockContext,
} from '../src/index.js';

// Git hooks and installing the editor hooks. Git hooks are help too — `--no-verify` skips
// them — but they see the one thing the editor hook cannot: what is actually staged,
// including files a shell command wrote.

const noPiece: LockContext = { paperPaths: ['docs'] };
const withPiece: LockContext = { activePiece: '997', paperPaths: ['docs'] };

describe('pre-commit', () => {
  it('refuses to commit code with no piece in the folder', () => {
    expect(decidePreCommit({ stagedPaths: ['src/a.ts'], context: noPiece }).allow).toBe(false);
  });

  it('names what it would have committed', () => {
    const decision = decidePreCommit({ stagedPaths: ['docs/a.md', 'src/a.ts'], context: noPiece });

    expect(decision.allow === false && decision.reason).toContain('src/a.ts');
  });

  it('allows committing only papers with no piece', () => {
    expect(decidePreCommit({ stagedPaths: ['docs/a.md', 'docs/adr/0204-x.md'], context: noPiece }).allow).toBe(true);
  });

  it('allows committing code when the folder has its piece', () => {
    expect(decidePreCommit({ stagedPaths: ['src/a.ts'], context: withPiece }).allow).toBe(true);
  });

  it('allows an empty commit to pass through', () => {
    expect(decidePreCommit({ stagedPaths: [], context: noPiece }).allow).toBe(true);
  });

  it('does not treat docs/../src as papers', () => {
    expect(decidePreCommit({ stagedPaths: ['docs/../src/a.ts'], context: noPiece }).allow).toBe(false);
  });
});

describe('pre-push', () => {
  it('refuses a push straight to the default branch', () => {
    const decision = decidePrePush({ remoteRefs: ['refs/heads/main'], defaultBranch: 'main' });

    expect(decision.allow).toBe(false);
  });

  it('allows pushing a feature branch', () => {
    expect(decidePrePush({ remoteRefs: ['refs/heads/feat/997-x'], defaultBranch: 'main' }).allow).toBe(true);
  });

  it('refuses when one of several refs is the default branch', () => {
    const decision = decidePrePush({ remoteRefs: ['refs/heads/feat/x', 'refs/heads/main'], defaultBranch: 'main' });

    expect(decision.allow).toBe(false);
  });

  it('does not mistake a branch that ends in the default name for it', () => {
    expect(decidePrePush({ remoteRefs: ['refs/heads/fix/main'], defaultBranch: 'main' }).allow).toBe(true);
  });
});

describe('the git hook script', () => {
  for (const kind of ['pre-commit', 'pre-push'] as const) {
    it(`${kind}: is a POSIX shell script`, () => {
      expect(renderGitHook(kind, 'npx ai-workflows lock')).toMatch(/^#!\/bin\/sh\n/);
    });

    it(`${kind}: has no carriage return anywhere`, () => {
      // Measured in this house: a CR at the end of the shebang line breaks the script on
      // the machines that run it, and nothing says why.
      expect(renderGitHook(kind, 'npx ai-workflows lock')).not.toContain('\r');
    });

    it(`${kind}: hands control to the lock command, passing git s arguments along`, () => {
      const script = renderGitHook(kind, 'npx ai-workflows lock');

      expect(script).toContain('npx ai-workflows lock');
      expect(script).toContain('"$@"');
      expect(script).toContain('exec');
    });

    it(`${kind}: tells the command which hook it is`, () => {
      expect(renderGitHook(kind, 'npx ai-workflows lock')).toContain(kind);
    });
  }
});

describe('installing the editor hooks', () => {
  it('claude: wires the hook to Claude s editing tools', () => {
    const file = buildHooksConfig('claude', 'npx ai-workflows hook');
    const group = file.hooks.PreToolUse[0];

    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(new RegExp(`^(?:${group?.matcher})$`).test(tool), tool).toBe(true);
    }
    expect(group?.hooks[0]).toMatchObject({ type: 'command', command: 'npx ai-workflows hook' });
  });

  it('claude: does not wire it to reading tools', () => {
    const group = buildHooksConfig('claude', 'npx ai-workflows hook').hooks.PreToolUse[0];

    expect(new RegExp(`^(?:${group?.matcher})$`).test('Read')).toBe(false);
  });

  it('codex: wires the hook to apply_patch', () => {
    const group = buildHooksConfig('codex', 'npx ai-workflows hook').hooks.PreToolUse[0];

    expect(new RegExp(`^(?:${group?.matcher})$`).test('apply_patch')).toBe(true);
  });

  it('keeps everything else already in the settings file', () => {
    const existing = {
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'otro' }] }] },
    };

    const merged = mergeHooksConfig(existing, buildHooksConfig('claude', 'npx ai-workflows hook'));

    expect(merged.permissions).toEqual({ allow: ['Bash(git status)'] });
    expect((merged.hooks as { PostToolUse: unknown }).PostToolUse).toEqual(existing.hooks.PostToolUse);
  });

  it('keeps someone else s PreToolUse hooks next to ours', () => {
    const existing = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bloquea-rm' }] }] },
    };

    const merged = mergeHooksConfig(existing, buildHooksConfig('claude', 'npx ai-workflows hook'));
    const commands = JSON.stringify(merged);

    expect(commands).toContain('bloquea-rm');
    expect(commands).toContain('npx ai-workflows hook');
  });

  it('changes nothing when installed a second time', () => {
    const ours = buildHooksConfig('claude', 'npx ai-workflows hook');
    const once = mergeHooksConfig({}, ours);

    expect(mergeHooksConfig(once, ours)).toEqual(once);
  });

  it('starts a file from nothing', () => {
    const merged = mergeHooksConfig(undefined, buildHooksConfig('codex', 'npx ai-workflows hook'));

    expect(JSON.stringify(merged)).toContain('npx ai-workflows hook');
  });

  it('does not modify the object it was given', () => {
    const existing = { hooks: { PreToolUse: [] } };
    const before = JSON.stringify(existing);

    mergeHooksConfig(existing, buildHooksConfig('claude', 'npx ai-workflows hook'));

    expect(JSON.stringify(existing)).toBe(before);
  });
});
