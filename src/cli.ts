import {
  InvalidPipeline,
  type JournalEntry,
  type PieceState,
  type PieceStatus,
  type PipelineConfig,
  type StageConfig,
  type RunOutcome,
  type Store,
} from './contract.js';
import { validateConfig } from './config.js';
import { createEngine, InvalidCancellationPoll, InvalidLease, MIN_LEASE_MS } from './engine.js';

export interface CommandOptions {
  readonly config: PipelineConfig;
  readonly store: Store;
  /** How the project describes what a piece changes, handed to every gate as `change`. */
  readonly describeChange?: (piece: string) => unknown | Promise<unknown>;
  /**
   * How long the engine's hold on a piece lasts before another controller may take it. A store
   * over a remote pays for every renewal, so it needs minutes, not the default seconds.
   */
  readonly leaseMs?: number;
  /**
   * How often a running stage checks the store for a park recorded by another controller.
   * Injected so a project (or a test) can shorten it; it must be a whole number of milliseconds
   * in [1, 2_147_483_647] or the engine refuses it and the command reports why.
   */
  readonly cancellationPollMs?: number;
  /**
   * How the environment is inspected for `doctor`. Omitted means no diagnosis was configured,
   * and `doctor` fails closed rather than inventing a reassuring report.
   */
  readonly diagnose?: () => DoctorReport | Promise<DoctorReport>;
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
  readonly skippedLabel: string;
  readonly empty: string;
  readonly startHint: string;
  readonly stageLabel: string;
  readonly state: Record<PieceState, string>;
  readonly guidance: Record<PieceState, string>;
}

const STATUS_WORDS: Record<Language, StatusWords> = {
  es: {
    header: 'Piezas',
    skippedLabel: '  Pasos omitidos:',
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
    skippedLabel: '  Skipped steps:',
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

/** Show only the latest result for each stage, keeping its first journal position. */
function renderSkippedSteps(
  journal: readonly JournalEntry[],
  stages: readonly StageConfig[],
  options: RenderOptions,
): string {
  const latest = new Map<string, JournalEntry>();
  for (const entry of journal) latest.set(entry.stage, entry);

  const skipped = [...latest.values()].filter((entry) => entry.outcome === 'skipped');
  if (skipped.length === 0) return '';

  const words = STATUS_WORDS[languageOf(options.locale)];
  const lines = skipped.map((entry) => {
    const name = stages.find((stage) => stage.name === entry.stage)?.summary ?? entry.stage;
    const line = `  - ${name} — ${entry.reason ?? ''}`;
    return options.verbose ? line : clampLine(line);
  });
  return [words.skippedLabel, ...lines].join('\n');
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
    '  doctor                 Diagnostica los proveedores instalados.',
    '  stop <pieza> [motivo]  Pone en pausa una pieza conservando su diagnóstico.',
    '  pause                  Pone en pausa todas las piezas sin terminar.',
    '  resume [pieza]         Reanuda una pieza o todas las pausadas.',
  ].join('\n'),
  en: [
    'Usage: ai-workflows <command>',
    '',
    'Commands:',
    '  run <piece>            Run a piece and report what happened.',
    '  run <piece> --dry-run  Rehearse without changing anything.',
    '  status                 Show the state of the pieces.',
    '  validate               Check that the configuration is correct.',
    '  doctor                 Diagnose the installed providers.',
    '  stop <piece> [reason]  Put one piece on hold, keeping its diagnosis.',
    '  pause                  Put every unfinished piece on hold.',
    '  resume [piece]         Resume one piece, or every piece on hold.',
  ].join('\n'),
};

/** Builds the engine, reporting a config the engine refuses instead of throwing it out. */
function openEngine(
  config: PipelineConfig,
  store: Store,
  locale: string,
  describeChange: CommandOptions['describeChange'],
  leaseMs: CommandOptions['leaseMs'],
  cancellationPollMs: CommandOptions['cancellationPollMs'],
): CommandOutput | ReturnType<typeof createEngine> {
  // A finite lease below the floor is a units mistake a project script makes (seconds written
  // where milliseconds were meant), not something the engine can honour: a renewal on every
  // tick would commit over GitHub while the lease still lapses between ticks. Refuse it here,
  // before the engine is built and before any store call, so no reservation is ever written.
  // A value that is not a positive finite number is a different mistake and still reaches the
  // engine, which names it as an `InvalidLease`.
  if (leaseMs !== undefined && Number.isFinite(leaseMs) && leaseMs > 0 && leaseMs < MIN_LEASE_MS) {
    return { ok: false, text: leaseTooShortText(locale) };
  }

  try {
    // `exactOptionalPropertyTypes` forbids an explicit `undefined`, so each key is only present
    // when the project actually supplied a value. Over GitHub every renewal is a commit, so the
    // lease the project asks for must reach the engine untouched.
    return createEngine({
      config,
      store,
      ...(describeChange === undefined ? {} : { describeChange }),
      ...(leaseMs === undefined ? {} : { leaseMs }),
      ...(cancellationPollMs === undefined ? {} : { cancellationPollMs }),
    });
  } catch (error) {
    if (error instanceof InvalidPipeline) {
      return { ok: false, text: invalidConfigText(error.errors, locale) };
    }
    // A lease the engine refuses is the project's configuration mistake, like a bad pipeline:
    // it is an answer to the person, not a stack trace out of the process.
    if (error instanceof InvalidLease) {
      return { ok: false, text: invalidLeaseText(locale) };
    }
    // A cancellation cadence Node timers cannot represent is the same kind of mistake.
    if (error instanceof InvalidCancellationPoll) {
      return { ok: false, text: invalidCancellationPollText(locale) };
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

function invalidLeaseText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'La duración del lease no es válida: debe ser un número finito de milisegundos mayor que cero.'
    : 'The lease duration is not valid: it must be a finite number of milliseconds greater than zero.';
}

function leaseTooShortText(locale: string): string {
  const seconds = MIN_LEASE_MS / 1000;
  return languageOf(locale) === 'es'
    ? `La duración del lease es demasiado corta: el mínimo es ${seconds} segundos.`
    : `The lease duration is too short: the minimum is ${seconds} seconds.`;
}

function invalidCancellationPollText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'La cadencia de cancelación no es válida: debe ser un número entero de milisegundos entre 1 y 2147483647.'
    : 'The cancellation cadence is not valid: it must be a whole number of milliseconds between 1 and 2147483647.';
}

function busyText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'La pieza la está trabajando otro controlador. Inténtalo de nuevo más tarde.'
    : 'Another controller is working on this piece. Try again later.';
}

function missingDiagnosisText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'No hay ningún diagnóstico configurado: falta la función diagnose en las opciones.'
    : 'No diagnosis is configured: the diagnose function is missing from the options.';
}

