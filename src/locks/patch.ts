// Reading the paths a Codex `apply_patch` payload touches.

// Codex's own parser (openai/codex, codex-rs/apply-patch/src/streaming_parser.rs) recognises
// these headers on the TRIMMED line, anywhere in the payload, not only at column 0. A lock
// that only looked at column 0 let an indented header create or delete code unnoticed.
const HEADER_PREFIXES = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
] as const;

// Markers that carry no path. Seen on the trimmed line, they are structure, not headers.
const KNOWN_MARKERS = new Set(['*** Begin Patch', '*** End Patch', '*** End of File']);

/** Every path a Codex `apply_patch` payload touches, including a rename's destination. */
export function pathsFromApplyPatch(command: unknown): string[] | undefined {
  if (typeof command !== 'string') {
    // Not readable: the caller refuses rather than guessing at a changed format.
    return undefined;
  }

  const paths: string[] = [];
  for (const rawLine of command.split('\n')) {
    // Codex reads headers off the trimmed line, so the lock does too: an indented header is
    // still a header.
    const line = rawLine.trim();

    // Rule 4: content lines (`+…`, `-…`, ` …`, `@@…`) may contain `***` in the middle; only a
    // line that begins with `***` after trimming can be a header or marker.
    if (!line.startsWith('***')) continue;

    const header = HEADER_PREFIXES.find((prefix) => line.startsWith(prefix));
    if (header) {
      // Rule 2: Codex takes the path exactly as written after `File: ` / `to: `, leading space
      // included — `*** Add File:  docs/evil.ts` writes into a folder literally named " docs".
      // Trimming the start here would make that path look legitimate.
      const path = line.slice(header.length);
      if (path.length > 0) paths.push(path);
      continue;
    }

    if (KNOWN_MARKERS.has(line)) continue;

    // Rule 3: a line that starts with `***` but is not a marker we know means the payload was
    // written in a shape this lock does not understand. Refuse rather than guess.
    return undefined;
  }

  return paths;
}
