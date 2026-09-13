import { describe, expect, it } from 'vitest';

import { decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of part 4 (13-sep-2026), read against Codex's own parser (openai/codex, main,
// codex-rs/apply-patch/src/streaming_parser.rs): outside an Update block it recognises the
// headers on the TRIMMED line, and it takes the path exactly as written after "File: ". A
// lock that only looks at column 0 lets an indented header create or delete code.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };

const patch = (...lines: string[]): HookInput => ({
  toolName: 'apply_patch',
  toolInput: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
  cwd: root,
});

const allowed = (...lines: string[]) => decideToolUse(patch(...lines), noPiece).allow;

describe('every kind of header is seen', () => {
  it('refuses adding a code file', () => {
    expect(allowed('*** Add File: src/a.ts', '+x')).toBe(false);
  });

  it('refuses deleting a code file', () => {
    expect(allowed('*** Delete File: src/a.ts')).toBe(false);
  });

  it('refuses moving a paper into code', () => {
    expect(allowed('*** Update File: docs/a.md', '*** Move to: src/a.ts', '@@', '-a', '+b')).toBe(false);
  });

  it('allows adding, updating and deleting papers', () => {
    expect(allowed('*** Add File: docs/a.md', '+hola')).toBe(true);
    expect(allowed('*** Update File: docs/b.md', '@@', '-a', '+b')).toBe(true);
    expect(allowed('*** Delete File: docs/c.md')).toBe(true);
    expect(allowed('*** Update File: docs/d.md', '@@', '-a', '+b', '*** End of File')).toBe(true);
  });
});

describe('an indented header is still a header', () => {
  it('refuses an indented Add after an Add of a paper', () => {
    expect(allowed('*** Add File: docs/a.md', '+hola', ' *** Add File: src/evil.ts', '+x')).toBe(false);
  });

  it('refuses a tab-indented Update after an Add of a paper', () => {
    expect(allowed('*** Add File: docs/a.md', '+hola', '\t*** Update File: src/a.ts', '@@', '-a', '+b')).toBe(false);
  });

  it('refuses an indented Delete after a Delete of a paper', () => {
    expect(allowed('*** Delete File: docs/a.md', ' *** Delete File: src/a.ts')).toBe(false);
  });

  it('refuses when the very first header is indented', () => {
    expect(allowed('  *** Update File: src/a.ts', '@@', '-a', '+b', '*** Update File: docs/a.md', '@@', '-a', '+b')).toBe(false);
  });

  it('fails closed on an indented header-looking line inside an Update block', () => {
    // Codex reads it as context there. Refusing it costs an unusual patch, never a bypass.
    expect(allowed('*** Update File: docs/a.md', '@@', ' *** Add File: src/x.ts', '-a', '+b')).toBe(false);
  });
});

describe('the path is taken exactly as Codex takes it', () => {
  it('refuses a path with a leading space, which Codex writes into a folder named " docs"', () => {
    expect(allowed('*** Add File:  docs/evil.ts', '+x')).toBe(false);
  });
});

describe('what it does not recognise, it refuses', () => {
  it('refuses a line starting with *** that is not a known marker', () => {
    expect(allowed('*** Copy File: src/a.ts')).toBe(false);
  });

  it('allows content lines that merely contain ***', () => {
    expect(allowed('*** Add File: docs/a.md', '+*** esto es texto', '+**negritas**')).toBe(true);
  });
});
