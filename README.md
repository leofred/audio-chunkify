# audio-chunkify

**Record audio in the browser and automatically split it into chunks — by silence, by time, or both.**

Framework agnostic · Zero dependencies · TypeScript · ESM

---

## Why audio-chunkify?

Long audio recordings are a problem: large files are slow to upload, expensive to process, and painful to recover from if something goes wrong. `audio-chunkify` solves this by splitting recordings into smaller, manageable chunks as they happen — in real time, without gaps or clicks.

Each chunk lands in an `onChunkProcessed` callback as a `File` object, ready to upload the moment it's created.

```
[──────────────── recording ────────────────────────────────]
[── chunk 0 ──][── chunk 1 ──][── chunk 2 ──][── chunk 3 ──]
     ↓               ↓               ↓               ↓
  upload()        upload()        upload()      upload() ← final
```

Splitting happens automatically: after a minimum duration, the recorder listens for a moment of silence and cuts there. If no silence comes, it cuts at a configurable maximum duration. You get clean boundaries and parallel uploads, without any manual work.

---

## Features

- ✂️ **Smart chunk splitting** — cuts at silence after a minimum duration, or forces a cut at maximum duration
- 🔇 **Real-time silence detection** — dB analysis via Web Audio API, configurable threshold
- 🔀 **Multi-stream mixing** — merge microphone + system audio (or any streams) into one recording
- ⏱️ **Time tracking** — elapsed recording time, pause-aware
- 📦 **TypeScript** — full type definitions included
- 🪶 **Zero dependencies**
- ⚙️ **Works with React, Vue, Svelte, Angular, Vanilla JS** — or any browser environment

---

## Installation

```bash
npm install audio-chunkify
# or
pnpm add audio-chunkify
# or
yarn add audio-chunkify
```

---

## Quick start

```ts
import { AudioChunkify } from 'audio-chunkify'

const recorder = new AudioChunkify()
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

recorder.create(stream)

// Called automatically as each chunk is ready
recorder.onChunkProcessed(async ({ file, index, duration, isLastChunk }) => {
  console.log(`Chunk ${index} — ${duration.toFixed(1)}s`)
  await uploadToServer(file) // upload while recording continues

  if (isLastChunk) {
    console.log('Recording complete')
  }
})

recorder.start()

// Later...
recorder.stop()

// Always release resources when done
recorder.destroy()
```

---

## How chunking works

```
minDuration ──────────────┐
                           ↓
[recording...]  [silence detected?] ──yes──→ split here ✂️
                           │
                          no
                           │
maxDuration ───────────────┴──────────────→ force split ✂️
```

| Parameter | Default | Description |
|---|---|---|
| `minDuration` | `30s` | Chunk won't split before this time |
| `maxDuration` | `300s` | Chunk always splits after this time |
| `minSilenceDuration` | `1s` | Silence must last this long to trigger a split |
| `silenceThreshold` | `-50 dB` | Audio below this level is considered silence |

All four values are configurable:

```ts
recorder.create(stream, {
  timeslice: 250,
  silenceThreshold: -45,
  chunkOptions: {
    minDuration: 10,
    maxDuration: 60,
    minSilenceDuration: 1.5,
  },
})
```

---

## API

### `new AudioChunkify()`

Creates a new instance. No arguments required.

---

### `.create(stream, options?)`

Initialises the recorder. Must be called before `start()`.

| Option | Type | Default | Description |
|---|---|---|---|
| `mimeType` | `string` | auto | Force a specific MIME type (e.g. `'audio/webm;codecs=opus'`). Auto-detected if omitted. |
| `timeslice` | `number` | — | Millisecond interval for internal `ondataavailable` events |
| `silenceThreshold` | `number` | `-50` | dB threshold for silence detection |
| `chunkOptions.minDuration` | `number` | `30` | Minimum chunk duration in seconds |
| `chunkOptions.maxDuration` | `number` | `300` | Maximum chunk duration in seconds |
| `chunkOptions.minSilenceDuration` | `number` | `1` | Seconds of silence required to trigger a split |

Returns the underlying `MediaRecorder` instance.

---

### `.start(timeslice?)` / `.pause()` / `.resume()` / `.stop()`

Control the recording lifecycle. Pause/resume correctly accounts for paused time when calculating chunk durations.

---

### `.addAudioStream(stream)` / `.removeAudioStream(stream)`

Dynamically add or remove streams from the mix at any time. The internal `AudioContext` graph is rebuilt transparently.

---

### `.destroy(options?)`

Stops recording, closes internal `AudioContext` instances, and clears all state. Always call this when done to avoid memory leaks.

