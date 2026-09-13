// Server-side protections: do GitHub's rulesets really enforce what the pipeline relies on?

import { isRecord } from './shared.js';

export interface ProtectionRequirement {
  /** Status checks that must be required to merge into the default branch. */
  readonly requiredChecks: readonly string[];
  /** Require branches to be up to date before merging. */
  readonly requireUpToDate?: boolean;
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

/** A branch ruleset only counts if GitHub is told to truly enforce it on the default branch. */
function appliesToDefaultBranch(ruleset: Record<string, unknown>): boolean {
  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined;
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined;
  const include = refName && Array.isArray(refName.include) ? refName.include : [];
  // GitHub spells the default branch as the `~DEFAULT_BRANCH` token; a literal
  // `refs/heads/main` is accepted too, because both mean the same branch.
  return include.some((entry) => entry === '~DEFAULT_BRANCH' || entry === 'refs/heads/main');
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
    if (!appliesToDefaultBranch(rawRuleset)) continue;
    hasActiveApplicable = true;

    // Anyone in `bypass_actors` can merge without meeting the rules, so their mere
    // presence weakens the protection. Names are collected to say who.
    const actors = Array.isArray(rawRuleset.bypass_actors) ? rawRuleset.bypass_actors : [];
    for (const rawActor of actors) {
      if (isRecord(rawActor) && typeof rawActor.actor_type === 'string') {
        bypassActorTypes.push(rawActor.actor_type);
      }
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

  const problems: string[] = [];

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
