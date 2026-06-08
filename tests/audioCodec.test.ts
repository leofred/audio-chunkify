import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCompatibleMimeType,
  getFileExtensionFromMimeType,
} from '../src/utils/audioCodec.js'
import { MockMediaRecorder } from './helpers/browserMocks.js'

describe('getCompatibleMimeType', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the first supported MIME type in preference order', () => {
    MockMediaRecorder.isTypeSupported = vi.fn(
      (mime: string) => mime === 'audio/webm;codecs=opus' || mime === 'audio/webm',
    )

    expect(getCompatibleMimeType()).toBe('audio/webm;codecs=opus')
  })

  it('skips unsupported types and returns the next match', () => {
    MockMediaRecorder.isTypeSupported = vi.fn(
      (mime: string) => mime === 'audio/mp4',
    )

    expect(getCompatibleMimeType()).toBe('audio/mp4')
  })

  it('returns null when MediaRecorder is unavailable', () => {
    vi.stubGlobal('MediaRecorder', undefined)

    expect(getCompatibleMimeType()).toBeNull()
  })

  it('returns null when no preferred type is supported', () => {
    MockMediaRecorder.isTypeSupported = vi.fn(() => false)

    expect(getCompatibleMimeType()).toBeNull()
  })
})

describe('getFileExtensionFromMimeType', () => {
  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/mp4;codecs=mp4a.40.2', 'mp4'],
    ['audio/mp4', 'mp4'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    [null, 'webm'],
    ['', 'webm'],
  ])('maps %s → %s', (mimeType, expected) => {
    expect(getFileExtensionFromMimeType(mimeType)).toBe(expected)
  })
})
