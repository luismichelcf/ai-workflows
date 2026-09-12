import type { PipelineConfig, ValidationResult } from './contract.js';

/**
 * Rejects a pipeline whose order is not fully determined. See `ValidateConfig` in the
 * contract for the six rejection cases and why ambiguity is one of them.
 */
export function validateConfig(_config: PipelineConfig): ValidationResult {
  throw new Error('validateConfig: not implemented');
}

/**
 * Stable fingerprint of a pipeline's shape: stage names and their order. Journal entries
 * carry it so evidence produced under a different pipeline is not mistaken for current.
 * Gate function identity is deliberately NOT part of it — editing a gate's body does not
 * invalidate what the engine observed.
 */
export function fingerprint(_config: PipelineConfig): string {
  throw new Error('fingerprint: not implemented');
}
