import { vi } from 'vitest'

// ── Controllable test state ───────────────────────────────────────────────────

let mockAudioTime = 0
let mockAmplitude = 0.1 // default ≈ -20 dBFS (above -50 threshold)

export function resetBrowserMocks(): void {
  mockAudioTime = 0
  mockAmplitude = 0.1
}

export function advanceMockAudioTime(seconds: number): void {
  mockAudioTime += seconds
}

/** Sets a constant signal level in dBFS for AnalyserNode mock reads. */
export function setMockAudioLevelDb(db: number): void {
  mockAmplitude = db === -Infinity || db <= -100 ? 0 : 10 ** (db / 20)
}

export function getMockAudioTime(): number {
  return mockAudioTime
}

// ── MediaStream ───────────────────────────────────────────────────────────────

export class MockMediaStreamTrack {
  kind = 'audio' as const
  stop = vi.fn()
}

export class MockMediaStream {
  private readonly _tracks: MockMediaStreamTrack[]

  constructor(tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()]) {
    this._tracks = tracks
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this._tracks
  }

  getTracks(): MockMediaStreamTrack[] {
    return this._tracks
  }

  addTrack(track: MockMediaStreamTrack): void {
    this._tracks.push(track)
  }
}

// ── MediaRecorder ─────────────────────────────────────────────────────────────

export class MockMediaRecorder {
  static isTypeSupported = vi.fn((mimeType: string) =>
    [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ].includes(mimeType),
  )

  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  stream: MockMediaStream
  mimeType?: string

  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstart: (() => void) | null = null
  onpause: (() => void) | null = null
  onresume: (() => void) | null = null
  onstop: (() => void | Promise<void>) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(stream: MockMediaStream, options?: { mimeType?: string }) {
    this.stream = stream
    this.mimeType = options?.mimeType
  }

  start(_timeslice?: number): void {
    if (this.state === 'recording') return
    this.state = 'recording'
    this.onstart?.()
  }

  stop(): void {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    void this.onstop?.()
  }

  pause(): void {
    if (this.state !== 'recording') return
    this.state = 'paused'
    this.onpause?.()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'recording'
    this.onresume?.()
  }

  emitDataAvailable(data: Blob): void {
    this.ondataavailable?.({ data } as BlobEvent)
  }
}

// ── Web Audio API ─────────────────────────────────────────────────────────────

class MockAnalyserNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  frequencyBinCount = 1024

  connect(): void { /* noop */ }
  disconnect(): void { /* noop */ }

  getFloatTimeDomainData(array: Float32Array): void {
    for (let i = 0; i < array.length; i++) {
      array[i] = mockAmplitude
    }
  }
}

class MockGainNode {
  gain = { value: 1 }
  connect(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

class MockMediaStreamAudioSourceNode {
  connect(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

class MockMediaStreamDestinationNode {
  stream = new MockMediaStream()
}

export class MockAudioContext {
  state: AudioContextState = 'running'

  get currentTime(): number {
    return mockAudioTime
  }

  createAnalyser(): MockAnalyserNode {
    return new MockAnalyserNode()
  }

  createGain(): MockGainNode {
    return new MockGainNode()
  }

  createMediaStreamSource(_stream: MockMediaStream): MockMediaStreamAudioSourceNode {
    return new MockMediaStreamAudioSourceNode()
  }

  createMediaStreamDestination(): MockMediaStreamDestinationNode {
    return new MockMediaStreamDestinationNode()
  }

  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

// ── Install globals ───────────────────────────────────────────────────────────

export function installBrowserMocks(): void {
  vi.stubGlobal('MediaStream', MockMediaStream)
  vi.stubGlobal('MediaRecorder', MockMediaRecorder)
  vi.stubGlobal('AudioContext', MockAudioContext)

  if (typeof globalThis.Blob === 'undefined') {
    vi.stubGlobal('Blob', class Blob {
      size: number
      type: string
      constructor(parts: BlobPart[] = [], options: BlobPropertyBag = {}) {
        this.type = options.type ?? ''
        this.size = parts.reduce((sum, part) => {
          if (typeof part === 'string') return sum + part.length
          if (part instanceof ArrayBuffer) return sum + part.byteLength
          return sum + part.byteLength
        }, 0)
      }
    })
  }

  if (typeof globalThis.File === 'undefined') {
    vi.stubGlobal('File', class File extends Blob {
      name: string
      lastModified: number
      constructor(parts: BlobPart[], name: string, options: FilePropertyBag = {}) {
        super(parts, options)
        this.name = name
        this.lastModified = options.lastModified ?? Date.now()
      }
    })
  }
}

/** Drains microtasks after async MediaRecorder handlers. */
export async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** Advances fake timers and flushes async work. */
export async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushAsync()
}
