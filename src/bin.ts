#!/usr/bin/env node
import { recipeCommand } from './recipe/command.js';

const output = await recipeCommand(process.argv.slice(2), { cwd: process.cwd() });
process.stdout.write(`${output.text}\n`);
process.exitCode = output.ok ? 0 : 1;
