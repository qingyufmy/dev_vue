import { randomBytes } from 'crypto'

const IMAGE_TYPES = [
  {
    extension:'.jpg',
    mimeType:'image/jpeg',
    matches:buffer => buffer.length >= 3
      && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    extension:'.png',
    mimeType:'image/png',
    signature:Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    extension:'.gif',
    mimeType:'image/gif',
    matches:buffer => buffer.subarray(0, 6).equals(Buffer.from('GIF87a'))
      || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')),
  },
  {
    extension:'.webp',
    mimeType:'image/webp',
    matches:buffer => buffer.length >= 12
      && buffer.subarray(0, 4).equals(Buffer.from('RIFF'))
      && buffer.subarray(8, 12).equals(Buffer.from('WEBP')),
  },
]

export function detectImageType(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  for (const type of IMAGE_TYPES) {
    if (type.signature && buffer.subarray(0, type.signature.length).equals(type.signature)) {
      return { extension:type.extension, mimeType:type.mimeType }
    }
    if (type.matches?.(buffer)) return { extension:type.extension, mimeType:type.mimeType }
  }
  return null
}

export function createImageAssetName(prefix = 'img') {
  const safePrefix = String(prefix || 'img').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'img'
  return `${safePrefix}-${Date.now()}-${randomBytes(8).toString('hex')}`
}
