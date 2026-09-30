import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseClientInput,
  parseHookInput,
  renderClientOutput,
  renderHookOutput,
  runHook,
  type HookClient,
  type HookResult,
} from '../src/index.js';

import {
  SHA,
  addFilePatch,
  claudeWrite,
  codexBash,
  codexPatch,
  codexTool,
  inProject,
  opencodeBash,
  opencodeCall,
  opencodeEdit,
  opencodePatch,
  opencodeWrite,
} from './client-payloads.js';
import { emptyFolder, git, removeRepositories, repository } from './git-fixtures.js';

// PLAN-13-R6 §3.2 and §3.5 (unit tests 1, 2, 3, 4, 5 and 9): one lock, three translators.
//
// Interface this file defines (exported from src/index.ts through src/locks.ts):
//   type HookClient = 'claude' | 'codex' | 'opencode'           (extends the existing type)
//   parseClientInput(client, stdin): HookInput | { error: string }
//     - claude: exactly parseHookInput.
//     - codex: `apply_patch`, `Edit` and `Write` (patch in tool_input.command) -> `apply_patch`;
//       `Bash` -> `Bash`; `cwd` from the request.
//     - opencode: reads the plugin's wire format `{tool, sessionID, callID, args, cwd}`;
//       `write` -> Write {file_path, content}; `edit` -> Edit {file_path, old_string, new_string};
//       `apply_patch` -> apply_patch {command: patchText}; `bash` -> Bash {command}.
//     - codex and opencode: an unknown tool whose input carries `path`, `filePath`, `file_path`,
//       `paths` or `patchText` is an error naming the tool; OpenCode's reading tools (`read`,
//       `glob`, `grep`) are known and are not errors.
//   renderClientOutput(client, decision): HookResult ({stdout, stderr, exitCode})
//     - claude and codex: renderHookOutput (deny = the JSON on stdout, exit 0; never exit 2).
//     - opencode: allow = empty, exit 0; deny = the reason on stderr, stdout empty, exit 2.
//   runHook('editor', { client?: HookClient (default 'claude'), projectDir?: string, cwd, stdin })
//     - codex and opencode need no projectDir: the project is the git top of `cwd` and of the
//       request's `cwd`; if it cannot be resolved the answer is a refusal in the client's format.
//     - every answer, internal failures included, is rendered in the client's format.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// An approval stage without a command: its order is the block default, `/approve`.
const RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  'hooks:',
  '  papers: ["docs"]',
  'stages:',
  '  - id: approval',
  '    summary: "La dueña aprueba"',
  '    nature: attest',
  '    needs-human: true',
  '    gate:',
  '      uses: ai-workflows/approval-comment@1',
  '      with: {}',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

function project(branch: string): string {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'export const a = 1;\n', 'docs/nota.md': 'nota\n' });
  git(root, 'switch', '-q', '-C', branch);
  return root;
}

