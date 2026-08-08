import sanitizeHtml from 'sanitize-html'

const ALLOWED_DATA_ATTRIBUTES = [
  'data-asset-id', 'data-reply-id', 'data-post-id', 'data-update-target',
  'data-mindmap-structure', 'data-fallback-image', 'data-quote-reply',
  'data-report-reply', 'data-post-report', 'data-post-pin', 'data-next-pin',
  'data-user-id', 'data-referral-approve', 'data-referral-void',
  'data-rule-rate', 'data-rule-enabled', 'data-board', 'data-field',
]

const DANGEROUS_CONTENT_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'textarea', 'button', 'meta', 'link', 'base', 'template', 'svg', 'math',
]

function normalizeAnchor(tagName, attributes) {
  const href = String(attributes.href || '').trim()
  if (/^(?:javascript|data|vbscript|file):/i.test(href)) attributes.href = '#'
  if (attributes.target === '_blank') attributes.rel = 'noopener noreferrer'
  else delete attributes.target
  return { tagName, attribs:attributes }
}

export function sanitizeRichContent(html) {
  if (!html || typeof html !== 'string') return ''
  return sanitizeHtml(html, {
    allowedTags:[
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
      'blockquote', 'pre', 'code', 'ol', 'ul', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'span', 'div', 'sub', 'sup',
    ],
    allowedAttributes:{
      a:['href', 'title', 'target', 'rel'],
      img:['src', 'alt', 'title', 'width', 'height', 'data-asset-id'],
      div:['class', ...ALLOWED_DATA_ATTRIBUTES],
      p:['class'],
      span:['class'],
      ol:['class'],
      ul:['class'],
      li:['class'],
      pre:['class'],
      code:['class'],
      blockquote:['class'],
    },
    allowedClasses:{
      div:['ql-*'], p:['ql-*'], span:['ql-*'], ol:['ql-*'], ul:['ql-*'],
      li:['ql-*'], pre:['ql-*'], code:['ql-*'], blockquote:['ql-*'],
    },
    allowedSchemes:['http', 'https', 'mailto'],
    allowedSchemesByTag:{ img:['http', 'https'] },
    allowProtocolRelative:false,
    nonTextTags:DANGEROUS_CONTENT_TAGS,
    transformTags:{ a:normalizeAnchor },
  }).replace(/<(br|img)([^>]*) \/>/g, '<$1$2>')
}

// Release notes are rendered in two different clients and are therefore
// sanitized at the storage/read boundary rather than relying on a browser
// helper. Keep this allow-list deliberately small: release notes need semantic
// markup, not arbitrary layout or interactive widgets.
const RELEASE_NOTE_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'blockquote', 'pre', 'code', 'ol', 'ul', 'li',
  'a', 'span', 'div', 'section', 'article',
]

const RELEASE_NOTE_DANGEROUS_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'textarea', 'select', 'button', 'meta', 'link', 'base', 'template',
  'svg', 'math', 'canvas', 'video', 'audio', 'source',
]

const RELEASE_NOTE_ATTRIBUTE_TAGS = Object.fromEntries(
  RELEASE_NOTE_TAGS.filter(tag => tag !== 'br').map(tag => [tag, ['class', 'style']]),
)
RELEASE_NOTE_ATTRIBUTE_TAGS.a = ['class', 'style', 'href', 'title', 'target', 'rel']

const RELEASE_STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-weight', 'font-style', 'text-decoration',
  'text-align', 'line-height',
])

