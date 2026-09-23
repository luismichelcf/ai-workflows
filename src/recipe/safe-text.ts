// Controls and direction markers can alter a terminal without appearing in the recipe.
const UNSAFE_SET =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f' +
  '\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]';

const UNSAFE_CHARACTER = new RegExp(UNSAFE_SET, 'u');
const UNSAFE_CHARACTERS = new RegExp(UNSAFE_SET, 'gu');

export function hasUnsafeText(text: string): boolean {
  return UNSAFE_CHARACTER.test(text);
}

export function safeTerminalText(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, '?');
}
