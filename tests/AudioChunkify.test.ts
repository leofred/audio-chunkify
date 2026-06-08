import { describe, expect, it, vi } from 'vitest'
import { AudioChunkify } from '../src/AudioChunkify.js'
import { DEFAULT_AUDIO_CONSTANTS } from '../src/constants.js'
import type { ChunkProcessedPayload } from '../src/types.js'
import {
  MockMediaRecorder,
  MockMediaStream,
  MockMediaStreamTrack,
  advanceMockAudioTime,
  flushAsync,
  setMockAudioLevelDb,
  tick,
} from './helpers/browserMocks.js'

function createRecorder(stream = new MockMediaStream()) {
  const recorder = new AudioChunkify()
  recorder.create(stream, { mimeType: 'audio/webm' })
  return { recorder, stream }
}

function sampleBlob(size = 128): Blob {
  return new Blob([new Uint8Array(size)], { type: 'audio/webm' })
}

async function startWithData(recorder: AudioChunkify): Promise<MockMediaRecorder> {
  recorder.start()
  const mr = recorder.getMediaRecorder() as unknown as MockMediaRecorder
  mr.emitDataAvailable(sampleBlob())
  await flushAsync()
  return mr
}

// ── Validation & setup ────────────────────────────────────────────────────────

describe('AudioChunkify — validation', () => {
  it('throws if create() is called without a MediaStream', () => {
    const recorder = new AudioChunkify()
    expect(() => recorder.create({} as MediaStream)).toThrow(TypeError)
  })

  it('throws if start() is called before create()', () => {
    const recorder = new AudioChunkify()
    expect(() => recorder.start()).toThrow(/Not initialised/)
  })

  it('throws for unsupported MIME type', () => {
    const recorder = new AudioChunkify()
    expect(() =>
      recorder.create(new MockMediaStream(), { mimeType: 'audio/unsupported' }),
    ).toThrow(/not supported/)
  })

  it('throws when silence threshold is positive', () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream())
    expect(() => recorder.setSilenceThreshold(10)).toThrow(RangeError)
  })

  it('throws when registering a non-function callback', () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream())
    expect(() => recorder.onStart('nope' as unknown as () => void)).toThrow(TypeError)
  })
})

