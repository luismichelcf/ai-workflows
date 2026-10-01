// PLAN-13-R6 §3.3: the files `hooks install` writes for Codex and OpenCode.
//
// Hiding the order in a console line is fragile in cmd, pwsh and sh, so both clients run the same
// file loader, `.ai-workflows/hook.cjs`, which is already protected for living under
// `.ai-workflows/`. Codex gets one entry in `.codex/hooks.json`; OpenCode gets a whole plugin in
// `.opencode/plugins/ai-workflows.js`. No file here carries a path of the machine that wrote it.

/** The fixed first line that marks a plugin file as ours; a file without it is never overwritten. */
export const OPENCODE_PLUGIN_HEADER =
  '// ai-workflows: plugin de OpenCode (generado por `hooks install`). No lo edites a mano.';

/** The loader, relative to the repository root. `doctor` and the installer recognize our entry by it. */
export const LOADER_RELATIVE = '.ai-workflows/hook.cjs';

/**
 * The Codex order (§3.2, §3.3 and §15 P5). It finds the loader from the repository root, not from
 * the folder the session started in, and runs it with the `codex` client.
 *
 * Codex lets the tool through on any exit that is not 0 with the deny JSON (§3.1: an exit 1 or a
 * signal death is read as a pass), so the order fails closed on its own: it lets the tool through
 * only when the loader exits 0 with empty stdout (the loader allowed it) or with exactly a valid
 * Codex deny JSON, which it forwards as is. Anything else — no repository, the loader missing or
 * not starting, another exit code or a signal, output that is not that JSON — makes the order
 * print the deny JSON itself, naming the engine or the loader, and exit 0.
 *
 * §15 P5: the order has its own clock, because Codex cuts it at `timeout: 30` and then lets the
 * tool through. `git rev-parse` gets about 3 s and the loader what is left up to about 27 s, so the
 * whole run ends well inside the cut even when git hangs; a spent budget is a deny like any other
 * failure. (The plan says the order stands alone, so it does not depend on `bin.ts` clock.)
 *
 * `sh`, cmd.exe and Windows PowerShell all accept the same line: the whole script rides inside one
 * double-quoted `node -e` argument with no shell metacharacter, so no quoting of any of the three
 * can break it.
 */
export const CODEX_HOOK_ORDER = `node -e "const cp=require('child_process'),fs=require('fs');function deny(r){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:r}}),function(){process.exit(0)})}function main(){var start=Date.now(),total=27000,gitMs=3000;function left(){var t=total-(Date.now()-start);return t>0?t:0}function budget(ms){var t=left();return t>ms?ms:t}var command='git rev-parse --show-toplevel',parts=command.split(' '),root='';try{var g=cp.spawnSync(parts[0],parts.slice(1),{encoding:'utf8',timeout:Math.max(1,budget(gitMs))});if(g.error||g.status!==0||!g.stdout){var why=g.error&&g.error.message?g.error.message:(g.stderr?String(g.stderr).trim():'git no dijo la raiz del repositorio');deny('ai-workflows: no se pudo cargar el motor (no encontre el repositorio: '+why+')');return}root=String(g.stdout).trim()}catch(e){deny('ai-workflows: no se pudo cargar el motor (no encontre el repositorio: '+(e&&e.message?e.message:String(e))+')');return}if(root===''){deny('ai-workflows: no se pudo cargar el motor (git no dijo la raiz del repositorio)');return}var loader=root+'/.ai-workflows/hook.cjs';if(fs.existsSync(loader)===false){deny('ai-workflows: no se pudo cargar el cargador ('+loader+')');return}var p=cp.spawnSync(process.execPath,[loader,'codex'],{stdio:['inherit','pipe','pipe'],encoding:'utf8',timeout:Math.max(1,left())});if(p.error){deny('ai-workflows: no se pudo cargar el cargador ('+(p.error.message?p.error.message:String(p.error))+')');return}if(p.status===0){var out=p.stdout===null||p.stdout===undefined?'':String(p.stdout).trim();if(out===''){process.exit(0)}var good=false;try{var j=JSON.parse(out);good=Boolean(j&&j.hookSpecificOutput&&j.hookSpecificOutput.hookEventName==='PreToolUse'&&j.hookSpecificOutput.permissionDecision==='deny'&&j.hookSpecificOutput.permissionDecisionReason)}catch(e){}if(good){process.stdout.write(p.stdout,function(){process.exit(0)});return}deny('ai-workflows: el motor contesto algo inesperado en su salida');return}deny('ai-workflows: el motor no pudo revisar la herramienta (codigo '+p.status+')')}main()"`;

