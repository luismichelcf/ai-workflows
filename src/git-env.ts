// PLAN-13-R2 §11 (review round 1): every git command of the engine runs in the repository it
// was given, never the one a hook or a CI wrapper pointed at. Git reads variables from the
// environment (any name starting with `GIT_`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
// `GIT_OBJECT_DIRECTORY` and the rest) and a hook that exports one silently redirects every
// later command of the engine. Every `GIT_*` variable is therefore removed here; the one
// exception is the temporary index the engine sets on purpose, which the caller adds back
// through `extra`.

/**
 * The environment for one git command: the process's own, minus every variable that redirects
 * which repository, tree or index git uses, plus whatever the engine set deliberately.
 */
export function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) continue;
    environment[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) environment[key] = value;
  }
  return environment;
}
