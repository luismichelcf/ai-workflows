import { describe, expect, it } from 'vitest';

import { buildHooksConfig, decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of part 4 (13-sep-2026): in pull request #1001 of Socialabs an agent wrote "Visto
// bueno del dueño (12-sep-2026, en chat)" with the owner's account, and GitHub showed it
// exactly as if he had typed it. While agents post with his account the server cannot tell
// them apart, so the editor hook refuses any tool call that would write the order itself.
// It is help, not a guarantee (spec §2, level A): it stops the honest mistake of relaying an
// approval, not someone set on getting around it.
//
// Codex hooks documentation, read that day: shell commands and exec_command match as `Bash`
// and carry the command in `tool_input.command`, like apply_patch.

const root = 'C:\\GitHub\\Socialabs';
const sha = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };
const libre: LockContext = { projectRoot: root, libre: true, paperPaths: ['docs'] };

const call = (toolName: string, toolInput: unknown): HookInput => ({ toolName, toolInput, cwd: root });

describe('no agent writes the owner s sign-off for him', () => {
  const attempts: Record<string, HookInput> = {
    'a gh comment': call('Bash', { command: `gh pr comment 12 --body "/visto-bueno ${sha}"` }),
    'a gh api call': call('Bash', { command: `gh api repos/o/r/issues/12/comments -f body='/visto-bueno ${sha}'` }),
    'a PowerShell command': call('PowerShell', { command: `gh pr comment 12 --body "/visto-bueno ${sha}"` }),
    'a file written to post later, outside the project': call('Write', {
      file_path: 'C:\\Users\\Luis\\AppData\\Local\\Temp\\body.md',
      content: `Aprobado en el chat.\n/visto-bueno ${sha}\n`,
    }),
    'an Edit': call('Edit', { file_path: `${root}\\docs\\a.md`, old_string: 'x', new_string: `/visto-bueno ${sha}` }),
    'a MultiEdit': call('MultiEdit', {
      file_path: `${root}\\docs\\a.md`,
      edits: [{ old_string: 'x', new_string: `/visto-bueno ${sha}` }],
    }),
    'a Codex patch': call('apply_patch', {
      command: ['*** Begin Patch', '*** Add File: docs/a.md', `+/visto-bueno ${sha}`, '*** End Patch'].join('\n'),
    }),
    'a Codex shell command': call('Bash', { command: `gh pr comment 12 -b '/visto-bueno ${sha.toUpperCase()}'` }),
  };

  for (const [name, input] of Object.entries(attempts)) {
    it(`refuses the order in ${name}, telling the agent to ask the owner`, () => {
      const decision = decideToolUse(input, noPiece);

      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.reason).toMatch(/dueño/);
    });
  }

  it('refuses it even with a piece active or in a /libre folder', () => {
    const input = attempts['a gh comment'];
    if (input === undefined) throw new Error('missing fixture');

    expect(decideToolUse(input, withPiece).allow).toBe(false);
    expect(decideToolUse(input, libre).allow).toBe(false);
  });

  it('refuses a prefix of a SHA too', () => {
    expect(decideToolUse(call('Bash', { command: `gh pr comment 12 --body "/visto-bueno ${sha.slice(0, 7)}"` }), noPiece).allow).toBe(false);
  });

  it('refuses the SHA filled in by the shell, the most natural way to write it', () => {
    const commands: ReadonlyArray<readonly [string, string]> = [
      ['Bash', 'gh pr comment 12 --body "/visto-bueno $(git rev-parse HEAD)"'],
      ['Bash', 'gh pr comment 12 --body "/visto-bueno $SHA"'],
      ['Bash', 'gh pr comment 12 --body "/visto-bueno ${SHA}"'],
      ['Bash', 'gh pr comment 12 --body "/visto-bueno `git rev-parse HEAD`"'],
      ['PowerShell', 'gh pr comment 12 --body "/visto-bueno $(git rev-parse HEAD)"'],
      ['PowerShell', 'gh pr comment 12 --body "/visto-bueno $env:SHA"'],
      ['Bash', 'cmd /c gh pr comment 12 --body "/visto-bueno %SHA%"'],
    ];
    for (const [toolName, command] of commands) {
      expect(decideToolUse(call(toolName, { command }), noPiece).allow, command).toBe(false);
    }
  });
});

describe('ordinary work is untouched', () => {
  it('allows ordinary shell commands with no piece', () => {
    for (const command of ['pnpm vitest run', 'git log --oneline -5', 'gh pr view 12']) {
      expect(decideToolUse(call('Bash', { command }), noPiece).allow, command).toBe(true);
      expect(decideToolUse(call('PowerShell', { command }), noPiece).allow, command).toBe(true);
    }
  });

  it('allows explaining the order with a placeholder', () => {
    const input = call('Write', { file_path: `${root}\\docs\\a.md`, content: 'Para aprobar escribe /visto-bueno <sha> en el PR.' });

    expect(decideToolUse(input, noPiece).allow).toBe(true);
  });

  it('allows a shell command that only mentions the word', () => {
    expect(decideToolUse(call('Bash', { command: 'grep -rn "visto-bueno" docs' }), noPiece).allow).toBe(true);
  });

  it('refuses a shell tool call it cannot read', () => {
    expect(decideToolUse(call('Bash', { cmd: 'x' }), noPiece).allow).toBe(false);
  });
});

describe('the hook is wired to the shell tools as well', () => {
  it('claude: the four editing tools plus Bash and PowerShell, nothing else', () => {
    expect(buildHooksConfig('claude', 'x').hooks.PreToolUse[0]?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell');
  });

  it('codex: apply_patch and Bash', () => {
    expect(buildHooksConfig('codex', 'x').hooks.PreToolUse[0]?.matcher).toBe('apply_patch|Bash');
  });
});
