// PLAN-13-R2 §11 (review round 1): every git command of the engine runs in the repository it
// was given, never the one a hook or a CI wrapper pointed at. Git reads variables from the
// environment (any name starting with `GIT_`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
// `GIT_OBJECT_DIRECTORY` and the rest) and a hook that exports one silently redirects every
// later command of the engine. Every `GIT_*` variable is therefore removed here; the one
// exception is the temporary index the engine sets on purpose, which the caller adds back
// through `extra`.
//
// PLAN-13-R4 §8 (review round 1): the agents' own credentials must never reach a child process.
// `AI_WORKFLOWS_APP_ID` and `AI_WORKFLOWS_APP_KEY_FILE` name the app that can publish as the
// agents, and `GH_TOKEN`/`GITHUB_TOKEN` are the installation token of a call; if a constructor,
// a reviewer, a command block or a git command inherited them, the piece could act as the app
// without going through the engine. They are stripped from every child environment built here.

/** The environment variables that carry the agents' credentials and must never be inherited. */
const SECRET_ENV: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AI_WORKFLOWS_APP_ID',
  'AI_WORKFLOWS_APP_KEY_FILE',
];
/** Windows does not tell the case of an environment name apart, so neither does this removal. */
const SECRET_ENV_UPPER = new Set(SECRET_ENV.map((name) => name.toUpperCase()));

function withoutSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(environment)) {
    if (SECRET_ENV_UPPER.has(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

/**
 * The environment for one git command: the process's own, minus every variable that redirects
 * which repository, tree or index git uses and minus the agents' credentials, plus whatever the
 * engine set deliberately.
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
  return withoutSecrets(environment);
}

/**
 * The environment of a child process the engine launches (a command block, a coding CLI, the
 * project's browser suite): the process's own without the agents' credentials, plus whatever the
 * caller sets deliberately. The `GIT_*` variables are left alone here, because a child may
 * legitimately have its own git setup; only the credentials are always removed.
 */
export function childEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) environment[key] = value;
  }
  return withoutSecrets(environment);
}
