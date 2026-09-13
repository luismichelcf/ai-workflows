// Server-side protections: do GitHub's rulesets really enforce what the pipeline relies on?

import { isValidDefaultBranchSetting } from './refname.js';
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

/** Escapes one character so it is literal inside a JavaScript regular-expression set. */
function escapeInSet(char: string): string {
  // `\`, `]`, `^` and `-` carry meaning inside a set; escaping the dash keeps it literal even
  // where a range would otherwise be read.
  if (char === '\\' || char === ']' || char === '^' || char === '-') return `\\${char}`;
  return char;
}

/** The source of a set with no members: `[]` matches nothing, `[!]` any character but `/`. */
function emptySetSource(negated: boolean): string {
  return negated ? '[^/]' : '(?!)';
}

/**
 * Reads one `[...]` set starting at `start` and turns it into regex source and the index of its
 * closing `]`. Follows Ruby's `File.fnmatch` under `FNM_PATHNAME`:
 *   - a set never matches `/`, so every set is guarded against consuming a slash, even `[/]` or
 *     a range such as `[+-0]` that spans it;
 *   - `[!...]` and `[^...]` are the complement, also barred from `/`;
 *   - `\x` inside a set is the literal `x`, so `[a\-z]` is `a`, `-` or `z` and never a range;
 *   - `]` right after `[`, `[!` or `[^` closes an empty set: `[]` matches nothing and `[!]`
 *     matches any character other than `/`;
 *   - a reversed range such as `[z-a]` still matches its two ends `z` and `a` (Ruby tests
 *     each bound before comparing the order), so both become members;
 *   - a set that is never closed is unreadable, and the caller gets `undefined`.
 */
function compileSet(pattern: string, start: number): { source: string; end: number } | undefined {
  let index = start + 1;
  let negated = false;
  const marker = pattern[index];
  if (marker === '!' || marker === '^') {
    negated = true;
    index += 1;
  }

  // `]` closing the set with no members is Ruby's empty set, not a literal bracket as in POSIX.
  if (pattern[index] === ']') return { source: emptySetSource(negated), end: index };

  let body = '';
  let hasMember = false;
  let closed = false;

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === ']') {
      closed = true;
      break;
    }

    // Read one member, honoring `\x` as the literal `x`.
    let member: string;
    if (char === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return undefined;
      member = escaped;
      index += 2;
    } else {
      member = char;
      index += 1;
    }

    // A `-` after this member that is not the closing `]` opens a range. An escaped `-` was read
    // as the member above, so it never reaches here and stays literal.
    const dash = pattern[index];
    const afterDash = pattern[index + 1];
    if (dash === '-' && afterDash !== undefined && afterDash !== ']') {
      let to: string;
      if (afterDash === '\\') {
        const escaped = pattern[index + 2];
        if (escaped === undefined) return undefined;
        to = escaped;
        index += 3;
      } else {
        to = afterDash;
        index += 2;
      }
      // Ruby matches the two ends of a reversed range before it ever compares the order
      // (its `dir.c` tests each bound first), so `[m-a]` matches both `m` and `a`. Dropping
      // the range would report "protected" for a branch GitHub really does not protect.
      if (member.charCodeAt(0) <= to.charCodeAt(0)) {
        body += `${escapeInSet(member)}-${escapeInSet(to)}`;
      } else {
        body += escapeInSet(member) + escapeInSet(to);
      }
      hasMember = true;
      continue;
    }

    body += escapeInSet(member);
    hasMember = true;
  }

  if (!closed) return undefined;
  if (!hasMember) return { source: emptySetSource(negated), end: index };
  // The lookahead keeps a positive set from ever consuming `/`, which Ruby's `FNM_PATHNAME`
  // forbids even when the set spells the slash out or a range spans it.
  const source = negated ? `[^/${body}]` : `(?:(?!/)[${body}])`;
  return { source, end: index };
}

/**
 * Compiles a GitHub ref pattern into a regular expression, mirroring Ruby's `File.fnmatch`
 * with `File::FNM_PATHNAME` the way GitHub reads `ref_name`:
 *   - `*` matches zero or more characters other than `/`; `?` matches exactly one.
 *   - `[...]` is a set and `[!...]` or `[^...]` its complement; a set never matches `/`.
 *   - a double star followed by a slash crosses zero or more whole folders, but only where a
 *     segment can start: at the beginning of the pattern or right after a slash. Anywhere else
 *     (as in `rel` followed by stars, or four stars) it is just a single star.
 *   - `\x` outside a set is the literal `x`; everything else is literal.
 * Returns `undefined` when the pattern cannot be read (for example an unclosed `[` or a regular
 * expression the source could not build), so the caller can fail closed instead of guessing.
 * Without this, a ruleset aimed only at `refs/heads/release/*` would be read as covering `main`,
 * and a "protected" verdict would be false.
 */
