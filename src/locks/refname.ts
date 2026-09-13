// One rule for "is this a branch name git would accept", shared by every lock that has to name
// a branch. Kept in its own module so the editor-side ruleset check and the pre-push hook can
// never drift apart: both answer the same question and must give the same verdict.

/**
 * Whether git itself would accept `name` as a ref (`git check-ref-format`), so the locks and git
 * agree on which branches exist. Written as git's own rule, not as a closed whitelist: git
 * accepts `release+1`, `año` or `feat/ñandú` and `ma]in` (only the opening `[` is refused), and a
 * whitelist would reject those good settings. It refuses names like `ma..in` or `main.`, which
 * git would never turn into a real ref and which would therefore switch a lock off without a word.
 */
export function isValidBranchName(name: string): boolean {
  // An empty name, or the lone `@`, names no branch at all.
  if (name.length === 0 || name === '@') return false;

  // No `..` or `@{` anywhere: git parses both as revision syntax, not as part of a name. No `//`:
  // it leaves an empty segment. And no control character (U+0000-U+001F, U+007F), space or one of
  // `~ ^ : ? * [ \`: git either refuses each one or ends the name early. `]` is valid, so only the
  // opening bracket is banned.
  if (/\.\.|@\{|\/\/|[ \u0000-\u001f\u007f~^:?*\[\\]/.test(name)) return false;

  // A leading or trailing slash leaves an empty segment, and git refuses a trailing dot.
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;

  // Each slash-separated segment must stand on its own: git keeps `.`-prefixed refs and `.lock`
  // suffixes for its own files, so neither may name a branch.
  for (const segment of name.split('/')) {
    if (segment.startsWith('.') || segment.endsWith('.lock')) return false;
  }

  return true;
}

/**
 * The stricter rule for the one setting that names the default branch, used both by the rulesets
 * check and by the pre-push hook so the two can never disagree. It is `git check-ref-format
 * --branch` (through `isValidBranchName`) plus what git treats specially in that mode:
 *   - a name starting with `-` is read as an option, not as a branch;
 *   - `HEAD` is git's own special ref and can never name a branch that gets checked out;
 *   - `refs/...` and `origin/...` are not branch names. The hooks prefix `refs/heads/` themselves,
 *     so `refs/heads/main` would build `refs/heads/refs/heads/main` and never match, switching
 *     the lock off without a word.
 * Kept here, once, for exactly the reason this module exists: two copies drift, and a lock that
 * disagrees with its hook about the default branch is a lock that silently stops guarding it.
 */
export function isValidDefaultBranchSetting(name: string): boolean {
  if (!isValidBranchName(name)) return false;
  if (name.startsWith('-')) return false;
  if (name === 'HEAD') return false;
  if (name.startsWith('refs/') || name.startsWith('origin/')) return false;
  return true;
}
