import { describe, expect, it } from 'vitest';

import {
  decideToolUse,
  handleHook,
  parseHookInput,
  renderHookOutput,
  type HookInput,
  type LockContext,
} from '../src/index.js';

// The editor hook. Formats from the primary docs, read on 13-sep-2026:
//   Claude Code (code.claude.com/docs/en/hooks): PreToolUse gets `tool_name`, `tool_input`,
//   `cwd` on stdin; Write/Edit carry `tool_input.file_path`. To deny, print
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
//   "permissionDecisionReason":"..."}}. Exit 0 with no output means "no decision".
//   Codex (developers.openai.com/codex/hooks): same deny shape; file edits arrive as
//   `tool_name: "apply_patch"` with the patch in `tool_input.command`.
//
// This layer is help, not a guarantee, and says so: an untrusted folder skips it, and shell
// commands that write are not its surface — the git pre-commit hook catches what they stage.

const cwd = 'C:/GitHub/Socialabs';
const noPiece: LockContext = { paperPaths: ['docs'] };
const withPiece: LockContext = { activePiece: '997', paperPaths: ['docs'] };
const libre: LockContext = { libre: true, paperPaths: ['docs'] };

const claudeWrite = (file: string): HookInput => ({
  toolName: 'Write',
  toolInput: { file_path: file, content: 'x' },
  cwd,
});

const codexPatch = (...files: string[]): HookInput => ({
  toolName: 'apply_patch',
  toolInput: {
    command: [
      '*** Begin Patch',
      ...files.map((file) => `*** Update File: ${file}\n@@\n-a\n+b`),
      '*** End Patch',
    ].join('\n'),
  },
  cwd,
});

describe('writing code with no piece in the folder', () => {
  it('refuses a Claude write to a source file', () => {
    expect(decideToolUse(claudeWrite('C:/GitHub/Socialabs/lib/calc/nomina.ts'), noPiece).allow).toBe(false);
  });

  it('refuses each Claude editing tool', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
      const input: HookInput = { toolName, toolInput: { file_path: `${cwd}/src/a.ts` }, cwd };

      expect(decideToolUse(input, noPiece).allow, toolName).toBe(false);
    }
  });

  it('refuses a notebook edit', () => {
    const input: HookInput = { toolName: 'NotebookEdit', toolInput: { notebook_path: `${cwd}/src/a.ipynb` }, cwd };

    expect(decideToolUse(input, noPiece).allow).toBe(false);
  });

  it('refuses a Codex patch to a source file', () => {
    expect(decideToolUse(codexPatch('lib/calc/nomina.ts'), noPiece).allow).toBe(false);
  });

  it('says what to do instead, not only that it refused', () => {
    const decision = decideToolUse(claudeWrite(`${cwd}/src/a.ts`), noPiece);

    expect(decision.allow === false && decision.reason.length).toBeGreaterThan(20);
  });
});

describe('what is never blocked', () => {
  it('reading', () => {
    for (const toolName of ['Read', 'Grep', 'Glob']) {
      expect(decideToolUse({ toolName, toolInput: { file_path: `${cwd}/src/a.ts` }, cwd }, noPiece).allow, toolName).toBe(true);
    }
  });

  it('a shell command, which is not this hook s surface', () => {
    const input: HookInput = { toolName: 'Bash', toolInput: { command: 'pnpm test' }, cwd };

    expect(decideToolUse(input, noPiece).allow).toBe(true);
  });

  it('writing papers', () => {
    expect(decideToolUse(claudeWrite(`${cwd}/docs/plans/PLAN-1.md`), noPiece).allow).toBe(true);
  });

  it('a Codex patch that only touches papers', () => {
    expect(decideToolUse(codexPatch('docs/adr/0204-x.md'), noPiece).allow).toBe(true);
  });

  it('writing outside the project folder, which is not this lock s business', () => {
    // Agents keep scratch files in temp folders. The lock guards the project, not the disk.
    expect(decideToolUse(claudeWrite('C:/Users/Luis/AppData/Local/Temp/scratch/a.md'), noPiece).allow).toBe(true);
  });

  it('writing code when the folder has its piece', () => {
    expect(decideToolUse(claudeWrite(`${cwd}/lib/calc/nomina.ts`), withPiece).allow).toBe(true);
  });

  it('writing code in a /libre folder', () => {
    expect(decideToolUse(claudeWrite(`${cwd}/proto/idea.tsx`), libre).allow).toBe(true);
  });
});