/** Renders any thrown value as text a person can read. Never `[object Object]`, never blank. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
  }
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json !== '{}') return json;
    } catch {
      // A value JSON cannot represent (bigint, circular): fall through to String below.
    }
  }
  return String(error);
}

/** A diagnosis that threw. The reason is carried through; it is never disguised as a report. */
function failedDiagnosisText(detail: string, locale: string): string {
  return languageOf(locale) === 'es'
    ? `El diagnóstico falló: ${detail}`
    : `The diagnosis failed: ${detail}`;
}

function unknownPieceText(piece: string, locale: string): string {
  return languageOf(locale) === 'es'
    ? `La pieza ${piece} no está registrada: no se detuvo nada.`
    : `Piece ${piece} is not registered: nothing was stopped.`;
}

function defaultStopReason(locale: string): string {
  return languageOf(locale) === 'es' ? 'Detenida a petición del dueño' : "Stopped at the owner's request";
}

function pauseReason(locale: string): string {
  return languageOf(locale) === 'es' ? 'En pausa' : 'On hold';
}

/**
 * What `stop` prints. The store is the channel another controller watches, so this command
 * only ever records the request: it must not claim the piece is already stopped, because a
 * gate in flight elsewhere is still running until it sees the park.
 */
function stopRequestText(piece: string, reason: string, locale: string): string {
  return languageOf(locale) === 'es'
    ? `Solicitud de parada registrada para la pieza ${piece}: ${reason}.`
    : `Stop request recorded for piece ${piece}: ${reason}.`;
}

/**
 * What `resume` prints for an argument it cannot accept. Nothing has been read from the store at
 * this point, so no hold can have been lifted: refusing here is what stops `resume --help` from
 * being silently read as a bulk resume.
 */
function invalidResumeArgumentText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'Argumento no válido para resume. Uso: resume [pieza]'
    : 'Invalid argument for resume. Usage: resume [piece]';
}

/** What `pause` prints for any operand: the command takes none, so nothing is touched. */
function invalidPauseArgumentText(locale: string): string {
  return languageOf(locale) === 'es'
    ? 'Argumento no válido para pause. Uso: pause'
    : 'Invalid argument for pause. Usage: pause';
}

