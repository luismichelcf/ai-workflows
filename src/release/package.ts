// PLAN-13-R6 §9.2 and §9.4 test 4d: reading the seal of a package given with `init --package`.
//
// The argument is a path as the owner typed it: a folder (an unpacked package) or a `.tgz`
// (what the release workflow uploads). Only `engine.json` is read from it, to compare its seal
// with the seal of the running `init`. A missing, unreadable or unparseable package is "no seal",
// never a throw: the caller reports the path and stops.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The seal of the package at `path` (relative to `cwd`), or `undefined` if it cannot be read. */
export async function readPackageSeal(path: string, cwd: string): Promise<unknown> {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(full);
  } catch {
    return undefined;
  }
  try {
    if (info.isDirectory()) {
      return JSON.parse(await readFile(join(full, 'engine.json'), 'utf8'));
    }
    const archive = await readFile(full);
    const entry = readTarballEntry(archive, 'package/engine.json');
    if (entry === undefined) return undefined;
    return JSON.parse(entry.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** A NUL-terminated field of a tar header block. */
function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** The `path=` record of a pax extended header, if any (long names, as `pnpm pack` writes them). */
function paxPath(content: Buffer): string | undefined {
  for (const record of content.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The content of one regular file of a gzipped tar archive (ustar, plus pax `path` records), or
 * `undefined`. Deliberately minimal: `init --package` only needs `package/engine.json`.
 */
function readTarballEntry(archive: Buffer, wanted: string): Buffer | undefined {
  const tar = gunzipSync(archive);
  const block = 512;
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + block <= tar.length) {
    const header = tar.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0x30);
    const content = tar.subarray(offset + block, offset + block + size);
    offset += block + Math.ceil(size / block) * block;
    if (type === 'x') {
      nextPath = paxPath(content) ?? nextPath;
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    nextPath = undefined;
    if (path === wanted) return Buffer.from(content);
  }
  return undefined;
}
