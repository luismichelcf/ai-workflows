import { describe, expect, it } from 'vitest';

import { decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026): natural ways to write the owner's sign-off still
// passed, each one reaching GitHub as a valid order. The order counts whenever `/visto-bueno`
// is followed by anything other than a `<placeholder>`: a space and a value, a quote, a
// backslash, a brace, or the end of the text (the rest is concatenated later).

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };
const sha = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

const call = (toolName: string, toolInput: unknown): HookInput => ({ toolName, toolInput, cwd: root });

describe('the order split or built by the shell is still the order', () => {
  const attempts: ReadonlyArray<readonly [string, string]> = [
    ['Bash', 'gh pr comment 12 --body "/visto-bueno "$(git rev-parse HEAD)'],
    ['Bash', `gh pr comment 12 --body '/visto-bueno '"$SHA"`],
    ['Bash', 'gh pr comment 12 --body /visto-bueno\\ $SHA'],
    ['Bash', 'printf "/visto-bueno " > b.md; git rev-parse HEAD >> b.md; gh pr comment 12 -F b.md'],
    ['PowerShell', 'gh pr comment 12 --body ("/visto-bueno " + (git rev-parse HEAD))'],
    ['PowerShell', 'gh pr comment 12 --body ("/visto-bueno {0}" -f (git rev-parse HEAD))'],
    ['PowerShell', '$b = "/visto-bueno " + $sha; gh pr comment 12 --body $b'],
    ['Bash', 'echo -n /visto-bueno'],
  ];

  for (const [toolName, command] of attempts) {
    it(`refuses ${command}`, () => {
      expect(decideToolUse(call(toolName, { command }), withPiece).allow).toBe(false);
    });
  }

  it('refuses the order in a notebook cell', () => {
    const input = call('NotebookEdit', { notebook_path: `${root}\\docs\\a.ipynb`, new_source: `/visto-bueno ${sha}` });

    expect(decideToolUse(input, noPiece).allow).toBe(false);
  });
});

describe('explaining the order is still allowed', () => {
  it('allows the order with a <placeholder>', () => {
    const input = call('Write', { file_path: `${root}\\docs\\a.md`, content: 'Para aprobar escribe `/visto-bueno <sha>` en el PR.' });

    expect(decideToolUse(input, noPiece).allow).toBe(true);
  });

  it('allows searching for the word without the slash', () => {
    expect(decideToolUse(call('Bash', { command: 'grep -rn "visto-bueno" docs' }), noPiece).allow).toBe(true);
  });
});