| Option | Type | Default | Description |
|---|---|---|---|
| `stopStreams` | `boolean` | `true` | When `true`, calls `stop()` on every track of the streams you passed to `create()` / `addAudioStream()`. Set to `false` to keep those streams alive (e.g. reuse the same microphone for another recording). |

By default, `destroy()` releases the microphone and any other input tracks — same as today. If you own the `MediaStream` and want to keep it after teardown:

```ts
recorder.stop()
recorder.destroy({ stopStreams: false })

// stream is still active — safe to pass to a new AudioChunkify instance
const next = new AudioChunkify()
next.create(stream)
```

When unmounting a component or leaving a page, keep the default (`stopStreams: true`) so the browser releases the mic indicator.

---

### State & metadata

| Method | Returns | Description |
|---|---|---|
| `.getState()` | `'inactive' \| 'recording' \| 'paused'` | Current state |
| `.getMimeType()` | `string \| null` | Active MIME type |
| `.getStream()` | `MediaStream \| null` | The mixed audio stream |
| `.getMediaRecorder()` | `MediaRecorder \| null` | The underlying `MediaRecorder` |
| `.getRecordingTime()` | `number` | Elapsed seconds (excludes paused time) |
| `.getSilenceTime()` | `number` | Continuous silence in seconds |
| `.getSilenceThreshold()` | `number` | Current dB threshold |
| `.setSilenceThreshold(dB)` | `void` | Update the dB threshold (must be negative) |
| `.getCurrentChunkIndex()` | `number` | Zero-based index of the current chunk |
| `.getAudioChunks()` | `Blob[]` | Current internal chunk buffer |

---

### Events

All `on*` methods return `this` for chaining.

```ts
recorder
  .onStart(() => setUI('recording'))
  .onPause(() => setUI('paused'))
  .onResume(() => setUI('recording'))
  .onStop(() => setUI('idle'))
  .onTimeUpdate((seconds) => setTimer(seconds))
  .onSilenceDetected(() => console.log('silence…'))
  .onAudioDetected(() => console.log('audio resumed'))
  .onError((e) => console.error(e))
  .onChunkProcessed(async ({ file, index, duration, isLastChunk }) => {
    await upload(file)
  })
```

#### `onChunkProcessed` payload

```ts
interface ChunkProcessedPayload {
  file: File        // Named "chunk-{index}.{ext}" with correct MIME type
  index: number     // Zero-based chunk index within the session
  duration: number  // Duration of this chunk in seconds
  isLastChunk: boolean // true only when triggered by stop()
}
```

---

## Recipes

### Microphone only

```ts
import { AudioChunkify } from 'audio-chunkify'

const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
const recorder = new AudioChunkify()

recorder.create(stream)
recorder.onChunkProcessed(async ({ file, isLastChunk }) => {
  await uploadChunk(file)
})
recorder.start()
```

### Mix microphone + system audio

```ts
const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
const system = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })

const recorder = new AudioChunkify()
recorder.create(mic)
recorder.addAudioStream(system)
recorder.start()
```

### Short chunks for real-time transcription

```ts
recorder.create(stream, {
  timeslice: 200,
  silenceThreshold: -40,
  chunkOptions: {
    minDuration: 5,
    maxDuration: 15,
    minSilenceDuration: 0.5,
  },
})

recorder.onChunkProcessed(async ({ file }) => {
  const transcript = await transcribeAudio(file) // send to Whisper, etc.
  appendToTranscript(transcript)
})
```

### React hook

```tsx
import { useEffect, useRef, useState } from 'react'
import { AudioChunkify } from 'audio-chunkify'

export function useAudioChunkify() {
  const recorder = useRef(new AudioChunkify())
  const [state, setState] = useState<'idle' | 'recording' | 'paused'>('idle')
  const [elapsed, setElapsed] = useState(0)

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    recorder.current
      .create(stream, { timeslice: 250 })
      .onStart(() => setState('recording'))
      .onPause(() => setState('paused'))
      .onResume(() => setState('recording'))
      .onStop(() => { setState('idle'); setElapsed(0) })
      .onTimeUpdate(setElapsed)
      .onChunkProcessed(async ({ file, isLastChunk }) => {
        await uploadChunk(file)
      })

    recorder.current.start()
  }

  useEffect(() => () => { recorder.current.destroy() }, [])

  return {
    state,
    elapsed,
    start,
    pause: () => recorder.current.pause(),
    resume: () => recorder.current.resume(),
    stop: () => recorder.current.stop(),
  }
}
```

---

## Browser support

Requires the [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) and [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API). Supported in all modern browsers (Chrome, Firefox, Safari 14.1+, Edge).

Not supported in Node.js or non-browser environments.

---

## License

MIT
