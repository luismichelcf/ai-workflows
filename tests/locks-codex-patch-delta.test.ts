import { describe, expect, it } from 'vitest';

import { decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026), read against Codex's parser
// (codex-rs/apply-patch/src/streaming_parser.rs):
//   - `line.trim()` in Rust removes U+0085 (NEXT LINE); JavaScript's `trim()` does not, so a
//     header after that character was invisible to the lock and real to Codex.
//   - Inside an Update block Codex only takes `***` at column 0 as structure; an indented
//     `***` line is context (its own test `keeps_indented_update_markers_as_context_lines`).
//   - `*** Environment ID:` is a marker Codex accepts.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };

const patch = (...lines: string[]): HookInput => ({
  toolName: 'apply_patch',
  toolInput: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
  cwd: root,
});

const allowed = (context: LockContext, ...lines: string[]) => decideToolUse(patch(...lines), context).allow;

describe('the lock trims a line like Codex does', () => {
  it('refuses a header preceded by U+0085, which Rust trims and JavaScript does not', () => {
    expect(allowed(noPiece, '*** Add File: docs/a.md', '+hola', '\u0085*** Add File: src/evil.ts', '+x')).toBe(false);
  });
});

describe('inside an Update block, an indented *** line is context', () => {
  it('allows a Markdown rule " ***" as context in a paper', () => {
    expect(allowed(noPiece, '*** Update File: docs/a.md', '@@', ' ***', '-a', '+b')).toBe(true);
  });

  it('allows "  *** WARNING ***" as context in a paper', () => {
    expect(allowed(noPiece, '*** Update File: docs/a.md', '@@', '  *** WARNING ***', '-a', '+b')).toBe(true);
  });

  it('still refuses an unknown marker at column 0 after a paper', () => {
    expect(allowed(noPiece, '*** Update File: docs/a.md', '@@', '-a', '+b', '*** Copy File: docs/b.md')).toBe(false);
  });
});

describe('markers Codex accepts are accepted', () => {
  it('allows a patch that declares its environment', () => {
    expect(allowed(noPiece, '*** Environment ID: remote', '*** Update File: docs/a.md', '@@', '-a', '+b')).toBe(true);
  });
});

describe('with a piece, a patch the lock cannot read does not stop the work', () => {
  it('allows a patch with a marker it does not know when writing is allowed anyway', () => {
    expect(allowed(withPiece, '*** Update File: src/a.ts', '@@', '-a', '+b', '*** Frobnicate')).toBe(true);
  });
});