function refPatternToRegExp(pattern: string): RegExp | undefined {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '\\') {
      // Outside a set a backslash escapes the next character, so `\m` is the literal `m`.
      const escaped = pattern[index + 1];
      if (escaped === undefined) return undefined;
      source += escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      index += 1;
    } else if (char === '*') {
      const atSegmentStart = index === 0 || pattern[index - 1] === '/';
      if (atSegmentStart && pattern[index + 1] === '*' && pattern[index + 2] === '/') {
        source += '(?:[^/]*/)*';
        index += 2;
      } else {
        source += '[^/]*';
        if (pattern[index + 1] === '*') index += 1;
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
  // Building the source never throws: a pattern whose regular expression cannot be built is an
  // unreadable pattern, not a crash in the middle of a verdict.
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return undefined;
  }
}

type RefCoverage = 'covers' | 'does-not-cover' | 'unevaluable';

/** One entry's verdict, with its text when it was a pattern that could not be read. */
interface RefEntryCoverage {
  readonly coverage: RefCoverage;
  readonly unreadable: string | undefined;
}

/** Whether a ruleset applies to the default branch, and any patterns it could not read. */
interface BranchCoverage {
  readonly applies: boolean;
  readonly unreadable: readonly string[];
}

/**
 * Whether one `ref_name` entry covers the repository's default branch. GitHub spells the
 * default branch as `~DEFAULT_BRANCH`, every branch as `~ALL`, and also accepts a literal
 * `refs/heads/<name>` or a `refs/heads/...` pattern. Anything else (tags, foreign prefixes,
 * tokens this code does not know) does not cover it. A pattern that cannot be read is
 * reported as `unevaluable` so the caller can fail closed.
 */
function refEntryCoverage(entry: string, defaultBranch: string): RefEntryCoverage {
  if (entry === '~DEFAULT_BRANCH' || entry === '~ALL') return { coverage: 'covers', unreadable: undefined };
  const defaultRef = `${BRANCH_REF_PREFIX}${defaultBranch}`;
  if (entry === defaultRef) return { coverage: 'covers', unreadable: undefined };
  if (!entry.startsWith(BRANCH_REF_PREFIX)) return { coverage: 'does-not-cover', unreadable: undefined };
  const pattern = refPatternToRegExp(entry);
  if (!pattern) return { coverage: 'unevaluable', unreadable: entry };
  return { coverage: pattern.test(defaultRef) ? 'covers' : 'does-not-cover', unreadable: undefined };
}

/**
 * A branch ruleset only counts if GitHub is told to enforce it on the default branch. An
 * entry in `include` must cover the branch and no entry in `exclude` may cover it, because
 * GitHub lets an exclusion win over an inclusion. An unreadable pattern in `exclude` counts
 * as excluding (fail closed); in `include` it does not cover. A pattern is returned for the
 * report only when it could have changed the answer: an unreadable include when nothing else
 * covers the branch, and an unreadable exclude always. Reporting one that decided nothing would
 * turn a green report red for no reason, and the caller could not act on it.
 */
function appliesToDefaultBranch(ruleset: Record<string, unknown>, defaultBranch: string): BranchCoverage {
  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined;
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined;
  if (!refName) return { applies: false, unreadable: [] };
  const include = Array.isArray(refName.include) ? refName.include : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude : [];
  const unreadableInclude: string[] = [];
  const unreadableExclude: string[] = [];

  let included = false;
  for (const entry of include) {
    if (typeof entry !== 'string') continue;
    const reading = refEntryCoverage(entry, defaultBranch);
    if (reading.unreadable !== undefined) unreadableInclude.push(reading.unreadable);
    if (reading.coverage === 'covers') included = true;
  }

  let excluded = false;
  for (const entry of exclude) {
    if (typeof entry !== 'string') continue;
    const reading = refEntryCoverage(entry, defaultBranch);
    if (reading.unreadable !== undefined) unreadableExclude.push(reading.unreadable);
    // Only a pattern known not to cover leaves the branch in; "covers" and "unevaluable" both
    // exclude, because an unreadable exclusion must fail closed.
    if (reading.coverage !== 'does-not-cover') excluded = true;
  }

  // An unreadable include only matters when no other entry already covered the branch; when one
  // did, the unreadable pattern cannot change the verdict. An unreadable exclude always matters,
  // because it is treated as excluding and so always could change it.
  const unreadable = included ? unreadableExclude : [...unreadableInclude, ...unreadableExclude];

  return { applies: included && !excluded, unreadable };
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
  if (!isValidDefaultBranchSetting(requirement.defaultBranch)) {
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

    const branch = appliesToDefaultBranch(rawRuleset, requirement.defaultBranch);
    // A pattern nobody can read is named so a person can fix it, instead of the rule silently
    // failing to count with no clue why.
    for (const pattern of branch.unreadable) {
      problems.push(
        `Hay un patrón de ref_name que no se pudo leer (${pattern}): puede cubrir o excluir la rama por defecto y no se cuenta como protección.`,
      );
    }
    if (!branch.applies) continue;
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