describe('AudioChunkify — create & getters', () => {
  it('resolves MIME type and exposes getters', () => {
    const { recorder } = createRecorder()
    expect(recorder.getMimeType()).toBe('audio/webm')
    expect(recorder.getState()).toBe('inactive')
    expect(recorder.getStream()).toBeTruthy()
    expect(recorder.getMediaRecorder()).toBeTruthy()
    expect(recorder.getSilenceThreshold()).toBe(DEFAULT_AUDIO_CONSTANTS.SILENCE_THRESHOLD)
    expect(recorder.getCurrentChunkIndex()).toBe(0)
  })

  it('applies custom silenceThreshold and chunkOptions', () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream(), {
      mimeType: 'audio/webm',
      silenceThreshold: -40,
      chunkOptions: { minDuration: 5, maxDuration: 10, minSilenceDuration: 0.5 },
    })

    expect(recorder.getSilenceThreshold()).toBe(-40)
  })

  it('supports fluent event registration', () => {
    const { recorder } = createRecorder()
    const result = recorder.onStart(vi.fn()).onStop(vi.fn())
    expect(result).toBe(recorder)
  })
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('AudioChunkify — lifecycle', () => {
  it('fires onStart when recording begins', async () => {
    const { recorder } = createRecorder()
    const onStart = vi.fn()
    recorder.onStart(onStart)
    await startWithData(recorder)

    expect(recorder.getState()).toBe('recording')
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('increments recording time every second while active', async () => {
    const { recorder } = createRecorder()
    const times: number[] = []
    recorder.onTimeUpdate((t) => times.push(t))
    await startWithData(recorder)

    await tick(1000)
    await tick(1000)

    expect(recorder.getRecordingTime()).toBe(2)
    expect(times).toEqual([1, 2])
  })

  it('pauses and resumes without counting paused time in chunk window', async () => {
    const { recorder } = createRecorder()
    const onPause = vi.fn()
    const onResume = vi.fn()
    recorder.onPause(onPause).onResume(onResume)
    await startWithData(recorder)

    recorder.pause()
    await flushAsync()
    expect(onPause).toHaveBeenCalledOnce()
    expect(recorder.getState()).toBe('paused')

    advanceMockAudioTime(5)
    recorder.resume()
    await flushAsync()
    expect(onResume).toHaveBeenCalledOnce()
    expect(recorder.getState()).toBe('recording')
  })

  it('fires onStop and delivers final chunk on stop()', async () => {
    const { recorder } = createRecorder()
    const onStop = vi.fn()
    const chunks: ChunkProcessedPayload[] = []

    recorder
      .onStop(onStop)
      .onChunkProcessed((payload) => { chunks.push(payload) })

    await startWithData(recorder)
    recorder.stop()
    await flushAsync()

    expect(onStop).toHaveBeenCalledOnce()
    expect(recorder.getState()).toBe('inactive')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.isLastChunk).toBe(true)
    expect(chunks[0]?.index).toBe(0)
    expect(chunks[0]?.file.name).toBe('chunk-0.webm')
    expect(chunks[0]?.file.type).toBe('audio/webm')
  })
})

// ── Silence detection ─────────────────────────────────────────────────────────

describe('AudioChunkify — silence detection', () => {
  it('fires onSilenceDetected and onAudioDetected using the configured threshold', async () => {
    const { recorder } = createRecorder()
    recorder.setSilenceThreshold(-30)

    const onSilence = vi.fn()
    const onAudio = vi.fn()
    recorder.onSilenceDetected(onSilence).onAudioDetected(onAudio)

    setMockAudioLevelDb(-20) // above -30 → not silent
    await startWithData(recorder)
    await tick(100)

    setMockAudioLevelDb(-50) // below -30 → silent
    await tick(100)
    expect(onSilence).toHaveBeenCalledOnce()

    setMockAudioLevelDb(-20)
    await tick(100)
    expect(onAudio).toHaveBeenCalledOnce()
  })

  it('accumulates silence time while signal stays below threshold', async () => {
    const { recorder } = createRecorder()
    recorder.setSilenceThreshold(-30)

    setMockAudioLevelDb(-60) // clearly below -30 (exact threshold is exclusive)
    await startWithData(recorder)
    await tick(100) // first silence check → enters silent state
    expect(recorder.getSilenceTime()).toBe(0)

    await tick(1000)
    expect(recorder.getSilenceTime()).toBe(1)

    await tick(1000)
    expect(recorder.getSilenceTime()).toBe(2)
  })
})

// ── Chunk splitting ───────────────────────────────────────────────────────────

describe('AudioChunkify — chunk splitting', () => {
  it('splits on maxDuration and increments chunk index', async () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream(), {
      mimeType: 'audio/webm',
      chunkOptions: { minDuration: 1, maxDuration: 3, minSilenceDuration: 1 },
    })

    const chunks: ChunkProcessedPayload[] = []
    recorder.onChunkProcessed((p) => { chunks.push(p) })

    setMockAudioLevelDb(-20)
    const mr = await startWithData(recorder) // emits blob so split can produce a chunk

    advanceMockAudioTime(3.1)
    await tick(100) // chunk split interval
    await flushAsync()

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.isLastChunk).toBe(false)
    expect(chunks[0]?.index).toBe(0)
    expect(recorder.getCurrentChunkIndex()).toBe(1)

    mr.emitDataAvailable(sampleBlob())
    recorder.stop()
    await flushAsync()

    expect(chunks).toHaveLength(2)
    expect(chunks[1]?.isLastChunk).toBe(true)
    expect(chunks[1]?.index).toBe(1)
  })

  it('splits on sustained silence after minDuration using custom threshold', async () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream(), {
      mimeType: 'audio/webm',
      silenceThreshold: -35,
      chunkOptions: { minDuration: 2, maxDuration: 60, minSilenceDuration: 1 },
    })

    const chunks: ChunkProcessedPayload[] = []
    recorder.onChunkProcessed((p) => { chunks.push(p) })

    setMockAudioLevelDb(-20)
    await startWithData(recorder) // emits blob so split can produce a chunk

    advanceMockAudioTime(2.5) // past minDuration while still loud
    setMockAudioLevelDb(-60) // below custom threshold of -35
    await tick(100) // first silent check → marks silence start at t=2.5
    advanceMockAudioTime(1.1) // sustain silence (AudioContext clock, not fake timers)
    await tick(100) // chunk-split interval sees minSilenceDuration met
    await flushAsync()

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.isLastChunk).toBe(false)
  })

  it('does not split while paused', async () => {
    const recorder = new AudioChunkify()
    recorder.create(new MockMediaStream(), {
      mimeType: 'audio/webm',
      chunkOptions: { minDuration: 1, maxDuration: 2, minSilenceDuration: 0.5 },
    })

    const chunks: ChunkProcessedPayload[] = []
    recorder.onChunkProcessed((p) => { chunks.push(p) })

    await startWithData(recorder)
    recorder.pause()
    await flushAsync()

    advanceMockAudioTime(10)
    await tick(200)
    await flushAsync()

    expect(chunks).toHaveLength(0)
  })
})

