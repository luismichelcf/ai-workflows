import {
  InvalidPipeline,
  type PieceState,
  type PieceStatus,
  type PipelineConfig,
  type RunOutcome,
  type Store,
} from './contract.js';
import { validateConfig } from './config.js';
import { createEngine } from './engine.js';

export interface CommandOptions {
  readonly config: PipelineConfig;
  readonly store: Store;
  /** How the project describes what a piece changes, handed to every gate as `change`. */
  readonly describeChange?: (piece: string) => unknown | Promise<unknown>;
}

export interface CommandOutput {
  /** Whether the command succeeded. Drives the process exit code. */
  readonly ok: boolean;
  /** What the person reads. Plain language: never an internal state name. */
  readonly text: string;
}

export interface RenderOptions {
  readonly locale: string;
  /** Keep long reasons whole instead of trimming them to fit a terminal line. */
  readonly verbose?: boolean;
}

export interface ProviderReport {
  readonly name: string;
  readonly authenticated: boolean;
  readonly models: readonly string[];
}

export interface DoctorReport {
  readonly providers: readonly ProviderReport[];
}

/**
 * The longest line the owner's terminal will ever be asked to show. Anything wider wraps
 * under his cursor and turns a status list into a wall, so every line is trimmed to fit.
 */
const MAX_LINE_WIDTH = 120;

/** How `locale` is reduced to the two languages this CLI speaks, defaulting to English. */
type Language = 'es' | 'en';

const languageOf = (locale: string): Language => (locale.toLowerCase().startsWith('es') ? 'es' : 'en');

/**
 * Every internal state maps to a phrase a person can read. It is a `Record` keyed by the
 * closed union of states, so a new internal state cannot be added without also deciding how
 * to say it out loud — the compiler is what keeps the owner from ever reading jargon.
 */
interface StatusWords {
  readonly header: string;
  readonly empty: string;
  readonly startHint: string;
  readonly stageLabel: string;
  readonly state: Record<PieceState, string>;
  readonly guidance: Record<PieceState, string>;
}

const STATUS_WORDS: Record<Language, StatusWords> = {
  es: {
    header: 'Piezas',
    empty: 'Sin piezas.',
    startHint: 'Empieza con: run <pieza>',
    stageLabel: 'paso',
    state: {
      running: 'en curso',
      done: 'terminada',
      'blocked:rejected': 'revisión rechazada',
      'blocked:technical': 'fallo técnico',
      'waiting:decision': 'espera tu decisión',
      parked: 'en pausa',
    },
    guidance: {
      running: '',
      done: '',
      'blocked:rejected': 'Corrige lo que señala y vuelve a ejecutarla con run.',
      'blocked:technical': 'Revisa el fallo y vuelve a ejecutarla con run.',
      'waiting:decision': 'Necesita tu respuesta para continuar.',
      parked: 'Reanúdala cuando quieras continuar.',
    },
  },
  en: {
    header: 'Pieces',
    empty: 'No pieces.',
    startHint: 'Start with: run <piece>',
    stageLabel: 'step',
    state: {
      running: 'in progress',
      done: 'finished',
      'blocked:rejected': 'review rejected',
      'blocked:technical': 'technical failure',
      'waiting:decision': 'waiting for your decision',
      parked: 'on hold',
    },
    guidance: {
      running: '',
      done: '',
      'blocked:rejected': 'Fix what it points out and run it again with run.',
      'blocked:technical': 'Look into the failure and run it again with run.',
      'waiting:decision': 'It needs your answer to continue.',
      parked: 'Resume it whenever you want to continue.',
    },
  },
};

/**
 * Shortens a line to fit the terminal. Reasons are aggressive about wrapping the screen, so
 * a too-long line is cut at the edge rather than allowed to spill.
 */
function clampLine(line: string): string {
  if (line.length <= MAX_LINE_WIDTH) return line;
  return line.slice(0, MAX_LINE_WIDTH);
}

