import { DEFAULT_AUDIO_CONSTANTS } from './constants.js'
import {
  getCompatibleMimeType,
  getFileExtensionFromMimeType,
} from './utils/audioCodec.js'
import type {
  ChunkOptions,
  ChunkProcessedPayload,
  DestroyOptions,
  RecorderCreateOptions,
  RecorderState,
} from './types.js'

interface MixedStreamNode {
  source: MediaStreamAudioSourceNode
  gainNode: GainNode
}

/**
 * AudioChunkify
 *
 * A framework-agnostic MediaRecorder wrapper that adds:
 * - Automatic MIME type detection
 * - Multi-stream mixing via AudioContext
 * - Silence detection with configurable threshold
 * - Automatic chunk splitting (time + silence based)
 * - Recording time tracking
 * - Pause/resume with correct duration accounting
 */
export class AudioChunkify {
  // ── Core recorder ────────────────────────────────────────────────────────
  private _mediaRecorder: MediaRecorder | null = null
  private _stream: MediaStream | null = null
  private _audioStreams: MediaStream[] = []
  private _mimeType: string | null = null
  private _timeslice: number | null = null

  // ── Event callbacks ───────────────────────────────────────────────────────
  private _onDataAvailableCallback: ((event: BlobEvent) => void) | null = null
  private _onStartCallback: (() => void) | null = null
  private _onPauseCallback: (() => void) | null = null
  private _onResumeCallback: (() => void) | null = null
  private _onStopCallback: (() => void) | null = null
  private _onErrorCallback: ((event: Event) => void) | null = null

  // ── Time tracking ─────────────────────────────────────────────────────────
  private _recordingTime = 0
  private _intervalId: ReturnType<typeof setInterval> | null = null
  private _onTimeUpdateCallback: ((seconds: number) => void) | null = null

  // ── Silence analysis ─────────────────────────────────────────────────────
  private _audioContext: AudioContext | null = null
  private _analyserNode: AnalyserNode | null = null
  private _sourceNode: MediaStreamAudioSourceNode | null = null
  private _silenceTime = 0
  private _silenceIntervalId: ReturnType<typeof setInterval> | null = null
  private _silenceCheckIntervalId: ReturnType<typeof setInterval> | null = null
  private _silenceThreshold: number = DEFAULT_AUDIO_CONSTANTS.SILENCE_THRESHOLD
  private _isInSilence = false
  private _onSilenceDetectedCallback: (() => void) | null = null
  private _onAudioDetectedCallback: (() => void) | null = null

  // ── Mixed stream ──────────────────────────────────────────────────────────
  private _mixedStreamContext: AudioContext | null = null
  private _mixedStreamDestination: MediaStreamAudioDestinationNode | null = null
  private _mixedStreamSourceNodes: MixedStreamNode[] = []

  // ── Chunk management ─────────────────────────────────────────────────────
  private _audioChunks: Blob[] = []
  private _currentChunkIndex = 0
  private _processingChunk = false
  private _isChunkSplit = false
  private _lastChunkEnd: number | null = null
  private _silenceStartForChunking: number | null = null
  private _chunkSplitIntervalId: ReturnType<typeof setInterval> | null = null
  private _onChunkProcessedCallback:
    | ((payload: ChunkProcessedPayload) => Promise<void> | void)
    | null = null
  private _pauseStartTime: number | null = null
  private _totalPausedTime = 0

  // ── Chunk options ─────────────────────────────────────────────────────────
  private _chunkOptions: ChunkOptions = {
    maxDuration: DEFAULT_AUDIO_CONSTANTS.MAX_CHUNK_DURATION,
    minDuration: DEFAULT_AUDIO_CONSTANTS.MIN_CHUNK_DURATION,
    minSilenceDuration: DEFAULT_AUDIO_CONSTANTS.MIN_SILENCE_DURATION,
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Initialises the recorder with the given stream and options.
   *
   * @example
   * const recorder = new AudioChunkify()
   * const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
   * recorder.create(stream, { timeslice: 250 })
   */
  create(stream: MediaStream, options: RecorderCreateOptions = {}): MediaRecorder {
    if (!(stream instanceof MediaStream)) {
      throw new TypeError('stream must be a MediaStream instance.')
    }

    // Resolve MIME type
    if (options.mimeType) {
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        throw new Error(`MIME type "${options.mimeType}" is not supported by this browser.`)
      }
      this._mimeType = options.mimeType
    } else {
      this._mimeType = getCompatibleMimeType()
    }

    this._timeslice = options.timeslice ?? null

    if (options.silenceThreshold !== undefined) {
      this.setSilenceThreshold(options.silenceThreshold)
    }

    if (options.chunkOptions) {
      this._chunkOptions = { ...this._chunkOptions, ...options.chunkOptions }
    }

    this._audioStreams = [stream]
    this._stream = this._createMixedStream()

    const recorderOptions: MediaRecorderOptions = {}
    if (this._mimeType) recorderOptions.mimeType = this._mimeType

    this._mediaRecorder = new MediaRecorder(this._stream, recorderOptions)
    this._setupEventHandlers()
    this._setupAudioAnalysis()

    return this._mediaRecorder
  }