// ── Stream mixing ───────────────────────────────────────────────────────────────

describe('AudioChunkify — stream mixing', () => {
  it('adds a second stream and keeps recording', async () => {
    const stream1 = new MockMediaStream()
    const stream2 = new MockMediaStream()
    const { recorder } = createRecorder(stream1)

    await startWithData(recorder)
    recorder.addAudioStream(stream2)
    await flushAsync()

    expect(recorder.getState()).toBe('recording')
  })

  it('warns when adding a duplicate stream', async () => {
    const stream = new MockMediaStream()
    const { recorder } = createRecorder(stream)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    recorder.addAudioStream(stream)
    expect(warn).toHaveBeenCalledWith('[AudioChunkify] Stream is already being mixed.')
  })

  it('throws when removing the last stream', () => {
    const stream = new MockMediaStream()
    const { recorder } = createRecorder(stream)

    expect(() => recorder.removeAudioStream(stream)).toThrow(/last stream/)
  })

  it('removes a stream from the mix', async () => {
    const stream1 = new MockMediaStream()
    const stream2 = new MockMediaStream()
    const recorder = new AudioChunkify()
    recorder.create(stream1, { mimeType: 'audio/webm' })
    recorder.addAudioStream(stream2)

    await startWithData(recorder)
    recorder.removeAudioStream(stream2)
    await flushAsync()

    expect(recorder.getState()).toBe('recording')
  })
})

// ── Cleanup ─────────────────────────────────────────────────────────────────────

describe('AudioChunkify — destroy', () => {
  it('stops tracks by default and resets state', async () => {
    const track = new MockMediaStreamTrack()
    const stream = new MockMediaStream([track])
    const { recorder } = createRecorder(stream)

    await startWithData(recorder)
    recorder.destroy()

    expect(track.stop).toHaveBeenCalled()
    expect(recorder.getMediaRecorder()).toBeNull()
    expect(recorder.getStream()).toBeNull()
    expect(recorder.getState()).toBe('inactive')
  })

  it('keeps input stream tracks when stopStreams is false', async () => {
    const track = new MockMediaStreamTrack()
    const stream = new MockMediaStream([track])
    const { recorder } = createRecorder(stream)

    await startWithData(recorder)
    recorder.destroy({ stopStreams: false })

    expect(track.stop).not.toHaveBeenCalled()
    expect(recorder.getMediaRecorder()).toBeNull()
    expect(recorder.getState()).toBe('inactive')
  })
})
