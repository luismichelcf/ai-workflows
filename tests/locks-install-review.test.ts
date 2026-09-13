import { describe, expect, it } from 'vitest';

import { buildHooksConfig, mergeHooksConfig, type HookGroup } from '../src/index.js';

// Review of part 4 (13-sep-2026). Installing must never lose what the user already had, and
// reinstalling must repair our entry instead of duplicating it or leaving an old one frozen.

const command = 'node C:/GitHub/ai-workflows/dist/lock.js';
const ours = buildHooksConfig('claude', command);

const groupsOf = (config: unknown): HookGroup[] => {
  const hooks = (config as { hooks: { PreToolUse: HookGroup[] } }).hooks;
  return hooks.PreToolUse;
};

const commandsOf = (config: unknown): string[] =>
  groupsOf(config).flatMap((group) => group.hooks.map((handler) => handler.command));

describe('a file with an unexpected shape is refused, never rebuilt', () => {
  const shapes: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['the file is a list', [], /root|raíz|archivo|file/i],
    ['the file is text', 'hola', /root|raíz|archivo|file/i],
    ['hooks is a list', { hooks: [] }, /hooks/],
    ['hooks is text', { hooks: 'x' }, /hooks/],
    ['PreToolUse is an object', { hooks: { PreToolUse: { matcher: 'Bash' } } }, /PreToolUse/],
    ['PreToolUse is text', { hooks: { PreToolUse: 'Write' } }, /PreToolUse/],
    ['a group is not an object', { hooks: { PreToolUse: ['Write'] } }, /PreToolUse/],
  ];

  for (const [name, existing, names] of shapes) {
    it(`refuses when ${name}, naming where`, () => {
      expect(() => mergeHooksConfig(existing, ours)).toThrow(names);
    });
  }

  it('starts a fresh file when there is none yet', () => {
    expect(mergeHooksConfig(undefined, ours)).toEqual(ours);
    expect(mergeHooksConfig(null, ours)).toEqual(ours);
  });
});

describe('reinstalling repairs our entry', () => {
  it('updates our matcher when an older install left a narrower one', () => {
    const old = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }] } };

    expect(groupsOf(mergeHooksConfig(old, ours))).toEqual(ours.hooks.PreToolUse);
  });

  it('recognises our command written with different spacing', () => {
    const old = {
      hooks: {
        PreToolUse: [{ matcher: ours.hooks.PreToolUse[0]?.matcher, hooks: [{ type: 'command', command: `  node   C:/GitHub/ai-workflows/dist/lock.js ` }] }],
      },
    };

    expect(groupsOf(mergeHooksConfig(old, ours))).toHaveLength(1);
  });

  it('does not duplicate when our group is not the first', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hola' }] };
    const once = mergeHooksConfig({ hooks: { PreToolUse: [foreign] } }, ours);
    const twice = mergeHooksConfig(once, ours);

    expect(twice).toEqual(once);
    expect(groupsOf(twice)).toHaveLength(2);
  });

  it('adds ours even when a foreign group already uses the same matcher', () => {
    const foreign = { matcher: ours.hooks.PreToolUse[0]?.matcher, hooks: [{ type: 'command', command: 'prettier-hook' }] };
    const merged = mergeHooksConfig({ hooks: { PreToolUse: [foreign] } }, ours);

    expect(commandsOf(merged)).toContain('prettier-hook');
    expect(commandsOf(merged).filter((each) => each === command)).toHaveLength(1);
  });

  it('never widens a foreign handler that shared a group with an old copy of ours', () => {
    const shared = {
      matcher: 'Write',
      hooks: [
        { type: 'command', command: 'prettier-hook' },
        { type: 'command', command },
      ],
    };
    const groups = groupsOf(mergeHooksConfig({ hooks: { PreToolUse: [shared] } }, ours));

    const foreignGroup = groups.find((group) => group.hooks.some((handler) => handler.command === 'prettier-hook'));
    expect(foreignGroup?.matcher).toBe('Write');
    expect(groups.flatMap((group) => group.hooks).filter((handler) => handler.command === command)).toHaveLength(1);
    const ourGroup = groups.find((group) => group.hooks.some((handler) => handler.command === command));
    expect(ourGroup?.matcher).toBe(ours.hooks.PreToolUse[0]?.matcher);
  });
});
