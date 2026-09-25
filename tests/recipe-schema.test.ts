import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { recipeSchema } from '../src/index.js';

// PLAN-13 §3.2: the engine publishes a JSON Schema per version so the editor validates,
// completes and explains while the recipe is written. The published file and what `validate`
// enforces must be the same thing, so the file in the repository is the exported schema.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the published recipe schema', () => {
  it('is exactly the schema the engine exports', () => {
    expect(JSON.parse(read('../schema/recipe.schema.json'))).toEqual(recipeSchema);
  });

  it('is a draft-07 schema the YAML editor understands', () => {
    expect(recipeSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(recipeSchema.type).toBe('object');
    expect(recipeSchema.additionalProperties).toBe(false);
    expect([...recipeSchema.required].sort()).toEqual(['locale', 'stages', 'version']);
  });

  it('allows at the top only the keys of §3.3, plus lanes and labels (R15, R16), pieces (R19), agent-account (R21) and messages (PLAN-13-R4 §6) and hooks (PLAN-13-R5 §1.1)', () => {
    expect(Object.keys(recipeSchema.properties).sort()).toEqual(
      ['agent-account', 'classify', 'hooks', 'kinds', 'labels', 'lanes', 'locale', 'messages', 'owner', 'pieces', 'stages', 'version'].sort(),
    );
  });

  it('requires the kind vocabulary whenever kinds are declared (R15)', () => {
    expect([...recipeSchema.properties.kinds.required].sort()).toEqual(['default', 'names']);
  });

  it('allows in a stage exactly the fields §3.3 lists, and nothing else', () => {
    const stage = recipeSchema.definitions.stage;
    expect(stage.additionalProperties).toBe(false);
    expect(Object.keys(stage.properties).sort()).toEqual(
      [
        'id',
        'summary',
        'after',
        'phase',
        'required',
        'nature',
        'applies-if',
        'valid-while',
        'needs-human',
        'gate',
        'server',
        'retry',
      ].sort(),
    );
    expect([...stage.required].sort()).toEqual(['gate', 'id', 'nature', 'summary']);
  });

  it('allows in a condition only the structured forms of §3.4, never an expression', () => {
    const condition = recipeSchema.definitions.condition;
    expect(condition.additionalProperties).toBe(false);
    expect(Object.keys(condition.properties).sort()).toEqual(
      ['kind-any', 'kind-none', 'lane-any', 'touches-any', 'touches-none'].sort(),
    );
  });

  it('is the schema the example recipe points the editor at', () => {
    const firstLine = read('../templates/pipeline.yml').split('\n')[0];
    expect(firstLine).toMatch(/^# yaml-language-server: \$schema=\S+\/recipe\.schema\.json$/);
  });
});