  /** Starts recording. Optionally overrides the timeslice set in create(). */
  start(timeslice?: number): void {
    const mr = this._assertReady()

    if (mr.state === 'recording') {
      console.warn('[AudioChunkify] Already recording.')
      return
    }

    this._silenceStartForChunking = null
    const slice = timeslice ?? this._timeslice

    if (slice !== null && slice !== undefined) {
      mr.start(slice)
    } else {
      mr.start()
    }
  }

  /** Pauses an active recording. */
  pause(): void {
    const mr = this._assertReady()
    if (mr.state === 'recording') {
      mr.pause()
    } else {
      console.warn(`[AudioChunkify] Cannot pause — state is "${mr.state}".`)
    }
  }

  /** Resumes a paused recording. */
  resume(): void {
    const mr = this._assertReady()
    if (mr.state === 'paused') {
      mr.resume()
    } else {
      console.warn(`[AudioChunkify] Cannot resume — state is "${mr.state}".`)
    }
  }

  /** Stops the recording and finalises all pending chunks. */
  stop(): void {
    const mr = this._assertReady()
    this._stopChunkSplitting()
    if (mr.state !== 'inactive') {
      mr.stop()
    }
  }

  /**
   * Dynamically mixes in an additional audio stream.
   * The recorder is briefly restarted to rebuild the AudioContext graph.
   */
  addAudioStream(stream: MediaStream): void {
    if (!(stream instanceof MediaStream)) {
      throw new TypeError('stream must be a MediaStream instance.')
    }
    this._assertReady()
    if (this._audioStreams.includes(stream)) {
      console.warn('[AudioChunkify] Stream is already being mixed.')
      return
    }

    const { wasRecording, wasPaused } = this._captureState()
    if (wasRecording || wasPaused) this._mediaRecorder?.stop()
    this._audioStreams.push(stream)
    this._recreateMediaRecorder()
    this._restoreState(wasRecording, wasPaused)
  }

  /**
   * Removes a previously added audio stream from the mix.
   * At least one stream must remain — call destroy() to tear everything down.
   */
  removeAudioStream(stream: MediaStream): void {
    this._assertReady()
    const index = this._audioStreams.indexOf(stream)
    if (index === -1) {
      console.warn('[AudioChunkify] Stream not found.')
      return
    }

    if (this._audioStreams.length === 1) {
      throw new Error(
        'Cannot remove the last stream. Call destroy() to clean up instead.',
      )
    }

    const { wasRecording, wasPaused } = this._captureState()
    if (wasRecording || wasPaused) this._mediaRecorder?.stop()
    this._audioStreams.splice(index, 1)
    this._recreateMediaRecorder()
    this._restoreState(wasRecording, wasPaused)
  }

  // ── State & metadata ──────────────────────────────────────────────────────

  /** Current recorder state: 'inactive' | 'recording' | 'paused' */
  getState(): RecorderState {
    return (this._mediaRecorder?.state ?? 'inactive') as RecorderState
  }

  /** Active MIME type (resolved at create() time). */
  getMimeType(): string | null {
    return this._mimeType
  }

  /** The mixed MediaStream used internally by the recorder. */
  getStream(): MediaStream | null {
    return this._stream
  }

  /** The underlying MediaRecorder instance. */
  getMediaRecorder(): MediaRecorder | null {
    return this._mediaRecorder
  }

  /** Elapsed recording time in seconds (excludes paused time). */
  getRecordingTime(): number {
    return this._recordingTime
  }

