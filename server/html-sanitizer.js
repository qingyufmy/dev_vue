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
