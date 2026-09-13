// Reading the paths a Codex `apply_patch` payload touches.

// Codex's own parser (openai/codex, codex-rs/apply-patch/src/streaming_parser.rs) reads two
// different ways, so the lock must too:
//   - Outside an Update block it recognises the headers on the TRIMMED line. Rust's `trim()`
//     removes all Unicode whitespace INCLUDING U+0085 (NEXT LINE), which JavaScript's `trim()`
//     leaves behind, so a header after that character was invisible to the lock and real to Codex.
//   - Inside an Update block only a `***` line at column 0 is structure; an indented `***` line
//     is a context line (Codex's own test `keeps_indented_update_markers_as_context_lines`).
const RUST_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/g;

// Headers that carry a path. Recognised on the trimmed line outside an Update block; inside one,
// an indented line whose trim matches is still a header and must fail closed (`Move to:` renames
// the file the surrounding Update opened).
const HEADER_PREFIXES = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
] as const;

const ADD_FILE = '*** Add File: ';
const UPDATE_FILE = '*** Update File: ';
const DELETE_FILE = '*** Delete File: ';

// Markers that carry no path. `*** Environment ID: <value>` is one Codex accepts, with any value.
const KNOWN_MARKERS = new Set(['*** Begin Patch', '*** End Patch', '*** End of File']);
const ENVIRONMENT_MARKER = '*** Environment ID:';

function trimLikeRust(line: string): string {
  // Rust trims JavaScript's whitespace and U+0085 (NEXT LINE), which JavaScript's `trim()` does
  // not. Read the line exactly the way Codex reads it.
  return line.replace(RUST_WHITESPACE, '');
}

function headerOf(line: string): (typeof HEADER_PREFIXES)[number] | undefined {
  return HEADER_PREFIXES.find((prefix) => line.startsWith(prefix));
}

function isKnownMarker(line: string): boolean {
  return KNOWN_MARKERS.has(line) || line.startsWith(ENVIRONMENT_MARKER);
}

/** Every path a Codex `apply_patch` payload touches, including a rename's destination. */
export function pathsFromApplyPatch(command: unknown): string[] | undefined {
  if (typeof command !== 'string') {
    // Not readable: the caller refuses rather than guessing at a changed format.
    return undefined;
  }

  const paths: string[] = [];

  // Rule 2: after `*** Update File:` and until the next header at column 0 the payload is inside
  // that Update. Only an Add/Delete header leaves it; `*** Move to:` belongs to the Update it
  // renames and keeps the state.
  let inUpdate = false;

  for (const rawLine of command.split('\n')) {
    const line = trimLikeRust(rawLine);
    const atColumn0 = rawLine.startsWith('***');

    if (inUpdate && !atColumn0) {
      // Inside an Update an indented line is context, not structure. The one exception is an
      // indented KNOWN header: Codex reads it as context, but a lock must fail closed, so an
      // indented `Add/Update/Delete File:` or `Move to:` still counts as a path.
      const header = headerOf(line);
      if (header) {
        // Rule 4: the path is taken exactly as written, leading space included.
        const path = line.slice(header.length);
        if (path.length > 0) paths.push(path);
      }
      continue;
    }

    // Outside an Update, and for every structure line inside one, Codex reads a header off the
    // trimmed line: an indented header is still a header.
    if (!line.startsWith('***')) continue;

    const header = headerOf(line);
    if (header) {
      // Rule 4: the path is taken exactly as written after `File: ` / `to: `, leading space
      // included — `*** Add File:  docs/evil.ts` writes into a folder literally named " docs".
      // Trimming the start here would make that path look legitimate.
      const path = line.slice(header.length);
      if (path.length > 0) paths.push(path);

      if (header === UPDATE_FILE) inUpdate = true;
      else if (header === ADD_FILE || header === DELETE_FILE) inUpdate = false;
      continue;
    }

    if (isKnownMarker(line)) continue;

    // Rule 3: a line that starts with `***` but is not a marker we know means the payload was
    // written in a shape this lock does not understand. Refuse rather than guess.
    return undefined;
  }

  return paths;
}
