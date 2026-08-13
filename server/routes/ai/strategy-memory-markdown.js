// Server-side Markdown preview for the unified strategy memory library.
//
// The durable source remains plain Markdown.  This module only derives a
// display representation: it never writes to the library, and the generated
// HTML is passed through a dedicated, narrow sanitizer before it is returned.

import crypto from 'node:crypto'
import sanitizeHtml from 'sanitize-html'
import {
  buildStrategyMemorySourceManifest,
  normalizeStrategyMemorySemanticText,
} from './strategy-memory-semantics.js'

export const STRATEGY_MEMORY_MARKDOWN_RENDER_SCHEMA_VERSION = 1
export const STRATEGY_MEMORY_MARKDOWN_MAX_CHARS = 1_000_000
export const STRATEGY_MEMORY_MARKDOWN_MAX_BLOCKS = 10_000

const SAFE_PROTOCOL_PATTERN = /^(?:https?|mailto):/iu
const LANGUAGE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u
const CODE_TOKEN_PREFIX = '\u0001strategy-memory-code-'
const LINK_TOKEN_PREFIX = '\u0001strategy-memory-link-'
const CODE_TOKEN_SUFFIX = '\u0002'
const MEMORY_PREVIEW_ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'strong', 'b', 'em', 'i', 's', 'del',
  'blockquote', 'pre', 'code', 'ol', 'ul', 'li', 'a',
]
const MEMORY_PREVIEW_ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target', 'rel'],
  code: ['class'],
}
const MEMORY_PREVIEW_DANGEROUS_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'textarea', 'select', 'button', 'meta', 'link', 'base', 'template',
  'svg', 'math', 'canvas', 'video', 'audio', 'source', 'img',
]

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(value) {
  const source = String(value ?? '').trim()
  // Reject whitespace/control characters instead of allowing a browser to
  // normalize a split protocol such as "java\nscript:".
  if (!source || /[\u0000-\u0020\u007f]/u.test(source) || source.startsWith('//')) return null
  if (!SAFE_PROTOCOL_PATTERN.test(source)) return null
  try {
    const parsed = new URL(source)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol.toLowerCase())) return null
  } catch {
    return null
  }
  return source
}

function codeToken(index) {
  return `${CODE_TOKEN_PREFIX}${index}${CODE_TOKEN_SUFFIX}`
}

function linkToken(index) {
  return `${LINK_TOKEN_PREFIX}${index}${CODE_TOKEN_SUFFIX}`
}

