const identifier = '^[a-z][a-z0-9-]*$';

const identifierList = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', pattern: identifier },
} as const;

const globList = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
} as const;

const pathClasses = {
  type: 'object',
  propertyNames: { pattern: identifier },
  additionalProperties: globList,
} as const;

const branchPatterns = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
} as const;

const conditionRef = { $ref: '#/definitions/condition' } as const;

/** The editor and parser consume this same object for the recipe's structural rules. */
export const recipeSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  description: 'A linear process for a coding project.',
  additionalProperties: false,
  required: ['version', 'locale', 'stages'],
  properties: {
    version: {
      const: 1,
      description: 'Recipe format version.',
    },
    locale: {
      type: 'string',
      pattern: '^[a-z]{2}(-[A-Z]{2})?$',
      description: 'Language for owner-facing text.',
    },
    owner: {
      type: 'string',
      pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$',
      description: 'GitHub owner login.',
    },
    classify: {
      ...pathClasses,
      description: 'Named file groups.',
    },
    kinds: {
      type: 'object',
      additionalProperties: false,
      required: ['default', 'names'],
      description: 'Change kind rules.',
      properties: {
        names: {
          ...identifierList,
          description: 'The closed vocabulary of change kinds.',
        },
        default: { type: 'string', pattern: identifier },
        'from-paths': pathClasses,
        elevate: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['when', 'to'],
            properties: {
              when: conditionRef,
              to: { type: 'string', pattern: identifier },
            },
          },
        },
      },
    },
    lanes: {
      type: 'object',
      propertyNames: { pattern: identifier },
      additionalProperties: identifierList,
      description: 'Every declared kind grouped into exactly one lane.',
    },
    labels: {
      type: 'object',
      propertyNames: { pattern: identifier },
      additionalProperties: { type: 'string', minLength: 1 },
      description: 'Owner-facing names for classes, kinds and lanes.',
    },
    pieces: {
      type: 'object',
      additionalProperties: false,
      required: ['branch'],
      description: 'R19: how a branch names its piece, and where that piece declares its kind.',
      properties: {
        branch: {
          ...branchPatterns,
          description: 'Branch name patterns; {piece} appears exactly once in each.',
        },
        'exclude-branches': {
          ...branchPatterns,
          description: 'Branches that never join the main line; they cannot contain {piece}.',
        },
        'declared-kind': {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'line'],
          description: 'Where a piece declares its change kind.',
          properties: {
            file: {
              type: 'string',
              minLength: 1,
              description: 'Relative path that carries {piece}.',
            },
            line: {
              type: 'string',
              minLength: 1,
              description: 'Non-empty label the declaring line starts with.',
            },
          },
        },
      },
    },
    stages: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/definitions/stage' },
      description: 'Ordered process steps.',
    },
  },
  definitions: {
    condition: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      description: 'All listed clauses must hold.',
      properties: {
        'touches-any': identifierList,
        'touches-none': identifierList,
        'kind-any': identifierList,
        'kind-none': identifierList,
        'lane-any': identifierList,
      },
    },
    stage: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'summary', 'nature', 'gate'],
      description: 'One process step.',
      properties: {
        id: {
          type: 'string',
          pattern: identifier,
          description: 'Stable step identifier.',
        },
        summary: {
          type: 'string',
          minLength: 1,
          description: 'Plain-language step description.',
        },
        after: {
          type: 'string',
          pattern: identifier,
          description: 'Previous step identifier.',
        },
        phase: {
          enum: ['pre-merge', 'merge', 'post-merge'],
          description: 'Part of the process.',
        },
        required: {
          type: 'boolean',
          description: 'Whether failure stops the piece.',
        },
        nature: {
          enum: ['recompute', 'structure', 'execution-record', 'attest'],
          description: 'What the gate can prove.',
        },
        'applies-if': {
          ...conditionRef,
          description: 'When this step applies.',
        },
        'valid-while': {
          enum: [
            'same-sha',
            'same-fingerprint',
            'same-fingerprint-or-clean-update',
            'forever',
          ],
          description: 'Evidence validity rule.',
        },
        'needs-human': {
          type: 'boolean',
          description: 'Wait for a person.',
        },
        gate: {
          type: 'object',
          additionalProperties: false,
          description: 'Block or command to execute.',
          properties: {
            uses: {
              type: 'string',
              pattern:
                '^(ai-workflows/[a-z][a-z0-9-]*@[1-9][0-9]*|' +
                '\\./\\.ai-workflows/blocks/[a-z][a-z0-9-]*)$',
            },
            run: { type: 'string', minLength: 1 },
            with: {},
          },
          oneOf: [{ required: ['uses'] }, { required: ['run'] }],
        },
        server: {
          oneOf: [
            { enum: ['recompute', 'attestation', 'local-only'] },
            {
              type: 'object',
              additionalProperties: false,
              required: ['require-check'],
              properties: {
                'require-check': { type: 'string', minLength: 1 },
              },
            },
          ],
          description: 'Server verification.',
        },
        retry: {
          type: 'object',
          additionalProperties: false,
          required: ['attempts'],
          properties: {
            attempts: { type: 'integer', minimum: 1, maximum: 5 },
            'wait-seconds': { type: 'integer', minimum: 0, maximum: 3600 },
          },
          description: 'Bounded attempts.',
        },
      },
    },
  },
} as const;