/** One human-readable line for one piece: its number, its step, its state, and its reason. */
function renderPieceLine(status: PieceStatus, words: StatusWords, verbose: boolean): string {
  const stagePart = status.stage === undefined ? '' : ` · ${words.stageLabel} "${status.stage}"`;
  const stateText = words.state[status.state];
  const guidance = words.guidance[status.state];
  const base = `- ${status.piece}${stagePart} · ${stateText}`;

  if (status.reason === undefined) {
    return clampLine(guidance.length === 0 ? base : `${base} — ${guidance}`);
  }

  const withReason = `${base}: ${status.reason}`;
  const tail = guidance.length === 0 ? '' : `. ${guidance}`;
  if (verbose) return withReason + tail;
  if (withReason.length + tail.length <= MAX_LINE_WIDTH) return withReason + tail;

  // The reason is short enough to survive whole, so the advice is what gets trimmed: what
  // happened matters more than the sentence telling him to act on it.
  if (withReason.length <= MAX_LINE_WIDTH) {
    return withReason + tail.slice(0, MAX_LINE_WIDTH - withReason.length);
  }

  // The reason itself is the overflow. Trim it, but never at the cost of the advice: an
  // error that says only what broke, with no way out, is the screen this CLI exists to avoid.
  const budget = MAX_LINE_WIDTH - base.length - 2 - tail.length - 1;
  if (budget <= 0) return clampLine(withReason + tail);
  return `${base}: ${status.reason.slice(0, budget)}…${tail}`;
}

/**
 * Renders the piece list. The seven states of the spec live here: empty, running, error,
 * no permission, one, many, and very long text. What the owner reads must never be an
 * internal state name — those are for the code, not for him.
 */
export function renderStatus(pieces: readonly PieceStatus[], options: RenderOptions): string {
  const words = STATUS_WORDS[languageOf(options.locale)];

  if (pieces.length === 0) {
    // An empty screen with no way out is a decision nobody made: always name the next move.
    return `${words.empty}\n${words.startHint}`;
  }

  const verbose = options.verbose === true;
  const lines = pieces.map((status) => renderPieceLine(status, words, verbose));
  return [words.header, ...lines].join('\n');
}

interface DoctorWords {
  readonly header: string;
  readonly none: string;
  readonly install: string;
  readonly authenticated: string;
  readonly notAuthenticated: string;
  /** Warns that a one-signed-in setup cannot do a cross-family review. */
  readonly crossWarning: (authenticated: readonly string[]) => string;
}

const DOCTOR_WORDS: Record<Language, DoctorWords> = {
  es: {
    header: 'Proveedores',
    none: 'No hay ningún proveedor instalado.',
    install: 'Instala y autentica dos proveedores de familias distintas para poder hacer revisión cruzada.',
    authenticated: 'autenticado',
    notAuthenticated: 'instalado, sin autenticar',
    crossWarning: (authenticated) =>
      authenticated.length === 0
        ? 'Para una revisión cruzada hacen falta dos proveedores de familias distintas; ahora mismo no hay ninguno autenticado.'
        : `Para una revisión cruzada hacen falta dos proveedores de familias distintas; solo hay uno autenticado (${authenticated.join(', ')}).`,
  },
  en: {
    header: 'Providers',
    none: 'No provider is installed.',
    install: 'Install and sign in to two providers from different families to be able to do a cross review.',
    authenticated: 'signed in',
    notAuthenticated: 'installed, not signed in',
    crossWarning: (authenticated) =>
      authenticated.length === 0
        ? 'A cross review needs two providers from different families; right now none is signed in.'
        : `A cross review needs two providers from different families; only one is signed in (${authenticated.join(', ')}).`,
  },
};

/** Renders what is installed and signed in, and what is missing to work. */
export function renderDoctor(report: DoctorReport, options: RenderOptions): string {
  const words = DOCTOR_WORDS[languageOf(options.locale)];

  if (report.providers.length === 0) {
    return `${words.none}\n${words.install}`;
  }

  const lines = [words.header];
  for (const provider of report.providers) {
    const state = provider.authenticated ? words.authenticated : words.notAuthenticated;
    // An empty model list is "no models", not the word `undefined`.
    const models = provider.models.length === 0 ? '' : ` (${provider.models.join(', ')})`;
    lines.push(`- ${provider.name}: ${state}${models}`);
  }

  const authenticated = report.providers.filter((provider) => provider.authenticated).map((provider) => provider.name);
  if (authenticated.length < 2) lines.push(words.crossWarning(authenticated));

  return lines.join('\n');
}

