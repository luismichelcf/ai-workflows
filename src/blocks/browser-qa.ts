import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult, JsonValue } from '../contract.js';
import { analyzeDocument, canonicalText, type DocumentAnalysis } from '../gates.js';
import { resolveExecutable, type ExecutableEnvironment } from '../exec.js';
import {
  DEFAULT_PROCESS_GROUPS,
  DEFAULT_STDOUT_BYTES,
  type GroupExit,
} from '../process-group.js';
import { confirmEmptyGroup } from './confirm-empty.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import {
  asObject,
  asString,
  asStringList,
  blockEvidence,
  isSpanish,
  judgedSha,
  lastPassed,
  requireAgent,
} from './final.js';
import type { BlockManifest } from './manifest.js';
import { PullRequestRefused, pullRequestOf, reconcilePullRequestEffect } from './pull-request.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.5: the project's browser suite over the preview. The command, the criteria, the
// variables it may receive and the time limit arrive by `with:`. The engine hands it a brand new
// environment with only the system minimum, its `pass-env` and `AI_WORKFLOWS_*`, and a report
// folder created outside the tree, which the engine removes whether the command passes or fails.

export const manifest: BlockManifest = {
  name: 'browser-qa',
  kind: 'module',
  natures: ['recompute'],
  validWhile: ['same-sha'],
  server: ['require-check'],
  inputs: {
    command: { type: 'command', required: true },
    'preview-stage': { type: 'string', required: true },
    criteria: {
      type: 'object',
      required: true,
      fields: {
        file: { type: 'string', required: true },
        section: { type: 'string', required: true },
        'id-prefix': { type: 'string', required: true },
      },
    },
    'pass-env': { type: 'string-list' },
    'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
  },
};

interface Criteria {
  readonly file: string;
  readonly section: string;
  readonly idPrefix: string;
}

