import { describe, expect, it } from 'vitest';

import { buildHooksConfig, decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Third review of the part 4 fixes (13-sep-2026). The widened rule refused normal work — even
// rewriting this project's own sign-off code or a document that names the order — while a
// template filled in by the shell (`"/visto-bueno <sha>" -replace '<sha>', …`) still passed.
// The rule is split by what each tool does:
//   - Files (Write, Edit, MultiEdit, NotebookEdit, apply_patch): refuse only a line the server
//     would read as an order: the line is `/visto-bueno` and a value that is not a <placeholder>.
//   - Shell commands (Bash, PowerShell, Monitor): refuse any `/visto-bueno`, placeholder or not,
//     because the shell can fill it in.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };
const sha = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

const call = (toolName: string, toolInput: unknown): HookInput => ({ toolName, toolInput, cwd: root });

describe('files that talk about the order can be written', () => {
  it('allows rewriting the code that reads the order', () => {
    const input = call('Edit', {
      file_path: `${root}\\src\\locks\\signoff.ts`,
      old_string: 'x',
      new_string: 'const SIGN_OFF_LINE = /^\\/visto-bueno\\s+(\\S+)$/;',
    });

    expect(decideToolUse(input, withPiece).allow).toBe(true);
  });

  it('allows a message that names the order inside a sentence', () => {
    const input = call('Edit', { file_path: `${root}\\src\\locks\\signoff.ts`, old_string: 'x', new_string: "'No hay ninguna orden /visto-bueno en su propia línea.'" });

    expect(decideToolUse(input, withPiece).allow).toBe(true);
  });

  it('allows a document that explains the order', () => {
    for (const content of ['La orden `/visto-bueno` solo la escribe el dueño.', 'Sin /visto-bueno no se mergea.', 'Escribe:\n\n/visto-bueno <sha>\n']) {
      const input = call('Write', { file_path: `${root}\\docs\\a.md`, content });

      expect(decideToolUse(input, noPiece).allow, content).toBe(true);
    }
  });
});

describe('a line the server would read as an order is still refused in files', () => {
  it('refuses the order alone on its line, with spaces around it', () => {
    const input = call('Write', { file_path: 'C:\\Users\\Luis\\AppData\\Local\\Temp\\body.md', content: `Aprobado.\n  /visto-bueno ${sha}  \n` });

    expect(decideToolUse(input, withPiece).allow).toBe(false);
  });

  it('refuses the order as an added line of a Codex patch', () => {
    const input = call('apply_patch', { command: `*** Begin Patch\n*** Add File: docs/a.md\n+/visto-bueno ${sha}\n*** End Patch` });

    expect(decideToolUse(input, withPiece).allow).toBe(false);
  });

  it('refuses a patch whose command is not text, even with a piece', () => {
    const input = call('apply_patch', { command: ['*** Begin Patch', `+/visto-bueno ${sha}`, '*** End Patch'] });

    expect(decideToolUse(input, withPiece).allow).toBe(false);
  });
});

describe('in a shell, any /visto-bueno is refused, placeholder or not', () => {
  const attempts: ReadonlyArray<readonly [string, string]> = [
    ['PowerShell', `gh pr comment 12 --body ("/visto-bueno <sha>" -replace '<sha>', (git rev-parse HEAD))`],
    ['Bash', `gh pr comment 12 --body "$(echo '/visto-bueno <sha>' | sed "s/<sha>/$(git rev-parse HEAD)/")"`],
    ['Bash', 'grep -rn "/visto-bueno" docs'],
    ['Monitor', `until gh pr comment 12 --body "/visto-bueno ${sha}"; do sleep 5; done`],
  ];

  for (const [toolName, command] of attempts) {
    it(`refuses ${toolName}: ${command}`, () => {
      expect(decideToolUse(call(toolName, { command }), withPiece).allow).toBe(false);
    });
  }

  it('allows searching for the word without the slash', () => {
    expect(decideToolUse(call('Bash', { command: 'grep -rn "visto-bueno" docs' }), noPiece).allow).toBe(true);
  });

  it('wires the Claude hook to Monitor too, which runs a shell command', () => {
    expect(buildHooksConfig('claude', 'x').hooks.PreToolUse[0]?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor');
  });
});