  /** Resets the elapsed recording time counter to zero. */
  resetRecordingTime(): void {
    this._recordingTime = 0
    this._onTimeUpdateCallback?.(this._recordingTime)
  }

  /** Current continuous silence duration in seconds. */
  getSilenceTime(): number {
    return this._silenceTime
  }

  /** Current silence detection threshold in dB. */
  getSilenceThreshold(): number {
    return this._silenceThreshold
  }

  /**
   * Updates the silence detection threshold.
   * @param threshold — Must be a negative number in dB (e.g. -50).
   */
  setSilenceThreshold(threshold: number): void {
    if (typeof threshold !== 'number' || threshold > 0) {
      throw new RangeError('Silence threshold must be a negative number (dB).')
    }
    this._silenceThreshold = threshold
  }

  /** Accumulated audio chunks since the last start() or split. */
  getAudioChunks(): Blob[] {
    return [...this._audioChunks]
  }

  /** Zero-based index of the current chunk. */
  getCurrentChunkIndex(): number {
    return this._currentChunkIndex
  }

  /** Clears the internal chunk buffer. */
  clearAudioChunks(): void {
    this._audioChunks = []
  }

  // ── Event registration ────────────────────────────────────────────────────

  onDataAvailable(callback: (event: BlobEvent) => void): this {
    this._assertCallback(callback)
    this._onDataAvailableCallback = callback
    if (this._mediaRecorder) this._mediaRecorder.ondataavailable = callback
    return this
  }

  onStart(callback: () => void): this {
    this._assertCallback(callback)
    this._onStartCallback = callback
    if (this._mediaRecorder) this._setupEventHandlers()
    return this
  }

  onPause(callback: () => void): this {
    this._assertCallback(callback)
    this._onPauseCallback = callback
    if (this._mediaRecorder) this._setupEventHandlers()
    return this
  }

  onResume(callback: () => void): this {
    this._assertCallback(callback)
    this._onResumeCallback = callback
    if (this._mediaRecorder) this._setupEventHandlers()
    return this
  }

  onStop(callback: () => void): this {
    this._assertCallback(callback)
    this._onStopCallback = callback
    if (this._mediaRecorder) this._setupEventHandlers()
    return this
  }

  onError(callback: (event: Event) => void): this {
    this._assertCallback(callback)
    this._onErrorCallback = callback
    if (this._mediaRecorder) this._mediaRecorder.onerror = callback
    return this
  }

  onTimeUpdate(callback: (seconds: number) => void): this {
    this._assertCallback(callback)
    this._onTimeUpdateCallback = callback
    return this
  }

  onSilenceDetected(callback: () => void): this {
    this._assertCallback(callback)
    this._onSilenceDetectedCallback = callback
    return this
  }

  onAudioDetected(callback: () => void): this {
    this._assertCallback(callback)
    this._onAudioDetectedCallback = callback
    return this
  }

  /**
   * Called each time a chunk is finalised (either by splitting or on stop).
   *
   * @example
   * recorder.onChunkProcessed(async ({ file, index, duration, isLastChunk }) => {
   *   await uploadChunk(file)
   *   if (isLastChunk) console.log('Recording complete')
   * })
   */
  onChunkProcessed(
    callback: (payload: ChunkProcessedPayload) => Promise<void> | void,
  ): this {
    this._assertCallback(callback)
    this._onChunkProcessedCallback = callback
    return this
  }