/**
 * What `stop` prints when the park could not be stored. The request was not recorded, so it is
 * not reported as recorded; the piece is named and the reason is kept.
 */
function failedStopText(piece: string, detail: string, locale: string): string {
  return languageOf(locale) === 'es'
    ? `No se pudo registrar la parada de la pieza ${piece}: ${detail}`
    : `Could not record the stop of piece ${piece}: ${detail}`;
}

/**
 * A bulk `pause` that stopped partway. It accounts for the pieces this invocation actually
 * paused, names the one that failed and its reason, and says nothing about untouched later
 * pieces. Only the `engine.stop` call is guarded by the caller, so an error from anywhere else
 * still surfaces as itself.
 */
function partialPauseText(
  paused: readonly string[],
  failed: string,
  detail: string,
  locale: string,
): string {
  if (languageOf(locale) === 'es') {
    const done = paused.length === 0 ? 'Ninguna pieza quedó en pausa' : `Ya en pausa: ${paused.join(', ')}`;
    return `No se pudieron pausar todas las piezas. ${done}. No se pudo pausar ${failed}: ${detail}.`;
  }
  const done = paused.length === 0 ? 'No piece was paused' : `Already paused: ${paused.join(', ')}`;
  return `Could not pause every piece. ${done}. Could not pause ${failed}: ${detail}.`;
}

/**
 * A bulk `pause` whose pauses landed but whose final status read failed. The pieces this
 * invocation paused are named; the pieces that were not read are not described at all, and the
 * read failure keeps its own reason instead of being lost with the progress.
 */
function pauseReadFailureText(paused: readonly string[], detail: string, locale: string): string {
  if (languageOf(locale) === 'es') {
    const done = paused.length === 0 ? 'Ninguna pieza quedó en pausa' : `Ya en pausa: ${paused.join(', ')}`;
    return `No se pudo leer el estado tras la pausa. ${done}. Motivo: ${detail}.`;
  }
  const done = paused.length === 0 ? 'No piece was paused' : `Already paused: ${paused.join(', ')}`;
  return `Could not read the status after pausing. ${done}. Reason: ${detail}.`;
}

/**
 * A bulk `resume` whose resumes landed but whose final status read failed. The pieces this
 * invocation resumed are named; pieces that were not read are not described, and the read
 * failure keeps its own reason.
 */
function resumeReadFailureText(resumed: readonly string[], detail: string, locale: string): string {
  if (languageOf(locale) === 'es') {
    const done =
      resumed.length === 0 ? 'Ninguna pieza quedó reanudada' : `Ya reanudadas: ${resumed.join(', ')}`;
    return `No se pudo leer el estado tras reanudar. ${done}. Motivo: ${detail}.`;
  }
  const done = resumed.length === 0 ? 'No piece was resumed' : `Already resumed: ${resumed.join(', ')}`;
  return `Could not read the status after resuming. ${done}. Reason: ${detail}.`;
}

/**
 * A named `resume` that failed — a lost race against a newer hold, or a store that could not
 * answer. It shares the vocabulary of a partial bulk resume but claims nothing about other
 * pieces: only the one asked for is in play.
 */
function failedResumeText(piece: string, detail: string, locale: string): string {
  return languageOf(locale) === 'es'
    ? `No se pudo reanudar la pieza ${piece}: ${detail}`
    : `Could not resume piece ${piece}: ${detail}`;
}

/**
 * A named `resume` whose resume call returned but whose final listing could not be read. The
 * status the engine actually returned is shown unchanged — a piece that was already `done` is
 * never claimed as resumed — alongside the reason the listing could not be read.
 */
function resumeUnreadText(status: PieceStatus, detail: string, locale: string): string {
  const rendered = renderStatus([status], { locale });
  return languageOf(locale) === 'es'
    ? `No se pudo leer el listado tras reanudar. Estado conocido:\n${rendered}\nMotivo: ${detail}.`
    : `Could not read the listing after resuming. Known state:\n${rendered}\nReason: ${detail}.`;
}

/**
 * A bulk `resume` that stopped partway. It accounts for the pieces that were actually resumed,
 * names the one that failed and its reason, and says nothing about the untouched later pieces:
 * claiming those succeeded would be the same false green the whole CLI exists to avoid.
 */