const HELP: Record<Language, string> = {
  es: [
    'Uso: ai-workflows <comando>',
    '',
    'Comandos:',
    '  run <pieza>            Ejecuta una pieza y cuenta qué pasó.',
    '  run <pieza> --dry-run  Ensaya sin cambiar nada.',
    '  status                 Muestra el estado de las piezas.',
    '  validate               Comprueba que la configuración es correcta.',
  ].join('\n'),
  en: [
    'Usage: ai-workflows <command>',
    '',
    'Commands:',
    '  run <piece>            Run a piece and report what happened.',
    '  run <piece> --dry-run  Rehearse without changing anything.',
    '  status                 Show the state of the pieces.',
    '  validate               Check that the configuration is correct.',
  ].join('\n'),
};

/** Builds the engine, reporting a config the engine refuses instead of throwing it out. */
function openEngine(
  config: PipelineConfig,
  store: Store,
  locale: string,
  describeChange: CommandOptions['describeChange'],
): CommandOutput | ReturnType<typeof createEngine> {
  try {
    // `exactOptionalPropertyTypes` forbids an explicit `undefined`, so the key is only present
    // when the project actually supplied a way to describe its changes.
    return createEngine({
      config,
      store,
      ...(describeChange === undefined ? {} : { describeChange }),
    });
  } catch (error) {
    if (error instanceof InvalidPipeline) {
      return { ok: false, text: invalidConfigText(error.errors, locale) };
    }
    throw error;
  }
}

const isOutput = (value: CommandOutput | ReturnType<typeof createEngine>): value is CommandOutput =>
  'ok' in value && 'text' in value;

function missingPieceText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'Falta la pieza. Uso: run <pieza>'
    : 'Missing the piece. Usage: run <piece>';
}

function invalidConfigText(errors: readonly string[], locale: string): string {
  const detail = errors.join('; ');
  return languageOf(locale) === 'es'
    ? `La configuración no es válida: ${detail}`
    : `The configuration is not valid: ${detail}`;
}

function busyText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'La pieza la está trabajando otro controlador. Inténtalo de nuevo más tarde.'
    : 'Another controller is working on this piece. Try again later.';
}

/** Reads a run's outcome through the same plain-language lens as `status`. */
function renderRunOutcome(outcome: RunOutcome, locale: string): CommandOutput {
  if (outcome.outcome === 'busy') return { ok: false, text: busyText(locale) };

  const text = renderStatus([outcome.status], { locale });
  if (outcome.outcome === 'parked') return { ok: false, text };
  return { ok: outcome.status.state === 'done', text };
}

/** Runs one command. Unknown or missing commands answer with the help, never in silence. */
export async function runCommand(argv: readonly string[], options: CommandOptions): Promise<CommandOutput> {
  const { config, store } = options;
  const locale = config.locale;
  const [command, ...args] = argv;

  switch (command) {
    case 'run': {
      const piece = args.find((arg) => !arg.startsWith('--'));
      if (piece === undefined || piece.length === 0) {
        return { ok: false, text: missingPieceText(locale) };
      }

      const engine = openEngine(config, store, locale, options.describeChange);
      if (isOutput(engine)) return engine;

      const dryRun = args.includes('--dry-run');
      const outcome = await engine.run(piece, dryRun ? { mode: 'dry-run' } : undefined);
      return renderRunOutcome(outcome, locale);
    }

    case 'status': {
      const engine = openEngine(config, store, locale, options.describeChange);
      if (isOutput(engine)) return engine;

      const piece = args[0];
      if (piece === undefined) {
        return { ok: true, text: renderStatus(await engine.list(), { locale }) };
      }
      const status = await engine.status(piece);
      if (status === undefined) {
        return {
          ok: true,
          text: languageOf(locale) === 'es' ? `La pieza ${piece} no está registrada.` : `Piece ${piece} is not registered.`,
        };
      }
      return { ok: true, text: renderStatus([status], { locale }) };
    }

    case 'validate': {
      const validation = validateConfig(config);
      if (validation.ok) {
        return {
          ok: true,
          text: languageOf(locale) === 'es' ? 'La configuración es válida.' : 'The configuration is valid.',
        };
      }
      return { ok: false, text: invalidConfigText(validation.errors, locale) };
    }

    default:
      return { ok: false, text: HELP[languageOf(locale)] };
  }
}
