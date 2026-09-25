import { isMap, type Node } from 'yaml';

import type {
  Recipe,
  RecipeCondition,
  RecipeMessages,
  RecipePieces,
  RecipeStage,
} from './types.js';
import { yamlField, yamlMap, yamlSeq, yamlValue, yamlWord, type YamlNode } from './validation.js';

function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function condition(node: YamlNode): RecipeCondition {
  const entries = (yamlMap(node)?.items ?? []).map((pair) => [
    camel(yamlWord(pair.key)),
    yamlValue(pair.value),
  ]);
  return Object.fromEntries(entries) as RecipeCondition;
}

function constructStage(node: Node): RecipeStage {
  const gate = yamlField(node, 'gate');
  const gateEntries = (yamlMap(gate)?.items ?? []).map((pair) => [
    yamlWord(pair.key),
    yamlValue(pair.value),
  ]);
  const base: Omit<RecipeStage, 'validWhile'> = {
    id: yamlWord(yamlField(node, 'id')),
    summary: yamlWord(yamlField(node, 'summary')),
    phase: (yamlValue(yamlField(node, 'phase')) ?? 'pre-merge') as RecipeStage['phase'],
    required: (yamlValue(yamlField(node, 'required')) ?? true) as boolean,
    nature: yamlWord(yamlField(node, 'nature')) as RecipeStage['nature'],
    needsHuman: (yamlValue(yamlField(node, 'needs-human')) ?? false) as boolean,
    gate: Object.fromEntries(gateEntries),
  };

  const after = yamlField(node, 'after');
  const appliesIf = yamlField(node, 'applies-if');
  const validWhile = yamlField(node, 'valid-while');
  const server = yamlField(node, 'server');
  const retry = yamlField(node, 'retry');
  return {
    ...base,
    ...(after === null ? {} : { after: yamlWord(after) }),
    ...(appliesIf === null ? {} : { appliesIf: condition(appliesIf) }),
    validWhile: (validWhile === null
      ? 'same-sha'
      : yamlWord(validWhile)) as RecipeStage['validWhile'],
    ...(server === null ? {} : {
      server: isMap(server)
        ? { requireCheck: yamlWord(yamlField(server, 'require-check')) }
        : yamlWord(server) as NonNullable<RecipeStage['server']>,
    }),
    ...(retry === null ? {} : {
      retry: {
        attempts: yamlValue(yamlField(retry, 'attempts')) as number,
        waitSeconds: (yamlValue(yamlField(retry, 'wait-seconds')) ?? 0) as number,
      },
    }),
  };
}

function constructPieces(node: YamlNode): RecipePieces {
  const declaredKind = yamlField(node, 'declared-kind');
  const file = yamlWord(yamlField(declaredKind, 'file'));
  const line = yamlWord(yamlField(declaredKind, 'line'));
  return {
    branch: (yamlValue(yamlField(node, 'branch')) ?? []) as string[],
    excludeBranches: (yamlValue(yamlField(node, 'exclude-branches')) ?? []) as string[],
    ...(declaredKind === null ? {} : { declaredKind: { file, line } }),
  };
}

function constructMessages(node: YamlNode): RecipeMessages {
  const summary = yamlField(node, 'summary');
  const maxLength = yamlValue(yamlField(node, 'max-length'));
  const banned = yamlValue(yamlField(node, 'banned-words'));
  return {
    ...(summary === null
      ? {}
      : {
          summary: {
            file: yamlWord(yamlField(summary, 'file')),
            section: yamlWord(yamlField(summary, 'section')),
          },
        }),
    maxLength: (maxLength ?? 700) as number,
    bannedWords: (banned ?? []) as string[],
  };
}

export function constructRecipe(root: Node): Recipe {
  const classify = yamlField(root, 'classify');
  const kinds = yamlField(root, 'kinds');
  const lanes = yamlField(root, 'lanes');
  const labels = yamlField(root, 'labels');
  const pieces = yamlField(root, 'pieces');
  const stageNodes = yamlSeq(yamlField(root, 'stages'))?.items ?? [];
  const owner = yamlField(root, 'owner');
  const agentAccount = yamlField(root, 'agent-account');
  const messages = yamlField(root, 'messages');
  const elevations = yamlSeq(yamlField(kinds, 'elevate'))?.items ?? [];
  return {
    version: 1,
    locale: yamlWord(yamlField(root, 'locale')),
    classify: (yamlValue(classify) ?? {}) as Record<string, string[]>,
    stages: stageNodes.map(constructStage),
    ...(owner === null ? {} : { owner: yamlWord(owner) }),
    ...(agentAccount === null ? {} : { agentAccount: yamlWord(agentAccount) }),
    ...(messages === null ? {} : { messages: constructMessages(messages) }),
    ...(kinds === null ? {} : {
      kinds: {
        names: (yamlValue(yamlField(kinds, 'names')) ?? []) as string[],
        default: yamlWord(yamlField(kinds, 'default')),
        fromPaths: (yamlValue(yamlField(kinds, 'from-paths')) ?? {}) as Record<string, string[]>,
        elevate: elevations.map((entry) => ({
          when: condition(yamlField(entry, 'when')),
          to: yamlWord(yamlField(entry, 'to')),
        })),
      },
    }),
    ...(lanes === null ? {} : {
      lanes: yamlValue(lanes) as Record<string, string[]>,
    }),
    ...(labels === null ? {} : {
      labels: yamlValue(labels) as Record<string, string>,
    }),
    ...(pieces === null ? {} : { pieces: constructPieces(pieces) }),
  };
}
