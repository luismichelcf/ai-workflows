import { describe, expect, it } from 'vitest';

import { buildHooksConfig, mergeHooksConfig, type HookGroup } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026): reinstalling dropped a timeout the user had put
// on our hook, two copies of ours in two groups were not merged, and the result shared objects
// with the file it was given.

const command = 'node C:/GitHub/ai-workflows/dist/lock.js';
const ours = buildHooksConfig('claude', command);
const matcher = ours.hooks.PreToolUse[0]?.matcher ?? '';

const groupsOf = (config: unknown): HookGroup[] => (config as { hooks: { PreToolUse: HookGroup[] } }).hooks.PreToolUse;
const handlersNamed = (config: unknown, name: string) =>
  groupsOf(config).flatMap((group) => group.hooks).filter((handler) => handler.command === name);

describe('reinstalling keeps what the user set on our hook', () => {
  it('keeps a timeout the user put on our handler', () => {
    const existing = { hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command, timeout: 30 }] }] } };

    expect(handlersNamed(mergeHooksConfig(existing, ours), command)).toEqual([{ type: 'command', command, timeout: 30 }]);
  });
});

describe('reinstalling collapses every copy of ours into one', () => {
  it('merges two copies found in two different groups', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hola' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command }] },
        ],
      },
    };

    const merged = mergeHooksConfig(existing, ours);

    expect(handlersNamed(merged, command)).toHaveLength(1);
    expect(handlersNamed(merged, 'echo hola')).toHaveLength(1);
  });
});

describe('the result shares nothing with the file it was given', () => {
  it('changing the result does not change the original', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hola' }] };
    const existing = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [foreign] } };
    const snapshot = JSON.parse(JSON.stringify(existing)) as unknown;

    const merged = mergeHooksConfig(existing, ours) as { permissions: { allow: string[] }; hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
    merged.permissions.allow.push('Write');
    for (const group of merged.hooks.PreToolUse) group.hooks.push({ type: 'command', command: 'x' });

    expect(existing).toEqual(snapshot);
  });
});
