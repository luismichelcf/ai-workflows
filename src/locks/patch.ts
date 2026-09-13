// Reading the paths a Codex `apply_patch` payload touches.

/** Every path a Codex `apply_patch` payload touches, including a rename's destination. */
export function pathsFromApplyPatch(command: unknown): string[] | undefined {
  if (typeof command !== 'string') {
    // Not readable: the caller refuses rather than guessing at a changed format.
    return undefined;
  }

  const paths: string[] = [];
  const fileLine = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  const moveLine = /^\*\*\* Move to: (.+)$/gm;
  for (const match of command.matchAll(fileLine)) if (match[1]) paths.push(match[1].trim());
  for (const match of command.matchAll(moveLine)) if (match[1]) paths.push(match[1].trim());
  return paths;
}
