// ai-workflows — deterministic stage engine for coding agents.
//
// This barrel is the whole public surface. Everything else is implementation detail, kept
// behind it so the boundary lint of the integration slice has real boundaries to guard.

export * from './contract.js';
export { validateConfig, fingerprint } from './config.js';
export { createMemoryStore, type MemoryStoreOptions } from './state.js';
export { createGitStore, type StatePort, type StateRef, type GitStoreOptions } from './store-git.js';
export {
  createGitHubStatePort,
  DEFAULT_STATE_NAMESPACE,
  type GitHubStatePortOptions,
} from './store-github.js';
export {
  createGhRunner,
  DEFAULT_GH_TIMEOUT_MS,
  type GhRun,
  type GhRunner,
  type GhRunnerOptions,
  type GhExecutable,
} from './gh-runner.js';
export { createEngine } from './engine.js';
export {
  launchInGroup,
  checkQuarantine,
  DEFAULT_STDOUT_BYTES,
  DEFAULT_PROCESS_GROUPS,
  type GroupExit,
  type LaunchInGroupOptions,
  type ProcessGroup,
  type ProcessGroupControl,
  type Quarantine,
  type QuarantineCheck,
  type QuarantineSurvivor,
  type TerminateResult,
} from './process-group.js';
export {
  runCommand,
  renderStatus,
  renderDoctor,
  type CommandOptions,
  type CommandOutput,
  type RenderOptions,
  type ProviderReport,
  type DoctorReport,
} from './cli.js';
export {
  findSections,
  requireSections,
  countDistinctSources,
  requireSources,
  requireSameFiles,
  type CheckResult,
  type SourceRequirement,
} from './gates.js';
export {
  runGateCommand,
  parseTestRun,
  isGreenRun,
  isRedEvidence,
  type GateCommand,
  type TestRun,
  type TestRunSummary,
} from './commands.js';
export {
  sameExecution,
  requireDifferentBuilder,
  requireFreshVerdicts,
  type ExecutionIdentity,
  type Verdict,
  type IndependenceOptions,
  type FreshnessOptions,
} from './identity.js';
export {
  capabilities,
  buildInvocation,
  parseRun,
  decideRelay,
  detectProvider,
  type ProviderName,
  type RunRequest,
  type Invocation,
  type RunStatus,
  type RawRun,
  type RunReport,
  type Capabilities,
  type Assignment,
  type RelayState,
  type RelayDecision,
  type CommandRunner,
  type Detection,
} from './providers.js';
export { resolveExecutable, type ExecutableEnvironment, type ResolvedExecutable } from './exec.js';
export { recipeSchema } from './recipe/schema.js';
export { parseRecipe } from './recipe/parse.js';
export { checkRecipe } from './recipe/blocks.js';
export type { CheckRecipeResult } from './recipe/blocks.js';
export { engineBlockManifest } from './blocks/registry.js';
export type {
  BlockDefinition,
  EngineBlockDeps,
  ProviderRunner,
  ProviderRunOptions,
} from './blocks/definition.js';
export {
  compileRecipe,
  runProviderInGroup,
  type CompiledRecipe,
  type CompileRecipeDeps,
  type CompileLimits,
  type ProviderRunInGroupOptions,
} from './recipe/compile.js';
export { classifyFiles } from './recipe/glob.js';
export { effectiveKind, type EffectiveKind } from './recipe/kind.js';
export {
  describeChangeFromGit,
  type ChangeFacts,
  type ChangeBuilder,
  type ChangeDeclared,
  type DescribeChangeFromGitOptions,
} from './recipe/facts.js';
export { appliesIfFor } from './recipe/applies.js';
export { explainRecipe } from './recipe/explain.js';
export { recipeCommand } from './recipe/command.js';
export { DEFAULT_BANNED_TERMS, findBannedTerms } from './messages.js';
export type { Recipe, RecipeStage, RecipeCondition, RecipeError } from './recipe/types.js';
export type { BlockManifest, InputSpec, ValidWhile } from './blocks/manifest.js';
export {
  parseHookInput,
  decideToolUse,
  renderHookOutput,
  handleHook,
  decidePreCommit,
  decidePrePush,
  parseStagedPaths,
  parsePrePushStdin,
  STAGED_PATHS_GIT_ARGS,
  renderGitHook,
  buildHooksConfig,
  mergeHooksConfig,
  verifyProtections,
  parseSignOff,
  concludeMergeCheck,
  type HookInput,
  type LockContext,
  type LockDecision,
  type HookOutput,
  type PreCommitInput,
  type PrePushInput,
  type GitHookKind,
  type HookClient,
  type HookHandler,
  type HookGroup,
  type HooksFile,
  type ProtectionRequirement,
  type ProtectionReport,
  type PullRequestComment,
  type SignOffRules,
  type MergeCheckInput,
  type MergeCheckResult,
} from './locks.js';
