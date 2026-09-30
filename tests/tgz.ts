import { gunzipSync, gzipSync } from 'node:zlib';

// A minimal reader and writer of gzipped tar archives (ustar, plus the pax `path` record that
// `pnpm pack` may use for long names), so the tests of PLAN-13-R6 §9 can build a package fixture
// for `init --package` and list what `pnpm pack` put in the package, on Windows and Linux alike,
// without a new dependency or the `tar` program.

export interface TarEntry {
  readonly path: string;
  readonly content: Buffer;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  if (Buffer.byteLength(path) > 100) throw new Error(`tgz fixture: path too long: ${path}`);
  block.write(path, 0, 'utf8');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write('0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** A `.tgz` holding the given files, like a package built by `pnpm pack`. */
export function writeTgz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry.path, entry.content.length));
    parts.push(entry.content);
    const pad = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
    parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts));
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function paxPath(content: Buffer): string | undefined {
  for (const record of content.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

/** Every regular file of a `.tgz`, in archive order. */
export function readTgz(archive: Buffer): TarEntry[] {
  const tar = gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = field(block, 0, 100);
    const prefix = field(block, 345, 155);
    const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156] ?? 0x30);
    const content = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      nextPath = paxPath(content);
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    nextPath = undefined;
    if (type === '0' || type === '\0') entries.push({ path, content: Buffer.from(content) });
  }
  return entries;
}
