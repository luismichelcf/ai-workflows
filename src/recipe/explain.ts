import { CONDITION_ORDER, joined, languageOf, quoted, type Language } from './applies.js';
import type { Recipe, RecipeCondition, RecipeStage } from './types.js';

type Clause = keyof RecipeCondition;
type Phase = RecipeStage['phase'];
type Validity = RecipeStage['validWhile'];
type GitHubMode = 'recompute' | 'require-check' | 'attestation' | 'local-only';

interface ExplainWords {
  readonly heading: (count: number) => string;
  readonly phase: Readonly<Record<Phase, string>>;
  readonly whenLabel: string;
  readonly always: string;
  readonly onlyIf: string;
  readonly and: string;
  readonly condition: Readonly<Record<Clause, (items: readonly string[]) => string>>;
  readonly validity: Readonly<Record<Validity, string>>;
  readonly pieces: string;
  readonly declaredKind: (line: string, file: string) => string;
  /** PLAN-13-R5 §1.1: where one may write while no piece is open. */
  readonly noPiece: (papers: readonly string[]) => string;
  readonly github: Readonly<Record<GitHubMode, string>>;
  /** The attestation line of a review block that reads the piece's published verdicts. */
  readonly attestationVerdicts: string;
  readonly githubOrder: string;
  readonly githubCleanUpdate: string;
  readonly declaredBuilder: string;
  readonly requiredFailure: string;
  readonly optionalFailure: string;
  readonly humanWait: string;
  readonly retryNow: (attempts: number) => string;
  readonly retryWait: (attempts: number, seconds: number) => string;
}

function noneOf(items: readonly string[]): string {
  return `none of ${quoted(items, false).join(', ')}`;
}

const EXPLAIN_WORDS: Record<Language, ExplainWords> = {
  es: {
    heading: (count) =>
      `Proceso de este proyecto: ${count} ${count === 1 ? 'paso' : 'pasos'}, en este orden.`,
    phase: {
      'pre-merge': 'Antes de fusionar',
      merge: 'Al fusionar',
      'post-merge': 'Después de fusionar',
    },
    whenLabel: 'Cuándo',
    always: 'siempre',
    onlyIf: 'solo si',
    and: ' y ',
    condition: {
      touchesAny: (items) => `el cambio toca ${joined(items, true)}`,
      touchesNone: (items) => `el cambio no toca ${joined(items, true, true)}`,
      kindAny: (items) => `el tipo de cambio es ${joined(items, true)}`,
      kindNone: (items) => `el tipo de cambio no es ${joined(items, true, true)}`,
      laneAny: (items) => `el carril es ${joined(items, true)}`,
    },
    validity: {
      'same-sha': 'Vale mientras el código no cambie.',
      'same-fingerprint': 'Vale mientras los cambios propios de la pieza sigan iguales.',
      'same-fingerprint-or-clean-update':
        'Vale mientras el código no cambie, salvo por actualizaciones sin conflictos con la versión principal.',
      forever: 'Vale siempre, una vez cumplido.',
    },
    pieces:
      'Cada pieza se reconoce por el nombre de su rama; una rama sin pieza nunca se fusiona.',
    declaredKind: (line, file) =>
      `Su tipo de cambio lo declara la línea «${line}» de «${file}».`,
    noPiece: (papers) =>
      `Sin una pieza activa solo se puede escribir en: ${papers.join(', ')}`,
    github: {
      recompute: '   En GitHub: se vuelve a comprobar antes de fusionar.',
      'require-check':
        '   En GitHub: se exige que un check lo confirme en verde sobre esta misma versión.',
      attestation: '   En GitHub: se busca la aprobación publicada en el PR.',
      'local-only': '   En GitHub: solo se comprueba junto al agente.',
    },
    attestationVerdicts: '   En GitHub: se buscan los veredictos publicados en el issue de la pieza.',
    githubOrder: '   El orden en que se escribió solo lo vigila el motor junto al agente.',
    githubCleanUpdate:
      '   En GitHub, una actualización con la versión principal pide aprobarla otra vez.',
    declaredBuilder: 'Quién construyó lo declara la pieza; el motor no puede comprobarlo.',
    requiredFailure: 'Si no se cumple: la pieza se detiene hasta corregirlo.',
    optionalFailure: 'Si no se cumple: se avisa y la pieza sigue.',
    humanWait: 'Si falta: la pieza espera tu decisión; las demás siguen.',
    retryNow: (attempts) => `Se intenta hasta ${attempts} veces seguidas.`,
    retryWait: (attempts, seconds) =>
      `Se intenta hasta ${attempts} veces, con ${seconds} segundos entre intentos.`,
  },
  en: {
    heading: (count) =>
      `This project's process: ${count} ${count === 1 ? 'step' : 'steps'}, in this order.`,
    phase: {
      'pre-merge': 'Before joining the main line',
      merge: 'When joining the main line',
      'post-merge': 'After joining the main line',
    },
    whenLabel: 'When',
    always: 'always',
    onlyIf: 'only if',
    and: ' and ',
    condition: {
      touchesAny: (items) => `the change touches ${joined(items, false)}`,
      touchesNone: (items) => items.length === 1
        ? `the change does not touch ${joined(items, false)}`
        : `the change touches ${noneOf(items)}`,
      kindAny: (items) => `the kind of change is ${joined(items, false)}`,
      kindNone: (items) => items.length === 1
        ? `the kind of change is not ${joined(items, false)}`
        : `the kind of change is ${noneOf(items)}`,
      laneAny: (items) => `the lane is ${joined(items, false)}`,
    },
    validity: {
      'same-sha': 'Valid while the code does not change.',
      'same-fingerprint': "Valid while the piece's own changes stay the same.",
      'same-fingerprint-or-clean-update':
        'Valid while the code does not change, except for conflict-free updates from the main line.',
      forever: 'Valid for good once met.',
    },
    pieces:
      'Each piece is recognized by the name it works under; work without a piece never joins the main line.',
    declaredKind: (line, file) =>
      `Its kind of change is declared by the line "${line}" of "${file}".`,
    noPiece: (papers) =>
      `Without an active piece, the only folders you may write to are: ${papers.join(', ')}`,
    github: {
      recompute: '   On GitHub: checked again before joining the main line.',
      'require-check':
        '   On GitHub: a check must confirm it in green on this same version.',
      attestation: '   On GitHub: the approval published on the pull request is looked for.',
      'local-only': '   On GitHub: only checked next to the agent.',
    },
    attestationVerdicts: "   On GitHub: the verdicts published on the piece's issue are looked for.",
    githubOrder:
      '   The order in which it was written is only watched by the engine next to the agent.',
    githubCleanUpdate:
      '   On GitHub, an update with the main version asks for it to be approved again.',
    declaredBuilder: 'Who built it is declared by the piece; the engine cannot check it.',
    requiredFailure: 'If it fails: the piece stops until it is fixed.',
    optionalFailure: 'If it fails: you are told and the piece carries on.',
    humanWait: 'If it is missing: the piece waits for your decision; the others carry on.',
    retryNow: (attempts) => `It is tried up to ${attempts} times in a row.`,
    retryWait: (attempts, seconds) =>
      `It is tried up to ${attempts} times, ${seconds} seconds apart.`,
  },
};