function replaceCodeSpans(source, codeParts) {
  return String(source ?? '').replace(/`([^`\n]+)`/gu, (_match, code) => {
    const index = codeParts.push(`<code>${escapeHtml(String(code).trim())}</code>`) - 1
    return codeToken(index)
  })
}

function renderInline(value, depth = 0) {
  if (depth > 4) return escapeHtml(value)
  const codeParts = []
  const links = []
  let source = replaceCodeSpans(String(value ?? ''), codeParts)
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["']([^"'\n]*)["'])?\)/gu,
    (match, label, href, title) => {
      const safeHref = safeUrl(href)
      // A dangerous destination is rendered as its label only.  Do not echo
      // the protocol into the HTML, where it could be mistaken for a link.
      if (!safeHref) return renderInline(label, depth + 1)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      const html = `<a href="${escapeHtml(safeHref)}"${titleAttr}>${renderInline(label, depth + 1)}</a>`
      const index = links.push(html) - 1
      return linkToken(index)
    })

  let rendered = escapeHtml(source)
  rendered = rendered
    .replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/gu, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/gu, '<del>$1</del>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '<em>$1</em>')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '<em>$1</em>')

  for (let index = 0; index < codeParts.length; index += 1) {
    rendered = rendered.replace(codeToken(index), codeParts[index])
  }
  for (let index = 0; index < links.length; index += 1) {
    rendered = rendered.replace(linkToken(index), links[index])
  }
  return rendered
}

function listMarker(line) {
  const match = String(line).match(/^\s*([-+*]|\d+[.)、])\s+(.*)$/u)
  if (!match) return null
  return { marker:match[1], text:match[2] }
}

function renderList(lines, start) {
  const first = listMarker(lines[start])
  if (!first) return null
  const ordered = /^\d/u.test(first.marker)
  const items = []
  let index = start
  while (index < lines.length) {
    const current = listMarker(lines[index])
    if (!current || /^\d/u.test(current.marker) !== ordered) break
    items.push(`<li>${renderInline(current.text)}</li>`)
    index += 1
  }
  const tag = ordered ? 'ol' : 'ul'
  return { html:`<${tag}>${items.join('')}</${tag}>`, next:index }
}

function renderBlockquote(lines, start) {
  const quoteLines = []
  let index = start
  while (index < lines.length) {
    const match = String(lines[index]).match(/^\s*>\s?(.*)$/u)
    if (!match) break
    quoteLines.push(match[1])
    index += 1
  }
  const body = quoteLines.length ? `<p>${renderInline(quoteLines.join('\n').trim())}</p>` : ''
  return { html:`<blockquote>${body}</blockquote>`, next:index }
}

function renderMarkdownBlock(source) {
  const lines = String(source ?? '').split('\n')
  const output = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    if (/^\s*```/u.test(line)) {
      const language = line.replace(/^\s*```\s*/u, '').trim()
      const body = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const className = LANGUAGE_PATTERN.test(language) ? ` class="language-${escapeHtml(language)}"` : ''
      output.push(`<pre><code${className}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u)
    if (heading) {
      const level = heading[1].length
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    const list = renderList(lines, index)
    if (list) {
      output.push(list.html)
      index = list.next
      continue
    }

    if (/^\s*>\s?/u.test(line)) {
      const quote = renderBlockquote(lines, index)
      output.push(quote.html)
      index = quote.next
      continue
    }

    const paragraph = []
    while (index < lines.length && lines[index].trim()
      && !/^\s*(?:#{1,6})\s+/u.test(lines[index])
      && !/^\s*(?:```|>|[-+*]\s+|\d+[.)、]\s+)/u.test(lines[index])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) output.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
  }
  return output.join('')
}

function sanitizePreviewHtml(html) {
  return sanitizeHtml(String(html ?? ''), {
    allowedTags:MEMORY_PREVIEW_ALLOWED_TAGS,
    allowedAttributes:MEMORY_PREVIEW_ALLOWED_ATTRIBUTES,
    allowedSchemes:['http', 'https', 'mailto'],
    allowedSchemesByTag:{ a:['http', 'https', 'mailto'] },
    allowProtocolRelative:false,
    nonTextTags:MEMORY_PREVIEW_DANGEROUS_TAGS,
    disallowedTagsMode:'discard',
    transformTags:{
      a:(tagName, attributes) => {
        const attrs = { ...attributes }
        const href = safeUrl(attrs.href)
        if (!href) delete attrs.href
        else attrs.href = href
        if (attrs.target === '_blank') attrs.rel = 'noopener noreferrer'
        else delete attrs.target
        return { tagName, attribs:attrs }
      },
    },
  }).replace(/<br\s*\/?>/giu, '<br>')
}

function renderError(code, detail) {
  const error = new Error(detail ? `${code}:${detail}` : code)
  error.code = code
  return error
}

/**
 * Render the current Markdown memory as a safe preview and stable block list.
 * The content hash is the same normalized SHA-256 form used by the library.
 */
export function renderStrategyMemoryMarkdownPreview(input = '') {
  const options = input && typeof input === 'object' && !Array.isArray(input)
    ? input : { content_text:input }
  const content = options.content_text ?? options.contentText ?? options.text ?? ''
  const normalized = normalizeStrategyMemorySemanticText(content)
  if (Array.from(normalized).length > STRATEGY_MEMORY_MARKDOWN_MAX_CHARS) {
    throw renderError('strategy_memory_markdown_too_large')
  }
  const manifest = buildStrategyMemorySourceManifest({
    content_text:normalized,
    namespace:String(options.namespace || 'current_library'),
    includePendingUpdates:false,
  })
  if (manifest.source_blocks.length > STRATEGY_MEMORY_MARKDOWN_MAX_BLOCKS) {
    throw renderError('strategy_memory_markdown_too_many_blocks')
  }
  const blocks = manifest.source_blocks.map((block, index) => ({
    block_id:block.id,
    block_hash:block.hash,
    order:index + 1,
    text:block.text,
    html:sanitizePreviewHtml(renderMarkdownBlock(block.text)),
  }))
  const previewHtml = blocks.map(block =>
    `<div class="strategy-memory-preview-block" data-memory-block-id="${block.block_id}" data-memory-block-hash="${block.block_hash}">${block.html}</div>`
  ).join('')
  return {
    render_schema_version:STRATEGY_MEMORY_MARKDOWN_RENDER_SCHEMA_VERSION,
    preview_html:previewHtml,
    blocks,
    content_hash:sha256(normalized),
  }
}

export const renderStrategyMemoryMarkdown = renderStrategyMemoryMarkdownPreview
export const renderStrategyMemoryPreview = renderStrategyMemoryMarkdownPreview
export const sanitizeStrategyMemoryMarkdownPreview = sanitizePreviewHtml