/** The same order is the one cmd.exe and Windows PowerShell run. */
export const CODEX_HOOK_ORDER_WINDOWS = CODEX_HOOK_ORDER;

/**
 * The file loader (§3.3), run as `node .ai-workflows/hook.cjs <codex|opencode>`. It hands the
 * engine `hook editor --client <client>` and passes its answer through. If the engine is missing,
 * throws while loading or exits with anything but 0, it answers the refusal in that client's
 * format: the JSON deny with exit 0 for Codex, an exit other than 0 with the reason on stderr for
 * OpenCode (the plugin then throws).
 */
export const HOOK_LOADER_CJS = [
  '#!/usr/bin/env node',
  "'use strict';",
  '// ai-workflows: cargador de ganchos para Codex y OpenCode. Lo escribe `hooks install`; no lo edites a mano.',
  "const fs = require('fs');",
  "const path = require('path');",
  "const { spawn } = require('child_process');",
  '',
  "const client = process.argv[2] === 'opencode' ? 'opencode' : 'codex';",
  '',
  'function end(stream, text, code) {',
  '  if (text.length === 0) {',
  '    process.exit(code);',
  '    return;',
  '  }',
  '  stream.write(text, function () {',
  '    process.exit(code);',
  '  });',
  '}',
  '',
  'function refuse(reason) {',
  "  if (client === 'opencode') {",
  "    end(process.stderr, reason + '\\n', 1);",
  '    return;',
  '  }',
  '  end(process.stdout, JSON.stringify({',
  '    hookSpecificOutput: {',
  "      hookEventName: 'PreToolUse',",
  "      permissionDecision: 'deny',",
  '      permissionDecisionReason: reason,',
  '    },',
  "  }) + '\\n', 0);",
  '}',
  '',
  "const engine = path.join(__dirname, '..', 'node_modules', 'ai-workflows', 'dist', 'bin.js');",
  'if (!fs.existsSync(engine)) {',
  "  refuse('ai-workflows: no se pudo cargar el motor (' + engine + ')');",
  '} else {',
  "  const child = spawn(process.execPath, [engine, 'hook', 'editor', '--client', client], { stdio: ['pipe', 'pipe', 'pipe'] });",
  "  let stdout = '';",
  "  let stderr = '';",
  '  let answered = false;',
  '  function answer(reason) {',
  '    if (answered) return;',
  '    answered = true;',
  '    refuse(reason);',
  '  }',
  '  function messageOf(error) {',
  '    return error && error.message ? error.message : String(error);',
  '  }',
  "  child.stdout.on('data', function (chunk) { stdout += chunk; });",
  "  child.stderr.on('data', function (chunk) { stderr += chunk; });",
  "  child.on('error', function (error) {",
  "    answer('ai-workflows: no se pudo cargar el motor (' + messageOf(error) + ')');",
  '  });',
  "  child.on('close', function (code) {",
  '    if (answered) return;',
  '    answered = true;',
  '    if (code === 0) {',
  '      end(process.stdout, stdout, 0);',
  '      return;',
  '    }',
  "    var reason = stderr.trim();",
  '    // §15: exit 2 is the engine s own refusal (OpenCode reads it); its reason is forwarded as is,',
  '    // never dressed up as the engine failing to review.',
  '    if (code === 2) {',
  "      refuse(reason.length > 0 ? reason : 'el motor rechazó la herramienta (código 2)');",
  '      return;',
  '    }',
  "    refuse('ai-workflows: el motor no pudo revisar la herramienta (' + (reason || ('terminó con código ' + code)) + ')');",
  '  });',
  "  process.stdin.on('error', function () {});",
  '  process.stdin.pipe(child.stdin);',
  '}',
  '',
].join('\n');

/**
 * The OpenCode plugin (§3.3). It lives inside OpenCode, so it fails closed on its own: it spawns
 * `node` (from PATH, never `process.execPath`, which inside OpenCode is OpenCode itself) with the
 * loader, forwards the call, and resolves only on exit 0 with nothing on stdout. Everything else — a
 * refusal, another exit code, unexpected output, node not starting, its own time running out —
 * throws and blocks the tool. It is a whole ES module with exactly one export, because OpenCode
 * calls every export of the file as a plugin.
 */