type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** Reads an answer in the format each client understands; anything else fails the test. */
function verdictOf(client: HookClient, output: HookResult): Verdict {
  if (client === 'opencode') {
    if (output.exitCode === 0 && output.stdout === '') return { allow: true };
    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr.trim().length).toBeGreaterThan(0);
    return { allow: false, reason: output.stderr.trim() };
  }
  // Claude and Codex: the refusal that works is the JSON on stdout with exit 0 (§3.1: Codex lets
  // an exit 2 through).
  expect(output.exitCode).toBe(0);
  if (output.stdout === '') return { allow: true };
  const answer = JSON.parse(output.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(answer.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
  return { allow: false, reason: answer.hookSpecificOutput.permissionDecisionReason };
}

/** Runs the editor hook as each client would: Claude with its project folder, the others without. */
function run(client: HookClient, root: string, payload: unknown, cwd = root): Promise<HookResult> {
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return client === 'claude'
    ? runHook('editor', { projectDir: root, cwd, stdin })
    : runHook('editor', { client, cwd, stdin });
}

const refusal = (verdict: Verdict): string => {
  if (verdict.allow) throw new Error('se esperaba un rechazo y el gancho dejó pasar');
  return verdict.reason;
};

describe('parseClientInput: each client is translated to the tools the lock already knows', () => {
  const root = process.platform === 'win32' ? 'C:\\proyecto' : '/proyecto';
  const patch = addFilePatch('src/x.mjs');

  it('claude: exactly what parseHookInput reads today', () => {
    const stdin = JSON.stringify(claudeWrite(root, 'src/x.mjs'));
    expect(parseClientInput('claude', stdin)).toEqual(parseHookInput(stdin));
  });

  it('codex: apply_patch and its aliases Edit and Write are apply_patch with the whole patch; Bash stays Bash', () => {
    for (const alias of ['apply_patch', 'Edit', 'Write'] as const) {
      expect(parseClientInput('codex', JSON.stringify(codexPatch(root, patch, alias)))).toEqual({
        toolName: 'apply_patch',
        toolInput: { command: patch },
        cwd: root,
      });
    }
    expect(parseClientInput('codex', JSON.stringify(codexBash(root, 'Get-ChildItem src')))).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'Get-ChildItem src' },
      cwd: root,
    });
  });

  it('opencode: write, edit, apply_patch and bash become Write, Edit, apply_patch and Bash', () => {
    const file = inProject(root, 'src/x.mjs');
    expect(parseClientInput('opencode', JSON.stringify(opencodeWrite(root, 'src/x.mjs', 'hola')))).toMatchObject({
      toolName: 'Write',
      toolInput: { file_path: file, content: 'hola' },
      cwd: root,
    });
    expect(parseClientInput('opencode', JSON.stringify(opencodeEdit(root, 'src/x.mjs', 'nuevo')))).toMatchObject({
      toolName: 'Edit',
      toolInput: { file_path: file, old_string: 'viejo', new_string: 'nuevo' },
      cwd: root,
    });
    expect(parseClientInput('opencode', JSON.stringify(opencodePatch(root, patch)))).toMatchObject({
      toolName: 'apply_patch',
      toolInput: { command: patch },
      cwd: root,
    });
    expect(parseClientInput('opencode', JSON.stringify(opencodeBash(root, 'ls -la src/')))).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'ls -la src/' },
      cwd: root,
    });
  });

  for (const key of ['path', 'filePath', 'file_path', 'paths', 'patchText'] as const) {
    it(`an unknown tool carrying "${key}" is an error naming the tool, in Codex and in OpenCode`, () => {
      const value = key === 'paths' ? [inProject(root, 'src/x.mjs')] : key === 'patchText' ? patch : inProject(root, 'src/x.mjs');
      const codex = parseClientInput('codex', JSON.stringify(codexTool(root, 'herramienta_nueva', { [key]: value })));
      const opencode = parseClientInput('opencode', JSON.stringify(opencodeCall(root, 'herramienta_nueva', { [key]: value })));
      for (const parsed of [codex, opencode]) {
        expect(parsed).toHaveProperty('error');
        expect((parsed as { error: string }).error).toContain('herramienta_nueva');
      }
    });
  }

  it('an unknown tool without anything shaped like a path is not an error', () => {
    expect(parseClientInput('codex', JSON.stringify(codexTool(root, 'mcp__docs__buscar', { query: 'ganchos' })))).not.toHaveProperty('error');
    expect(parseClientInput('opencode', JSON.stringify(opencodeCall(root, 'webfetch', { url: 'https://example.com' })))).not.toHaveProperty('error');
    expect(parseClientInput('opencode', JSON.stringify(opencodeCall(root, 'todowrite', { todos: [] })))).not.toHaveProperty('error');
  });

  it('OpenCode s reading tools carry paths but are known, so they are not refused', () => {
    for (const [tool, args] of [
      ['read', { filePath: inProject(root, 'src/a.mjs') }],
      ['glob', { pattern: '**/*.mjs', path: root }],
      ['grep', { pattern: 'export', path: root }],
    ] as const) {
      expect(parseClientInput('opencode', JSON.stringify(opencodeCall(root, tool, args)))).not.toHaveProperty('error');
    }
  });

  it('unreadable input is an error for every client', () => {
    for (const client of ['claude', 'codex', 'opencode'] as const) {
      expect(parseClientInput(client, '{roto')).toHaveProperty('error');
    }
    expect(parseClientInput('opencode', JSON.stringify({ args: { filePath: 'x' } }))).toHaveProperty('error');
    expect(parseClientInput('codex', JSON.stringify({ tool_input: { command: 'x' } }))).toHaveProperty('error');
  });
});

describe('renderClientOutput: a refusal in the only format each client obeys', () => {
  const deny = { allow: false, reason: 'motivo del motor' } as const;

  it('claude and codex: the JSON refusal on stdout with exit 0, never exit 2', () => {
    for (const client of ['claude', 'codex'] as const) {
      const output = renderClientOutput(client, deny);
      expect(output).toEqual({ stdout: renderHookOutput(deny).stdout, stderr: '', exitCode: 0 });
      expect(JSON.parse(output.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'motivo del motor' },
      });
      expect(renderClientOutput(client, { allow: true })).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    }
  });

  it('opencode: the reason on stderr and exit 2, so the plugin throws; allow is silence', () => {
    const output = renderClientOutput('opencode', deny);
    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('motivo del motor');
    expect(renderClientOutput('opencode', { allow: true })).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });
});

