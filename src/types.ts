/**
 * Options passed to AudioRecorder.create()
 */
export interface RecorderCreateOptions {
  /**
   * Explicit MIME type to use (e.g. 'audio/webm;codecs=opus').
   * If omitted the library auto-detects the best supported type.
   */
  mimeType?: string

  /**
   * Millisecond interval for ondataavailable events.
   * Passed directly to MediaRecorder.start(timeslice).
   */
  timeslice?: number

  /**
   * Silence detection threshold in dB (negative value, e.g. -50).
   * Audio below this level is considered silence.
   * @default -50
   */
  silenceThreshold?: number

  /**
   * Overrides for chunk-splitting timing constants.
   */
  chunkOptions?: Partial<ChunkOptions>
}

/**
 * Chunk splitting timing configuration.
 */
export interface ChunkOptions {
  /** Maximum chunk duration in seconds before a forced split. @default 300 */
  maxDuration: number
  /** Minimum chunk duration in seconds before silence-based split is allowed. @default 30 */
  minDuration: number
  /** Minimum continuous silence (seconds) needed to trigger a split. @default 1 */
  minSilenceDuration: number
}

/**
 * Payload delivered to the onChunkProcessed callback.
 */
export interface ChunkProcessedPayload {
  /** File object for the audio chunk, named chunk-{index}.{ext} */
  file: File
  /** Zero-based index of this chunk in the current recording session */
  index: number
  /** Duration of this chunk in seconds */
  duration: number
  /** true when this is the final chunk (recorder was stopped) */
  isLastChunk: boolean
}

/**
 * Recorder state — mirrors the native MediaRecorder.state values.
 */
export type RecorderState = 'inactive' | 'recording' | 'paused'

/**
 * Options passed to AudioChunkify.destroy().
 */
export interface DestroyOptions {
  /**
   * When `true` (default), calls `stop()` on every track of the streams
   * passed to `create()` / `addAudioStream()`. Set to `false` when you
   * plan to reuse those streams after tearing down the recorder
   * (e.g. start a new recording with the same microphone).
   */
  stopStreams?: boolean
}
