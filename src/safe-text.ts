// Unicode controls and formatting marks can change a terminal without visible text.
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHARACTERS = new RegExp(UNSAFE_CHARACTER.source, 'gu');

export function hasUnsafeText(text: string): boolean {
  return UNSAFE_CHARACTER.test(text);
}

export function safeTerminalText(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, '?');
}
