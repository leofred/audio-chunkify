import { afterEach, beforeEach, vi } from 'vitest'
import { installBrowserMocks, resetBrowserMocks } from './helpers/browserMocks.js'

beforeEach(() => {
  vi.useFakeTimers()
  installBrowserMocks()
})

afterEach(() => {
  resetBrowserMocks()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
