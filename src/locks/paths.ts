// One canonical form for the paths a hook or git reports, so every lock compares the same thing.

import * as path from 'node:path';

/** Backslashes are just the Windows spelling of a separator, so the rules see one form. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** A POSIX path or a Windows drive path. `path.posix` alone would miss `C:/...`. */
export function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(value);
}

/**
 * Turns any reported path into one canonical form: separators unified, relative paths read
 * against `cwd`, and `..` resolved. This is what stops `docs/../src/a.ts` from posing as
 * `docs`.
 */
export function canonicalize(value: string, cwd: string): string {
  const forward = toPosix(value);
  const base = toPosix(cwd).replace(/\/+$/, '');
  const joined = isAbsoluteLike(forward) ? forward : `${base}/${forward}`;
  return path.posix.normalize(joined);
}

/**
 * Windows drive letters are case-insensitive; a lowercase `c:` and an uppercase `C:` are
 * the same folder. Only the drive letter is folded, so case-sensitive names below it keep
 * their meaning.
 */
export function foldDrive(value: string): string {
  return value.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

/** True when `child` is `parent` itself or lives inside it. Prefix alone is not enough. */
export function isUnder(child: string, parent: string): boolean {
  const c = foldDrive(child);
  const p = foldDrive(parent).replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
}
