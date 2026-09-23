/** The recipe deliberately supports only path segments, not shell glob extensions. */
export function validGlob(pattern: string): boolean {
  if (pattern.length === 0 || pattern.startsWith('/') || pattern.startsWith('!')) return false;
  if (/[{}[\]\\]/.test(pattern)) return false;

  return pattern.split('/').every((segment) => {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    return !segment.includes('**') || segment === '**';
  });
}

/** Greedy wildcard comparison uses one retry point per star, never a regex backtracker. */
function matchSegment(pattern: string, path: string): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let starIndex = -1;
  let retryIndex = -1;

  while (pathIndex < path.length) {
    const token = pattern[patternIndex];
    if (token === '?' || token === path[pathIndex]) {
      patternIndex++;
      pathIndex++;
    } else if (token === '*') {
      starIndex = patternIndex++;
      retryIndex = pathIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      pathIndex = ++retryIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function collapseDoubleStars(segments: readonly string[]): string[] {
  const result: string[] = [];
  for (const segment of segments) {
    if (segment !== '**' || result[result.length - 1] !== '**') result.push(segment);
  }
  return result;
}

/** Dynamic programming bounds work even when many whole-segment ** markers overlap. */
function matchPath(pattern: readonly string[], path: readonly string[]): boolean {
  const segments = collapseDoubleStars(pattern);
  const rows = Array.from(
    { length: segments.length + 1 },
    () => Array<boolean>(path.length + 1).fill(false),
  );
  const last = rows[segments.length];
  if (last) last[path.length] = true;

  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    const row = rows[i];
    const next = rows[i + 1];
    if (!row || !next || segment === undefined) continue;

    for (let j = path.length; j >= 0; j--) {
      if (segment === '**') {
        row[j] = next[j] === true || (j < path.length && row[j + 1] === true);
      } else if (j < path.length) {
        row[j] = matchSegment(segment, path[j] ?? '') && next[j + 1] === true;
      }
    }
  }
  return rows[0]?.[0] === true;
}

export function classifyFiles(
  classify: Readonly<Record<string, readonly string[]>>,
  files: readonly string[],
): string[] {
  const paths = files.map((file) => file.replace(/\\/g, '/').split('/'));
  return Object.entries(classify)
    .filter(([, patterns]) => patterns.some((pattern) =>
      paths.some((path) => matchPath(pattern.split('/'), path))))
    .map(([name]) => name);
}