describe('§3.5 test 1: writing code without a piece is refused and papers pass, in the three clients', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly client: HookClient; readonly payload: (root: string, rel: string) => unknown }> = [
    { name: 'codex apply_patch', client: 'codex', payload: (root, rel) => codexPatch(root, addFilePatch(rel)) },
    { name: 'codex Edit (alias with the patch)', client: 'codex', payload: (root, rel) => codexPatch(root, addFilePatch(rel), 'Edit') },
    { name: 'codex Write (alias with the patch)', client: 'codex', payload: (root, rel) => codexPatch(root, addFilePatch(rel), 'Write') },
    { name: 'opencode write', client: 'opencode', payload: (root, rel) => opencodeWrite(root, rel) },
    { name: 'opencode edit', client: 'opencode', payload: (root, rel) => opencodeEdit(root, rel) },
    { name: 'opencode apply_patch', client: 'opencode', payload: (root, rel) => opencodePatch(root, addFilePatch(rel)) },
  ];

  for (const { name, client, payload } of cases) {
    it(`${name}: src/x is refused with the same reason as Claude, docs/x passes`, async () => {
      const root = project('arreglo');
      const claudeReason = refusal(verdictOf('claude', await run('claude', root, claudeWrite(root, 'src/x.mjs'))));
      expect(claudeReason).toMatch(/pieza/);

      expect(refusal(verdictOf(client, await run(client, root, payload(root, 'src/x.mjs'))))).toBe(claudeReason);
      expect(verdictOf(client, await run(client, root, payload(root, 'docs/x.md')))).toEqual({ allow: true });
    });
  }

  it('on a piece branch, code passes in Codex and in OpenCode', async () => {
    const root = project('feat/13-boton');
    expect(verdictOf('codex', await run('codex', root, codexPatch(root, addFilePatch('src/x.mjs'))))).toEqual({ allow: true });
    expect(verdictOf('opencode', await run('opencode', root, opencodeWrite(root, 'src/x.mjs')))).toEqual({ allow: true });
  });
});

// Claude's own rows of tests 2 and 4 already exist (tests/hooks-cli.test.ts, hooks-review*.test.ts)
// and pass today; here only the new clients are asserted, against the same reasons.
describe('§3.5 test 2: rule 0 in the three clients', () => {
  const approve = 'gh pr review 3 --approve';
  const order = `/approve ${SHA}`;
  const cases: ReadonlyArray<{ readonly name: string; readonly client: HookClient; readonly payload: (root: string) => unknown }> = [
    { name: 'codex console', client: 'codex', payload: (root) => codexBash(root, approve) },
    { name: 'codex file (apply_patch)', client: 'codex', payload: (root) => codexPatch(root, addFilePatch('docs/orden.md', order)) },
    { name: 'opencode console', client: 'opencode', payload: (root) => opencodeBash(root, approve) },
    { name: 'opencode file (write)', client: 'opencode', payload: (root) => opencodeWrite(root, 'docs/orden.md', order) },
    { name: 'opencode file (edit)', client: 'opencode', payload: (root) => opencodeEdit(root, 'docs/orden.md', order) },
    { name: 'opencode file (apply_patch)', client: 'opencode', payload: (root) => opencodePatch(root, addFilePatch('docs/orden.md', order)) },
  ];

  for (const { name, client, payload } of cases) {
    it(`${name}: refused even on a piece branch`, async () => {
      const root = project('feat/13-boton');
      expect(refusal(verdictOf(client, await run(client, root, payload(root))))).toMatch(/dueño/);
    });
  }

  it('control: the same file without the order passes in Codex and in OpenCode', async () => {
    const root = project('feat/13-boton');
    expect(verdictOf('codex', await run('codex', root, codexPatch(root, addFilePatch('docs/orden.md', 'hola'))))).toEqual({ allow: true });
    expect(verdictOf('opencode', await run('opencode', root, opencodeWrite(root, 'docs/orden.md', 'hola')))).toEqual({ allow: true });
  });
});