export const OPENCODE_PLUGIN_JS = [
  OPENCODE_PLUGIN_HEADER,
  "import { spawn, spawnSync } from 'node:child_process';",
  "import { join } from 'node:path';",
  "import { tmpdir } from 'node:os';",
  '',
  'const DEFAULT_TIMEOUT_MS = 30000;',
  '',
  'export const AiWorkflows = async (ctx, options) => {',
  "  const directory = ctx && typeof ctx.directory === 'string' ? ctx.directory : process.cwd();",
  '  // §15: the loader lives at the repository root, not at the folder OpenCode runs in. OpenCode',
  '  // finds the plugin by walking up, but `ctx.directory` can be a subfolder, so the hook is looked',
  '  // up from `ctx.worktree` and, when that is missing, from git s top of the project.',
  '  const root = rootOf(ctx, directory);',
  "  const timeoutMs = options && typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;",
  '  return {',
  "    'tool.execute.before': (input, output) =>",
  "      runLoader(root, { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args, cwd: root }, timeoutMs),",
  '  };',
  '};',
  '',
  'function rootOf(ctx, directory) {',
  "  if (ctx && typeof ctx.worktree === 'string' && ctx.worktree.length > 0) return ctx.worktree;",
  '  try {',
  "    const found = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8' });",
  "    const top = found.stdout === null || found.stdout === undefined ? '' : String(found.stdout).trim();",
  '    return top.length > 0 ? top : directory;',
  '  } catch (error) {',
  '    return directory;',
  '  }',
  '}',
  '',
  'function messageOf(error) {',
  '  return error && error.message ? error.message : String(error);',
  '}',
  '',
  'function runLoader(root, payload, timeoutMs) {',
  '  return new Promise((resolve, reject) => {',
  '    let child;',
  '    try {',
  "      // The loader is named in full (at the repository root) and run from a neutral folder: the",
  "      // project the engine judges comes from `cwd` in the payload, so the child never holds the",
  "      // project folder as its own working directory (killing it would otherwise keep that folder",
  "      // locked on Windows).",
  "      child = spawn('node', [join(root, '.ai-workflows', 'hook.cjs'), 'opencode'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });",
  '    } catch (error) {',
  "      reject(new Error('ai-workflows: no se pudo lanzar el cargador (' + messageOf(error) + ')'));",
  '      return;',
  '    }',
  "    let stdout = '';",
  "    let stderr = '';",
  '    let settled = false;',
  '    let timer;',
  '    function settle(action) {',
  '      if (settled) return;',
  '      settled = true;',
  '      clearTimeout(timer);',
  '      action();',
  '    }',
  '    timer = setTimeout(function () {',
  "      try { child.kill('SIGKILL'); } catch (error) {}",
  "      settle(function () { reject(new Error('ai-workflows: el gancho no contestó a tiempo (' + (timeoutMs / 1000) + ' s); se niega.')); });",
  '    }, timeoutMs);',
  "    child.on('error', function (error) {",
  "      settle(function () { reject(new Error('ai-workflows: no se pudo lanzar node para el gancho (' + messageOf(error) + ')')); });",
  '    });',
  "    child.stdout.on('data', function (chunk) { stdout += chunk; });",
  "    child.stderr.on('data', function (chunk) { stderr += chunk; });",
  "    child.on('close', function (code) {",
  '      if (code === 0 && stdout.length === 0) {',
  '        settle(resolve);',
  '      } else if (code === 0) {',
  "        settle(function () { reject(new Error('ai-workflows: el gancho contestó algo inesperado en la salida (' + stdout.trim() + ')')); });",
  '      } else {',
  "        settle(function () { reject(new Error('ai-workflows: el gancho rechazó la herramienta (código ' + code + '): ' + (stderr.trim() || 'sin motivo'))); });",
  '      }',
  '    });',
  "    child.stdin.on('error', function () {});",
  '    child.stdin.end(JSON.stringify(payload));',
  '  });',
  '}',
  '',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True when a Codex handler is ours: it runs the file loader. */
export function isOurCodexHandler(handler: unknown): boolean {
  return isRecord(handler) && typeof handler.command === 'string' && handler.command.includes(LOADER_RELATIVE);
}

/** True when a plugin file is ours: it carries the fixed header. */
export function isOurPlugin(text: string): boolean {
  return text.includes(OPENCODE_PLUGIN_HEADER);
}