const RELEASE_STYLE_PROPERTY_RE = /^(?:margin|padding)(?:-(?:top|right|bottom|left))?$/
const RELEASE_BORDER_PROPERTY_RE = /^border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?$/
const RELEASE_RADIUS_PROPERTY_RE = /^border-radius(?:-(?:top-left|top-right|bottom-right|bottom-left))?$/
const RELEASE_LENGTH_RE = /^(?:0|(?:\d{1,3}(?:\.\d{1,2})?)(?:px|em|rem|pt|%)?)$/i
const RELEASE_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^)]{1,100}\)|[a-z]{1,32})$/i
const RELEASE_STYLE_TOKEN_RE = /^[a-z0-9#(),.%\s+\-./]+$/i

const RELEASE_ALLOWED_TAG_SET = new Set(RELEASE_NOTE_TAGS)
const RELEASE_DANGEROUS_TAG_SET = new Set(RELEASE_NOTE_DANGEROUS_TAGS)
const RELEASE_CATEGORY_ORDER = [
  'script', 'form', 'embedded_content', 'svg', 'event_attribute',
  'dangerous_url', 'dangerous_style', 'unsupported_tag', 'unsupported_attribute',
]

function addReleaseCategory(categories, category) {
  categories.add(category)
}

function releaseStylePropertyAllowed(property) {
  return RELEASE_STYLE_PROPERTIES.has(property)
    || RELEASE_STYLE_PROPERTY_RE.test(property)
    || RELEASE_BORDER_PROPERTY_RE.test(property)
    || RELEASE_RADIUS_PROPERTY_RE.test(property)
}

function releaseLengthAllowed(value) {
  const parts = String(value).trim().split(/\s+/).filter(Boolean)
  if (!parts.length || parts.length > 4) return false
  return parts.every(part => {
    if (!RELEASE_LENGTH_RE.test(part)) return false
    const number = Number.parseFloat(part)
    return Number.isFinite(number) && number >= 0 && number <= 128
  })
}

function releaseColorAllowed(value) {
  return RELEASE_COLOR_RE.test(String(value).trim())
}

function releaseStyleValueAllowed(property, value) {
  const text = String(value).trim()
  if (!text || /(?:url|expression|javascript|vbscript|data:|var\s*\(|!important|@import)/i.test(text)) return false
  if (!RELEASE_STYLE_TOKEN_RE.test(text)) return false
  if (property === 'color' || property === 'background-color') return releaseColorAllowed(text)
  if (property === 'font-weight') return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(text)
  if (property === 'font-style') return /^(?:normal|italic|oblique)$/i.test(text)
  if (property === 'text-decoration') return /^(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*$/i.test(text)
  if (property === 'text-align') return /^(?:left|right|center|justify|start|end)$/i.test(text)
  if (property === 'line-height') return /^(?:normal|\d(?:\.\d{1,2})?|(?:\d{1,3}(?:\.\d{1,2})?)(?:px|em|rem|pt|%)?)$/i.test(text)
  if (RELEASE_STYLE_PROPERTY_RE.test(property) || RELEASE_RADIUS_PROPERTY_RE.test(property)) return releaseLengthAllowed(text)
  if (RELEASE_BORDER_PROPERTY_RE.test(property)) {
    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length > 4) return false
    return parts.every(part => /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|thin|medium|thick)$/i.test(part)
      || RELEASE_LENGTH_RE.test(part) && Number.parseFloat(part) <= 128
      || releaseColorAllowed(part))
  }
  return false
}

function sanitizeReleaseStyle(value, categories) {
  const declarations = String(value || '').split(';')
  const clean = []
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) {
      if (declaration.trim()) addReleaseCategory(categories, 'dangerous_style')
      continue
    }
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const rawValue = declaration.slice(separator + 1).trim()
    if (!releaseStylePropertyAllowed(property) || !releaseStyleValueAllowed(property, rawValue)) {
      addReleaseCategory(categories, 'dangerous_style')
      continue
    }
    clean.push(`${property}:${rawValue}`)
  }
  return clean.join(';')
}

