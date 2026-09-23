// PLAN-13-R2 §11 (review round 1): every git command of the engine runs in the repository it
// was given, never the one a hook or a CI wrapper pointed at. Git reads a handful of variables
// from the environment — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and friends — and a hook
// that exports them silently redirects every later command of the engine. They are removed
// here; the one exception is the temporary index the engine sets on purpose, which the caller
// adds back through `extra`.

const GIT_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

/**
 * The environment for one git command: the process's own, minus every variable that redirects
 * which repository, tree or index git uses, plus whatever the engine set deliberately.
 */
export function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) continue;
    environment[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) environment[key] = value;
  }
  return environment;
}