describe('§3.5 test 3 (the translator): an unknown tool with a path is refused in Codex and in OpenCode', () => {
  it('refused with the tool named, even on a piece branch where writing is allowed', async () => {
    const root = project('feat/13-boton');
    const file = inProject(root, 'src/x.mjs');
    const codex = refusal(verdictOf('codex', await run('codex', root, codexTool(root, 'herramienta_nueva', { filePath: file }))));
    expect(codex).toContain('herramienta_nueva');
    const opencode = refusal(verdictOf('opencode', await run('opencode', root, opencodeCall(root, 'herramienta_nueva', { filePath: file }))));
    expect(opencode).toContain('herramienta_nueva');
  });

  it('an unknown tool without a path passes, and OpenCode s read passes without a piece', async () => {
    const root = project('arreglo');
    expect(verdictOf('codex', await run('codex', root, codexTool(root, 'mcp__docs__buscar', { query: 'ganchos' })))).toEqual({ allow: true });
    expect(verdictOf('opencode', await run('opencode', root, opencodeCall(root, 'read', { filePath: inProject(root, 'src/a.mjs') })))).toEqual({ allow: true });
  });
});

describe('§3.5 test 4: unreadable input is refused in the client s format', () => {
  // Codex's refusal has the same shape as Claude's (JSON, exit 0), so its half is already true today;
  // it is asserted next to OpenCode's, whose format is new.
  it('broken JSON is a refusal: JSON with exit 0 for Codex, exit 2 for OpenCode', async () => {
    const root = project('feat/13-boton');
    for (const client of ['codex', 'opencode'] as const) {
      expect(refusal(verdictOf(client, await run(client, root, '{roto')))).toMatch(/leer/);
    }
  });

  it('opencode: a call without its tool is a refusal', async () => {
    const root = project('feat/13-boton');
    expect(verdictOf('opencode', await run('opencode', root, { args: { filePath: inProject(root, 'src/x.mjs') }, cwd: root })).allow).toBe(false);
  });
});

describe('§3.5 test 5: Codex and OpenCode find the project without CLAUDE_PROJECT_DIR', () => {
  it('codex from a subfolder resolves the root: code refused, papers reached with ../ pass', async () => {
    const root = project('arreglo');
    const sub = join(root, 'src');
    const code = await run('codex', root, codexPatch(sub, addFilePatch('x.mjs')), sub);
    expect(refusal(verdictOf('codex', code))).toMatch(/pieza/);
    const paper = await run('codex', root, codexPatch(sub, addFilePatch('../docs/y.md')), sub);
    expect(verdictOf('codex', paper)).toEqual({ allow: true });
  });

  it('opencode from a subfolder resolves the root the same way', async () => {
    const root = project('arreglo');
    const sub = join(root, 'src');
    const code = await run('opencode', root, opencodeCall(sub, 'write', { filePath: inProject(root, 'src/x.mjs'), content: 's' }), sub);
    expect(refusal(verdictOf('opencode', code))).toMatch(/pieza/);
    const paper = await run('opencode', root, opencodeCall(sub, 'write', { filePath: inProject(root, 'docs/y.md'), content: 's' }), sub);
    expect(verdictOf('opencode', paper)).toEqual({ allow: true });
  });

  it('a folder that is in no repository is a refusal, never a pass', async () => {
    const folder = emptyFolder();
    const codex = await runHook('editor', { client: 'codex', cwd: folder, stdin: JSON.stringify(codexPatch(folder, addFilePatch('src/x.mjs'))) });
    expect(verdictOf('codex', codex).allow).toBe(false);
    const opencode = await runHook('editor', { client: 'opencode', cwd: folder, stdin: JSON.stringify(opencodeWrite(folder, 'src/x.mjs')) });
    expect(verdictOf('opencode', opencode).allow).toBe(false);
  });
});

describe('§3.5 test 9: an internal failure answers in the client s format', () => {
  const exploding = (client: HookClient, cwd: string) => ({
    client,
    cwd,
    get stdin(): string {
      throw new Error('falla inventada');
    },
  });

  it('codex: the JSON refusal with exit 0, never exit 2; opencode: exit 2 with the reason', async () => {
    const root = project('feat/13-boton');
    const codex = await runHook('editor', exploding('codex', root));
    expect(codex.exitCode).toBe(0);
    expect(codex.exitCode).not.toBe(2);
    expect(refusal(verdictOf('codex', codex))).toMatch(/falla inventada/);
    const opencode = await runHook('editor', exploding('opencode', root));
    expect(refusal(verdictOf('opencode', opencode))).toMatch(/falla inventada/);
  });
});