interface QaInputs {
  readonly command: string;
  readonly previewStage: string;
  readonly criteria: Criteria;
  readonly passEnv: readonly string[];
  readonly timeoutMinutes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The environment `resolveExecutable` needs, so the resolver stays a pure function. */
function executableEnvironment(): ExecutableEnvironment {
  const pathExt = process.env['PATHEXT'];
  return {
    platform: process.platform,
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    ...(pathExt === undefined ? {} : { pathExt }),
    nodePath: process.execPath,
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

const SYSTEM_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'NUMBER_OF_PROCESSORS',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'LANG', 'LC_ALL', 'USER', 'SHELL',
] as const;

/**
 * PLAN-13-R4 §5 and §6: the agents' credentials. The recipe validation already refuses a
 * `pass-env` that names one, but the block removes them again here so a project cannot hand its
 * browser suite a token by any other spelling (`GITHUB_TOKEN` in the runner's own environment,
 * an inherited variable). They are deleted last, whatever `pass-env` or `extra` asked for.
 */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AI_WORKFLOWS_APP_ID',
  'AI_WORKFLOWS_APP_KEY_FILE',
];

/** The fresh environment of the QA command: system minimum, `pass-env`, and `AI_WORKFLOWS_*`. */
function commandEnvironment(
  passEnv: readonly string[],
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SYSTEM_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of passEnv) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
  return env;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionOf(analysis: DocumentAnalysis, name: string): DocumentAnalysis['sections'][number] | undefined {
  const wanted = canonicalText(name);
  return analysis.sections.find((section) => canonicalText(section.title) === wanted);
}

/** The identifiers `<prefix><two digits>` of the criteria section, once each, in order. */
function criteriaIds(content: string, criteria: Criteria): string[] {
  const analysis = analyzeDocument(content);
  const lines = sectionOf(analysis, criteria.section)?.lines ?? [];
  const expression = new RegExp(`${escapeRegExp(criteria.idPrefix)}\\d{2}`);
  const ids: string[] = [];
  for (const line of lines) {
    const match = expression.exec(line);
    if (match !== null && !ids.includes(match[0])) ids.push(match[0]);
  }
  return ids;
}

function expanded(command: string, piece: string): { readonly program: string; readonly args: string[] } {
  const tokens = command.split(' ').filter((token) => token.length > 0);
  const program = (tokens[0] ?? '').replaceAll('{piece}', piece);
  const args = tokens.slice(1).map((token) => token.replaceAll('{piece}', piece));
  return { program, args };
}

function tail(output: string, lines = 20): string {
  const parts = output.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n').trim();
}

async function runCommand(
  inputs: QaInputs,
  context: GateContext,
  root: string,
  reportDir: string,
  pieces: readonly string[],
  sha: string,
  url: string,
): Promise<{ readonly exit?: GroupExit; readonly abort?: true }> {
  const { program, args } = expanded(inputs.command, context.piece);
  const resolved = resolveExecutable(program, executableEnvironment());
  if (!resolved.ok) throw new Error(`could not start ${program}: ${resolved.reason}`);

  const environment = commandEnvironment(inputs.passEnv, {
    AI_WORKFLOWS_PREVIEW_URL: url,
    AI_WORKFLOWS_PIECE: context.piece,
    AI_WORKFLOWS_SHA: sha,
    AI_WORKFLOWS_CRITERIA: JSON.stringify(pieces),
    AI_WORKFLOWS_REPORT_DIR: reportDir,
  });

  const group = DEFAULT_PROCESS_GROUPS.launch({
    command: resolved.command,
    args: [...resolved.prefixArgs, ...args],
    cwd: root,
    stdin: '',
    environment,
    ...(resolved.env === undefined ? {} : { env: resolved.env }),
    timeoutMs: inputs.timeoutMinutes * 60_000,
    stdoutBytes: DEFAULT_STDOUT_BYTES,
  });

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    if (context.signal.aborted) {
      resolve('aborted');
      return;
    }
    onAbort = () => resolve('aborted');
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
  const confirmEmpty = (): Promise<void> =>
    confirmEmptyGroup(group, DEFAULT_PROCESS_GROUPS, program);

  try {
    const raced = await Promise.race([
      group.wait().then((exit) => ({ exit })),
      aborted.then(() => 'aborted' as const),
    ]);
    if (raced === 'aborted') {
      await confirmEmpty();
      return { exit: await group.wait(), abort: true };
    }
    return { exit: raced.exit };
  } finally {
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
    await confirmEmpty();
  }
}

async function readReports(
  reportDir: string,
  ids: readonly string[],
  spanish: boolean,
): Promise<{ readonly evidence?: Record<string, string>; readonly reason?: string }> {
  const entries = (await readdir(reportDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);

  const evidence: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of entries) {
    const id = name.slice(0, -'.json'.length);
    seen.add(id);
    if (!ids.includes(id)) {
      return { reason: spanish ? `Sobra el reporte ${id}.` : `The report ${id} is extra.` };
    }
    const content = await readFile(join(reportDir, name), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      return { reason: spanish ? `El reporte ${id} no es JSON válido.` : `The report ${id} is not valid JSON.` };
    }
    if (!isRecord(parsed) || parsed['status'] !== 'passed') {
      return { reason: spanish ? `El criterio ${id} no pasó.` : `The criterion ${id} did not pass.` };
    }
    const assertions = parsed['assertions'];
    if (typeof assertions !== 'number' || !Number.isInteger(assertions) || assertions < 1) {
      return {
        reason: spanish
          ? `El reporte ${id} no trae al menos una comprobación.`
          : `The report ${id} carries no assertion at all.`,
      };
    }
    evidence[id] = createHash('sha256').update(content).digest('hex');
  }

  for (const id of ids) {
    if (!seen.has(id)) {
      return { reason: spanish ? `Falta el reporte ${id}.` : `The report ${id} is missing.` };
    }
  }
  return { evidence };
}

function createGate(inputs: QaInputs, deps: EngineBlockDeps): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'browser-qa');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    const sha = judgedSha(context);

    const pullDeps = { root: deps.root, recipe: deps.recipe, agent, store: deps.store };
    let pr;
    try {
      pr = await pullRequestOf(context.piece, sha, { create: true, context, deps: pullDeps });
    } catch (error) {
      if (error instanceof PullRequestRefused) return { ok: false, reason: error.message };
      throw error;
    }

    let content: string;
    const criteriaFile = inputs.criteria.file.replaceAll('{piece}', context.piece);
    try {
      content = await readFile(join(deps.root, criteriaFile), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          reason: spanish
            ? `No existe el archivo de criterios «${criteriaFile}».`
            : `The criteria file "${criteriaFile}" does not exist.`,
        };
      }
      throw error;
    }
    const ids = criteriaIds(content, inputs.criteria);
    if (ids.length === 0) {
      return {
        ok: false,
        reason: spanish
          ? `No hay criterios con identificador «${inputs.criteria.idPrefix}».`
          : `There are no criteria with identifier "${inputs.criteria.idPrefix}".`,
      };
    }

    const previewEntry = lastPassed(context, inputs.previewStage);
    const previewBlock = blockEvidence(previewEntry);
    const url = previewBlock === undefined ? undefined : asString(previewBlock['url']);
    const previewSha = previewBlock === undefined ? undefined : asString(previewBlock['sha']);
    if (url === undefined || previewSha !== sha) {
      return {
        ok: false,
        reason: spanish
          ? 'La vista previa de esta versión todavía no está registrada.'
          : 'The preview of this version is not recorded yet.',
      };
    }

    const reportDir = await mkdtemp(join(tmpdir(), 'aiw-qa-'));
    try {
      let exit: GroupExit | undefined;
      try {
        const result = await runCommand(inputs, context, deps.root, reportDir, ids, sha, url);
        exit = result.exit;
        if (result.abort === true) throw new Error('the QA command was stopped');
      } catch (error) {
        throw error;
      }

      if (exit === undefined) throw new Error('the QA command did not run');
      if (exit.kind === 'technical') throw new Error(exit.reason);
      if (exit.code !== 0) {
        return {
          ok: false,
          reason: spanish
            ? `El comando terminó con código ${exit.code}: ${tail(exit.stdout)}`
            : `The command ended with code ${exit.code}: ${tail(exit.stdout)}`,
        };
      }

      const reports = await readReports(reportDir, ids, spanish);
      if (reports.reason !== undefined) return { ok: false, reason: reports.reason };

      const after = await agent.github.pullRequestDetail(pr.number);
      if (after.state !== 'OPEN' || after.headSha !== sha) {
        return {
          ok: false,
          reason: spanish
            ? 'El PR cambió de versión mientras corrían las pruebas.'
            : 'The pull request moved while the tests were running.',
        };
      }

      return {
        ok: true,
        evidence: { pr: pr.number, url, criteria: reports.evidence ?? {} },
      };
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  };
}

export const browserQaBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const criteria = asObject(inputs['criteria']) ?? {};
    return createGate(
      {
        command: asString(inputs['command']) ?? '',
        previewStage: asString(inputs['previewStage']) ?? '',
        criteria: {
          file: asString(criteria['file']) ?? '',
          section: asString(criteria['section']) ?? '',
          idPrefix: asString(criteria['idPrefix']) ?? '',
        },
        passEnv: asStringList(inputs['passEnv']) ?? [],
        timeoutMinutes: typeof inputs['timeoutMinutes'] === 'number' ? inputs['timeoutMinutes'] : 30,
      },
      deps,
    );
  },
  async reconcile(_inputs, operationId, context, deps) {
    const agent = deps.agent;
    if (agent === undefined) return undefined;
    const outcome = await reconcilePullRequestEffect(operationId, context, {
      root: deps.root,
      recipe: deps.recipe,
      agent,
      store: deps.store,
    });
    return outcome.handled ? outcome.answer : undefined;
  },
};
