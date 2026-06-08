/**
 * Default audio analysis and chunking constants.
 * All values can be overridden via RecorderOptions.
 */
export const DEFAULT_AUDIO_CONSTANTS = {
  /** FFT size for the AnalyserNode (must be a power of 2). Affects frequency resolution. */
  ANALYSIS_BUFFER_SIZE: 2048,

  /** Silence threshold in dB used for chunk splitting (-Infinity to 0). */
  SILENCE_THRESHOLD: -50,

  /** Maximum chunk duration in seconds before a forced split. */
  MAX_CHUNK_DURATION: 300,

  /** Minimum chunk duration in seconds before a silence-based split is allowed. */
  MIN_CHUNK_DURATION: 30,

  /** Minimum continuous silence duration in seconds required to trigger a split. */
  MIN_SILENCE_DURATION: 1,
} as const

export type AudioConstants = typeof DEFAULT_AUDIO_CONSTANTS
