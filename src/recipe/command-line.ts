import { nodeStart, type LocatedIssue, type YamlNode, yamlWord } from './validation.js';

// PLAN-13-R2 §1.4: a command text is split on spaces and never read by a console. Characters
// that a shell would act on, and every placeholder the engine does not know, are refused with
// the place of the command value.
const SHELL_CHARACTERS = [
  '"', "'", '$', '`', '|', ';', '&', '<', '>', '(', ')', '*', '?', '~', '\n', '\r',
] as const;

const PLACEHOLDER = /\{([^{}]*)\}/g;

function shown(character: string): string {
  if (character === '\n') return 'line break';
  if (character === '\r') return 'carriage return';
  return character;
}

export function validateCommandLine(
  node: YamlNode,
  issues: LocatedIssue[],
  field = 'run',
): void {
  const text = yamlWord(node);
  const offset = nodeStart(node);

  const forbidden = SHELL_CHARACTERS.filter((character) => text.includes(character));
  if (forbidden.length > 0) {
    issues.push({
      offset,
      message: `"${field}" cannot contain shell characters: ${forbidden.map(shown).join(' ')}`,
    });
  }

  for (const argument of text.split(' ')) {
    for (const match of argument.matchAll(PLACEHOLDER)) {
      const placeholder = match[0];
      const name = match[1] ?? '';
      if (name === 'piece') continue;
      if (name === 'tests') {
        if (argument !== '{tests}') {
          issues.push({ offset, message: '"{tests}" must be a whole argument' });
        }
        continue;
      }
      issues.push({ offset, message: `unknown placeholder "${placeholder}"` });
    }
  }
}
