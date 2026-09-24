#!/usr/bin/env node
import { judgeCli } from './judge/cli.js';
import { recipeCommand } from './recipe/command.js';

const argv = process.argv.slice(2);
if (argv[0] === 'judge' || argv[0] === 'red-test-check') {
  process.exitCode = await judgeCli(argv[0]);
} else {
  const output = await recipeCommand(argv, { cwd: process.cwd() });
  process.stdout.write(`${output.text}\n`);
  process.exitCode = output.ok ? 0 : 1;
}
