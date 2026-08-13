import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const CACHE_VERSION = '20260812memory4'
const FIRST_PARTY_ENTRY_FILES = [
  'public/index.html',
  'public/account/index.html',
  'public/admin/index.html',
  'public/ai/index.html',
  'public/ai/auth/index.html',
  'public/ai/bridge-pair.html',
  'public/src/main.js',
  'public/src/lib/course-pages.js',
]

describe('frontend static cache version', () => {
  it('uses one release cache key for every first-party local static reference', async () => {
    for (const file of FIRST_PARTY_ENTRY_FILES) {
      const source = await readFile(file, 'utf8')
      const firstPartySource = source.replace('/vendor/quill.js?v=2.0.3', '')
      const versions = [...firstPartySource.matchAll(/[?&]v=([A-Za-z0-9._-]+)/g)]
        .map(match => match[1])
      expect(versions.length, `${file} should contain a cache-busted local asset`).toBeGreaterThan(0)
      expect(new Set(versions), file).toEqual(new Set([CACHE_VERSION]))
    }
  })
})
