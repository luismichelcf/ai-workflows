// ai-workflows — deterministic stage engine for coding agents.
//
// This barrel is the whole public surface. Everything else is implementation detail, kept
// behind it so the boundary lint of the integration slice has real boundaries to guard.

export * from './contract.js';
export { validateConfig, fingerprint } from './config.js';
export { createMemoryStore, type MemoryStoreOptions } from './state.js';
export { createEngine } from './engine.js';
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
export {
  parseHookInput,
  decideToolUse,
  renderHookOutput,
  handleHook,
  decidePreCommit,
  decidePrePush,
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
