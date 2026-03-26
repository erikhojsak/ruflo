/**
 * Shared utilities for RuVector plugins
 */

export {
  // Fallback implementations
  FallbackVectorDB,
  FallbackLoRAEngine,
  // Factory functions
  createVectorDB,
  createLoRAEngine,
  // Utilities
  cosineSimilarity,
  generateHashEmbedding,
  LazyInitializable,
} from './vector-utils.js';

// Interfaces
export type {
  IVectorDB,
  ILoRAEngine,
  LoRAAdapter,
} from './vector-utils.js';