  /**
   * Fully tears down the recorder: stops recording, closes AudioContexts
   * and clears all internal state.
   *
   * By default also stops every track on the input streams. Pass
   * `{ stopStreams: false }` to keep those streams alive for reuse.
   */
  destroy(options: DestroyOptions = {}): void {
    const { stopStreams = true } = options

    if (this._mediaRecorder?.state !== 'inactive') {
      this._mediaRecorder?.stop()
    }

    if (stopStreams) {
      this._audioStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    }

    this._stopTimeTracking()
    this._recordingTime = 0

    this._cleanupAudioAnalysis()
    this._silenceTime = 0
    this._isInSilence = false

    this._stopChunkSplitting()
    this._audioChunks = []
    this._currentChunkIndex = 0
    this._processingChunk = false
    this._isChunkSplit = false
    this._lastChunkEnd = null
    this._silenceStartForChunking = null
    this._pauseStartTime = null
    this._totalPausedTime = 0

    this._cleanupMixedStream()

    this._mediaRecorder = null
    this._stream = null
    this._audioStreams = []
    this._mimeType = null
    this._timeslice = null

    this._onDataAvailableCallback = null
    this._onStartCallback = null
    this._onPauseCallback = null
    this._onResumeCallback = null
    this._onStopCallback = null
    this._onErrorCallback = null
    this._onTimeUpdateCallback = null
    this._onSilenceDetectedCallback = null
    this._onAudioDetectedCallback = null
    this._onChunkProcessedCallback = null
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _assertReady(): MediaRecorder {
    if (!this._mediaRecorder) {
      throw new Error('[AudioChunkify] Not initialised. Call create() first.')
    }
    return this._mediaRecorder
  }

  private _assertCallback(fn: unknown): void {
    if (typeof fn !== 'function') {
      throw new TypeError('Callback must be a function.')
    }
  }

  private _captureState() {
    return {
      wasRecording: this._mediaRecorder?.state === 'recording',
      wasPaused: this._mediaRecorder?.state === 'paused',
    }
  }

  private _restoreState(wasRecording: boolean, wasPaused: boolean): void {
    if (wasRecording) {
      this.start()
    } else if (wasPaused) {
      this.start()
      this.pause()
    }
  }

  private _now(): number {
    if (this._audioContext?.state === 'running') {
      return this._audioContext.currentTime
    }
    return Date.now() / 1000
  }

  // ── Time tracking ─────────────────────────────────────────────────────────

  private _startTimeTracking(): void {
    this._stopTimeTracking()
    this._intervalId = setInterval(() => {
      this._recordingTime++
      this._onTimeUpdateCallback?.(this._recordingTime)
    }, 1000)
  }

  private _stopTimeTracking(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }

  private _pauseTimeTracking(): void {
    this._stopTimeTracking()
  }

  private _resumeTimeTracking(): void {
    this._startTimeTracking()
  }

  // ── Audio analysis ────────────────────────────────────────────────────────

  private _setupAudioAnalysis(): void {
    if (!this._stream) return
    this._cleanupAudioAnalysis()

    try {
      this._audioContext = new AudioContext()
      this._analyserNode = this._audioContext.createAnalyser()
      this._analyserNode.fftSize = DEFAULT_AUDIO_CONSTANTS.ANALYSIS_BUFFER_SIZE
      this._analyserNode.smoothingTimeConstant = 0.8
      this._sourceNode = this._audioContext.createMediaStreamSource(this._stream)
      this._sourceNode.connect(this._analyserNode)
    } catch (err) {
      console.warn('[AudioChunkify] Could not set up audio analysis:', err)
      this._cleanupAudioAnalysis()
    }
  }

  private _cleanupAudioAnalysis(): void {
    this._stopSilenceTracking()

    try { this._sourceNode?.disconnect() } catch { /* noop */ }
    this._sourceNode = null

    try { this._analyserNode?.disconnect() } catch { /* noop */ }
    this._analyserNode = null

    if (this._audioContext && this._audioContext.state !== 'closed') {
      this._audioContext.close().catch(() => { /* noop */ })
    }
    this._audioContext = null
  }

  /**
   * Measures the current audio level in dBFS via time-domain RMS.
   * Shared by silence events and chunk-splitting logic.
   */
  private _measureAudioLevelDb(): number {
    if (!this._analyserNode) return -Infinity

    const data = new Float32Array(this._analyserNode.fftSize)
    this._analyserNode.getFloatTimeDomainData(data)

    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!
    const rms = Math.sqrt(sum / data.length)
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity
  }

  private _isCurrentlySilent(): boolean {
    if (!this._analyserNode || this._audioContext?.state !== 'running') return false

    try {
      return this._measureAudioLevelDb() < this._silenceThreshold
    } catch {
      return false
    }
  }

  private _checkSilence(): void {
    if (!this._analyserNode || this._audioContext?.state !== 'running') return

    try {
      const isSilent = this._isCurrentlySilent()

      if (isSilent && !this._isInSilence) {
        this._isInSilence = true
        if (!this._silenceIntervalId) {
          this._silenceIntervalId = setInterval(() => {
            if (this._isInSilence) this._silenceTime++
          }, 1000)
        }
        this._onSilenceDetectedCallback?.()
      } else if (!isSilent && this._isInSilence) {
        this._isInSilence = false
        if (this._silenceIntervalId !== null) {
          clearInterval(this._silenceIntervalId)
          this._silenceIntervalId = null
        }
        this._silenceTime = 0
        this._onAudioDetectedCallback?.()
      }
    } catch (err) {
      console.warn('[AudioChunkify] Silence check error:', err)
    }
  }

  private _startSilenceChecking(): void {
    if (this._silenceCheckIntervalId !== null) {
      clearInterval(this._silenceCheckIntervalId)
    }
    this._silenceCheckIntervalId = setInterval(() => this._checkSilence(), 100)
  }

  private _stopSilenceTracking(): void {
    if (this._silenceIntervalId !== null) {
      clearInterval(this._silenceIntervalId)
      this._silenceIntervalId = null
    }
    if (this._silenceCheckIntervalId !== null) {
      clearInterval(this._silenceCheckIntervalId)
      this._silenceCheckIntervalId = null
    }
    this._isInSilence = false
  }

  // ── Chunk splitting ───────────────────────────────────────────────────────

  private _shouldSplitChunk(): boolean {
    if (this._mediaRecorder?.state === 'paused') return false
    if (this._lastChunkEnd === null) return false

    const currentTime = this._now()
    const elapsed = currentTime - this._lastChunkEnd

    if (elapsed >= this._chunkOptions.maxDuration) return true

    if (elapsed >= this._chunkOptions.minDuration) {
      if (this._isCurrentlySilent()) {
        if (!this._silenceStartForChunking) {
          this._silenceStartForChunking = currentTime
        }
        if (currentTime - this._silenceStartForChunking >= this._chunkOptions.minSilenceDuration) {
          return true
        }
      } else {
        this._silenceStartForChunking = null
      }
    }

    return false
  }

  private _restartRecorderSegment(): void {
    if (
      this._mediaRecorder?.state === 'recording' &&
      !this._processingChunk
    ) {
      this._isChunkSplit = true
      this._mediaRecorder.stop()
    }
  }

  private _startChunkSplitting(): void {
    this._stopChunkSplitting()
    this._chunkSplitIntervalId = setInterval(() => {
      if (
        this._mediaRecorder?.state === 'recording' &&
        !this._processingChunk &&
        this._shouldSplitChunk()
      ) {
        this._restartRecorderSegment()
      }
    }, 100)
  }

  private _stopChunkSplitting(): void {
    if (this._chunkSplitIntervalId !== null) {
      clearInterval(this._chunkSplitIntervalId)
      this._chunkSplitIntervalId = null
    }
  }

  // ── Mixed stream ──────────────────────────────────────────────────────────

  private _createMixedStream(): MediaStream {
    if (!this._audioStreams.length) return new MediaStream()

    if (this._mixedStreamDestination) this._cleanupMixedStream()

    try {
      this._mixedStreamContext = new AudioContext()
      this._mixedStreamDestination =
        this._mixedStreamContext.createMediaStreamDestination()
      this._mixedStreamSourceNodes = []

      for (const stream of this._audioStreams) {
        if (stream.getAudioTracks().length > 0) {
          const source = this._mixedStreamContext.createMediaStreamSource(stream)
          const gainNode = this._mixedStreamContext.createGain()
          gainNode.gain.value = 1.0
          source.connect(gainNode)
          gainNode.connect(this._mixedStreamDestination)
          this._mixedStreamSourceNodes.push({ source, gainNode })
        }
      }

      return this._mixedStreamDestination.stream
    } catch (err) {
      console.warn('[AudioChunkify] Could not create mixed stream, falling back:', err)
      const fallback = new MediaStream()
      this._audioStreams.forEach((s) =>
        s.getAudioTracks().forEach((t) => fallback.addTrack(t)),
      )
      return fallback
    }
  }

  private _recreateMediaRecorder(): void {
    this._stream = this._createMixedStream()

    const opts: MediaRecorderOptions = {}
    if (this._mimeType) opts.mimeType = this._mimeType

    this._mediaRecorder = new MediaRecorder(this._stream, opts)
    this._setupEventHandlers()
    this._setupAudioAnalysis()
  }

  private _cleanupMixedStream(): void {
    for (const { source, gainNode } of this._mixedStreamSourceNodes) {
      try { gainNode.disconnect() } catch { /* noop */ }
      try { source.disconnect() } catch { /* noop */ }
    }
    this._mixedStreamSourceNodes = []

    try {
      this._mixedStreamDestination?.stream
        .getTracks()
        .forEach((t) => t.stop())
    } catch { /* noop */ }
    this._mixedStreamDestination = null

    if (this._mixedStreamContext?.state !== 'closed') {
      this._mixedStreamContext?.close().catch(() => { /* noop */ })
    }
    this._mixedStreamContext = null
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  private _setupEventHandlers(): void {
    if (!this._mediaRecorder) return

    this._mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data?.size > 0) {
        this._audioChunks.push(event.data)
        this._onDataAvailableCallback?.(event)
      }
    }

    this._mediaRecorder.onstart = () => {
      this._startTimeTracking()

      if (this._audioContext?.state === 'suspended') {
        this._audioContext.resume()
      }
      this._startSilenceChecking()

      if (this._lastChunkEnd === null) {
        this._lastChunkEnd = this._now()
      }

      this._audioChunks = []
      this._silenceStartForChunking = null
      this._startChunkSplitting()
      this._onStartCallback?.()
    }

    this._mediaRecorder.onpause = () => {
      this._pauseTimeTracking()
      this._stopSilenceTracking()
      this._stopChunkSplitting()
      this._pauseStartTime = this._now()
      this._onPauseCallback?.()
    }

    this._mediaRecorder.onresume = () => {
      this._resumeTimeTracking()

      if (this._audioContext?.state === 'suspended') {
        this._audioContext.resume()
      }

      if (this._pauseStartTime !== null) {
        const pausedDuration = this._now() - this._pauseStartTime
        this._totalPausedTime += pausedDuration
        if (this._lastChunkEnd !== null) {
          this._lastChunkEnd += pausedDuration
        }
        this._pauseStartTime = null
      }

      this._startSilenceChecking()
      this._startChunkSplitting()
      this._onResumeCallback?.()
    }

    this._mediaRecorder.onstop = async () => {
      this._stopTimeTracking()
      this._stopSilenceTracking()
      this._stopChunkSplitting()

      if (this._isChunkSplit) {
        await this._processChunk(false)

        this._audioChunks = []
        this._silenceStartForChunking = null

        // Restart the MediaRecorder to get fresh headers for the next segment
        const opts: MediaRecorderOptions = {}
        if (this._mimeType) opts.mimeType = this._mimeType

        this._mediaRecorder = new MediaRecorder(this._stream!, opts)
        this._setupEventHandlers()
        this._isChunkSplit = false

        if (this._timeslice !== null) {
          this._mediaRecorder.start(this._timeslice)
        } else {
          this._mediaRecorder.start()
        }
      } else {
        await this._processChunk(true)

        this.resetRecordingTime()
        this._silenceTime = 0
        this._audioChunks = []
        this._currentChunkIndex = 0
        this._lastChunkEnd = null
        this._silenceStartForChunking = null
        this._pauseStartTime = null
        this._totalPausedTime = 0
        this._onStopCallback?.()
      }
    }

    if (this._onErrorCallback) {
      this._mediaRecorder.onerror = this._onErrorCallback
    }
  }

  private async _processChunk(isLastChunk: boolean): Promise<void> {
    if (
      !this._audioChunks.length ||
      !this._onChunkProcessedCallback ||
      this._processingChunk
    ) return

    this._processingChunk = true

    try {
      const mimeType = this._mimeType ?? getCompatibleMimeType() ?? 'audio/webm'
      const ext = getFileExtensionFromMimeType(mimeType)

      const now = this._now()
      let pausedCompensation = 0
      if (this._pauseStartTime !== null) {
        pausedCompensation = now - this._pauseStartTime
      }

      const duration =
        this._lastChunkEnd !== null
          ? now - this._lastChunkEnd - pausedCompensation
          : 0

      const index = this._currentChunkIndex
      const blob = new Blob(this._audioChunks, { type: mimeType })
      const file = new File([blob], `chunk-${index}.${ext}`, { type: mimeType })

      await this._onChunkProcessedCallback({ file, index, duration, isLastChunk })

      if (!isLastChunk) {
        this._currentChunkIndex = index + 1
        this._lastChunkEnd = this._now()
        this._totalPausedTime = 0
      }
    } catch (err) {
      console.error('[AudioChunkify] Error processing chunk:', err)
    } finally {
      this._processingChunk = false
    }
  }
}