function releaseTagTransform(categories) {
  return (tagName, attributes) => {
    const attribs = { ...attributes }
    for (const name of Object.keys(attribs)) {
      if (/^on[a-z0-9_-]+$/i.test(name)) {
        addReleaseCategory(categories, 'event_attribute')
        delete attribs[name]
      }
    }
    if (Object.prototype.hasOwnProperty.call(attribs, 'style')) {
      const style = sanitizeReleaseStyle(attribs.style, categories)
      if (style) attribs.style = style
      else delete attribs.style
    }
    if (Object.prototype.hasOwnProperty.call(attribs, 'href')) {
      const href = String(attribs.href || '').trim()
      if (!/^(?:https?|mailto):/i.test(href)) {
        addReleaseCategory(categories, 'dangerous_url')
        delete attribs.href
      } else {
        attribs.href = href
      }
    }
    if (tagName === 'a' && attribs.target === '_blank') attribs.rel = 'noopener noreferrer'
    else if (tagName === 'a') delete attribs.target
    return { tagName, attribs }
  }
}

function inspectReleaseInput(html, categories) {
  const source = String(html || '')
  const tags = /<\s*\/?\s*([a-z][a-z0-9:-]*)\b[^>]*>/gi
  let match
  while ((match = tags.exec(source))) {
    const name = match[1].toLowerCase()
    if (RELEASE_DANGEROUS_TAG_SET.has(name)) {
      if (name === 'script') addReleaseCategory(categories, 'script')
      else if (name === 'form' || name === 'input' || name === 'textarea' || name === 'select' || name === 'button') addReleaseCategory(categories, 'form')
      else if (name === 'svg' || name === 'math') addReleaseCategory(categories, 'svg')
      else addReleaseCategory(categories, 'embedded_content')
    } else if (!RELEASE_ALLOWED_TAG_SET.has(name)) {
      addReleaseCategory(categories, 'unsupported_tag')
    }
    const rawTag = match[0]
    if (/\s+on[a-z0-9_-]+\s*=/i.test(rawTag)) addReleaseCategory(categories, 'event_attribute')
    if (/\s+(?:href|src)\s*=\s*(?:"|')?\s*(?:javascript|vbscript|data|file):/i.test(rawTag)) addReleaseCategory(categories, 'dangerous_url')
    if (/\s+style\s*=/i.test(rawTag) && /(?:url\s*\(|expression\s*\(|position\s*:|display\s*:|z-index\s*:|--[\w-]+\s*:)/i.test(rawTag)) addReleaseCategory(categories, 'dangerous_style')
  }
  const attributes = /<\s*[a-z][^>]*\s+([a-z_:][a-z0-9_:.\-]*)\s*(?:=|\/?>)/gi
  const allowedAttributes = new Set(['class', 'style', 'href', 'title', 'target', 'rel'])
  while ((match = attributes.exec(source))) {
    const name = match[1].toLowerCase()
    if (!allowedAttributes.has(name) && !/^on[a-z0-9_-]+$/i.test(name)) addReleaseCategory(categories, 'unsupported_attribute')
  }
}

/**
 * Sanitize a release note and report what the server removed. The result is
 * deterministic and can safely be passed through this function again.
 */
export function sanitizeReleaseNote(html) {
  const source = typeof html === 'string' ? html : ''
  const categories = new Set()
  inspectReleaseInput(source, categories)
  const transformTags = Object.fromEntries(RELEASE_NOTE_TAGS.map(tag => [tag, releaseTagTransform(categories)]))
  const content = sanitizeHtml(source, {
    allowedTags: RELEASE_NOTE_TAGS,
    allowedAttributes: RELEASE_NOTE_ATTRIBUTE_TAGS,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    nonTextTags: RELEASE_NOTE_DANGEROUS_TAGS,
    disallowedTagsMode: 'discard',
    transformTags,
  }).replace(/<br\s*\/?\s*>/gi, '<br>')
  const removedCategories = RELEASE_CATEGORY_ORDER.filter(category => categories.has(category))
  return {
    content,
    sanitized: content,
    removed: removedCategories.length > 0,
    wasModified: content !== source,
    removedCategories,
  }
}

export const sanitizeReleaseNoteHtml = html => sanitizeReleaseNote(html).content
export const sanitizeReleaseNotes = sanitizeReleaseNote
export const sanitizeReleaseNotesHtml = sanitizeReleaseNoteHtml
export const sanitizeReleaseNotesContent = sanitizeReleaseNote
