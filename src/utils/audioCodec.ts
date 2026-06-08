/**
 * Ordered list of preferred MIME types for audio recording.
 * The first supported type by the browser will be used.
 */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const

/**
 * Returns the first audio MIME type supported by the current browser,
 * or null if MediaRecorder is unavailable.
 */
export function getCompatibleMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') {
    return null
  }

  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType
    }
  }

  return null
}

/**
 * Derives a file extension from a MIME type string.
 * Falls back to 'webm' if the type is unrecognised.
 */
export function getFileExtensionFromMimeType(mimeType: string | null): string {
  if (!mimeType) return 'webm'
  if (mimeType.startsWith('audio/mp4')) return 'mp4'
  if (mimeType.startsWith('audio/ogg')) return 'ogg'
  if (mimeType.startsWith('audio/webm')) return 'webm'

  const match = mimeType.match(/audio\/(\w+)/)
  return match?.[1] ?? 'webm'
}
