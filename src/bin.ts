#!/usr/bin/env node
import { ghAccounts, runAgentCli } from './agent/cli.js';
import { judgeCli } from './judge/cli.js';
import { recipeCommand } from './recipe/command.js';
import { installHooks, runHook, type HookKind } from './locks/hook-cli.js';

// PLAN-13-R4 §4: the commands that read the recipe and run next to the agent are served here;
// `validate`, `explain`, `init` and the judge keep their own paths. PLAN-13-R5 §1.5 adds the two
// lock commands: `hook <kind>` (which the editor and git run) and `hooks install [--apply]`.

const AGENT_COMMANDS: ReadonlySet<string> = new Set([
  'run',
  'status',
  'stop',
  'pause',
  'resume',
  'doctor',
  'build',
  'review',
  'sync',
  'finish',
]);

const HOOK_KINDS: ReadonlySet<string> = new Set(['editor', 'pre-commit', 'pre-push']);

const argv = process.argv.slice(2);
const [command] = argv;

/** Everything the hook got on stdin; a request the CLI did not pipe reads as an empty string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (command === 'hook') {
  const kind = argv[1];
  if (kind === undefined || !HOOK_KINDS.has(kind)) {
    process.stderr.write('Usage: ai-workflows hook <editor|pre-commit|pre-push>\n');
    process.exitCode = 1;
  } else {
    // The loader passes the project folder in the environment, because `-e` puts it in argv[1]
    // and the compiled binary only sees its own arguments. Without it (git hooks) the folder is
    // where the command runs, which is the repository git itself uses.
    const projectDir = process.env.AI_WORKFLOWS_PROJECT_DIR ?? process.cwd();
    const stdin = kind === 'pre-commit' ? '' : await readStdin();
    const result = await runHook(kind as HookKind, { projectDir, cwd: process.cwd(), stdin });
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }
} else if (command === 'hooks') {
  const sub = argv[1];
  if (sub !== 'install') {
    process.stderr.write('Usage: ai-workflows hooks install [--apply]\n');
    process.exitCode = 1;
  } else {
    const root = process.env.AI_WORKFLOWS_PROJECT_DIR ?? process.cwd();
    const result = await installHooks({ root, apply: argv.includes('--apply') });
    process.stdout.write(`${result.text}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
} else if (command === 'judge' || command === 'red-test-check') {
  process.exitCode = await judgeCli(command);
} else if (command !== undefined && AGENT_COMMANDS.has(command)) {
  const output = await runAgentCli(argv, { cwd: process.cwd(), env: process.env, ghAccounts });
  process.stdout.write(`${output.text}\n`);
  process.exitCode = output.ok ? 0 : 1;
} else {
  const output = await recipeCommand(argv, { cwd: process.cwd() });
  process.stdout.write(`${output.text}\n`);
  process.exitCode = output.ok ? 0 : 1;
}