describe('not being fooled by the path', () => {
  it('does not treat docs/../src as papers', () => {
    expect(decideToolUse(claudeWrite(`${cwd}/docs/../src/a.ts`), noPiece).allow).toBe(false);
  });

  it('does not treat a folder that merely starts with "docs" as papers', () => {
    expect(decideToolUse(claudeWrite(`${cwd}/docs-old/a.ts`), noPiece).allow).toBe(false);
  });

  it('reads Windows backslashes the same as forward slashes', () => {
    expect(decideToolUse(claudeWrite('C:\\GitHub\\Socialabs\\src\\a.ts'), noPiece).allow).toBe(false);
  });

  it('reads a relative path against the session folder', () => {
    expect(decideToolUse(claudeWrite('src/a.ts'), noPiece).allow).toBe(false);
  });

  it('refuses a Codex patch that touches papers AND code', () => {
    expect(decideToolUse(codexPatch('docs/a.md', 'src/b.ts'), noPiece).allow).toBe(false);
  });

  it('refuses a Codex patch that moves a paper into the code', () => {
    const input: HookInput = {
      toolName: 'apply_patch',
      toolInput: { command: '*** Begin Patch\n*** Update File: docs/a.md\n*** Move to: src/a.ts\n*** End Patch' },
      cwd,
    };

    expect(decideToolUse(input, noPiece).allow).toBe(false);
  });

  it('refuses a Codex patch it cannot read, rather than letting it through', () => {
    const input: HookInput = { toolName: 'apply_patch', toolInput: { command: 42 }, cwd };

    expect(decideToolUse(input, noPiece).allow).toBe(false);
  });
});

describe('reading what the CLI sends', () => {
  it('reads Claude s PreToolUse payload', () => {
    const stdin = JSON.stringify({
      session_id: 'abc',
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: `${cwd}/src/a.ts` },
    });

    expect(parseHookInput(stdin)).toMatchObject({ toolName: 'Write', cwd });
  });

  it('returns an error for input that is not JSON, without throwing', () => {
    expect(() => parseHookInput('not json')).not.toThrow();
    expect(parseHookInput('not json')).toHaveProperty('error');
  });

  it('returns an error when the tool name is missing', () => {
    expect(parseHookInput(JSON.stringify({ cwd }))).toHaveProperty('error');
  });
});

describe('answering the CLI', () => {
  it('stays silent to allow, so the CLI s own permissions still apply', () => {
    expect(renderHookOutput({ allow: true })).toEqual({ stdout: '', exitCode: 0 });
  });

  it('denies with the shape both Claude Code and Codex accept', () => {
    const output = renderHookOutput({ allow: false, reason: 'esta carpeta no tiene pieza activa' });

    expect(JSON.parse(output.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'esta carpeta no tiene pieza activa',
      },
    });
  });

  it('denies on one line, which is how the CLIs recognise JSON', () => {
    const output = renderHookOutput({ allow: false, reason: 'motivo' });

    expect(output.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('refuses loudly when it cannot read the request', () => {
    // A lock that fails open when the format changes is a lock that quietly stopped working.
    const output = handleHook('<<basura>>', noPiece);

    expect(output.stdout).toContain('deny');
  });

  it('runs the whole path: stdin in, decision out', () => {
    const stdin = JSON.stringify({ cwd, tool_name: 'Write', tool_input: { file_path: `${cwd}/src/a.ts` } });

    expect(handleHook(stdin, noPiece).stdout).toContain('deny');
    expect(handleHook(stdin, withPiece)).toEqual({ stdout: '', exitCode: 0 });
  });
});
