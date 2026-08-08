import { describe, expect, it } from 'vitest'
import { createImageAssetName, detectImageType } from '../server/image-upload.js'

describe('detectImageType', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '.jpg', 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), '.png', 'image/png'],
    [Buffer.from('GIF89a'), '.gif', 'image/gif'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), '.webp', 'image/webp'],
  ])('detects the file signature instead of trusting metadata', (buffer, extension, mimeType) => {
    expect(detectImageType(buffer)).toEqual({ extension, mimeType })
  })

  it('rejects HTML even when the caller labels it as an image', () => {
    expect(detectImageType(Buffer.from('<script>alert(1)</script>'))).toBeNull()
  })
})

describe('createImageAssetName', () => {
  it('creates an opaque extension-free name', () => {
    const name = createImageAssetName('../post image.html')
    expect(name).toMatch(/^postimagehtml-\d+-[a-f0-9]{16}$/)
    expect(name).not.toContain('.')
  })
})
