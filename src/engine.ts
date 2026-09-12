import type { Engine, EngineOptions } from './contract.js';

export function createEngine(_options: EngineOptions): Engine {
  throw new Error('createEngine: not implemented');
}
