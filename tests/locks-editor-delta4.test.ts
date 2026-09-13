import { describe, expect, it } from 'vitest';

import { decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Fourth review of the part 4 fixes (13-sep-2026):
//   - Claude Code's Monitor takes a shell `command` or a WebSocket `ws`, never both. A `ws`
//     monitor has no shell text and was refused as unreadable in every folder.
//   - Rules a mutation could remove with every test green: case in shell and in files, and the
//     leading `+` stripped only in patches.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };
const sha = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

const call = (toolName: string, toolInput: unknown): HookInput => ({ toolName, toolInput, cwd: root });

describe('Monitor', () => {
  it('allows a WebSocket monitor, which runs no shell command', () => {
    const input = call('Monitor', { ws: { url: 'wss://example.com/events' }, description: 'eventos', timeout_ms: 60_000, persistent: false });

    expect(decideToolUse(input, withPiece).allow).toBe(true);
    expect(decideToolUse(input, noPiece).allow).toBe(true);
  });

  it('refuses a Monitor with neither a command nor a ws', () => {
    expect(decideToolUse(call('Monitor', { description: 'nada' }), withPiece).allow).toBe(false);
  });
});

describe('the order in any letter case', () => {
  it('refuses /VISTO-BUENO in a shell command', () => {
    expect(decideToolUse(call('Bash', { command: `gh pr comment 12 --body "/VISTO-BUENO ${sha}"` }), withPiece).allow).toBe(false);
  });

  it('refuses /Visto-Bueno alone on a line of a file', () => {
    expect(decideToolUse(call('Write', { file_path: `${root}\\docs\\a.md`, content: `/Visto-Bueno ${sha}\n` }), noPiece).allow).toBe(false);
  });
});

describe('the leading + is a patch thing', () => {
  it('allows a file line that starts with +/visto-bueno, which the server does not read as the order', () => {
    expect(decideToolUse(call('Write', { file_path: `${root}\\docs\\a.md`, content: `+/visto-bueno ${sha}\n` }), noPiece).allow).toBe(true);
  });
});
