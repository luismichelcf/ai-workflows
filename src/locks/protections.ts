// Server-side protections: do GitHub's rulesets really enforce what the pipeline relies on?

import { isRecord } from './shared.js';

export interface ProtectionRequirement {
  /** Status checks that must be required to merge into the default branch. */
  readonly requiredChecks: readonly string[];
  /** Require branches to be up to date before merging. */
  readonly requireUpToDate?: boolean;
  /** The repository's default branch as GitHub reports it, e.g. `main`. Never assumed. */
  readonly defaultBranch: string;
}

export interface ProtectionReport {
  readonly ok: boolean;
  /** What is missing or weaker than required, one sentence each. */
  readonly problems: readonly string[];
  /** What these protections cannot do even when everything is in place. */
  readonly limits: readonly string[];
}

/** One `required_status_checks` entry, reduced to what this check cares about. */
interface RequiredCheckEntry {
  readonly context: string;
  /** `undefined` means any app or workflow may report this context and satisfy it. */
  readonly integrationId: number | undefined;
}

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * Whether a string is a branch name git would accept (`git check-ref-format --branch`). An
 * unreadable default branch makes every ruleset verdict meaningless, so it is reported before
 * looking at any rule rather than guessed at.
 */
function isValidGitBranchName(name: string): boolean {
  if (name.length === 0) return false;
  // `--branch` rejects a leading dash, and a ref cannot contain a control character, a space
  // or any of `~^:?*[\]`.
  if (name.startsWith('-')) return false;
  if (/[\u0000-\u001f\u007f ~^:?*\[\]\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  if (name === '@') return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Escapes one character for the body of a JavaScript regular-expression character class. */
function escapeInClass(char: string): string {
  if (char === '\\' || char === ']' || char === '[' || char === '^') return `\\${char}`;
  return char;
}

/**
 * Reads one `[...]` set starting at `start`, returning its regex source and the index of its
 * closing `]`. Returns `undefined` when the set is never closed, which makes the whole pattern
 * unevaluable. A `[!...]` or `[^...]` complement also excludes `/`, because under
 * `FNM_PATHNAME` a set can never match a slash.
 */
function compileSet(pattern: string, start: number): { source: string; end: number } | undefined {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true;
    index += 1;
  }
  let body = '';
  let first = true;
  let closed = false;
  let canStartRange = false;
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    // A `]` right after `[` or `[!` is a literal member, as in Ruby's fnmatch.
    if (char === ']' && !first) {
      closed = true;
      break;
    }
    first = false;
    if (char === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return undefined;
      body += escapeInClass(escaped);
      canStartRange = true;
      index += 1;
      continue;
    }
    // A `-` between two characters is a range; anywhere else it is literal.
    if (char === '-' && canStartRange && pattern[index + 1] !== ']') {
      body += '-';
      canStartRange = false;
      continue;
    }
    body += escapeInClass(char);
    canStartRange = true;
  }
  if (!closed) return undefined;
  const source = negated ? `[^/${body}]` : `[${body}]`;
  return { source, end: index };
}

/**
 * Compiles a GitHub ref pattern into a regular expression, mirroring Ruby's `File.fnmatch`
 * with `File::FNM_PATHNAME` the way GitHub reads `ref_name`:
 *   - `*` matches zero or more characters other than `/`; `?` matches exactly one.
 *   - `[...]` is a set and `[!...]` or `[^...]` its complement; a set never matches `/`.
 *   - a double star followed by `/` crosses zero or more whole folders; a double star not
 *     followed by `/` is just a single star.
 *   - everything else is literal.
 * Returns `undefined` when the pattern cannot be read (for example an unclosed `[`), so the
 * caller can fail closed instead of guessing. Without this, a ruleset aimed only at
 * `refs/heads/release/*` would be read as covering `main`, and a "protected" verdict would be
 * false.
 */
function refPatternToRegExp(pattern: string): RegExp | undefined {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*';
          index += 2;
        } else {
          source += '[^/]*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const set = compileSet(pattern, index);
      if (!set) return undefined;
      source += set.source;
      index = set.end;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

type RefCoverage = 'covers' | 'does-not-cover' | 'unevaluable';

/**
 * Whether one `ref_name` entry covers the repository's default branch. GitHub spells the
 * default branch as `~DEFAULT_BRANCH`, every branch as `~ALL`, and also accepts a literal
 * `refs/heads/<name>` or a `refs/heads/...` pattern. Anything else (tags, foreign prefixes,
 * tokens this code does not know) does not cover it. A pattern that cannot be read is
 * reported as `unevaluable` so the caller can fail closed.
 */
function refEntryCoverage(entry: string, defaultBranch: string): RefCoverage {
  if (entry === '~DEFAULT_BRANCH' || entry === '~ALL') return 'covers';
  const defaultRef = `${BRANCH_REF_PREFIX}${defaultBranch}`;
  if (entry === defaultRef) return 'covers';
  if (!entry.startsWith(BRANCH_REF_PREFIX)) return 'does-not-cover';
  const pattern = refPatternToRegExp(entry);
  if (!pattern) return 'unevaluable';
  return pattern.test(defaultRef) ? 'covers' : 'does-not-cover';
}

/**
 * A branch ruleset only counts if GitHub is told to enforce it on the default branch. An
 * entry in `include` must cover the branch and no entry in `exclude` may cover it, because
 * GitHub lets an exclusion win over an inclusion. An unreadable pattern in `exclude` counts
 * as excluding (fail closed); in `include` it does not cover.
 */
function appliesToDefaultBranch(ruleset: Record<string, unknown>, defaultBranch: string): boolean {
  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined;
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined;
  if (!refName) return false;
  const include = Array.isArray(refName.include) ? refName.include : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude : [];
  const included = include.some(
    (entry) => typeof entry === 'string' && refEntryCoverage(entry, defaultBranch) === 'covers',
  );
  if (!included) return false;
  const excluded = exclude.some(
    (entry) => typeof entry === 'string' && refEntryCoverage(entry, defaultBranch) !== 'does-not-cover',
  );
  return !excluded;
}

/**
 * Reads GitHub's rulesets for the repository and says whether they actually enforce what
 * the pipeline relies on. Installing a check is worthless if nothing requires it.
 *
 * Several rulesets are combined: it is enough that between all of them they cover what the
 * pipeline needs. Only branch rulesets that GitHub is actively enforcing on the default
 * branch count — a disabled or evaluation-only ruleset blocks nothing.
 */
export function verifyProtections(
  rulesets: unknown,
  requirement: ProtectionRequirement,
): ProtectionReport {
  // The residual risk is always declared, even when the rules cannot be read: a green
  // report must never be read as more than it is.
  const limits: readonly string[] = [
    'Nada de esto puede impedir que un administrador del repositorio cambie o desactive las reglas: el sistema acepta ese riesgo y lo declara aquí.',
  ];

  // An unreadable default branch makes every verdict about "the default branch" meaningless,
  // so it is reported up front and no rule is evaluated against it.
  if (!isValidGitBranchName(requirement.defaultBranch)) {
    return {
      ok: false,
      problems: [
        `El nombre de la rama por defecto (defaultBranch) no es un nombre de rama válido de git: no se pueden evaluar las reglas.`,
      ],
      limits,
    };
  }

  // Input that is not a list of rulesets (for example an HTML error page) is an answer,
  // never an exception. The caller gets a report that says it could not read the rules.
  if (!Array.isArray(rulesets)) {
    return {
      ok: false,
      problems: [
        'No se pudieron leer las reglas del repositorio: GitHub no devolvió una lista de reglas.',
      ],
      limits,
    };
  }

  const problems: string[] = [];
  let hasActiveApplicable = false;
  let hasDeletion = false;
  let hasNonFastForward = false;
  let hasStrictPolicy = false;
  const checkEntries: RequiredCheckEntry[] = [];
  const bypassActorTypes: string[] = [];

  for (const rawRuleset of rulesets) {
    if (!isRecord(rawRuleset)) continue;
    // Only branch rulesets that are actively enforced on the default branch can block a
    // merge; `evaluate` and `disabled` rulesets are recorded but never relied upon.
    if (rawRuleset.target !== 'branch' || rawRuleset.enforcement !== 'active') continue;

    // The list endpoint returns a summary without `rules` or `conditions`. Treating it as a
    // real ruleset would invent a verdict for rules this code never saw, so it is reported
    // and the caller is told to fetch the detail of each ruleset instead.
    const hasRules = Object.prototype.hasOwnProperty.call(rawRuleset, 'rules');
    const hasConditions = Object.prototype.hasOwnProperty.call(rawRuleset, 'conditions');
    if (!hasRules && !hasConditions) {
      problems.push(
        'GitHub devolvió el resumen de una regla, sin sus condiciones ni sus reglas: hay que pedir el detalle de cada regla para saber si protege la rama por defecto.',
      );
      continue;
    }

    // Conditions this code cannot evaluate (repository_name, repository_id,
    // repository_property, ...) may aim the ruleset at other repositories, so it is not a
    // protection for this one and is left out rather than trusted.
    const conditions = isRecord(rawRuleset.conditions) ? rawRuleset.conditions : undefined;
    const unknownConditionKeys = conditions
      ? Object.keys(conditions).filter((key) => key !== 'ref_name')
      : [];
    if (unknownConditionKeys.length > 0) {
      problems.push(
        `Hay una regla con condiciones que no se pueden evaluar (${unknownConditionKeys.join(', ')}): puede estar dirigida a otros repositorios y no se cuenta como protección.`,
      );
      continue;
    }

    if (!appliesToDefaultBranch(rawRuleset, requirement.defaultBranch)) continue;
    hasActiveApplicable = true;

    // `bypass_actors` is only returned when the API caller has write access to the ruleset,
    // so a missing key means "not shown", not "nobody". Assuming nobody could bypass would
    // turn an unverifiable rule into a green report.
    if (!Object.prototype.hasOwnProperty.call(rawRuleset, 'bypass_actors')) {
      problems.push(
        'GitHub no mostró quién puede saltarse estas reglas (no vino la clave bypass_actors): no se puede verificar que nadie pueda saltárselas.',
      );
    } else if (!Array.isArray(rawRuleset.bypass_actors)) {
      // A non-list value (for example `null`) says nothing verifiable about who can bypass;
      // reading it as "nobody" would report an unverifiable rule as fine.
      problems.push(
        'GitHub devolvió un valor que no es una lista en bypass_actors: no se puede verificar quién puede saltarse estas reglas.',
      );
    } else {
      // Anyone in `bypass_actors` can merge without meeting the rules, so their mere
      // presence weakens the protection. Names are collected to say who.
      for (const rawActor of rawRuleset.bypass_actors) {
        if (!isRecord(rawActor) || typeof rawActor.actor_type !== 'string') {
          // An actor this code cannot identify may still be able to bypass, so it is not
          // silently dropped.
          problems.push(
            'Hay un actor de bypass sin un tipo (actor_type) legible: no se puede verificar quién puede saltarse estas reglas.',
          );
          continue;
        }
        bypassActorTypes.push(rawActor.actor_type);
      }
    }

    // `current_user_can_bypass` says whether the credentials used for this very check can
    // sidestep the rules. A missing key means it was not shown, which is not the same as
    // "never"; anything other than `never` weakens the protection.
    if (!Object.prototype.hasOwnProperty.call(rawRuleset, 'current_user_can_bypass')) {
      problems.push(
        'GitHub no dijo si quien está leyendo estas reglas puede saltárselas (no vino current_user_can_bypass): no se puede verificar.',
      );
    } else if (rawRuleset.current_user_can_bypass !== 'never') {
      problems.push(
        'Quien está leyendo estas reglas puede saltárselas (current_user_can_bypass no es "never").',
      );
    }

    const rules = Array.isArray(rawRuleset.rules) ? rawRuleset.rules : [];
    for (const rawRule of rules) {
      if (!isRecord(rawRule)) continue;
      if (rawRule.type === 'deletion') hasDeletion = true;
      if (rawRule.type === 'non_fast_forward') hasNonFastForward = true;
      if (rawRule.type !== 'required_status_checks') continue;

      const parameters = isRecord(rawRule.parameters) ? rawRule.parameters : undefined;
      if (!parameters) continue;
      if (parameters.strict_required_status_checks_policy === true) hasStrictPolicy = true;

      const checks = Array.isArray(parameters.required_status_checks)
        ? parameters.required_status_checks
        : [];
      for (const rawCheck of checks) {
        if (!isRecord(rawCheck) || typeof rawCheck.context !== 'string') continue;
        checkEntries.push({
          context: rawCheck.context,
          integrationId: typeof rawCheck.integration_id === 'number' ? rawCheck.integration_id : undefined,
        });
      }
    }
  }

  // 1. No ruleset is both enforced and aimed at the default branch, so nothing stops
  //    changes there and every rule below is effectively absent.
  if (!hasActiveApplicable) {
    problems.push(
      'No hay ninguna regla activa que aplique a la rama por defecto: hoy GitHub no bloquea cambios directos en ella.',
    );
  }

  const requiredContexts = new Set(checkEntries.map((entry) => entry.context));

  // 2. Every check the pipeline relies on must be demanded by some enforced ruleset.
  for (const check of requirement.requiredChecks) {
    if (!requiredContexts.has(check)) {
      problems.push(`El check "${check}" no está exigido para poder mergear a la rama por defecto.`);
    }
  }

  // 3. When the pipeline needs a branch that is up to date, the strict policy must be on.
  if (requirement.requireUpToDate && !hasStrictPolicy) {
    problems.push(
      'No se exige que la rama esté al día con la rama por defecto antes de mergear.',
    );
  }

  // 4. Without this rule, history on the default branch can be rewritten with a force push.
  if (!hasNonFastForward) {
    problems.push(
      'Se puede reescribir la historia de la rama por defecto con un force push: ninguna regla lo impide.',
    );
  }

  // 5. Without this rule, the default branch itself can be deleted.
  if (!hasDeletion) {
    problems.push('Se puede borrar la rama por defecto: ninguna regla lo impide.');
  }

  // 6. A bypass actor can merge without meeting the rules; the report names the kind.
  for (const actorType of bypassActorTypes) {
    problems.push(
      `Hay quien puede saltarse estas reglas sin cumplirlas: un actor de tipo "${actorType}".`,
    );
  }

  // 7. A required check without an integration id can be reported by any app or workflow,
  //    including one written to always pass. Reported once per distinct check name.
  const seenContexts = new Set<string>();
  for (const entry of checkEntries) {
    if (seenContexts.has(entry.context)) continue;
    seenContexts.add(entry.context);
    const anyWithoutIntegration = checkEntries.some(
      (other) => other.context === entry.context && other.integrationId === undefined,
    );
    if (anyWithoutIntegration) {
      problems.push(
        `El check "${entry.context}" no está atado a una aplicación concreta: cualquier app o workflow puede reportarlo y darlo por bueno.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, limits };
}
