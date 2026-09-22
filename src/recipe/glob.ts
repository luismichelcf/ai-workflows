/** The recipe deliberately supports only path segments, not shell glob extensions. */
export function validGlob(pattern: string): boolean {
  if (pattern.length === 0 || pattern.startsWith('/') || pattern.startsWith('!')) return false;
  if (/[{}[\]\\]/.test(pattern)) return false;

  return pattern.split('/').every((segment) => {
    if (segment.length === 0) return false;
    return !segment.includes('**') || segment === '**';
  });
}

function escapeLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentPattern(segment: string): RegExp {
  const source = [...segment]
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return escapeLiteral(char);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
  patternIndex = 0,
  pathIndex = 0,
): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const segment = pattern[patternIndex];
  if (segment === undefined) return false;

  if (segment === '**') {
    // A whole-segment ** can consume zero folders, including at the start of a path.
    for (let next = pathIndex; next <= path.length; next++) {
      if (matchSegments(pattern, path, patternIndex + 1, next)) return true;
    }
    return false;
  }

  const candidate = path[pathIndex];
  if (candidate === undefined || !segmentPattern(segment).test(candidate)) return false;
  return matchSegments(pattern, path, patternIndex + 1, pathIndex + 1);
}

export function classifyFiles(
  classify: Readonly<Record<string, readonly string[]>>,
  files: readonly string[],
): string[] {
  const paths = files.map((file) => file.replace(/\\/g, '/').split('/'));
  return Object.entries(classify)
    .filter(([, patterns]) => patterns.some((pattern) =>
      paths.some((path) => matchSegments(pattern.split('/'), path))))
    .map(([name]) => name);
}
