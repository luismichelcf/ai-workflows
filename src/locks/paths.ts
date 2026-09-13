// One canonical form for the paths a hook or git reports, so every lock compares the same thing.
//
// Windows reaches the same folder through many spellings of its path: another capitalisation, an
// extended-length prefix (\\?\C:\ or \\.\C:\), a loopback share (\\localhost\c$\ or
// \\127.0.0.1\C$\), an 8.3 short name (SOCIAL~1) or an NTFS stream. The lock must recognise every
// spelling of the folder it guards, and refuse the ones it cannot reduce instead of guessing.
// On POSIX a path already has one spelling and the case of a name is part of it.

import * as path from 'node:path';

/** Backslashes are just the Windows spelling of a separator, so the rules see one form. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * A path in one canonical spelling plus the key used to compare it. Windows folds the case of
 * the whole path; POSIX keeps it, because `Docs` and `docs` are two different folders there.
 */
export interface CanonicalPath {
  /** Canonical spelling, for the messages a person reads. */
  readonly display: string;
  /** Comparison key: case-folded on Windows, exact on POSIX. */
  readonly key: string;
  /** True when the path names a Windows volume, where case does not matter. */
  readonly windows: boolean;
}

/** A path the lock could read, or the reason it refused to. Never a guess. */
export type PathReading =
  | { readonly ok: true; readonly path: CanonicalPath }
  | { readonly ok: false; readonly problem: string };

// \\?\C:\ and //?/C:/ — the prefix Windows uses to bypass its own parsing.
const WINDOWS_EXTENDED = /^\/\/[?.]\/([A-Za-z]):(?:\/|$)/;
// \\localhost\c$\ and \\127.0.0.1\C$\ — the local machine seen through a share.
const WINDOWS_LOOPBACK = /^\/\/(?:localhost|127\.0\.0\.1)\/([A-Za-z])\$(?:\/|$)/i;
// C:\ or C:/ — a drive-rooted path. `C:foo` (drive-relative) is deliberately not matched.
const WINDOWS_DRIVE = /^([A-Za-z]):(?:\/|$)/;

/** True when this spelling names one absolute place, on either filesystem. */
export function isAbsolutePath(value: string): boolean {
  const forward = toPosix(value);
  return forward.startsWith('/') || WINDOWS_DRIVE.test(forward);
}

function unreadable(problem: string): PathReading {
  return { ok: false, problem };
}

/**
 * Builds the canonical form of a Windows path from the drive letter and the rest below it.
 * Anything the lock cannot reduce on its own — a stream, a short name — is refused here.
 */
function windowsPath(drive: string, rest: string): PathReading {
  // A `:` after the drive names an NTFS alternate data stream, not a file in the folder: it is
  // either a different file or the same one read another way, and we cannot tell which.
  if (rest.includes(':')) return unreadable('una ruta con dos puntos después de la unidad (un flujo NTFS)');

  const segments = rest.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    // Empty pieces (from a leading, trailing or doubled separator) and the `.`/`..` names are not
    // folder names of their own, so the two rules below do not apply to them.
    if (segment === '' || segment === '.' || segment === '..') continue;

    // Windows strips a trailing dot or space from every name it writes, so `Socialabs.` and
    // `Socialabs ` both name the folder `Socialabs`. We cannot know which folder the caller meant,
    // so we refuse instead of collapsing the two ourselves.
    if (/[. ]$/.test(segment)) {
      return unreadable('un segmento que termina en punto o espacio (Windows lo recortaría y cambiaría de carpeta)');
    }

    // An 8.3 short name `SOCIAL~1` is another spelling of the same folder, but expanding it means
    // asking the filesystem. Never guess. Only a folder can hide behind a short name: in the last
    // segment (`docs/notas~1.md`) there is nothing below it, so a file name may pass.
    if (index !== segments.length - 1 && /~[0-9]/.test(segment)) {
      return unreadable('un nombre corto 8.3 que no se puede expandir sin preguntar al sistema');
    }
  }

  // Anchor the rest at the drive root before resolving `..`: Windows resolves `C:\..` to `C:\`,
  // while normalising `c:/../x` as a whole drops the drive and reads as a relative path.
  const normalized = `${drive.toLowerCase()}:${path.posix.normalize(`/${rest}`)}`;
  // Windows does not distinguish case anywhere in the path, so the key folds all of it.
  return { ok: true, path: { display: normalized, key: normalized.toLowerCase(), windows: true } };
}