function labeled(
  labels: Readonly<Record<string, string>> | undefined,
  items: readonly string[],
): readonly string[] {
  return items.map((item) => labels?.[item] ?? item);
}

function when(
  condition: RecipeCondition | undefined,
  labels: Readonly<Record<string, string>> | undefined,
  words: ExplainWords,
): string {
  if (!condition) return words.always;
  const clauses: string[] = [];
  for (const key of CONDITION_ORDER) {
    const list = condition[key];
    if (list) clauses.push(words.condition[key](labeled(labels, list)));
  }
  return `${words.onlyIf} ${clauses.join(words.and)}`;
}

function orderedStages(recipe: Recipe): RecipeStage[] {
  const ordered: RecipeStage[] = [];
  let next = recipe.stages.find((stage) => stage.after === undefined);
  while (next) {
    ordered.push(next);
    const id = next.id;
    next = recipe.stages.find((stage) => stage.after === id);
  }
  return ordered;
}

function failureLine(stage: RecipeStage, words: ExplainWords): string {
  if (stage.needsHuman) return words.humanWait;
  return stage.required ? words.requiredFailure : words.optionalFailure;
}

function retryLine(stage: RecipeStage, words: ExplainWords): string | undefined {
  const retry = stage.retry;
  if (!retry || retry.attempts <= 1) return undefined;
  return retry.waitSeconds === 0
    ? words.retryNow(retry.attempts)
    : words.retryWait(retry.attempts, retry.waitSeconds);
}

/** §1.4: what GitHub does with a pre-merge stage, and what it cannot see. */
function githubLines(stage: RecipeStage, words: ExplainWords): readonly string[] {
  if (stage.phase !== 'pre-merge' || stage.server === undefined) return [];
  const mode = typeof stage.server === 'string' ? stage.server : 'require-check';
  // A review block reads the verdicts the agents publish on the piece's issue; every other
  // attestation reads what the owner published on the pull request (PLAN-13-R4 §3.1, §7).
  const verdictOfReview =
    mode === 'attestation' &&
    (stage.gate.uses === 'ai-workflows/sandboxed-review@1' || stage.gate.uses === 'ai-workflows/independent-review@1');
  const lines = [verdictOfReview ? words.attestationVerdicts : words.github[mode]];
  if (mode === 'require-check' && stage.nature === 'execution-record') {
    lines.push(words.githubOrder);
  }
  if (mode === 'attestation' && stage.validWhile === 'same-fingerprint-or-clean-update') {
    lines.push(words.githubCleanUpdate);
  }
  return lines;
}

export function explainRecipe(recipe: Recipe): string {
  const words = EXPLAIN_WORDS[languageOf(recipe.locale)];
  const stages = orderedStages(recipe);
  const lines = [words.heading(stages.length)];
  let phase: Phase | undefined;

  if (recipe.pieces !== undefined) {
    lines.push('', words.pieces);
    const declared = recipe.pieces.declaredKind;
    if (declared !== undefined) lines.push(words.declaredKind(declared.line, declared.file));
  }

  if (recipe.hooks !== undefined && recipe.hooks.papers.length > 0) {
    lines.push('', words.noPiece(recipe.hooks.papers));
  }

  for (const [index, stage] of stages.entries()) {
    if (stage.phase !== phase) {
      phase = stage.phase;
      lines.push('', words.phase[phase]);
    }

    const summary = /[.!?…]$/.test(stage.summary)
      ? stage.summary
      : `${stage.summary}.`;
    lines.push(`${index + 1}. ${summary}`);
    lines.push(`   ${words.whenLabel}: ${when(stage.appliesIf, recipe.labels, words)}.`);
    lines.push(`   ${words.validity[stage.validWhile]}`);
    lines.push(...githubLines(stage, words));
    // Who built the piece is only declared by the piece (PLAN-13-R2 §3.3): say so, so nobody
    // reads the engine's approval as proof of who wrote the code.
    if (stage.gate.uses === 'ai-workflows/sandboxed-review@1') {
      lines.push(`   ${words.declaredBuilder}`);
    }
    lines.push(`   ${failureLine(stage, words)}`);

    const retry = retryLine(stage, words);
    if (retry) lines.push(`   ${retry}`);
  }
  return lines.join('\n');
}
