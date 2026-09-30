#!/usr/bin/env node
// PLAN-13-R4 §4: the commands that read the recipe and run next to the agent are served here;
// `validate`, `explain`, `init` and the judge keep their own paths. PLAN-13-R5 §1.5 adds the two
// lock commands: `hook <kind>` (which the editor and git run) and `hooks install [--apply]`.
//
// PLAN-13-R6 §4: `hook` loads only what it uses, so the cold start on Windows does not eat the
// hook's budget. Every other command is imported when it is the one being run.
import type { HookKind, HookResult } from './locks/hook-cli.js';
import type { HookClient } from './locks/install.js';

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

const HOOK_CLIENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode']);

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

/**
 * §15 P6: the watchdog of `hook editor`, shortened for the tests by
 * `AI_WORKFLOWS_HOOK_WATCHDOG_MS`. Only a positive whole number of milliseconds counts; anything
 * else leaves the default. Read here and nowhere else.
 */
function watchdogFrom(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Writes the answer and ends the process explicitly, with the streams flushed first, whatever
 * handle is still open. Claude Code cuts a hook that keeps running and lets the tool through, so
 * the process must not linger on a worker or on a pipe a grandchild holds.
 */
function finishHook(result: HookResult): void {
  const write = (stream: NodeJS.WriteStream, text: string, next: () => void): void => {
    if (text.length === 0) {
      next();
      return;
    }
    stream.write(text, next);
  };
  write(process.stdout, result.stdout, () => {
    write(process.stderr, result.stderr, () => process.exit(result.exitCode));
  });
}

if (command === 'hook') {
  const kind = argv[1];
  if (kind === undefined || !HOOK_KINDS.has(kind)) {
    process.stderr.write('Usage: ai-workflows hook <editor|pre-commit|pre-push>\n');
    process.exitCode = 1;
  } else {
    const clientArg = argv.indexOf('--client');
    const clientValue = clientArg >= 0 ? argv[clientArg + 1] : 'claude';
    if (clientValue === undefined || !HOOK_CLIENTS.has(clientValue)) {
      process.stderr.write('Usage: ai-workflows hook <editor|pre-commit|pre-push> [--client claude|codex|opencode]\n');
      process.exitCode = 1;
    } else {
      const client = clientValue as HookClient;
      const { runHook, superviseHook, HOOK_WATCHDOG_MS } = await import('./locks/hook-cli.js');
      // The loader passes the project folder in the environment, because `-e` puts it in argv[1]
      // and the compiled binary only sees its own arguments. Without it (git hooks) the folder is
      // where the command runs, which is the repository git itself uses. Codex and OpenCode do not
      // hand it over at all: their root is read from `cwd` with git (§3.2).
      const projectDir = process.env.AI_WORKFLOWS_PROJECT_DIR ?? process.cwd();
      if (kind === 'editor') {
        // §4 and §15 P6: the watchdog is armed as soon as the hook starts. The decision runs in a
        // separate process that owns the stdin read, so a client that never closes stdin, or a disk
        // read that blocks the deciding thread, still gets an answer; the deciding process is ended
        // before exiting so nothing is left behind.
        const watchdogMs = watchdogFrom(process.env.AI_WORKFLOWS_HOOK_WATCHDOG_MS) ?? HOOK_WATCHDOG_MS;
        const { spawnHookProcess } = await import('./locks/hook-worker.js');
        const running = spawnHookProcess(kind as HookKind, client);
        const result = await superviseHook(kind as HookKind, running.result, watchdogMs, client);
        running.cancel();
        finishHook(result);
      } else {
        const stdin = kind === 'pre-commit' ? '' : await readStdin();
        finishHook(await runHook(kind as HookKind, { projectDir, cwd: process.cwd(), stdin }));
      }
    }
  }
} else if (command === 'hooks') {
  const sub = argv[1];
  if (sub !== 'install') {
    process.stderr.write('Usage: ai-workflows hooks install [--client claude|codex|opencode] [--apply]\n');
    process.exitCode = 1;
  } else {
    const clientArg = argv.indexOf('--client');
    const clientValue = clientArg >= 0 ? argv[clientArg + 1] : undefined;
    if (clientValue !== undefined && !HOOK_CLIENTS.has(clientValue)) {
      process.stderr.write('Usage: ai-workflows hooks install [--client claude|codex|opencode] [--apply]\n');
      process.exitCode = 1;
    } else {
      const { installHooks } = await import('./locks/hook-cli.js');
      const root = process.env.AI_WORKFLOWS_PROJECT_DIR ?? process.cwd();
      const options = clientValue === undefined
        ? { root, apply: argv.includes('--apply') }
        : { root, apply: argv.includes('--apply'), client: clientValue as HookClient };
      const result = await installHooks(options);
      process.stdout.write(`${result.text}\n`);
      process.exitCode = result.ok ? 0 : 1;
    }
  }
} else if (command === 'judge' || command === 'red-test-check') {
  const { judgeCli } = await import('./judge/cli.js');
  process.exitCode = await judgeCli(command);
} else if (command !== undefined && AGENT_COMMANDS.has(command)) {
  const { runAgentCli, ghAccounts } = await import('./agent/cli.js');
  const output = await runAgentCli(argv, { cwd: process.cwd(), env: process.env, ghAccounts });
  process.stdout.write(`${output.text}\n`);
  process.exitCode = output.ok ? 0 : 1;
} else {
  const { recipeCommand } = await import('./recipe/command.js');
  const output = await recipeCommand(argv, { cwd: process.cwd() });
  process.stdout.write(`${output.text}\n`);
  process.exitCode = output.ok ? 0 : 1;
}
