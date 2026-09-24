/**
 * The recipe deliberately supports only path segments, not shell glob extensions. A block's
 * path inputs may carry the `{piece}` placeholder (PLAN-13-R2 §1.1/§2.1); class globs may not.
 */
export function validGlob(pattern: string, allowPiece = false): boolean {
  const candidate = allowPiece ? pattern.split('{piece}').join('PIECE') : pattern;
  if (candidate.length === 0 || candidate.startsWith('/') || candidate.startsWith('!')) return false;
  if (/[{}[\]\\\uFF01-\uFF60]/u.test(candidate)) return false;

  return candidate.split('/').every((segment) => {
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
    // A pattern star stays a wildcard even when the file name contains a literal star.
    if (token === '*') {
      starIndex = patternIndex++;
      retryIndex = pathIndex;
    } else if (token === '?' || token === path[pathIndex]) {
      patternIndex++;
      pathIndex++;
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
function matchPath(
  segments: readonly string[],
  path: readonly string[],
  buffers: readonly [boolean[], boolean[]],
): boolean {
  const width = path.length + 1;
  let next = buffers[0];
  let row = buffers[1];
  next.length = width;
  row.length = width;
  next.fill(false);
  next[path.length] = true;

  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    row.fill(false);

    for (let j = path.length; j >= 0; j--) {
      if (segment === '**') {
        row[j] = next[j] === true || (j < path.length && row[j + 1] === true);
      } else if (j < path.length) {
        row[j] = next[j + 1] === true && matchSegment(segment, path[j] ?? '');
      }
    }
    const previous = next;
    next = row;
    row = previous;
  }
  return next[0] === true;
}

export function classifyFiles(
  classify: Readonly<Record<string, readonly string[]>>,
  files: readonly string[],
): string[] {
  const paths = files.map((file) => file.split('/'));
  const buffers: [boolean[], boolean[]] = [[], []];
  const touched: string[] = [];

  for (const [name, patterns] of Object.entries(classify)) {
    const compiled = patterns.map((pattern) => collapseDoubleStars(pattern.split('/')));
    if (compiled.some((pattern) => paths.some((path) => matchPath(pattern, path, buffers)))) {
      touched.push(name);
    }
  }
  return touched;
}