/** Reads an absolute spelling (POSIX or Windows) into one canonical form. */
export function readAbsolute(value: string): PathReading {
  const forward = toPosix(value);

  const extended = WINDOWS_EXTENDED.exec(forward);
  const extendedDrive = extended?.[1];
  if (extended && extendedDrive) return windowsPath(extendedDrive, forward.slice(extended[0].length));

  const loopback = WINDOWS_LOOPBACK.exec(forward);
  const loopbackDrive = loopback?.[1];
  if (loopback && loopbackDrive) return windowsPath(loopbackDrive, forward.slice(loopback[0].length));

  // Any remaining `//` prefix is a UNC share we cannot prove is this folder: another machine's
  // share may be this very folder, or may not be. Refuse rather than guess.
  if (forward.startsWith('//')) return unreadable('una ruta UNC de la que no se puede saber si es esta carpeta');

  const drive = WINDOWS_DRIVE.exec(forward);
  const driveLetter = drive?.[1];
  if (drive && driveLetter) return windowsPath(driveLetter, forward.slice(drive[0].length));

  // POSIX absolute: one spelling, and case is part of every name.
  if (forward.startsWith('/')) {
    const normalized = path.posix.normalize(forward);
    return { ok: true, path: { display: normalized, key: normalized, windows: false } };
  }

  return unreadable('no es una ruta absoluta');
}

/**
 * Reads a path that may be relative against the `cwd` the CLI reported. A relative path with no
 * readable absolute `cwd` is refused: without a base it could name anything, and the lock only
 * ever reads relative paths against the folder the session says it is in.
 */
export function readAgainst(value: string, cwd: string): PathReading {
  const forward = toPosix(value);

  // A path with exactly one leading separator and no drive (a `\x` or a `/x`) is rooted at the
  // current drive on Windows: Windows fills the drive in and writes inside the project, not on a
  // POSIX disk. When the base is a Windows path, anchor the spelling to that drive. With a POSIX
  // base, `/x` is already absolute and keeps its POSIX meaning.
  if (forward.startsWith('/') && !forward.startsWith('//')) {
    const base = readAbsolute(cwd);
    const drive = base.ok && base.path.windows ? /^([A-Za-z]):/.exec(base.path.display)?.[1] : undefined;
    if (drive) return readAbsolute(`${drive}:${forward}`);
    return readAbsolute(forward);
  }

  if (isAbsolutePath(forward)) return readAbsolute(forward);

  const base = readAbsolute(cwd);
  if (!base.ok) return unreadable('la ruta es relativa y el cwd que debería situarla no es absoluto');

  // Resolve `..` against the base before reading, so `docs/../src` cannot pose as `docs` and a
  // spelling that climbs out of the drive is refused by `readAbsolute` as unreadable.
  const joined = path.posix.normalize(`${base.path.display}/${forward}`);
  return readAbsolute(joined);
}

/**
 * Reads the declared paper folders against the project root. Each entry must name a folder inside
 * the project and stay there: an entry that is absolute, empty, `.`, or climbs out would switch
 * the lock off while looking like configuration, so it is refused as a `paperPaths` problem.
 */
export function readPapers(
  entries: readonly string[],
  root: CanonicalPath,
): { readonly ok: true; readonly paths: readonly CanonicalPath[] } | { readonly ok: false; readonly problem: string } {
  const paths: CanonicalPath[] = [];
  for (const entry of entries) {
    const forward = toPosix(entry);
    // `normalize` keeps a trailing slash, so collapse it before deciding: `./` must fail like `.`.
    const normalized = path.posix.normalize(forward).replace(/\/+$/, '');
    const escapes = normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../');
    if (isAbsolutePath(forward) || escapes) {
      return {
        ok: false,
        problem: `la entrada ${JSON.stringify(entry)} no es una carpeta relativa dentro del proyecto`,
      };
    }

    // Papers are read against the project root, never against the hook's cwd: from inside `src`,
    // `docs/a.md` is `src/docs/a.md`, not the project's `docs`.
    const full = readAbsolute(`${root.display}/${normalized}`);
    if (!full.ok) {
      return { ok: false, problem: `la entrada ${JSON.stringify(entry)} no se puede leer (${full.problem})` };
    }
    paths.push(full.path);
  }
  return { ok: true, paths };
}

/**
 * True when `child` is `parent` itself or lives inside it, using the filesystem's own case rule.
 * A prefix alone is not enough: `docs-old` must not count as being under `docs`.
 */
export function isUnder(child: CanonicalPath, parent: CanonicalPath): boolean {
  if (child.windows !== parent.windows) return false;
  const parentKey = parent.key.replace(/\/+$/, '');
  return child.key === parentKey || child.key.startsWith(`${parentKey}/`);
}