function partialResumeText(
  resumed: readonly string[],
  failed: string,
  detail: string,
  locale: string,
): string {
  if (languageOf(locale) === 'es') {
    const done =
      resumed.length === 0 ? 'Ninguna pieza quedó reanudada' : `Ya reanudadas: ${resumed.join(', ')}`;
    return `No se pudieron reanudar todas las piezas. ${done}. No se pudo reanudar ${failed}: ${detail}.`;
  }
  const done = resumed.length === 0 ? 'No piece was resumed' : `Already resumed: ${resumed.join(', ')}`;
  return `Could not resume every piece. ${done}. Could not resume ${failed}: ${detail}.`;
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

      const engine = openEngine(
        config,
        store,
        locale,
        options.describeChange,
        options.leaseMs,
        options.cancellationPollMs,
      );
      if (isOutput(engine)) return engine;

      const dryRun = args.includes('--dry-run');
      const outcome = await engine.run(piece, dryRun ? { mode: 'dry-run' } : undefined);
      return renderRunOutcome(outcome, locale);
    }

    case 'status': {
      const engine = openEngine(
        config,
        store,
        locale,
        options.describeChange,
        options.leaseMs,
        options.cancellationPollMs,
      );
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
      const verbose = args.includes('--verbose');
      const detail = renderSkippedSteps(
        await store.journal(piece),
        config.stages,
        { locale, verbose },
      );
      const text = renderStatus([status], { locale, verbose });
      return { ok: true, text: detail.length > 0 ? `${text}\n${detail}` : text };
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

    case 'doctor': {
      // Without a diagnosis there is nothing to report. A reassuring empty screen would be a
      // claim this command cannot back, so it fails closed and says what is missing.
      if (options.diagnose === undefined) {
        return { ok: false, text: missingDiagnosisText(locale) };
      }
      // A diagnosis is external input and may throw: a bad credential, a missing binary. That
      // is a failed diagnosis with a reason, not something to let escape the command as a stack
      // trace, and not a green report. The reason is kept and named.
      let report: DoctorReport;
      try {
        report = await options.diagnose();
      } catch (error) {
        return { ok: false, text: failedDiagnosisText(describeFailure(error), locale) };
      }
      return { ok: true, text: renderDoctor(report, { locale }) };
    }

    case 'stop': {
      const piece = args[0];
      if (piece === undefined || piece.length === 0) {
        return { ok: false, text: missingPieceText(locale) };
      }

      const engine = openEngine(
        config,
        store,
        locale,
        options.describeChange,
        options.leaseMs,
        options.cancellationPollMs,
      );
      if (isOutput(engine)) return engine;

      // Parking a piece the store has never seen would invent a phantom that `list` hides and
      // `status` shows. The engine stores nothing for it, so the CLI must not claim otherwise.
      // If the read that establishes the piece fails, nothing was recorded; the piece is named
      // with the read's reason and no «request recorded» text is printed.
      let registered: boolean;
      try {
        registered = (await engine.status(piece)) !== undefined;
      } catch (error) {
        return { ok: false, text: failedStopText(piece, describeFailure(error), locale) };
      }
      if (!registered) {
        return { ok: false, text: unknownPieceText(piece, locale) };
      }

      const reason = args.slice(1).join(' ').trim();
      const parkedReason = reason.length > 0 ? reason : defaultStopReason(locale);
      // Only a store that accepted the park gets the «request recorded» text. A failure here is
      // the store's, not a successful brake, so it is reported with its reason.
      try {
        await engine.stop(piece, parkedReason);
      } catch (error) {
        return { ok: false, text: failedStopText(piece, describeFailure(error), locale) };
      }
      return { ok: true, text: stopRequestText(piece, parkedReason, locale) };
    }

    case 'pause': {
      // `pause` takes no operands. Refused before the engine is built, so an operand can never
      // be read as a bulk pause and park pieces the caller did not name.
      if (args.length > 0) {
        return { ok: false, text: invalidPauseArgumentText(locale) };
      }

      const engine = openEngine(
        config,
        store,
        locale,
        options.describeChange,
        options.leaseMs,
        options.cancellationPollMs,
      );
      if (isOutput(engine)) return engine;

      // The snapshot only decides what to ask for. Each `stop` re-checks eligibility against its
      // own fresh read, so a piece that finished after this list was read is not parked.
      let unfinished: readonly PieceStatus[];
      try {
        unfinished = (await engine.list()).filter(
          (status) => status.state !== 'done' && status.state !== 'parked',
        );
      } catch (error) {
        // Nothing was paused: the snapshot never arrived. The report says exactly that, with the
        // read failure's reason, rather than failing silently or naming pieces it never saw.
        return { ok: false, text: pauseReadFailureText([], describeFailure(error), locale) };
      }
      const paused: string[] = [];
      for (const status of unfinished) {
        try {
          const parked = await engine.stop(status.piece, pauseReason(locale), {
            onlyWhenUnfinished: true,
          });
          // An eligible piece becomes `parked`; one excluded by a fresh read comes back as it
          // already was, and is not claimed as paused by this invocation.
          if (parked.state === 'parked') paused.push(status.piece);
        } catch (error) {
          // A store or network failure is an ordinary Error at this boundary. The pieces already
          // paused stay paused, and the failure is reported with its reason rather than thrown.
          return {
            ok: false,
            text: partialPauseText(paused, status.piece, describeFailure(error), locale),
          };
        }
      }
      // The pauses have landed; this read only reports them. If it fails, the progress is not
      // thrown away — the pieces paused are named, with the read failure as the reason — and no
      // piece that was never read is described.
      try {
        return { ok: true, text: renderStatus(await engine.list(), { locale }) };
      } catch (error) {
        return { ok: false, text: pauseReadFailureText(paused, describeFailure(error), locale) };
      }
    }

    case 'resume': {
      // Parsed before any read, so a flag can never fall through to bulk resume and lift every
      // hold. `resume` with no arguments resumes every parked piece; `resume <piece>` names
      // exactly one non-empty piece and no flags; anything else is refused here.
      const piece = args.length === 1 ? args[0] : undefined;
      const named = piece !== undefined && piece.length > 0 && !piece.startsWith('-');
      if (args.length > 1 || (args.length === 1 && !named)) {
        return { ok: false, text: invalidResumeArgumentText(locale) };
      }

      const engine = openEngine(
        config,
        store,
        locale,
        options.describeChange,
        options.leaseMs,
        options.cancellationPollMs,
      );
      if (isOutput(engine)) return engine;

      if (piece !== undefined) {
        // The initial read establishes whether the piece exists. If it cannot answer, nothing
        // was resumed: the piece is named with the read's reason instead of throwing out.
        let registered: boolean;
        try {
          registered = (await engine.status(piece)) !== undefined;
        } catch (error) {
          return { ok: false, text: failedResumeText(piece, describeFailure(error), locale) };
        }
        if (!registered) {
          return {
            ok: false,
            text:
              languageOf(locale) === 'es'
                ? `La pieza ${piece} no está registrada: no se reanudó nada.`
                : `Piece ${piece} is not registered: nothing was resumed.`,
          };
        }
        // Restoring the prior state is the transition; whether that prior state was a
        // rejection does not make the restore itself a failure. Any failed restore — a lost
        // race or a store that cannot answer — is reported with its reason, and nothing is
        // retried over a newer hold or undone.
        let restored: PieceStatus;
        try {
          restored = await engine.resume(piece);
        } catch (error) {
          return { ok: false, text: failedResumeText(piece, describeFailure(error), locale) };
        }
        // The resume call returned; this read only reports the wider listing. If it fails, the
        // status the engine actually returned is shown as-is — a piece already `done` is not
        // claimed as resumed — with the read failure as the reason.
        try {
          return { ok: true, text: renderStatus(await engine.list(), { locale }) };
        } catch (error) {
          return {
            ok: false,
            text: resumeUnreadText(restored, describeFailure(error), locale),
          };
        }
      }

      // No name: resume every parked piece, without running any gate.
      let parked: readonly PieceStatus[];
      try {
        parked = (await engine.list()).filter((status) => status.state === 'parked');
      } catch (error) {
        // The snapshot never arrived, so nothing was resumed. The report says so, with the read
        // failure's reason, and names no piece it never saw.
        return { ok: false, text: resumeReadFailureText([], describeFailure(error), locale) };
      }
      const resumed: string[] = [];
      for (const status of parked) {
        try {
          await engine.resume(status.piece);
          resumed.push(status.piece);
        } catch (error) {
          // The command boundary catches every failure, whether a lost race or a store that
          // cannot answer: it is not retried over the newer hold and nothing is undone. The
          // pieces already resumed stay resumed, and the report names them, the failed piece
          // and the reason.
          return {
            ok: false,
            text: partialResumeText(resumed, status.piece, describeFailure(error), locale),
          };
        }
      }
      // The resumes have landed; this read only reports them. If it fails, the progress is not
      // thrown away — the pieces resumed are named, with the read failure as the reason — and no
      // piece that was never read is described.
      try {
        return { ok: true, text: renderStatus(await engine.list(), { locale }) };
      } catch (error) {
        return { ok: false, text: resumeReadFailureText(resumed, describeFailure(error), locale) };
      }
    }

    default:
      return { ok: false, text: HELP[languageOf(locale)] };
  }
}
