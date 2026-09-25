#!/usr/bin/env node
import { ghAccounts, runAgentCli } from './agent/cli.js';
import { judgeCli } from './judge/cli.js';
import { recipeCommand } from './recipe/command.js';

// PLAN-13-R4 §4: the commands that read the recipe and run next to the agent are served here;
// `validate`, `explain`, `init` and the judge keep their own paths.

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

const argv = process.argv.slice(2);
const [command] = argv;

if (command === 'judge' || command === 'red-test-check') {
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
