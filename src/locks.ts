// The locks: what stops an agent or a person from getting around the process.
//
// Three layers with different reach, and each one says what it covers (spec D07):
//
//   1. Editor hooks (Claude Code and Codex share one format). Help, not a guarantee: the
//      agent's CLI runs them, a folder that is not trusted skips them, and they only see
//      the tools they are wired to.
//   2. Git hooks. Also help: `git commit --no-verify` skips them. They see what is staged,
//      which the editor hook cannot.
//   3. The server check. The only mandatory layer: GitHub refuses the merge without it, and
//      it recomputes what it can instead of reading a file from the branch.
//
// Everything here is pure — decisions, file contents, readings of API responses — so every
// lock can be tested without installing anything on a real machine.
//
// Each layer lives in its own module under ./locks/; this file is the surface the rest of the
// engine imports, so the split changes nothing for callers.

export * from './locks/editor.js';
export * from './locks/git.js';
export * from './locks/install.js';
export * from './locks/protections.js';
export * from './locks/signoff.js';
export type { CheckResult } from './gates.js';
