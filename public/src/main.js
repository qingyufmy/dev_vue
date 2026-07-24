import { episodes as staticEpisodes, categories } from './data/episodes.js?v=20260714i'
import { loadSiteUpdates } from './data/updates.js'
import { api } from './lib/api.js'
import { createCourseContent } from './lib/course-content.js?v=20260723attachments1'
import { getArticleContentValidationError, getCourseMediaValidationError } from './lib/admin-course.js?v=20260714f'
import { classifyArticleUrl, getVideoEpisodeIds } from './lib/course-media.js?v=20260714f'
import { getCourseProgramByView } from './data/course-programs.js?v=20260714h'
import { renderCourseOverviewPage, renderCourseProgramPage } from './lib/course-pages.js?v=20260714h'
import { getCoursesForCategory } from './lib/course-catalog.js?v=20260714i'
// Quill loaded via <script> tag in index.html (local /vendor/quill.js)
// Quill snow theme CSS loaded via <link> in index.html

const MAX_POST_IMAGES = 8
const MAX_POST_IMAGE_BYTES = 5 * 1024 * 1024
const TOS_AGREEMENT_VERSION = '2026-04-12'
const ARTICLE_THEME_URL_CANDIDATES = [
  '/article-theme.css',
  '/public/article-theme.css',
]
let articleThemeUrlPromise = null
let episodes = [...staticEpisodes]

// ===== Course Catalog Loader =====
const courseCatalog = {
  loaded: false,
  source: 'static',
  error: null,
  promise: null,

  normalizeCourse(item) {
    const id = Number(item.episodeId || item.id)
    return {
      id,
      episodeId: id,
      number: Number(item.number || item.episodeNumber || 0),
      title: item.title || '',
      description: item.description || '',
      category: item.category || 'strategy',
      contentType: item.contentType || item.content_type || (item.articleUrl ? 'article' : 'video'),
      duration: item.duration || '',
      youtubeId: item.youtubeId || item.youtube_id || '',
      cover: item.cover || '',
      gradient: item.gradient || staticEpisodes[(Math.max(1, id) - 1) % staticEpisodes.length]?.gradient || 'linear-gradient(135deg, #667eea, #764ba2)',
      articleUrl: item.articleUrl || item.article_url || '',
      articleObjectKey: item.articleObjectKey || item.article_object_key || '',
      accessLevel: item.accessLevel || item.access_level || 'free',
      hasStreamVideo: Boolean(item.hasStreamVideo),
      quizCount: Number(item.quizCount || item.quiz_count || 0),
      knowledgeCount: Number(item.knowledgeCount || item.knowledge_count || 0),
      mindmapCount: Number(item.mindmapCount || item.mindmap_count || 0),
      structureCount: Number(item.structureCount || item.structure_count || 0),
      attachmentCount: Number(item.attachmentCount || item.attachment_count || 0),
      status: item.status || 'published',
      sortOrder: Number(item.sortOrder || item.sort_order || id),
      createdAt: item.createdAt || item.created_at || '',
      updatedAt: item.updatedAt || item.updated_at || '',
    }
  },

  apply(list, source = 'static') {
    const normalized = Array.isArray(list)
      ? list.map(item => this.normalizeCourse(item)).filter(item => item.id && item.title)
      : []
    episodes = normalized.length ? normalized : [...staticEpisodes]
    this.source = normalized.length ? source : 'static'
    this.loaded = true
  },

  async load() {
    if (this.loaded) return episodes
    if (this.promise) return this.promise
    this.promise = api.get('/api/course-items')
      .then(data => {
        if (data.ok && Array.isArray(data.courses) && data.courses.length) {
          this.apply(data.courses, data.source || 'd1')
          this.error = null
        } else {
          this.apply(staticEpisodes, 'static')
          this.error = data.error || 'course_items unavailable'
        }
        return episodes
      })
      .catch(err => {
        console.error('Course catalog load error:', err)
        this.apply(staticEpisodes, 'static')
        this.error = err
        return episodes
      })
    return this.promise
  },

  getById(id) {
    return episodes.find(ep => ep.id === Number(id)) || null
  },
}

// ===== HTML Escape (XSS protection) =====
function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ===== Rich HTML sanitizer (defense-in-depth for stored Quill output) =====
const RICH_TEXT_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'blockquote',
  'pre', 'code', 'ol', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'span', 'div', 'sub', 'sup',
])
const RICH_TEXT_DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
  'button', 'meta', 'link', 'base', 'template', 'svg', 'math',
])
const RICH_TEXT_ATTRIBUTES = {
  a:new Set(['href', 'title', 'target', 'rel']),
  img:new Set(['src', 'alt', 'title', 'width', 'height', 'data-asset-id']),
}

function richTextUrlAllowed(value, tagName) {
  const source = String(value || '').trim()
  if (!source || /^[\u0000-\u001f]/.test(source)) return false
  try {
    const parsed = new URL(source, location.origin)
    const schemes = tagName === 'a' ? new Set(['http:', 'https:', 'mailto:']) : new Set(['http:', 'https:'])
    return schemes.has(parsed.protocol)
  } catch {
    return false
  }
}

function sanitizeRichHtml(html) {
  if (!html || typeof html !== 'string') return ''
  const documentFragment = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  const cleanChildren = parent => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const tagName = node.tagName.toLowerCase()
      if (RICH_TEXT_DROP_TAGS.has(tagName)) {
        node.remove()
        continue
      }
      if (!RICH_TEXT_TAGS.has(tagName)) {
        node.replaceWith(...node.childNodes)
        cleanChildren(parent)
        continue
      }

      const allowed = RICH_TEXT_ATTRIBUTES[tagName] || new Set()
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase()
        const keepQuillClass = name === 'class' && ['div', 'p', 'span', 'ol', 'ul', 'li', 'pre', 'code', 'blockquote'].includes(tagName)
        if (!allowed.has(name) && !keepQuillClass) node.removeAttribute(attribute.name)
      }

      if (node.hasAttribute('class')) {
        const classNames = [...node.classList].filter(name => /^ql-[a-z0-9-]+$/i.test(name))
        if (classNames.length) node.className = classNames.join(' ')
        else node.removeAttribute('class')
      }
      for (const attribute of ['href', 'src']) {
        if (node.hasAttribute(attribute) && !richTextUrlAllowed(node.getAttribute(attribute), tagName)) {
          node.removeAttribute(attribute)
        }
      }
      if (tagName === 'a') {
        if (node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer')
        else {
          node.removeAttribute('target')
          node.removeAttribute('rel')
        }
      }
      cleanChildren(node)
    }
  }

  cleanChildren(documentFragment.body)
  return documentFragment.body.innerHTML
}

function formatUsdAmount(dollars) {
  const value = Number(dollars || 0)
  return `$${Math.max(0, value).toFixed(2)}`
}

let communityEditor = null
const postImageObjectUrls = new Set()
const replyDraftObjectUrls = new Set()
let replyDraftImages = []
let postLightboxEl = null

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getPostImageCount(root) {
  return root ? root.querySelectorAll('img').length : 0
}

function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl || '').split(',')
  if (parts.length !== 2) return null
  const header = parts[0]
  const mimeMatch = header.match(/^data:([^;]+);base64$/i)
  if (!mimeMatch) return null
  const binary = atob(parts[1])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeMatch[1] })
}

function getImageExtension(mimeType) {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'bin'
  }
}

function releasePostImageObjectUrls() {
  for (const url of postImageObjectUrls) {
    URL.revokeObjectURL(url)
  }
  postImageObjectUrls.clear()
}

function releaseReplyDraftObjectUrls() {
  for (const url of replyDraftObjectUrls) {
    URL.revokeObjectURL(url)
  }
  replyDraftObjectUrls.clear()
}

function renderReplyDraftImages() {
  const list = document.getElementById('replyImageList')
  if (!list) return

  if (!replyDraftImages.length) {
    list.innerHTML = ''
    return
  }

  list.innerHTML = replyDraftImages.map(image => `
    <div class="reply-image-card">
      <img class="reply-image-card-img" src="${escapeHtml(image.previewUrl)}" alt="${escapeHtml(image.alt)}">
      <button type="button" class="reply-image-card-remove" data-remove-reply-image="${image.id}" aria-label="移除图片">×</button>
    </div>
  `).join('')
}

function updateReplyComposerMeta() {
  const count = document.getElementById('replyCharCount')
  if (!count) return

  const textLength = String(document.getElementById('replyInput')?.value || '').length
  count.textContent = `${textLength} 字 · ${replyDraftImages.length} 图`
}

function resetReplyDraftImages() {
  releaseReplyDraftObjectUrls()
  replyDraftImages = []
  const input = document.getElementById('replyImageInput')
  if (input) input.value = ''
  renderReplyDraftImages()
  updateReplyComposerMeta()
}

function removeReplyDraftImage(imageId) {
  const image = replyDraftImages.find(item => item.id === imageId)
  if (!image) return

  URL.revokeObjectURL(image.previewUrl)
  replyDraftObjectUrls.delete(image.previewUrl)
  replyDraftImages = replyDraftImages.filter(item => item.id !== imageId)
  renderReplyDraftImages()
  updateReplyComposerMeta()
}

function handleReplyImageSelection(fileList) {
  const files = [...(fileList || [])]
  if (!files.length) return

  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

  for (const file of files) {
    if (!allowedTypes.has((file.type || '').toLowerCase())) {
      showToast('回复仅支持 JPEG、PNG、WebP、GIF 图片', 'error')
      continue
    }

    if (file.size > MAX_POST_IMAGE_BYTES) {
      showToast('单张图片不能超过 5MB', 'error')
      continue
    }

    const previewUrl = URL.createObjectURL(file)
    replyDraftObjectUrls.add(previewUrl)
    replyDraftImages.push({
      id: crypto.randomUUID(),
      file,
      previewUrl,
      alt: file.name || `reply-image-${replyDraftImages.length + 1}`,
    })
  }

  renderReplyDraftImages()
  updateReplyComposerMeta()
}

function buildReplyContentHtml(text, imageUrls = []) {
  const blocks = []
  const normalizedText = normalizePlainText(text)

  if (normalizedText) {
    const paragraphs = normalizedText.split('\n\n')
    for (const paragraph of paragraphs) {
      const html = paragraph
        .split('\n')
        .map(line => escapeHtml(line))
        .join('<br>')
      blocks.push(`<p>${html}</p>`)
    }
  }

  if (imageUrls.length) {
    blocks.push(`<p>${imageUrls.map((url, index) => (
      `<img src="${escapeHtml(url)}" alt="回复图片 ${index + 1}">`
    )).join('')}</p>`)
  }

  return blocks.join('')
}

function isReplyImageOnlyParagraph(node) {
  if (!node || node.tagName !== 'P') return false

  const meaningfulNodes = [...node.childNodes].filter(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      return child.textContent.trim() !== ''
    }
    return !(child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR')
  })

  return meaningfulNodes.length > 0 && meaningfulNodes.every(child => (
    child.nodeType === Node.ELEMENT_NODE && child.tagName === 'IMG'
  ))
}

function enhanceReplyImageLayouts(container) {
  if (!container) return

  container.querySelectorAll('.reply-image-grid').forEach(grid => {
    const parent = grid.parentElement
    if (!parent) return
    const frag = document.createDocumentFragment()
    ;[...grid.querySelectorAll('img')].forEach(image => {
      const paragraph = document.createElement('p')
      paragraph.appendChild(image)
      frag.appendChild(paragraph)
    })
    grid.replaceWith(frag)
  })

  container.querySelectorAll('.reply-body-rich').forEach(body => {
    let currentGrid = null
    for (const child of [...body.children]) {
      if (isReplyImageOnlyParagraph(child)) {
        if (!currentGrid) {
          currentGrid = document.createElement('div')
          currentGrid.className = 'reply-image-grid'
          child.before(currentGrid)
        }
        ;[...child.querySelectorAll('img')].forEach(image => currentGrid.appendChild(image))
        child.remove()
      } else {
        currentGrid = null
      }
    }
  })
}

async function uploadReplyDraftImages(submitBtn) {
  const uploadedAssetIds = []
  const uploadedUrls = []

  for (let index = 0; index < replyDraftImages.length; index++) {
    const image = replyDraftImages[index]
    const formData = new FormData()
    formData.append('file', image.file, image.file.name || `reply-image-${index + 1}.${getImageExtension(image.file.type)}`)

    if (submitBtn) {
      submitBtn.textContent = `上传图片 ${index + 1}/${replyDraftImages.length}...`
    }

    const response = await api.postForm('/api/post-images', formData)
    if (!response.ok || !response.assetId || !response.url) {
      throw new Error(response.error || '上传回复图片失败')
    }

    uploadedAssetIds.push(response.assetId)
    uploadedUrls.push(response.url)
  }

  return { assetIds: uploadedAssetIds, urls: uploadedUrls }
}

function closePostImageLightbox() {
  if (!postLightboxEl) return
  const overlay = postLightboxEl
  postLightboxEl = null
  overlay.classList.remove('active')
  setTimeout(() => {
    overlay.remove()
  }, 180)
}

function showPostImageLightbox(src, alt = '帖子图片') {
  closePostImageLightbox()
  const overlay = document.createElement('div')
  overlay.className = 'post-image-lightbox active'
  overlay.innerHTML = `
    <button class="post-image-lightbox-close" aria-label="关闭预览">×</button>
    <img class="post-image-lightbox-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">
  `
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('.post-image-lightbox-close')) {
      closePostImageLightbox()
    }
  })
  document.body.appendChild(overlay)
  postLightboxEl = overlay
}

function destroyCommunityEditor() {
  if (!communityEditor) return
  const editorRoot = communityEditor.root
  const editorHost = editorRoot?.closest('.ql-container')?.parentElement
  communityEditor = null
  if (editorHost && editorHost.id === 'postEditor') {
    editorHost.innerHTML = ''
  }
}

function resetCommunityComposer() {
  const titleInput = document.getElementById('postTitleInput')
  if (titleInput) titleInput.value = ''
  const tagsInput = document.getElementById('postTagsInput')
  if (tagsInput) tagsInput.value = ''
  if (communityEditor) {
    communityEditor.setContents([{ insert: '\n' }], 'silent')
  }
  const form = document.getElementById('createPostForm')
  if (form) form.style.display = 'none'
}

function initCommunityEditor() {
  if (communityEditor) return communityEditor
  const editorEl = document.getElementById('postEditor')
  if (!editorEl) return null

  communityEditor = new Quill(editorEl, {
    theme: 'snow',
    placeholder: '写下你的想法，支持段落、引用、列表、链接和图片...',
    modules: {
      toolbar: {
        container: [
          [{ header: [1, 2, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'link', 'image'],
          ['clean'],
        ],
        handlers: {
          image: () => handleCommunityEditorImageInsert(),
        },
      },
    },
  })

  return communityEditor
}

async function handleCommunityEditorImageInsert() {
  const editor = initCommunityEditor()
  if (!editor) return

  if (getPostImageCount(editor.root) >= MAX_POST_IMAGES) {
    showToast(`最多上传 ${MAX_POST_IMAGES} 张图片`, 'error')
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > MAX_POST_IMAGE_BYTES) {
      showToast('单张图片不能超过 5MB', 'error')
      return
    }
    if (getPostImageCount(editor.root) >= MAX_POST_IMAGES) {
      showToast(`最多上传 ${MAX_POST_IMAGES} 张图片`, 'error')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const range = editor.getSelection(true) || { index: editor.getLength(), length: 0 }
      editor.insertEmbed(range.index, 'image', reader.result, 'user')
      editor.setSelection(range.index + 1, 0, 'silent')
    }
    reader.readAsDataURL(file)
  }, { once: true })
  input.click()
}

async function uploadEditorImages(editorRoot, submitBtn) {
  const images = [...editorRoot.querySelectorAll('img')]
  const uploadedAssetIds = []
  const dataImages = images.filter(image => (image.getAttribute('src') || '').startsWith('data:image/'))

  if (images.length > MAX_POST_IMAGES) {
    throw new Error(`最多上传 ${MAX_POST_IMAGES} 张图片`)
  }

  for (let index = 0; index < dataImages.length; index++) {
    const image = dataImages[index]
    const source = image.getAttribute('src') || ''
    const blob = dataUrlToBlob(source)
    if (!blob) {
      throw new Error('图片格式无效，请重新插入')
    }
    if (blob.size > MAX_POST_IMAGE_BYTES) {
      throw new Error('单张图片不能超过 5MB')
    }

    const formData = new FormData()
    formData.append('file', blob, `post-image-${index + 1}.${getImageExtension(blob.type)}`)

    if (submitBtn) {
      submitBtn.textContent = `上传图片 ${index + 1}/${dataImages.length}...`
    }

    const response = await api.postForm('/api/post-images', formData)
    if (!response.ok || !response.assetId || !response.url) {
      throw new Error(response.error || '上传图片失败')
    }

    uploadedAssetIds.push(response.assetId)
    image.setAttribute('src', response.url)
  }

  return uploadedAssetIds
}

async function cleanupTemporaryPostImages(assetIds) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return
  await Promise.all(assetIds.map(assetId =>
    api.del(`/api/post-images?id=${encodeURIComponent(assetId)}`).catch(() => null)
  ))
}

async function hydrateProtectedPostImages(container, options = {}) {
  if (!container || !api._token()) return
  const imageClass = options.imageClass || 'post-rich-image'
  const images = [...container.querySelectorAll('img')]
  await Promise.all(images.map(async (image) => {
    const protectedSrc = image.getAttribute('src') || ''
    if (!protectedSrc.startsWith('/api/post-images?id=')) return

    image.classList.add(imageClass, 'is-loading')
    image.dataset.protectedSrc = protectedSrc

    try {
      const response = await fetch(protectedSrc, {
        headers: api._headers(false),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      postImageObjectUrls.add(objectUrl)
      if (!container.isConnected || state.currentView !== 'post') {
        URL.revokeObjectURL(objectUrl)
        postImageObjectUrls.delete(objectUrl)
        return
      }
      image.src = objectUrl
      image.classList.remove('is-loading')
    } catch (error) {
      console.error('Post image hydrate error:', error)
      image.classList.remove('is-loading')
      image.classList.add('is-error')
      image.alt = '帖子图片加载失败'
    }
  }))
}

// ===== 量见语录 =====
const allQuotes = [
  '市场的故事不断更换，但人性的贪婪与恐惧始终相似，因此相同的错误总会在相似的位置重复出现。',
  '越是拥挤的突破越需要谨慎。很多时候，等待假突破暴露后再寻找反向机会，比盲目追价更有优势。',
  '每次下单之前，都要先确定自己在哪里认错，以及这笔交易最多能够承受多少损失。',
  '左侧交易是在趋势尚未转向时提前押注拐点；右侧交易是在方向得到确认后顺势参与。',
  '空仓并不代表错过机会，而是在保存判断力。没有持仓牵制时，往往更容易看清市场。',
  '机会通常藏在无人关注的时候，风险往往聚集在人声鼎沸之处。',
  '不要把一次交易当成决战，也不要依赖过高杠杆。控制仓位，让长期概率决定结果，而不是让单次输赢决定命运。',
  '普通行情淘汰看不懂走势的人，极端行情则会把那些自认为已经看懂市场的人一起清场。',
  '财富机会经常被故事和幻象包装。看清叙事之后参与趋势，并在所有人都深信不疑之前保持退出能力。',
  '年轻时或许可以依靠体力、机灵和运气走捷径，但真正决定一个人能走多远的，最终还是自律、心态与认知。',
  '大行情可以让一个人迅速成名，却没有人能够永远正确。真正的差距在于：判断正确时能够耐心持有，判断错误时能够果断退出。',
  '沉迷风险往往不是从一次重大亏损开始，而是从第一次轻松获利开始。',
  '市场永远比个人更强大。每当开始把自己当成高手时，往往也是最容易放松警惕的时候。',
  '顺势的人可以赚钱，逆势的人偶尔也能赚钱，但被贪婪支配的人很难长期留在市场。',
  '会进场只是开始，盈利之后懂得离场，才算真正完成了一笔交易。',
  '不必试图抓住每一段行情，只需要参与那些符合自己系统、节奏和性格的机会。',
  '当一个品种持续与你的交易方式不匹配时，就应该停止纠缠。过去的亏损，没有必要非在原来的地方赚回来。',
  '接受亏损，承认市场没有义务服从自己的判断，是交易走向成熟的重要一步。',
  '行情不会因为你的预测而出现。不要急于用观点证明自己，而要用纪律和长期结果检验自己的系统。',
  '金融市场最大的常态，就是未来始终存在意外。所谓绝对确定，往往只是另一种风险。',
  '交易允许犯错，但必须为重复出现的错误建立终止机制。',
  '相信年轻人的创造力，本质上就是相信未来仍然拥有新的可能。',
]

// ===== State =====
const state = {
  currentView: 'home',
  currentEpisode: null,
  currentCategory: 'morning',
  user: (() => { try { return JSON.parse(localStorage.getItem('ws_user')); } catch { return null; } })(),
  quizState: { currentQuestion: 0, answers: [], answered: false, wrongCount: 0, attempt: 0 },
  currentBoard: 'ideas',
  currentPost: null,
  currentPostData: null,
  currentReplies: [],
  communityPosts: [],
  communityPage: 1,
  communityTotal: 0,
  communityTotalPages: 1,
  communityRequestSeq: 0,
  communitySort: 'active',
  communityQuery: '',
  communityTag: '',
  communityTags: [],
  replyPage: 1,
  replyTotal: 0,
  replyTotalPages: 1,
  replyQuote: null,
  notificationUnread: 0,
  paidVideoEpisodes: [], // episode IDs with CF Stream paid videos
  videoAccessMap: {},    // { episodeId: access_level } — universal access control
  authMode: 'login_password',
  authRegType: 'phone',
  authPrefillEmail: '',
  authRedirectAfterLogin: null,
  referralInviteCode: '',
  paymentStatus: null,
}

const AUTH_COOKIE_NAME = 'ws_token'
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const LOGIN_REQUIRED_STATIC_PREFIXES = ['/research', '/earnings', '/ai泡沫周报', '/weekly']
const LOGIN_REQUIRED_APP_PREFIXES = [
  '/article',
  '/video',
  '/quiz',
  '/knowledge',
  '/mindmap',
  '/tools',
  '/community',
  '/post',
  '/profile',
  '/account',
  '/membership',
  '/quotes',
  '/admin',
  '/ai',
]
const LOGIN_REQUIRED_APP_VIEWS = new Set([
  'article',
  'video',
  'quiz',
  'knowledge',
  'mindmap',
  'tools',
  'community',
  'post',
  'profile',
  'membership',
  'quotes',
  'admin',
])

function getAuthCookieAttributes(maxAge) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  return `Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`
}

function setAuthCookie(token) {
  if (!token) return
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${getAuthCookieAttributes(AUTH_COOKIE_MAX_AGE_SECONDS)}`
}

function clearAuthCookie() {
  document.cookie = `${AUTH_COOKIE_NAME}=; ${getAuthCookieAttributes(0)}`
}

function safeDecodePathname(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function syncAuthCookieFromStorage() {
  const token = localStorage.getItem('ws_token')
  if (token) {
    setAuthCookie(token)
  } else {
    clearAuthCookie()
  }
  return token
}

function isLoginRequiredStaticPath(pathname) {
  const decodedPathname = safeDecodePathname(pathname)
  return LOGIN_REQUIRED_STATIC_PREFIXES.some((prefix) => (
    decodedPathname === prefix || decodedPathname.startsWith(`${prefix}/`) ||
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
}

function isLoginRequiredAppPath(pathname) {
  return LOGIN_REQUIRED_APP_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
}

function isLoginRequiredAppView(view) {
  return LOGIN_REQUIRED_APP_VIEWS.has(view)
}

function isLoginRequiredPath(pathname) {
  return isLoginRequiredStaticPath(pathname) || isLoginRequiredAppPath(pathname)
}

function hasClientAuth() {
  return Boolean(state.user && localStorage.getItem('ws_token'))
}

function getSafeLoginReturnPath(rawPath) {
  if (!rawPath) return null
  try {
    const target = new URL(rawPath, window.location.origin)
    if (target.origin !== window.location.origin) return null
    const path = target.pathname
    if (!isLoginRequiredPath(path)) return null
    return `${path}${target.search}${target.hash}`
  } catch {
    return null
  }
}

function showLoginRequiredModal(nextUrl) {
  showAuthModal('login_password', {
    message: '请先登录后访问该板块',
    messageType: 'err',
    nextUrl,
  })
}

function openProtectedLoginPath(targetPath) {
  if (hasClientAuth()) {
    syncAuthCookieFromStorage()
    window.location.href = targetPath
    return
  }
  showLoginRequiredModal(targetPath)
}

function handleProtectedStaticNav(event, targetPath) {
  if (hasClientAuth()) {
    syncAuthCookieFromStorage()
    return
  }
  event.preventDefault()
  showLoginRequiredModal(targetPath)
}

async function handleAuthGateRedirect(nextPath) {
  const safeNext = getSafeLoginReturnPath(nextPath)
  if (!safeNext) return false

  const token = syncAuthCookieFromStorage()
  if (token) {
    const verifiedUser = await refreshCurrentUserProfile().catch(() => null)
    if (verifiedUser) {
      syncAuthCookieFromStorage()
      window.location.assign(safeNext)
      return 'redirect'
    }
  }

  showLoginRequiredModal(safeNext)
  return true
}


// ===== Course Content Loader =====
const courseContent = createCourseContent(api)

function getEpisodeContentEntry(episodeId) {
  const id = Number(episodeId)
  const ep = episodes.find(item => item.id === id)
  const entry = courseContent.getEntry(id) || {}
  return {
    ...entry,
    quizCount: ep?.quizCount || entry.quizCount || 0,
    knowledgeCount: ep?.knowledgeCount || entry.knowledgeCount || 0,
    mindmapCount: ep?.mindmapCount || entry.mindmapCount || 0,
    structureCount: ep?.structureCount || entry.structureCount || 0,
  }
}

function courseContentLoadingHtml(label = '课程资料加载中...') {
  return `<p class="course-content-loading">${label}</p>`
}

function shouldRerenderForCourseManifest() {
  return ['home', 'article', 'video', 'quiz', 'knowledge', 'mindmap'].includes(state.currentView)
}

function getTelegramBindingSignature(user) {
  const binding = user?.telegramBinding
  if (!binding) return ''
  return [
    binding.username || '',
    binding.name || '',
    binding.groupStatus || '',
    binding.botStartedAt || '',
    binding.joinedAt || '',
    binding.lastInviteSentAt || '',
  ].join('|')
}

function getTelegramBindingLabel(binding) {
  if (!binding) return '未绑定'
  if (binding.username) return `@${binding.username}`
  if (binding.name) return binding.name
  return '已绑定 Telegram 账号'
}

function getTelegramBindingStatus(binding) {
  if (!binding) return ''
  const status = String(binding.groupStatus || '').trim()
  if (status === 'joined' || status === 'grace' || status === 'left' || status === 'kicked' || status === 'bound') {
    return status
  }
  return status || 'bound'
}

function canGenerateTelegramEntry(user) {
  const status = getTelegramBindingStatus(user?.telegramBinding)
  if (!status) return true
  return status === 'bound' || status === 'left' || status === 'kicked'
}

function getTelegramEntryButtonLabel(user) {
  const status = getTelegramBindingStatus(user?.telegramBinding)
  if (status === 'left' || status === 'kicked') return '重新获取入群链接'
  if (status === 'bound') return '重新获取机器人入口'
  return '联系机器人获取入群链接'
}

function getTelegramBindingHint(binding) {
  const status = getTelegramBindingStatus(binding)
  if (status === 'left') return '你之前已经退出群聊，可以继续用这个 Telegram 账号重新获取入群链接。'
  if (status === 'bound') return '如果你上次没进群，或者邀请链接过期了，可以继续用这个 Telegram 账号重新获取。'
  if (status === 'kicked') return '如果你已经重新续费，可以继续用这个 Telegram 账号重新获取入群链接。'
  if (status === 'grace') return '你当前还在宽限期内，暂时不需要重新生成入口。'
  if (status === 'joined') return '你当前已经在群里，不需要重新生成入口。'
  return ''
}

function getPlanExpiresAt(user = state.user) {
  const raw = user?.planExpiresAt || ''
  // mysql2 may return Date objects; extract YYYY-MM-DD portion
  if (raw && typeof raw === 'string' && raw.length >= 10) return raw.substring(0, 10)
  if (raw instanceof Date) return raw.toISOString().substring(0, 10)
  return String(raw)
}

function isPlanActiveClient(user = state.user) {
  if (!user || !user.plan || user.plan === 'free') return false
  if (user.membershipExpired === true || Number(user.membership_expired) === 1) return false
  const expiresAt = getPlanExpiresAt(user)
  // A null expiry represents a deliberately configured long-term membership.
  if (!expiresAt) return true
  const expiresTime = new Date(`${expiresAt}T23:59:59+08:00`).getTime()
  return Number.isFinite(expiresTime) && expiresTime >= Date.now()
}

function isMembershipExpiredClient(user = state.user) {
  const plan = user?.plan || 'free'
  return (plan === 'plus' || plan === 'pro') && !isPlanActiveClient(user)
}

function getMembershipDisplayName(user = state.user) {
  const rawPlan = user?.plan || 'free'
  if (isMembershipExpiredClient(user)) return `${rawPlan === 'pro' ? '💎 Pro' : '⭐ Plus'} 已过期`
  return ({ free:'体验版（免费）', plus:'⭐ Plus', pro:'💎 Pro' })[getEffectivePlan(user)] || '体验版（免费）'
}

function getEffectivePlan(user = state.user) {
  const plan = user?.plan || 'free'
  if (plan === 'plus' || plan === 'pro') {
    return isPlanActiveClient(user) ? plan : 'free'
  }
  return plan
}

let membershipExpiryReminderOpen = false

async function acknowledgeMembershipExpiryReminder(reminderId, surface = 'main') {
  try {
    await api.post(`/api/membership-expiry-reminders/${Number(reminderId)}/read`, { surface })
  } catch {
    // The reminder may appear again after a network failure; renewal remains available.
  }
}

function showMembershipExpiryReminder(reminder) {
  if (!reminder || membershipExpiryReminderOpen) return
  membershipExpiryReminderOpen = true
  const previousFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'membership-expiry-overlay'
  overlay.innerHTML = `
    <section class="membership-expiry-dialog" role="dialog" aria-modal="true" aria-labelledby="membershipExpiryTitle" aria-describedby="membershipExpirySummary">
      <button class="membership-expiry-close" type="button" aria-label="关闭会员到期提醒">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <div class="membership-expiry-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
      </div>
      <p class="membership-expiry-eyebrow">会员到期提醒</p>
      <h2 id="membershipExpiryTitle">${escapeHtml(reminder.title)}</h2>
      <p id="membershipExpirySummary">${escapeHtml(reminder.summary)}</p>
      <div class="membership-expiry-facts">
        <span><small>当前会员</small><strong>${escapeHtml(reminder.plan_label)}</strong></span>
        <span><small>到期日期</small><strong>${escapeHtml(reminder.expiry_date_text)}</strong></span>
      </div>
      <div class="membership-expiry-actions">
        <button class="btn btn-primary membership-expiry-renew" type="button">前往续费</button>
        <button class="btn btn-ghost membership-expiry-later" type="button">稍后处理</button>
      </div>
      <p class="membership-expiry-note">续费成功后会员有效期会自动更新，无需重复操作。</p>
    </section>`
  document.body.appendChild(overlay)

  const dismiss = ({ renew = false } = {}) => {
    if (!membershipExpiryReminderOpen) return
    membershipExpiryReminderOpen = false
    overlay.classList.remove('active')
    void acknowledgeMembershipExpiryReminder(reminder.id, 'main')
    setTimeout(() => overlay.remove(), 180)
    if (renew) {
      openMainAccountCenter('subscription')
      mainAccountCenterPreviousFocus = previousFocus instanceof HTMLElement ? previousFocus : null
    } else if (previousFocus instanceof HTMLElement) previousFocus.focus()
  }
  overlay.querySelector('.membership-expiry-close')?.addEventListener('click', () => dismiss())
  overlay.querySelector('.membership-expiry-later')?.addEventListener('click', () => dismiss())
  overlay.querySelector('.membership-expiry-renew')?.addEventListener('click', () => dismiss({ renew:true }))
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss() })
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') return dismiss()
    if (event.key !== 'Tab') return
    const focusable = [...overlay.querySelectorAll('button:not([disabled]), a[href]')]
    if (!focusable.length) return
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  requestAnimationFrame(() => {
    overlay.classList.add('active')
    overlay.querySelector('.membership-expiry-renew')?.focus()
  })
}

async function checkMembershipExpiryReminder() {
  if (!state.user || !api._token() || membershipExpiryReminderOpen) return
  if (!['plus', 'pro'].includes(String(state.user.plan || '').toLowerCase())) return
  try {
    const result = await api.get('/api/membership-expiry-reminders?surface=main')
    if (result.ok && result.reminder) showMembershipExpiryReminder(result.reminder)
  } catch {
    // Reminder loading must never block the rest of the site.
  }
}

async function refreshCurrentUserProfile({ rerender = false, syncTelegram = false } = {}) {
  if (!localStorage.getItem('ws_token')) return null

  try {
    const r = await api.get(syncTelegram ? '/api/profile?syncTelegram=1' : '/api/profile')
    if (r.user) {
      const planChanged = (
        getEffectivePlan(state.user) !== getEffectivePlan(r.user) ||
        state.user?.plan !== r.user.plan ||
        state.user?.planPeriod !== r.user.planPeriod ||
        getPlanExpiresAt(state.user) !== getPlanExpiresAt(r.user)
      )
      const adminChanged = !!state.user?.isAdmin !== !!r.user.isAdmin
      const bindingChanged = getTelegramBindingSignature(state.user) !== getTelegramBindingSignature(r.user)
      state.user = r.user
      localStorage.setItem('ws_user', JSON.stringify(r.user))
      updateAuthUI()
      refreshNotificationUnread()
      startPresenceHeartbeat()
      void checkMembershipExpiryReminder()
      if (rerender || state.paymentStatus === 'success' || planChanged || adminChanged || bindingChanged) renderView()
      return r.user
    }

    localStorage.removeItem('ws_token')
    localStorage.removeItem('ws_user')
    clearAuthCookie()
    state.user = null
    state.notificationUnread = 0
    stopPresenceHeartbeat()
    updateAuthUI()
    renderView()
    return null
  } catch {
    return null
  }
}

const PRESENCE_HEARTBEAT_INTERVAL_MS = 60 * 1000
const PRESENCE_HEARTBEAT_MIN_GAP_MS = 30 * 1000
let presenceHeartbeatTimer = null
let lastPresenceHeartbeatAt = 0

function canSendPresenceHeartbeat() {
  return Boolean(state.user && api._token())
}

async function sendPresenceHeartbeat({ force = false } = {}) {
  if (!canSendPresenceHeartbeat()) return
  const now = Date.now()
  if (!force && now - lastPresenceHeartbeatAt < PRESENCE_HEARTBEAT_MIN_GAP_MS) return
  lastPresenceHeartbeatAt = now

  try {
    await api.post('/api/presence', {
      view: state.currentView || 'home',
    })
  } catch {
    // Presence is best-effort and must not block normal browsing.
  }
}

function startPresenceHeartbeat() {
  if (!canSendPresenceHeartbeat()) return
  sendPresenceHeartbeat({ force: true })
  if (presenceHeartbeatTimer) return
  presenceHeartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    if (!canSendPresenceHeartbeat()) {
      stopPresenceHeartbeat()
      return
    }
    sendPresenceHeartbeat()
  }, PRESENCE_HEARTBEAT_INTERVAL_MS)
}

function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer)
    presenceHeartbeatTimer = null
  }
  lastPresenceHeartbeatAt = 0
}

// ===== Progress Tracking =====
const progress = {
  _getData() {
    try { return JSON.parse(localStorage.getItem('ws_progress') || '{}') } catch { return {} }
  },

  getAll() {
    if (!state.user) return {}
    return this._getData()[state.user.email] || {}
  },

  get(episodeId) {
    return this.getAll()[episodeId] || { watchedSeconds: 0, totalDuration: 0, completed: false }
  },

  async syncFromServer() {
    if (!state.user || !api._token()) return
    try {
      const res = await api.get('/api/progress')
      const list = res?.progress
      if (!Array.isArray(list)) return
      const data = this._getData()
      if (!data[state.user.email]) data[state.user.email] = {}
      list.forEach(p => {
        const serverTime = p.updatedAt ? new Date(p.updatedAt + 'Z').getTime() : 0
        const local = data[state.user.email][p.episodeId]
        // Keep the more recent data between local and server
        const localTime = local?.lastWatchedAt || 0
        data[state.user.email][p.episodeId] = {
          watchedSeconds: Math.max(p.watchedSeconds || 0, local?.watchedSeconds || 0),
          totalDuration: p.totalDuration || local?.totalDuration || 0,
          completed: !!(p.completed || local?.completed),
          quizPassed: !!(p.quizPassed || local?.quizPassed),
          lastWatchedAt: Math.max(serverTime, localTime),
        }
      })
      localStorage.setItem('ws_progress', JSON.stringify(data))
    } catch (e) { /* API unavailable, use localStorage */ }
  },

  update(episodeId, watchedSeconds, totalDuration) {
    if (!state.user) return
    const data = this._getData()
    if (!data[state.user.email]) data[state.user.email] = {}
    const entry = data[state.user.email][episodeId] || { watchedSeconds: 0, totalDuration: 0, completed: false }

    entry.watchedSeconds = Math.max(entry.watchedSeconds, watchedSeconds)
    entry.totalDuration = totalDuration
    entry.lastWatchedAt = Date.now()

    if (!entry.completed && totalDuration > 0 && entry.watchedSeconds / totalDuration >= 0.6) {
      entry.completed = true
    }

    data[state.user.email][episodeId] = entry
    localStorage.setItem('ws_progress', JSON.stringify(data))

    // Debounced sync to server (avoid flooding on every timeupdate)
    clearTimeout(this._syncTimer)
    this._pendingSync = { episodeId, watchedSeconds: entry.watchedSeconds, totalDuration: entry.totalDuration, completed: entry.completed }
    this._syncTimer = setTimeout(() => {
      this._flushSync()
    }, 3000)

    return entry
  },

  // Immediately flush pending progress to server
  _flushSync() {
    if (!this._pendingSync) return
    const data = this._pendingSync
    this._pendingSync = null
    clearTimeout(this._syncTimer)
    api.post('/api/progress', data).catch(err => console.error('Progress sync error:', err))
  },

  getRecentlyWatched(limit = 5) {
    const all = this.getAll()
    return Object.entries(all)
      .filter(([, p]) => p.watchedSeconds > 0)
      .sort((a, b) => (b[1].lastWatchedAt || 0) - (a[1].lastWatchedAt || 0))
      .slice(0, limit)
      .map(([id, p]) => ({ episodeId: parseInt(id), ...p }))
  },

  getCompletedCount() {
    return Object.values(this.getAll()).filter(p => p.completed).length
  },

  getInProgressCount() {
    return Object.values(this.getAll()).filter(p => p.watchedSeconds > 0 && !p.completed).length
  },

  isCompleted(episodeId) {
    return this.get(episodeId).completed
  },

  getPercent(episodeId) {
    const p = this.get(episodeId)
    if (!p.totalDuration) return 0
    return Math.min(100, Math.round((p.watchedSeconds / p.totalDuration) * 100))
  },

  // 测验通过记录
  isQuizPassed(episodeId) {
    const all = this.getAll()
    return all[episodeId]?.quizPassed === true
  },

  async setQuizPassed(episodeId) {
    if (!state.user) return
    try {
      await api.post('/api/progress', { episodeId, quizPassed: true })
    } catch (err) {
      console.error('Quiz sync error:', err)
    }
    // Update local cache after server sync
    const data = this._getData()
    if (!data[state.user.email]) data[state.user.email] = {}
    if (!data[state.user.email][episodeId]) data[state.user.email][episodeId] = { watchedSeconds: 0, totalDuration: 0, completed: false }
    data[state.user.email][episodeId].quizPassed = true
    localStorage.setItem('ws_progress', JSON.stringify(data))
  },

  // 课程是否解锁：所有课程均可自由进入，无顺序限制
  isUnlocked(episodeId) {
    return true
  },
}

// ===== Admin Check =====
function isAdmin() {
  return !!state.user?.isAdmin
}

// ===== Comments =====
const comments = {
  _getData() {
    try { return JSON.parse(localStorage.getItem('ws_comments') || '{}') } catch { return {} }
  },
  _save(data) {
    localStorage.setItem('ws_comments', JSON.stringify(data))
  },

  getByEpisode(episodeId) {
    return this._getData()[episodeId] || []
  },

  // 统计总数（评论 + 回复）
  getTotalCount(episodeId) {
    const list = this.getByEpisode(episodeId)
    return list.reduce((sum, c) => sum + 1 + (c.replies?.length || 0), 0)
  },

  async fetchFromServer(episodeId) {
    if (!api._token()) return
    try {
      const res = await api.get(`/api/comments?episode=${episodeId}`)
      const list = res.comments || res
      if (!Array.isArray(list)) return
      const data = this._getData()
      data[episodeId] = list.map(c => ({
        id: c.id,
        user: c.user || { id: null, name: 'Unknown' },
        text: c.text,
        timestamp: c.timestamp ? new Date(c.timestamp).getTime() : Date.now(),
        likes: c.isLiked ? [state.user?.email] : [],
        _likeCount: c.likes || 0,
        _isLiked: c.isLiked || false,
        replies: (c.replies || []).map(r => ({
          id: r.id,
          user: r.user || { id: null, name: 'Unknown' },
          text: r.text,
          timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
          likes: r.isLiked ? [state.user?.email] : [],
          _likeCount: r.likes || 0,
          _isLiked: r.isLiked || false,
        })),
      }))
      this._save(data)
    } catch (e) { /* API unavailable, use localStorage */ }
  },

  async add(episodeId, text) {
    if (!state.user || !text.trim()) return
    try {
      await api.post('/api/comments', { episodeId, text: text.trim() })
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Add comment error:', err)
      showToast('发布评论失败，请检查网络后重试', 'error')
    }
  },

  async delete(episodeId, index) {
    const data = this._getData()
    const comment = data[episodeId]?.[index]
    if (!comment?.id) return
    if (!state.user || Number(comment.user.id) !== Number(state.user.id)) return
    try {
      await api.del(`/api/comments?id=${comment.id}`)
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Delete comment error:', err)
      showToast('删除评论失败，请检查网络后重试', 'error')
    }
  },

  // 点赞/取消点赞
  async toggleLike(episodeId, commentIndex) {
    if (!state.user) return
    const data = this._getData()
    const comment = data[episodeId]?.[commentIndex]
    if (!comment?.id) return
    try {
      await api.post('/api/comments-like', { commentId: comment.id })
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Like error:', err)
    }
  },

  // 回复点赞
  async toggleReplyLike(episodeId, commentIndex, replyIndex) {
    if (!state.user) return
    const data = this._getData()
    const reply = data[episodeId]?.[commentIndex]?.replies?.[replyIndex]
    if (!reply?.id) return
    try {
      await api.post('/api/comments-like', { commentId: reply.id })
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Reply like error:', err)
    }
  },

  // 添加回复
  async addReply(episodeId, commentIndex, text) {
    if (!state.user || !text.trim()) return
    const data = this._getData()
    const comment = data[episodeId]?.[commentIndex]
    if (!comment?.id) return
    try {
      await api.post('/api/comments', { episodeId, text: text.trim(), parentId: comment.id })
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Add reply error:', err)
      showToast('回复失败，请检查网络后重试', 'error')
    }
  },

  // 删除回复
  async deleteReply(episodeId, commentIndex, replyIndex) {
    const data = this._getData()
    const reply = data[episodeId]?.[commentIndex]?.replies?.[replyIndex]
    if (!reply?.id) return
    if (!state.user || Number(reply.user.id) !== Number(state.user.id)) return
    try {
      await api.del(`/api/comments?id=${reply.id}`)
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Delete reply error:', err)
      showToast('删除回复失败，请检查网络后重试', 'error')
    }
  },

  formatTime(ts) {
    const d = new Date(ts)
    const now = new Date()
    const diff = now - d
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  },
}


let watchTimer = null
let accumulatedTime = 0

// ===== Bilibili Player =====
let biliPlayer = null
const biliDurationCache = {}

function fetchBiliDuration(bvid, epId) {
  api.get(`/api/bilibili-info/${bvid}`).then(r => {
    if (r.ok) {
      if (r.duration) biliDurationCache[epId] = r.duration
      // Auto-update cover for bilibili courses if cover is missing
      if (r.cover) {
        const ep = episodes.find(e => e.id === epId)
        if (ep && !ep.cover && r.cover) {
          ep.cover = r.cover
          // Persist cover to database
          api.post('/api/video-stream', { episodeId: epId, bilibiliId: bvid }).catch(() => {})
        }
      }
    }
  }).catch(() => {})
}

function initBiliPlayer(bvid) {
  const ep = state.currentEpisode
  if (ep) {
    const p = progress.get(ep.id)
    accumulatedTime = p.watchedSeconds || 0
    fetchBiliDuration(bvid, ep.id)
  }

  const container = document.getElementById('videoContainer')
  if (!container) return

  // Bilibili embed iframe — validate BV id format first
  const safeBvid = /^BV[a-zA-Z0-9]+$/.test(bvid) ? bvid : ''
  if (!safeBvid) {
    container.innerHTML = '<div class="video-error">无效的视频 ID</div>'
    return
  }
  container.innerHTML = '<iframe id="biliPlayer" src="https://player.bilibili.com/player.html?bvid=' + safeBvid + '&high_quality=1&danmaku=0" allowfullscreen allow="autoplay; encrypted-media" style="width:100%;height:100%;border:none;"></iframe>'

  biliPlayer = document.getElementById('biliPlayer')
  // Bilibili doesn't have a JS API for progress tracking,
  // so we use a timer-based approach
  startWatchTimer()
}

// Event delegation for video retry buttons (avoids inline onclick XSS risk)
document.addEventListener('click', (e) => {
  if (e.target.closest('.video-retry-btn')) {
    location.reload()
  }
})

function initLocalPlayer(videoUrl) {
  const ep = state.currentEpisode
  if (ep) {
    const p = progress.get(ep.id)
    accumulatedTime = p.watchedSeconds || 0
  }

  const container = document.getElementById('videoContainer')
  if (!container) return

  container.innerHTML = '<video id="localPlayer" controls preload="metadata" style="width:100%;height:100%;"><source src="' + escapeHtml(videoUrl) + '" type="video/mp4">您的浏览器不支持视频播放</video>'

  const video = document.getElementById('localPlayer')
  if (!video) return

  video.addEventListener('play', () => startWatchTimer())
  video.addEventListener('pause', () => stopWatchTimer())
  video.addEventListener('ended', () => stopWatchTimer())
  video.addEventListener('loadedmetadata', () => {
    const duration = video.duration
    if (ep && state.user) {
      const entry = progress.get(ep.id)
      updateProgressUI({ ...entry, totalDuration: duration }, duration)
    }
    // Resume from saved position
    if (accumulatedTime > 0) {
      video.currentTime = accumulatedTime
    }
  })
  video.addEventListener('timeupdate', () => {
    if (video.duration > 0 && ep && state.user) {
      accumulatedTime = Math.floor(video.currentTime)
      const entry = progress.update(ep.id, accumulatedTime, video.duration)
      updateProgressUI(entry, video.duration)
    }
  })
}

function initQiniuPlayer(videoUrl) {
  // Qiniu CDN serves standard MP4, use same as local player
  initLocalPlayer(videoUrl)
}

function destroyPlayer() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  biliPlayer = null
  const localVideo = document.getElementById('localPlayer')
  if (localVideo) { localVideo.pause(); localVideo.src = '' }
  accumulatedTime = 0
}

function parseDuration(str) {
  if (!str) return 0
  const parts = String(str).split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(str) || 0
}

function getEpisodeDuration() {
  const ep = state.currentEpisode
  if (!ep) return 0;
  // Check Bilibili duration cache first
  if (biliDurationCache[ep.id]) return biliDurationCache[ep.id]
  // Try to get duration from course catalog
  const course = courseCatalog.getById(ep.id)
  const dur = parseDuration(course?.duration) || parseDuration(ep.duration) || 0
  return dur
}

function startWatchTimer() {
  if (watchTimer) return
  watchTimer = setInterval(() => {
    accumulatedTime++
    const ep = state.currentEpisode
    if (!ep || !state.user) return
    // Bilibili uses episode duration
    const duration = getEpisodeDuration()
    if (duration > 0) {
      const entry = progress.update(ep.id, accumulatedTime, duration)
      updateProgressUI(entry, duration)
    }
  }, 1000)
}

function stopWatchTimer() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
}

function updateProgressUI(entry, duration) {
  const percent = Math.min(100, Math.round((entry.watchedSeconds / duration) * 100))
  const fill = document.getElementById('watchFill')
  const text = document.getElementById('watchText')
  if (fill) fill.style.width = percent + '%'
  if (text) text.textContent = `已观看 ${percent}%` + (entry.completed ? ' · 已完成' : ` · 需达到 60%`)

  // 完成提示 + 解锁答题按钮
  if (entry.completed) {
    if (fill) fill.style.background = 'var(--accent-gradient)'
    const badge = document.getElementById('completeBadge')
    if (badge) badge.style.display = 'inline-flex'
    const quizBtn = document.querySelector('.video-actions button[disabled][title="观看60%后解锁"]')
    if (quizBtn) {
      quizBtn.disabled = false
      quizBtn.className = 'btn btn-primary btn-lg'
      quizBtn.id = 'startQuiz'
      quizBtn.removeAttribute('title')
      quizBtn.textContent = '开始答题'
    }
  }
}

// ===== DOM References =====
const $ = (sel) => document.querySelector(sel)
const mainContent = $('#mainContent')
const modalOverlay = $('#modalOverlay')
const modalTitle = $('#modalTitle')
const modalBody = $('#modalBody')
let authModalBackdropPress = false
const mainAccountCenterModal = $('#mainAccountCenterModal')
const mainAccountCenterFrame = $('#mainAccountCenterFrame')
let mainAccountCenterPreviousFocus = null

function getMainAccountTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function openMainAccountCenter(tab = 'overview') {
  if (!requireLogin() || !mainAccountCenterModal || !mainAccountCenterFrame) return
  mainAccountCenterPreviousFocus = document.activeElement
  const theme = getMainAccountTheme()
  const nextSrc = `/account/?embed=main&tab=${encodeURIComponent(tab)}&theme=${theme}`
  if (!mainAccountCenterFrame.src || !mainAccountCenterFrame.src.includes('/account/')) {
    mainAccountCenterFrame.src = nextSrc
  } else {
    mainAccountCenterFrame.contentWindow?.postMessage({ type:'account-center-tab',tab },window.location.origin)
    mainAccountCenterFrame.contentWindow?.postMessage({ type:'account-center-theme',theme },window.location.origin)
  }
  mainAccountCenterModal.classList.remove('hidden')
  mainAccountCenterModal.setAttribute('aria-hidden','false')
  document.body.classList.add('main-account-center-open')
  requestAnimationFrame(() => mainAccountCenterFrame.focus())
}

function closeMainAccountCenter() {
  if (!mainAccountCenterModal || mainAccountCenterModal.classList.contains('hidden')) return
  mainAccountCenterModal.classList.add('hidden')
  mainAccountCenterModal.setAttribute('aria-hidden','true')
  document.body.classList.remove('main-account-center-open')
  if (mainAccountCenterPreviousFocus instanceof HTMLElement) mainAccountCenterPreviousFocus.focus()
  mainAccountCenterPreviousFocus = null
}

function applyMainLoggedOutState() {
  state.user = null
  state.notificationUnread = 0
  localStorage.removeItem('ws_user')
  stopPresenceHeartbeat()
  updateAuthUI()
  renderView()
}

window.addEventListener('message',(event) => {
  if (event.origin !== window.location.origin || event.source !== mainAccountCenterFrame?.contentWindow) return
  if (event.data?.type === 'account-center-close') return closeMainAccountCenter()
  if (event.data?.type === 'account-session-logout') {
    closeMainAccountCenter()
    applyMainLoggedOutState()
    return
  }
  if (event.data?.type === 'account-profile-updated' && event.data.user) {
    state.user = { ...state.user,...event.data.user }
    localStorage.setItem('ws_user',JSON.stringify(state.user))
    updateAuthUI()
  }
  if (event.data?.type === 'account-notifications-updated') {
    state.notificationUnread = Number(event.data.unreadCount || 0)
    updateAuthUI()
  }
})

function normalizeReferralDisplayCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
}

async function handleReferralQueryParam(urlParams) {
  const code = normalizeReferralDisplayCode(urlParams.get('ref'))
  if (!code) return
  const cleanUrl = new URL(window.location.href)
  cleanUrl.searchParams.delete('ref')
  const nextUrl = `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`
  if (state.user) {
    window.history.replaceState(window.history.state || {}, '', nextUrl || '/')
    showFormMsgProfile('邀请链接仅用于新用户注册', 'ok')
    return
  }
  try {
    const res = await api.post('/api/referrals/track', { code })
    if (res.disabled) {
      showFormMsgProfile(res.message || '邀请返佣功能暂未开放', 'ok')
    }
    if (res.ok || res.disabled) {
      window.history.replaceState(window.history.state || {}, '', nextUrl || '/')
      if (res.ok) {
        state.referralInviteCode = code
        showAuthModal('register', {
          referralCode: code,
          message: '已识别邀请链接，请完成注册',
          messageType: 'ok',
        })
      }
    } else if (res.error) {
      showFormMsgProfile(res.error, 'err')
    }
  } catch (err) {
    console.warn('Referral tracking failed:', err)
  }
}

// ===== Initialize =====
async function init() {
  // Restore cached user state BEFORE first render so protected views (admin) work on deep link
  if (localStorage.getItem('ws_token')) {
    try {
      const cached = JSON.parse(localStorage.getItem('ws_user') || 'null')
      if (cached) state.user = cached
    } catch {}
  }
  syncAuthCookieFromStorage()

  mainContent.innerHTML = '<div class="loading-spinner" style="padding:60px 0;text-align:center;">加载课程中...</div>'
  await courseCatalog.load()

  // Check for payment redirect
  const urlParams = new URLSearchParams(window.location.search)
  await handleReferralQueryParam(urlParams)
  const paymentStatus = urlParams.get('payment')
  state.paymentStatus = paymentStatus
  const authGateNext = urlParams.get('auth') === 'login' ? urlParams.get('next') : null
  let initialLoginNext = null
  let initialAuthMode = null
  if (paymentStatus) {
    // Clean URL
    window.history.replaceState({}, '', '/')
    state.currentView = 'home'
    if (paymentStatus === 'success') {
      setTimeout(() => {
        showToast('🎉 支付成功！你的会员已升级，请重新登录以刷新状态。', 'success')
      }, 500)
    } else if (paymentStatus === 'failed') {
      setTimeout(() => {
        showToast('支付未完成，如有问题请联系客服。', 'error')
      }, 500)
    }
  } else {
    // Restore view from URL path on initial load
    const route = pathToRoute(window.location.pathname)
    initialAuthMode = route.authMode || null
    state.currentView = route.view
    if (route.episode) state.currentEpisode = route.episode
    if (route.postId) state.currentPost = route.postId
    const routePath = route.canonicalPath || window.location.pathname
    const routeUrl = `${routePath}${window.location.search}${window.location.hash}`
    if (isLoginRequiredAppPath(routePath) && !hasClientAuth()) {
      initialLoginNext = routeUrl
      state.currentView = 'home'
      state.currentEpisode = null
      state.currentPost = null
    }
    // Replace state so popstate has data for the initial entry
    window.history.replaceState(
      initialLoginNext
        ? { view: 'home' }
        : { view: route.view, episodeId: route.episode?.id, postId: route.postId },
      '',
      initialLoginNext ? '/' : routeUrl
    )
  }

  if (state.currentView === 'profile') {
    const requestedSettingsTab = urlParams.get('tab')
    if (['profile','account','notifications','subscription','credits'].includes(requestedSettingsTab)) settingsTab = requestedSettingsTab
  }
  renderView()
  updateAuthUI()
  setupGlobalEvents()
  startPresenceHeartbeat()
  loadMarketMenu()
  if (await handleAuthGateRedirect(authGateNext) === 'redirect') return
  if (initialAuthMode) {
    const authReturnPath = getSafeLoginReturnPath(urlParams.get('next')) || '/account'
    if (hasClientAuth()) {
      const verifiedUser = await refreshCurrentUserProfile().catch(() => null)
      if (verifiedUser) {
        window.location.replace(authReturnPath)
        return
      }
    }
    showAuthModal(initialAuthMode, { nextUrl:authReturnPath })
  }
  if (!authGateNext && initialLoginNext) {
    showLoginRequiredModal(initialLoginNext)
  }

  courseContent.loadManifest().then(() => {
    if (shouldRerenderForCourseManifest()) renderView()
  }).catch(() => {})

  // Load video access map (public, no sensitive data — only episode IDs + access_level)
  api.get('/api/video-stream').then(r => {
    if (r.episodes) {
      syncVideoAccessState(r.episodes)
      const streamIds = new Set(state.paidVideoEpisodes.map(Number))
      episodes = episodes.map(ep => ({
        ...ep,
        hasStreamVideo: streamIds.has(ep.id),
        accessLevel: state.videoAccessMap[ep.id] || ep.accessLevel || 'free',
      }))
      if (state.currentView === 'home') renderHome()
      else if (state.currentView === 'article') renderArticle()
      else if (state.currentView === 'video') renderVideo()
    }
  }).catch(() => {})

  // Validate token on app startup & sync plan from server
  if (localStorage.getItem('ws_token')) {
    refreshCurrentUserProfile().catch(() => {})
  }
}

// ===== Routing =====
function renderView() {
  const pageTitles = {
    home: '量见',
    courses: '课程体系 | 量见',
    courseCraft: '交易是一门手艺 | 量见',
    courseAi: 'AI铸剑 | 量见',
  }
  document.title = pageTitles[state.currentView] || '量见'
  switch (state.currentView) {
    case 'home': renderHome(); break
    case 'courses': mainContent.innerHTML = renderCourseOverviewPage(); break
    case 'courseCraft': mainContent.innerHTML = renderCourseProgramPage(getCourseProgramByView('courseCraft')); break
    case 'courseAi': mainContent.innerHTML = renderCourseProgramPage(getCourseProgramByView('courseAi')); break
    case 'article': renderArticle(); break
    case 'video': renderVideo(); break
    case 'quiz': renderQuiz(); break
    case 'knowledge': renderKnowledge(); break
    case 'mindmap': renderMindmap(); break
    case 'quotes': renderQuotes(); break
    case 'tools': renderTools(); break
    case 'tos': renderTos(); break
    case 'profile': renderProfile(); break
    case 'membership': renderMembership(); break
    case 'community': renderCommunity(); break
    case 'post': renderPost(); break
    case 'trades': renderTrades(); break
  }
}

// 未登录时拦截操作，弹出登录提示
function requireLogin() {
  if (hasClientAuth()) return true
  showAuthModal('login_password')
  return false
}

// 是否付费会员（plus 或 pro）
function isPaid() {
  const plan = getEffectivePlan()
  return plan === 'plus' || plan === 'pro'
}

// --- Universal Video Access Control ---
// Check if current user can access a video with given access_level
function canAccessVideo(episodeId) {
  const ep = episodes.find(item => item.id === Number(episodeId))
  const level = state.videoAccessMap[episodeId] || ep?.accessLevel
  if (!level || level === 'free') return true
  if (level === 'logged_in') return !!state.user
  const plan = getEffectivePlan()
  if (level === 'plus_pro') return plan === 'plus' || plan === 'pro'
  if (level === 'pro_only') return plan === 'pro'
  return false
}

// Get human-readable access level label
function getAccessLabel(episodeId) {
  const ep = episodes.find(item => item.id === Number(episodeId))
  const level = state.videoAccessMap[episodeId] || ep?.accessLevel
  if (!level || level === 'free') return ''
  if (level === 'logged_in') return '登录可看'
  if (level === 'plus_pro') return '仅 Plus / Pro 会员可观看'
  if (level === 'pro_only') return '仅 Pro 会员可观看'
  return ''
}

// Get short badge text for episode card
function getAccessBadge(episodeId) {
  const ep = episodes.find(item => item.id === Number(episodeId))
  const level = state.videoAccessMap[episodeId] || ep?.accessLevel
  if (!level || level === 'free') return ''
  if (level === 'logged_in') return '登录可看'
  if (level === 'plus_pro') return '会员专属'
  if (level === 'pro_only') return 'Pro 专属'
  return ''
}

function isArticleEpisode(ep) {
  return ep?.contentType === 'article' || Boolean(ep?.articleUrl)
}

function getEpisodeDetailView(ep = state.currentEpisode) {
  return isArticleEpisode(ep) ? 'article' : 'video'
}

function getEpisodeDetailPath(ep) {
  return viewToPath(getEpisodeDetailView(ep), ep)
}

function navigateToEpisode(ep, skipPush = false) {
  if (!ep) return navigate('home')
  return navigate(getEpisodeDetailView(ep), ep, skipPush)
}

function getEpisodeBackLabel(ep = state.currentEpisode) {
  return isArticleEpisode(ep) ? '← 返回文章' : '← 返回视频'
}

function getNextEpisodeLabel(ep) {
  if (!ep) return '进入下一篇'
  return `进入${escapeHtml(ep.title)}`
}

// 渲染用户头像（支持自定义头像或首字母）
function renderAvatar(user, extraClass = '') {
  const cls = extraClass ? `comment-avatar ${extraClass}` : 'comment-avatar'
  if (user.avatar) {
    return `<div class="${cls}"><img src="${escapeHtml(user.avatar)}" class="avatar-img"></div>`
  }
  return `<div class="${cls}">${escapeHtml((user.name || 'U').charAt(0).toUpperCase())}</div>`
}

// ===== SPA Routing =====
function viewToPath(view, episode) {
  switch (view) {
    case 'home': return '/'
    case 'courses': return '/courses'
    case 'courseCraft': return '/courses/trading-craft'
    case 'courseAi': return '/courses/ai-forging'
    case 'article': return episode ? `/article/${episode.id}` : '/article'
    case 'video': return episode ? `/video/${episode.id}` : '/video'
    case 'quiz': return state.currentEpisode ? `/quiz/${state.currentEpisode.id}` : '/quiz'
    case 'knowledge': return state.currentEpisode ? `/knowledge/${state.currentEpisode.id}` : '/knowledge'
    case 'mindmap': return state.currentEpisode ? `/mindmap/${state.currentEpisode.id}` : '/mindmap'
    case 'trades': return '/trades'
    case 'tools': return '/tools'
    case 'community': return '/community'
    case 'post': return state.currentPost ? `/post/${state.currentPost}` : '/community'
    case 'profile': return '/account'
    case 'membership': return '/membership'
    case 'quotes': return '/quotes'
    case 'tos': return '/tos'
    default: return '/'
  }
}

function pathToRoute(path) {
  const clean = path.replace(/\/$/, '') || '/'
  if (clean === '/') return { view: 'home' }
  if (clean === '/courses') return { view: 'courses' }
  if (clean === '/courses/trading-craft') return { view: 'courseCraft' }
  if (clean === '/courses/ai-forging') return { view: 'courseAi' }
  if (clean === '/trades') return { view: 'trades' }
  if (clean === '/tools') return { view: 'tools' }
  if (clean === '/community') return { view: 'community' }
  if (clean === '/account') return { view: 'profile' }
  if (clean === '/profile') return { view: 'profile', canonicalPath:'/account' }
  if (clean === '/auth' || clean === '/auth/login') return { view:'home', authMode:'login_password' }
  if (clean === '/auth/register') return { view:'home', authMode:'register' }
  if (clean === '/membership') return { view: 'membership' }
  if (clean === '/quotes') return { view: 'quotes' }
  if (clean === '/tos') return { view: 'tos' }

  const articleMatch = clean.match(/^\/article\/(\d+)$/)
  if (articleMatch) {
    const ep = episodes.find(e => e.id === parseInt(articleMatch[1]))
    return ep && isArticleEpisode(ep)
      ? { view: 'article', episode: ep }
      : ep
        ? { view: 'video', episode: ep, canonicalPath: getEpisodeDetailPath(ep) }
        : { view: 'home' }
  }
  if (clean === '/article') return { view: 'home' }

  const videoMatch = clean.match(/^\/video\/(\d+)$/)
  if (videoMatch) {
    const ep = episodes.find(e => e.id === parseInt(videoMatch[1]))
    return ep
      ? { view: getEpisodeDetailView(ep), episode: ep, canonicalPath: getEpisodeDetailPath(ep) }
      : { view: 'home' }
  }
  if (clean === '/video') return { view: 'home' }

  const quizMatch = clean.match(/^\/quiz\/(\d+)$/)
  if (quizMatch) {
    const ep = episodes.find(e => e.id === parseInt(quizMatch[1]))
    return ep ? { view: 'quiz', episode: ep } : { view: 'home' }
  }

  const knowledgeMatch = clean.match(/^\/knowledge\/(\d+)$/)
  if (knowledgeMatch) {
    const ep = episodes.find(e => e.id === parseInt(knowledgeMatch[1]))
    return ep ? { view: 'knowledge', episode: ep } : { view: 'home' }
  }

  const mindmapMatch = clean.match(/^\/mindmap\/(\d+)$/)
  if (mindmapMatch) {
    const ep = episodes.find(e => e.id === parseInt(mindmapMatch[1]))
    return ep ? { view: 'mindmap', episode: ep } : { view: 'home' }
  }

  const postMatch = clean.match(/^\/post\/(.+)$/)
  if (postMatch) return { view: 'post', postId: postMatch[1] }

  return { view: 'home' }
}

function navigate(view, episode = null, skipPush = false) {
  if (isLoginRequiredAppView(view) && !hasClientAuth()) {
    showLoginRequiredModal(viewToPath(view, episode))
    return
  }
  destroyPlayer()
  destroyCommunityEditor()
  resetReplyDraftImages()
  releasePostImageObjectUrls()
  closePostImageLightbox()
  state.currentView = view
  if (episode) {
    state.currentEpisode = episode
    state._videoWarningShown = false
  }
  if (view === 'quiz') {
    state.quizState = { currentQuestion: 0, answers: [], answered: false, wrongCount: 0, attempt: 0 }
  }
  if (!skipPush) {
    const path = viewToPath(view, episode)
    window.history.pushState({ view, episodeId: episode?.id, postId: state.currentPost }, '', path)
  }
  window.scrollTo(0, 0)
  renderView()
  if (view === 'profile' && localStorage.getItem('ws_token')) {
    refreshCurrentUserProfile({ rerender: true }).catch(() => {})
  }
}

// Flush pending progress sync before user leaves page
window.addEventListener('beforeunload', () => { progress._flushSync() })
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    progress._flushSync()
  } else {
    sendPresenceHeartbeat({ force: true })
  }
})

window.addEventListener('popstate', (e) => {
  const route = e.state ? e.state : pathToRoute(window.location.pathname)
  const nextPath = route.canonicalPath || window.location.pathname
  if (isLoginRequiredAppPath(nextPath) && !hasClientAuth()) {
    destroyPlayer()
    destroyCommunityEditor()
    resetReplyDraftImages()
    releasePostImageObjectUrls()
    closePostImageLightbox()
    state.currentView = 'home'
    state.currentEpisode = null
    state.currentPost = null
    window.history.replaceState({ view: 'home' }, '', '/')
    window.scrollTo(0, 0)
    renderView()
    showLoginRequiredModal(nextPath)
    return
  }
  destroyPlayer()
  destroyCommunityEditor()
  resetReplyDraftImages()
  releasePostImageObjectUrls()
  closePostImageLightbox()
  state.currentView = route.view || 'home'
  if (route.episodeId) {
    const ep = episodes.find(e => e.id === route.episodeId)
    if (ep) state.currentEpisode = ep
  }
  if (route.episode) {
    state.currentEpisode = route.episode
  }
  if (route.postId) state.currentPost = route.postId
  if (state.currentView === 'quiz') {
    state.quizState = { currentQuestion: 0, answers: [], answered: false, wrongCount: 0, attempt: 0 }
  }
  window.scrollTo(0, 0)
  renderView()
  if (state.currentView === 'profile' && localStorage.getItem('ws_token')) {
    refreshCurrentUserProfile({ rerender: true }).catch(() => {})
  }
})

// ===== Home View =====
function renderHome() {
  const filtered = getFilteredEpisodes()
  const statsHtml = renderSidebarStats()
  const quotesHtml = renderSidebarQuotes()
  const updatesHtml = renderSidebarUpdates()
  const mobileUpdatesHtml = renderSidebarUpdates(null, true)
  const historyHtml = renderSidebarHistory()
  const mobileBelowCoursesHtml = `${mobileUpdatesHtml}${historyHtml}${quotesHtml}${statsHtml}`
  const sidebarHtml = `${statsHtml}${quotesHtml}${updatesHtml}${historyHtml}`

  mainContent.innerHTML = `
    <section class="hero-wrap">
      <span class="hero-eyebrow">交易与 AI 技术教育平台</span>
      <h1 class="hero-title">量化市场之道，诚待天下之人</h1>
      <p class="hero-lead">在这里，系统学习交易的底层逻辑、技术分析方法，以及 AI 在交易分析中的技术应用。我们教方法、讲原理，帮你建立属于自己的判断力。</p>
      <p class="hero-fineprint">市场永远有风险。我们能交付的是能力与方法，而不是对收益的承诺——这一点，从第一天起就不会变。</p>
      <div class="hero-cta">
        <button class="btn btn-primary" type="button" data-course-route="courseCraft">免费试听入门课</button>
        <button class="btn btn-outline" type="button" data-course-route="courses">查看完整课程体系</button>
      </div>
      <div class="hero-tags">
        <span class="hero-tag"><b>讲方法</b>，不讲内幕</span>
        <span class="hero-tag"><b>讲风险</b>，不讲稳赚</span>
        <span class="hero-tag"><b>讲技术</b>，不带单不荐股</span>
      </div>
    </section>

    <section class="values-wrap">
      <div class="value-card">
        <div class="value-icon">⚖︎</div>
        <h3>技术平权</h3>
        <p>把曾经只属于专业圈子的分析方法，清楚地讲给每一个普通人。</p>
      </div>
      <div class="value-card">
        <div class="value-icon">⚡︎</div>
        <h3>执行效率</h3>
        <p>理解 AI 如何把繁琐、易受情绪干扰的环节自动化——这是一种值得学习的能力。</p>
      </div>
      <div class="value-card">
        <div class="value-icon">◈</div>
        <h3>复杂决策辅助</h3>
        <p>学会用数据与模型辅助思考，把判断权牢牢握在自己手里。</p>
      </div>
    </section>

    <div class="home-layout fade-in">
      <div class="home-main">
        <div class="tabs">
          ${categories.map(cat => `
            <button class="tab ${state.currentCategory === cat.id ? 'active' : ''}" data-category="${cat.id}">
              ${cat.name}
            </button>
          `).join('')}
        </div>

        <div class="episode-grid">
          ${filtered.map(ep => renderEpisodeCard(ep)).join('')}
        </div>

        ${filtered.length === 0 ? '<p style="text-align:center; color:var(--text-3); padding:48px 0;">未找到匹配的课程</p>' : ''}

        <div class="home-mobile-below-courses">
          ${mobileBelowCoursesHtml}
        </div>
      </div>

      <div class="home-sidebar">
        ${sidebarHtml}
      </div>
    </div>
  `

  // 异步从 API 加载最新更新（用真实数据替换静态后备）
  refreshSidebarUpdates()

}

function getCardBackground(ep) {
  if (ep.cover) return `background-image: url('${ep.cover}'); background-size: cover; background-position: center;`
  return `background: ${ep.gradient};`
}

function renderEpisodeCard(ep) {
  const hasPaidVideo = ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)
  const hasCover = ep.cover || hasPaidVideo
  const completed = state.user && progress.isCompleted(ep.id)
  const quizPassed = state.user && progress.isQuizPassed(ep.id)
  const percent = state.user ? progress.getPercent(ep.id) : 0
  const accessBadge = getAccessBadge(ep.id)

  return `
    <div class="episode-card ${completed ? 'completed' : ''}" data-episode-id="${ep.id}">
      <div class="card-thumbnail">
        <div class="card-thumbnail-bg" style="${getCardBackground(ep)}">
          ${!hasCover && ep.number ? `
            <span class="ep-label">EP</span>
            <span class="ep-number">${String(ep.number).padStart(2, '0')}</span>
          ` : ''}
        </div>
        ${(ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)) && ep.duration ? `<span class="card-duration">${ep.duration}</span>` : ''}
        ${ep.number ? `<span class="card-ep-badge">EP.${String(ep.number).padStart(2, '0')}</span>` : ''}
        ${isArticleEpisode(ep) ? '<span class="card-type-badge">文章</span>' : ''}
        ${accessBadge && !isArticleEpisode(ep) ? `<span class="card-paid-badge">${accessBadge}</span>` : ''}
        ${completed && quizPassed ? '<span class="card-complete-badge">已通过</span>' : completed ? '<span class="card-complete-badge" style="background:rgba(247,147,26,0.9)">待答题</span>' : ''}
      </div>
      ${percent > 0 && !completed ? `<div class="card-progress"><div class="card-progress-fill" style="width:${percent}%"></div></div>` : ''}
      <div class="card-body">
        <div class="card-title">${escapeHtml(ep.title)}</div>
        <div class="card-desc">${escapeHtml(ep.description)}</div>
      </div>
    </div>
  `
}

function renderSidebarStats() {
  const completedCount = state.user ? progress.getCompletedCount() : 0
  const inProgressCount = state.user ? progress.getInProgressCount() : 0

  return `
    <div class="sidebar-card">
      <h3>学习统计</h3>
      ${!state.user ? '<p class="login-hint">登录后查看学习进度</p>' : `
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-number">${episodes.length}</div>
            <div class="stat-label">总课程</div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${completedCount}</div>
            <div class="stat-label">已完成</div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${inProgressCount}</div>
            <div class="stat-label">学习中</div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${Math.round(completedCount / episodes.length * 100)}%</div>
            <div class="stat-label">完成率</div>
          </div>
        </div>
      `}
    </div>
  `
}

function renderSidebarQuotes() {
  // 侧边栏随机显示5条语录
  const shuffled = allQuotes.map((text, index) => ({ text, index })).sort(() => Math.random() - 0.5)
  const sidebarQuotes = shuffled.slice(0, 5)

  return `
    <div class="sidebar-card sidebar-quote-card quotes-card" style="cursor:pointer">
      <h3>量见语录</h3>
      <ul class="sidebar-quote-list">
        ${sidebarQuotes.map((q, i) => `
          <li class="sidebar-quote-item">
            <span class="sidebar-quote-num">${String(q.index + 1).padStart(2, '0')}</span>
            <span class="sidebar-quote-text">${q.text.length > 30 ? q.text.substring(0, 30) + '...' : q.text}</span>
          </li>
        `).join('')}
      </ul>
      <div class="sidebar-quote-more">查看全部 ${allQuotes.length} 条语录 →</div>
    </div>
  `
}

function renderSidebarUpdates(data = null, isMobile = false) {
  const updates = data || []
  const cardId = isMobile ? 'mobile-updates-card' : 'sidebar-updates-card'
  if (!updates || updates.length === 0) {
    // 页面加载时异步获取，先显示占位
    return `
      <div class="sidebar-card sidebar-updates-card" id="${cardId}">
        <h3>最近更新</h3>
        <ul class="updates-list">
          <li class="update-item" style="justify-content:center;opacity:0.5">加载中…</li>
        </ul>
      </div>
    `
  }
  const items = updates.slice(0, 5)
  const now = new Date()

  return `
    <div class="sidebar-card sidebar-updates-card" id="${cardId}">
      <h3>📢 最近更新</h3>
      <ul class="updates-list">
        ${items.map((u, idx) => {
          const isNew = isRecent(u.date, now, 3) // 3 天内标"新"
          const targetAttr = u.target ? `data-update-target='${escapeHtml(JSON.stringify(u.target))}'` : ''
          return `
            <li class="update-item" ${targetAttr}>
              <div class="update-icon">${u.icon || '·'}</div>
              <div class="update-info">
                <div class="update-title">${escapeHtml(u.title)}${isNew ? '<span class="update-new-badge">新</span>' : ''}</div>
                <div class="update-date">${formatUpdateDate(u.date, now)}</div>
              </div>
            </li>
          `
        }).join('')}
      </ul>
    </div>
  `
}

function isRecent(dateStr, now, days) {
  if (!dateStr) return false
  const then = new Date(dateStr + 'T00:00:00')
  const diffDays = (now - then) / (1000 * 60 * 60 * 24)
  return diffDays >= 0 && diffDays <= days
}

function formatUpdateDate(dateStr, now) {
  if (!dateStr) return ''
  const then = new Date(dateStr + 'T00:00:00')
  const diffDays = Math.floor((now - then) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`
  // 超过 30 天显示具体日期（去年就带年份）
  const [y, m, d] = dateStr.split('-')
  if (String(now.getFullYear()) !== y) return `${y}.${m}.${d}`
  return `${m}.${d}`
}

async function refreshSidebarUpdates() {
  const updates = await loadSiteUpdates(5)
  if (!updates || updates.length === 0) return
  const now = new Date()
  const html = updates.map(u => {
    const isNew = isRecent(u.date, now, 3)
    const targetAttr = u.target ? `data-update-target='${escapeHtml(JSON.stringify(u.target))}'` : ''
    return `
      <li class="update-item" ${targetAttr}>
        <div class="update-icon">${u.icon || '\u00B7'}</div>
        <div class="update-info">
          <div class="update-title">${escapeHtml(u.title)}${isNew ? '<span class="update-new-badge">新</span>' : ''}</div>
          <div class="update-date">${formatUpdateDate(u.date, now)}</div>
        </div>
      </li>
    `
  }).join('')
  // 同时更新桌面端和移动端两个卡片
  for (const id of ['sidebar-updates-card', 'mobile-updates-card']) {
    const card = document.getElementById(id)
    if (!card) continue
    const list = card.querySelector('.updates-list')
    if (list) list.innerHTML = html
  }
}

function renderSidebarHistory() {
  if (!state.user) return ''
  const recent = progress.getRecentlyWatched(5)
  if (recent.length === 0) return ''

  return `
    <div class="sidebar-card sidebar-history-card">
      <h3>观看历史</h3>
      <ul class="history-list">
        ${recent.map(p => {
          const ep = episodes.find(e => e.id === p.episodeId)
          if (!ep) return ''
          const percent = p.totalDuration ? Math.min(100, Math.round((p.watchedSeconds / p.totalDuration) * 100)) : 0
          const timeStr = formatWatchTime(p.watchedSeconds)
          const ago = p.lastWatchedAt ? formatTimeAgo(p.lastWatchedAt) : ''
          return `
            <li class="history-item" data-episode-id="${ep.id}">
              <div class="history-thumb">
                <span class="history-ep">${ep.number ? `EP${String(ep.number).padStart(2, '0')}` : ''}</span>
                ${p.completed ? '<span class="history-done-badge">✓</span>' : ''}
              </div>
              <div class="history-info">
                <div class="history-title">${ep.title.length > 20 ? ep.title.substring(0, 20) + '...' : ep.title}</div>
                <div class="history-meta">
                  <span class="history-time">看到 ${timeStr}</span>
                  ${ago ? `<span class="history-ago">${ago}</span>` : ''}
                </div>
                <div class="history-progress-bar">
                  <div class="history-progress-fill ${p.completed ? 'completed' : ''}" style="width:${percent}%"></div>
                </div>
              </div>
              <span class="history-play">▶</span>
            </li>
          `
        }).join('')}
      </ul>
    </div>
  `
}

function formatWatchTime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}

// Category labels matching homepage tabs
const COURSE_CATEGORY_IDS = ['morning', 'indicator', 'pattern', 'strategy', 'advanced']
const CATEGORY_LABELS = { morning: '早盘解读', strategy: '交易策略', indicator: '技术指标', pattern: '形态分析', advanced: '经济指标' }
function getCategoryLabel(cat) { return CATEGORY_LABELS[cat] || cat || '' }

function syncVideoAccessState(items = []) {
  state.paidVideoEpisodes = getVideoEpisodeIds(items)
  state.videoAccessMap = {}
  items.forEach(item => { state.videoAccessMap[item.id] = item.access_level || 'plus_pro' })
}

function hasEpisodeVideo(ep) {
  return Boolean(ep?.hasStreamVideo) || state.paidVideoEpisodes.includes(ep?.id)
}

async function resolveArticleThemeUrl() {
  if (!articleThemeUrlPromise) {
    articleThemeUrlPromise = (async () => {
      for (const href of ARTICLE_THEME_URL_CANDIDATES) {
        try {
          const resp = await fetch(href, { headers: { Accept: 'text/css,*/*;q=0.1' } })
          const contentType = (resp.headers.get('content-type') || '').toLowerCase()
          if (resp.ok && contentType.includes('text/css')) return href
        } catch {}
      }
      return null
    })()
  }
  return articleThemeUrlPromise
}

function updateArticleFrameHeight(frame) {
  const doc = frame?.contentDocument
  if (!doc) return
  const body = doc.body
  const root = doc.documentElement
  const height = Math.max(
    body?.scrollHeight || 0,
    body?.offsetHeight || 0,
    root?.scrollHeight || 0,
    root?.offsetHeight || 0
  )
  frame.style.height = `${Math.max(height + 2, 640)}px`
}

function attachArticleFrameObservers(frame) {
  const doc = frame?.contentDocument
  const win = frame?.contentWindow
  if (!doc || !win) return

  if (frame._wsArticleResizeObserver) {
    frame._wsArticleResizeObserver.disconnect()
    frame._wsArticleResizeObserver = null
  }

  const resize = () => updateArticleFrameHeight(frame)
  resize()
  win.requestAnimationFrame(resize)
  setTimeout(resize, 120)
  setTimeout(resize, 480)

  if (typeof win.ResizeObserver === 'function') {
    const observer = new win.ResizeObserver(resize)
    if (doc.body) observer.observe(doc.body)
    observer.observe(doc.documentElement)
    frame._wsArticleResizeObserver = observer
  }
}

async function syncArticleFrameTheme(frame = document.getElementById('articleFrame')) {
  const doc = frame?.contentDocument
  if (!doc) return

  const href = await resolveArticleThemeUrl()

  let link = doc.getElementById('wsArticleTheme')
  if (href) {
    if (!link) {
      link = doc.createElement('link')
      link.id = 'wsArticleTheme'
      link.rel = 'stylesheet'
      doc.head.appendChild(link)
    }
    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href)
    }
  } else if (link) {
    link.remove()
  }

  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  doc.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  doc.documentElement.style.overflow = 'hidden'
  doc.documentElement.style.overflowX = 'hidden'
  if (doc.body) {
    doc.body.setAttribute('data-theme', dark ? 'dark' : 'light')
    doc.body.style.overflow = 'hidden'
    doc.body.style.overflowX = 'hidden'
    doc.body.style.margin = '0'
    // 避免 body { min-height: 100vh } 与 iframe 自适应高度形成反馈循环
    doc.body.style.minHeight = '0'
  }
  updateArticleFrameHeight(frame)
}

function initArticleFrame(ep) {
  const frame = document.getElementById('articleFrame')
  const container = document.getElementById('articleContainer')
  if (!frame || !container) return

  const markLoaded = async () => {
    if (state.currentView !== 'article' || state.currentEpisode?.id !== ep.id) return
    await syncArticleFrameTheme(frame)
    attachArticleFrameObservers(frame)
    container.classList.add('loaded')
  }

  frame.addEventListener('load', markLoaded, { once: true })
}

function renderEpisodeActions(ep, progressRecord) {
  const hasPaidVideo = ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)
  const manifestReady = courseContent.isManifestReady()
  const courseEntry = getEpisodeContentEntry(ep.id)
  const hasQuiz = Boolean(courseEntry?.quizCount)
  const hasMindmap = Boolean(courseEntry?.mindmapCount)
  const hasKnowledge = Boolean(courseEntry?.knowledgeCount)

  if (!manifestReady) {
    return `
      <div class="video-actions">
        <button class="btn btn-ghost btn-lg" disabled>课程资料加载中...</button>
      </div>
    `
  }

  if (!hasQuiz && !hasMindmap && !hasKnowledge) return ''

  const unlockItems = [hasQuiz ? '答题' : null, hasMindmap ? '思维导图' : null, hasKnowledge ? '知识点' : null].filter(Boolean).join('、')

  return `
    <div class="video-actions">
      ${!isPaid() ? `
        ${hasQuiz ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>🔒 答题（会员专属）</button>' : ''}
        ${hasMindmap ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>🔒 思维导图（会员专属）</button>' : ''}
        ${hasKnowledge ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>🔒 知识点（会员专属）</button>' : ''}
        <p class="paid-hint">升级会员解锁${unlockItems} <a class="paid-hint-link" id="goUpgrade">查看方案 →</a></p>
      ` : `
        ${hasQuiz
          ? ((!hasPaidVideo)
              ? '<button class="btn btn-primary btn-lg" id="startQuiz">开始答题</button>'
              : !progressRecord?.completed
                ? '<button class="btn btn-ghost btn-lg" disabled title="观看60%后解锁">观看60%后可答题</button>'
                : '<button class="btn btn-primary btn-lg" id="startQuiz">开始答题</button>')
          : ''
        }
        ${hasMindmap ? '<button class="btn btn-ghost btn-lg" id="showMindmap">思维导图</button>' : ''}
        ${hasKnowledge ? '<button class="btn btn-ghost btn-lg" id="showKnowledge">知识点</button>' : ''}
      `}
    </div>
  `
}

function formatCourseAttachmentSize(bytes) {
  const value = Math.max(0, Number(bytes || 0))
  if (!value) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function courseAttachmentRegionHtml(ep) {
  const count = Number(ep?.attachmentCount || 0)
  if (!count) return ''
  const hasAccess = canAccessVideo(ep.id)
  return `
    <section class="course-attachment-panel" id="courseAttachmentPanel" aria-labelledby="courseAttachmentsTitle">
      <header class="course-attachment-head">
        <div class="course-attachment-heading">
          <span class="course-attachment-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h5M10 17h5"/></svg>
          </span>
          <div><span>配套课件</span><h2 id="courseAttachmentsTitle">课程附件</h2><p>${hasAccess ? '下载讲义、表格、模板与课程补充资料。' : '附件权限与本课程一致。'}</p></div>
        </div>
        <span class="course-attachment-count">${count} 个文件</span>
      </header>
      ${hasAccess
        ? '<div class="course-attachment-list" id="courseAttachmentList" aria-live="polite"><div class="course-attachment-loading"><span></span><div><strong>正在读取课程附件</strong><small>请稍候…</small></div></div></div>'
        : `<div class="course-attachment-locked"><strong>${!state.user ? '登录后即可下载' : '当前会员等级不可下载'}</strong><p>${!state.user ? '登录后系统会按课程权限开放附件。' : '升级会员后可下载本课程全部配套资料。'}</p><button class="btn btn-outline" id="goUpgradeAttachments" type="button">${!state.user ? '登录' : '查看会员方案'}</button></div>`}
    </section>
  `
}

async function hydrateCourseAttachments(ep) {
  const panel = document.getElementById('courseAttachmentPanel')
  const list = document.getElementById('courseAttachmentList')
  if (!panel || !list || !canAccessVideo(ep.id)) return
  const attachments = await courseContent.loadAttachments(ep.id)
  if (state.currentEpisode?.id !== ep.id || !document.body.contains(panel)) return
  if (!attachments.length) {
    panel.remove()
    return
  }
  const count = panel.querySelector('.course-attachment-count')
  if (count) count.textContent = `${attachments.length} 个文件`
  list.innerHTML = attachments.map(attachment => {
    const extension = String(attachment.extension || '').replace(/^\./, '').toUpperCase() || 'FILE'
    return `<button class="course-attachment-item" type="button" data-course-attachment-download="${escapeHtml(attachment.download_url)}" data-course-attachment-name="${escapeHtml(attachment.file_name || attachment.title || '课程附件')}">
      <span class="course-attachment-type">${escapeHtml(extension.slice(0, 5))}</span>
      <span class="course-attachment-copy"><strong>${escapeHtml(attachment.title || attachment.file_name || '课程附件')}</strong><small>${escapeHtml(extension)} · ${formatCourseAttachmentSize(attachment.file_size)}</small></span>
      <span class="course-attachment-download">下载<span aria-hidden="true">↓</span></span>
    </button>`
  }).join('')
}

async function downloadCourseAttachment(url, fileName, button) {
  if (!url || !button) return
  const originalLabel = button.querySelector('.course-attachment-download')?.innerHTML || '下载'
  button.disabled = true
  const action = button.querySelector('.course-attachment-download')
  if (action) action.textContent = '准备下载…'
  try {
    const objectUrl = await api.fetchBlobUrl(url)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName || '课程附件'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) {
    showToast(error.message || '附件下载失败', 'error')
  } finally {
    button.disabled = false
    if (action) action.innerHTML = originalLabel
  }
}

function renderEpisodeDetailShell({ ep, viewClass, mediaHtml, showProgress, infoBeforeMedia = false }) {
  const progressRecord = state.user ? progress.get(ep.id) : null
  const percent = progressRecord
    ? Math.min(100, Math.round((progressRecord.watchedSeconds / (progressRecord.totalDuration || 1)) * 100))
    : 0
  const infoHtml = `
    <div class="video-info">
      <h1 class="video-title">${escapeHtml(ep.title)}</h1>
      <p class="video-description">${escapeHtml(ep.description)}</p>
      ${renderEpisodeActions(ep, progressRecord)}
    </div>
  `

  mainContent.innerHTML = `
    <div class="${viewClass} fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

      ${infoBeforeMedia ? infoHtml : ''}
      ${mediaHtml}

      ${showProgress ? `
        <div class="watch-progress-bar">
          <div class="watch-progress-fill" id="watchFill" style="width:${percent}%; ${progressRecord?.completed ? 'background:var(--accent-gradient)' : ''}"></div>
        </div>
        <div class="watch-progress-info">
          <span id="watchText">${progressRecord?.completed ? `已观看 ${percent}% · 已完成` : percent > 0 ? `已观看 ${percent}% · 需达到 60%` : '开始观看视频，观看 60% 即可完成课程'}</span>
          <span class="complete-badge" id="completeBadge" style="display:${progressRecord?.completed ? 'inline-flex' : 'none'}">已完成</span>
        </div>
      ` : ''}

      ${infoBeforeMedia ? '' : infoHtml}
      ${courseAttachmentRegionHtml(ep)}
    </div>
  `
  hydrateCourseAttachments(ep).catch(error => console.error('Course attachments render error:', error))
}

function getFilteredEpisodes() {
  return getCoursesForCategory(episodes, state.currentCategory)
}

function renderArticle() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (!isArticleEpisode(ep)) return renderVideo()

  const hasPaidVideo = state.paidVideoEpisodes.includes(ep.id)
  const hasAccess = canAccessVideo(ep.id)
  const articleTarget = classifyArticleUrl(ep.articleUrl, window.location.origin)

  renderEpisodeDetailShell({
    ep,
    viewClass: 'article-view',
    showProgress: state.user && hasPaidVideo && hasAccess,
    infoBeforeMedia: true,
    mediaHtml: `
      ${hasPaidVideo ? `
        <div class="article-video-section">
          <h3 class="article-video-title">📺 视频讲解</h3>
          <div class="video-container" id="videoContainer">
            ${hasAccess
              ? `<div class="video-placeholder" style="background: ${ep.gradient}" id="cfVideoLoading">
                  <span style="color:rgba(255,255,255,0.7);font-size:14px;">正在加载视频...</span>
                </div>`
              : `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                  <div class="video-lock-icon">🔒</div>
                  <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '会员专属视频')}</h3>
                  <p class="video-lock-text">${!state.user ? '请先登录后查看' : '升级会员即可观看'}</p>
                  <button class="btn btn-primary" id="goUpgradeVideo">${!state.user ? '登录' : '升级会员'}</button>
                </div>`
            }
          </div>
        </div>
        <div class="article-study-order">
          <span class="article-study-order-icon">📚</span>
          <span class="article-study-order-text">学习顺序：先看图解的文字知识点，再看视频教学</span>
        </div>
      ` : ''}
      ${articleTarget.mode === 'embedded' ? `
        <div class="article-container" id="articleContainer">
          <div class="article-loading">正在加载文章...</div>
          <iframe
            class="article-frame"
            id="articleFrame"
            title="${escapeHtml(ep.title)}"
            src="${escapeHtml(articleTarget.url)}"
            loading="eager"
            scrolling="no"
          ></iframe>
        </div>
      ` : articleTarget.mode === 'external' ? `
        <div class="article-container loaded">
          <div class="comments-empty">该文章需要在原站打开</div>
          <div style="display:flex;justify-content:center;padding:0 0 32px;">
            <a class="btn btn-primary" href="${escapeHtml(articleTarget.url)}" target="_blank" rel="noopener noreferrer">打开文章</a>
          </div>
        </div>
      ` : `
        <div class="article-container loaded">
          <div class="comments-empty">暂无文章内容</div>
        </div>
      `}
    `,
  })

  if (articleTarget.mode === 'embedded') initArticleFrame(ep)

  // 若当前用户可观看该文章配套视频，则拉取 CF Stream 并嵌入播放
  if (hasPaidVideo && hasAccess) {
    api.get(`/api/video-stream?episode=${ep.id}`).then(r => {
      if (state.currentEpisode?.id !== ep.id) return
      if (!r.ok) throw new Error(r.error || '视频加载失败')

      // Priority: Bilibili > Local > Qiniu
      if (r.bilibiliId) {
        initBiliPlayer(r.bilibiliId)
      } else if (r.localPath) {
        initLocalPlayer(r.localPath)
      } else if (r.qiniuKey) {
        const domain = r.qiniuDomain || ''
        initQiniuPlayer(domain + '/' + r.qiniuKey)
      } else {
        const container = document.getElementById('videoContainer')
        if (container) {
          container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;">暂无视频源</p></div></div>'
        }
      }
    }).catch(err => {
      console.error('Video fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;margin-bottom:12px;">视频加载失败</p><button class="btn btn-primary video-retry-btn">点击重试</button></div></div>'
      }
    }).catch(err => {
      console.error('CF Stream fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = `<div class="video-placeholder" style="background:var(--bg-secondary)">
          <div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <p style="font-size:16px;margin-bottom:12px;">视频加载失败</p>
            <button class="btn btn-primary video-retry-btn">点击重试</button>
          </div>
        </div>`
      }
    })
  }
}

// ===== Video View =====
function renderVideo() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (isArticleEpisode(ep)) return renderArticle()

  // Guard: only skip re-render if the CORRECT player type is already active
  // This prevents async callbacks (profile sync, progress sync) from destroying the player
  const _hasPaid = ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)
  const _hasAcc = canAccessVideo(ep.id)
  if (_hasPaid && _hasAcc && document.getElementById('cfStreamPlayer')) return

  // 每次进入视频页弹出学习提醒（无视频的课程跳过）
  const hasVideo = hasEpisodeVideo(ep)
  if (hasVideo && !state._videoWarningShown) {
    state._videoWarningShown = true
    setTimeout(() => {
      const overlay = document.createElement('div')
      overlay.className = 'warning-overlay active'
      overlay.innerHTML = `
        <div class="warning-modal">
          <div class="warning-icon">⚠️</div>
          <h3 class="warning-title">量见警告</h3>
          <p class="warning-text">请务必耐心、完整、连续地学习，避免跳跃式观看。看似学会实战却依然亏钱，往往说明并没有真正掌握。不要让自己停留在半懂不懂的状态，学得慢并不可耻，真正重要的是学会之后能够熟练运用。</p>
          <button class="btn btn-primary btn-lg warning-confirm" id="warningConfirm">我知道了，认真学习</button>
        </div>
      `
      document.body.appendChild(overlay)
      overlay.querySelector('#warningConfirm').addEventListener('click', () => {
        overlay.classList.remove('active')
        setTimeout(() => overlay.remove(), 300)
      })
    }, 300)
  }

  const hasPaidVideo = ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)
  const hasAccess = canAccessVideo(ep.id)
  renderEpisodeDetailShell({
    ep,
    viewClass: 'video-view',
    showProgress: state.user && (hasPaidVideo && hasAccess),
    mediaHtml: (() => {
      if (!hasPaidVideo) return ''
      return `<div class="video-container" id="videoContainer">
        ${hasPaidVideo && hasAccess
          ? `<div class="video-placeholder" style="background: ${ep.gradient}" id="cfVideoLoading">
              <span style="color:rgba(255,255,255,0.7);font-size:14px;">正在加载视频...</span>
            </div>`
          : hasPaidVideo && !hasAccess
            ? `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                <div class="video-lock-icon">🔒</div>
                <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '会员专属视频')}</h3>
                <p class="video-lock-text">${!state.user ? '请先登录后查看' : '升级会员即可观看'}</p>
                <button class="btn btn-primary" id="goUpgradeVideo">${!state.user ? '登录' : '升级会员'}</button>
              </div>`
            : ''
        }
      </div>`
    })(),
  })

  // Initialize the appropriate video player
  if (hasPaidVideo && canAccessVideo(ep.id)) {
    // Fetch cfStreamId from server (gated API)
    api.get(`/api/video-stream?episode=${ep.id}`).then(r => {
      if (state.currentEpisode?.id !== ep.id) return
      if (!r.ok) throw new Error(r.error || '视频加载失败')

      if (r.bilibiliId) {
        const container = document.getElementById('videoContainer')
        const safeBvid = /^BV[a-zA-Z0-9]+$/.test(r.bilibiliId) ? r.bilibiliId : ''
        if (container && safeBvid) {
          container.innerHTML = '<iframe id="biliPlayer" src="https://player.bilibili.com/player.html?bvid=' + safeBvid + '&high_quality=1&danmaku=0" allowfullscreen allow="autoplay; encrypted-media" style="width:100%;height:100%;border:none;"></iframe>'
          biliPlayer = document.getElementById('biliPlayer')
          if (ep && state.user) {
            const p = progress.get(ep.id)
            accumulatedTime = p.watchedSeconds || 0
            fetchBiliDuration(r.bilibiliId, ep.id)
          }
          startWatchTimer()
        }
      } else if (r.localPath) {
        initLocalPlayer(r.localPath)
      } else if (r.qiniuKey) {
        const domain = r.qiniuDomain || ''
        initQiniuPlayer(domain + '/' + r.qiniuKey)
      }
    }).catch(err => {
      console.error('Video fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;">视频加载失败</p><button class="btn btn-primary" onclick="location.reload()">点击重试</button></div></div>'
      }
    }).catch(err => {
      console.error('CF Stream fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = `<div class="video-placeholder" style="background:var(--bg-secondary)">
          <div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <p style="font-size:16px;margin-bottom:12px;">视频加载失败</p>
            <button class="btn btn-primary video-retry-btn">点击重试</button>
          </div>
        </div>`
      }
    })
  }

}

// ===== Quiz View =====
function hasQuizInsight(q) {
  const explanations = Array.isArray(q?.explanations) ? q.explanations : []
  return Boolean(q?.explanation || q?.hint || explanations.some(Boolean))
}

function renderQuizInsight(q, selectedAnswer, isCorrect) {
  if (!hasQuizInsight(q)) return ''

  const explanations = Array.isArray(q.explanations) ? q.explanations : []
  const selectedExplanation = explanations[selectedAnswer] || ''
  const correctExplanation = explanations[q.answer] || q.explanation || ''
  const primaryExplanation = selectedExplanation || correctExplanation || q.explanation || ''
  const showCorrectExplanation = !isCorrect && correctExplanation && correctExplanation !== selectedExplanation

  return `
    <div class="quiz-insight">
      ${primaryExplanation ? `
        <div class="quiz-explanation">
          <div class="quiz-insight-label">${isCorrect ? '解释' : '你选择的解释'}</div>
          <p>${escapeHtml(primaryExplanation)}</p>
        </div>
      ` : ''}
      ${showCorrectExplanation ? `
        <div class="quiz-explanation">
          <div class="quiz-insight-label">正确思路</div>
          <p>${escapeHtml(correctExplanation)}</p>
        </div>
      ` : ''}
      ${q.hint ? `
        <details class="quiz-hint">
          <summary>查看提示</summary>
          <p>${escapeHtml(q.hint)}</p>
        </details>
      ` : ''}
    </div>
  `
}

async function renderQuiz() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (!isPaid()) return navigateToEpisode(ep)
  if (!progress.get(ep.id)?.completed) return navigateToEpisode(ep)

  const cachedQuestions = courseContent.getCachedQuiz(ep.id)
  if (!cachedQuestions) {
    mainContent.innerHTML = `
      <div class="quiz-section fade-in">
        <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
        <div class="quiz-card">${courseContentLoadingHtml('正在加载课后测试...')}</div>
      </div>
    `
    const questions = await courseContent.loadQuiz(ep.id)
    if (state.currentView !== 'quiz' || state.currentEpisode?.id !== ep.id) return
    if (!questions.length) return navigateToEpisode(ep)
    renderQuizContent(ep, questions)
    return
  }

  if (!cachedQuestions.length) return navigateToEpisode(ep)
  renderQuizContent(ep, cachedQuestions)
}

function renderQuizContent(ep, questions) {
  const { currentQuestion, answered, wrongCount } = state.quizState
  const total = questions.length

  // 全部答完 → 结果页
  if (currentQuestion >= total) {
    const passed = wrongCount === 0
    if (passed) progress.setQuizPassed(ep.id)
    const nextEp = episodes.find(e => e.id === ep.id + 1)

    mainContent.innerHTML = `
      <div class="quiz-section fade-in">
        <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
        <div class="quiz-card">
          <div class="quiz-result">
            <div class="score" style="${passed ? '' : 'background: linear-gradient(135deg, #ef4444, #f97316); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;'}">${total - wrongCount}/${total}</div>
            <p class="score-label">${passed
              ? '🎉 全部答对，已解锁下一期课程！'
              : `答错了 ${wrongCount} 题，需要全部答对才能解锁下一期`
            }</p>
            <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
              ${passed && nextEp
                  ? `<button class="btn btn-primary btn-lg" id="goNextEp" data-next-id="${nextEp.id}">${getNextEpisodeLabel(nextEp)}</button>`
                : ''
              }
              ${!passed
                ? '<button class="btn btn-primary btn-lg" id="retryQuiz">重新答题</button>'
                : ''
              }
              <button class="btn btn-ghost btn-lg" id="backVideo2">${getEpisodeBackLabel(ep).replace('← ', '')}</button>
            </div>
          </div>
        </div>
      </div>
    `
    return
  }

  const q = questions[currentQuestion]
  const quizPercent = (currentQuestion / total) * 100
  const selectedAnswer = state.quizState.answers[currentQuestion]
  const isCorrect = selectedAnswer === q.answer
  const hasAnswered = answered

  mainContent.innerHTML = `
    <div class="quiz-section fade-in">
      <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
      <div class="quiz-card">
        <div class="quiz-header">
          <h2>课后测试</h2>
          <span class="quiz-progress-text">${currentQuestion + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width: ${quizPercent}%"></div>
        </div>
        <div class="quiz-question">${escapeHtml(q.question)}</div>
        <div class="quiz-options">
          ${q.options.map((opt, i) => {
            let cls = ''
            if (hasAnswered) {
              if (isCorrect && i === q.answer) cls = 'correct'
              else if (i === selectedAnswer && !isCorrect) cls = 'wrong'
              else cls = 'dimmed'
            }
            return `
            <div class="quiz-option ${cls}" data-option="${i}" ${hasAnswered ? 'style="pointer-events:none"' : ''}>
              <span class="option-letter">${['A', 'B', 'C', 'D'][i]}</span>
              <span>${escapeHtml(opt)}</span>
              ${hasAnswered && isCorrect && i === q.answer ? '<span class="option-check">✓</span>' : ''}
              ${hasAnswered && i === selectedAnswer && !isCorrect ? '<span class="option-cross">✗</span>' : ''}
            </div>`
          }).join('')}
        </div>
        ${hasAnswered ? `
          <div class="quiz-feedback ${isCorrect ? 'feedback-correct' : 'feedback-wrong'}">
            ${isCorrect
              ? '✅ 回答正确！'
              : state.quizState.attempt === 1
                ? '❌ 答错了，再给你一次机会'
                : '❌ 两次都答错了，需要从头答题'
            }
          </div>
          ${renderQuizInsight(q, selectedAnswer, isCorrect)}
          <div class="quiz-actions">
            ${isCorrect
              ? (currentQuestion < total - 1
                  ? '<button class="btn btn-primary" id="nextQ">下一题 →</button>'
                  : '<button class="btn btn-primary" id="finishQuiz">查看结果</button>')
              : state.quizState.attempt === 1
                ? '<button class="btn btn-primary" id="retryThis">再试一次</button>'
                : '<button class="btn btn-primary" id="retryQuiz">从头答题</button>'
            }
          </div>
        ` : ''}
      </div>
    </div>
  `
}

// ===== Knowledge View =====
// ===== Quotes Page =====
function renderQuotes() {
  mainContent.innerHTML = `
    <div class="quotes-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>
      <div class="quotes-header">
        <h1 class="quotes-title">量见语录</h1>
        <p class="quotes-subtitle">共 ${allQuotes.length} 条交易智慧</p>
      </div>
      <div class="quotes-list">
        ${allQuotes.map((q, i) => `
          <div class="quote-card-item">
            <span class="quote-card-num">${String(i + 1).padStart(2, '0')}</span>
            <p class="quote-card-text">${q}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

async function renderKnowledge() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (!isPaid()) return navigateToEpisode(ep)

  const cachedPoints = courseContent.getCachedKnowledge(ep.id)
  if (!cachedPoints) {
    mainContent.innerHTML = `
      <div class="knowledge-section fade-in">
        <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
        <h2>知识点</h2>
        ${courseContentLoadingHtml('正在加载知识点...')}
      </div>
    `
    const points = await courseContent.loadKnowledge(ep.id)
    if (state.currentView !== 'knowledge' || state.currentEpisode?.id !== ep.id) return
    renderKnowledgeContent(ep, points)
    return
  }

  renderKnowledgeContent(ep, cachedPoints)
}

function renderKnowledgeContent(ep, knowledgePoints) {
  mainContent.innerHTML = `
    <div class="knowledge-section fade-in">
      <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
      <h2>知识点</h2>
      <div class="knowledge-grid">
        ${knowledgePoints.length > 0
          ? knowledgePoints.map(kp => {
              const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(kp.url || '')
              return isImage
                ? `<div class="knowledge-card knowledge-card-image">
                    <h3>${escapeHtml(kp.title)}</h3>
                    <img src="${escapeHtml(kp.url)}" alt="${escapeHtml(kp.title)}" loading="lazy" style="max-width:100%;border-radius:12px;">
                  </div>`
                : `<div class="knowledge-card">
                    <h3>${escapeHtml(kp.title)}</h3>
                    <p>${escapeHtml(kp.content || '')}</p>
                  </div>`
            }).join('')
          : '<p style="color: var(--text-3); padding: 24px 0;">本期暂无知识点</p>'
        }
      </div>
    </div>
  `
}

// ===== Mindmap View =====
async function renderMindmap() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (!isPaid()) return navigateToEpisode(ep)

  const cachedItems = courseContent.getCachedMindmaps(ep.id)
  if (!cachedItems) {
    mainContent.innerHTML = `
      <div class="mindmap-section fade-in">
        <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
        <h2>思维导图与知识点</h2>
        ${courseContentLoadingHtml('正在加载思维导图...')}
      </div>
    `
    const items = await courseContent.loadMindmaps(ep.id)
    if (state.currentView !== 'mindmap' || state.currentEpisode?.id !== ep.id) return
    renderMindmapContent(ep, items)
    return
  }

  renderMindmapContent(ep, cachedItems)
}

function renderMindmapContent(ep, mindmapItems) {
  mainContent.innerHTML = `
    <div class="mindmap-section fade-in">
      <button class="back-btn" id="backVideo">${getEpisodeBackLabel(ep)}</button>
      <h2>思维导图与知识点</h2>
      <div class="mindmap-list">
        ${mindmapItems.length > 0
          ? mindmapItems.map(renderMindmapItemHtml).join('')
          : '<p style="color: var(--text-3); padding: 24px 0;">本期暂无思维导图</p>'
        }
      </div>
    </div>
  `
  hydrateMindmapStructures()
}

function renderMindmapItemHtml(item, index) {
  const title = item.title || `思维导图 ${index + 1}`
  if (item.structure) {
    const structureJson = typeof item.structure === 'string' ? item.structure : JSON.stringify(item.structure)
    return `
      <div class="mindmap-item">
        <h3>${escapeHtml(title)}</h3>
        <div class="mindmap-structure-wrapper"
          data-mindmap-structure='${escapeHtml(structureJson)}'
          data-fallback-image="${escapeHtml(item.image || '')}"
          data-title="${escapeHtml(title)}">
          ${courseContentLoadingHtml('正在绘制结构化思维导图...')}
        </div>
      </div>
    `
  }

  return `
    <div class="mindmap-item">
      <h3>${escapeHtml(title)}</h3>
      ${item.pdf
        ? `<div class="mindmap-pdf-wrapper">
            <iframe src="${escapeHtml(item.pdf)}" class="mindmap-pdf"></iframe>
            <a href="${escapeHtml(item.pdf)}" target="_blank" class="btn btn-ghost btn-sm pdf-download">在新窗口打开 PDF</a>
          </div>`
        : `<div class="mindmap-image-wrapper">
            <img src="${escapeHtml(item.image || '')}" alt="${escapeHtml(title)}" class="mindmap-image" loading="lazy">
          </div>`
      }
    </div>
  `
}

function createSvgElement(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name)
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value))
  return el
}

function flattenMindmapNode(root, parent = null, nodes = [], links = []) {
  const geometry = root.geometry || {}
  const width = Math.max(geometry.bboxWidth || 180, 120)
  const height = Math.max(geometry.bboxHeight || 55, 48)
  const node = {
    title: root.title || '',
    level: root.level || 1,
    x: geometry.transformX || 0,
    y: geometry.transformY || 0,
    width,
    height,
    parentAnchorX: geometry.parentAnchorX ?? ((geometry.transformX || 0) + width),
    childAnchorX: geometry.childAnchorX ?? ((geometry.transformX || 0) - 18),
  }
  nodes.push(node)
  if (parent) links.push({ parent, child: node })
  ;(root.children || []).forEach(child => flattenMindmapNode(child, node, nodes, links))
  return { nodes, links }
}

function getMindmapBounds(nodes, links) {
  const margin = 180
  const linkX = links.flatMap(edge => [edge.parent.parentAnchorX, edge.child.childAnchorX])
  const left = Math.min(...nodes.map(node => node.x), ...linkX) - margin
  const right = Math.max(...nodes.map(node => node.x + node.width), ...linkX) + margin
  const top = Math.min(...nodes.map(node => node.y - node.height / 2)) - margin
  const bottom = Math.max(...nodes.map(node => node.y + node.height / 2)) + margin
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function renderStructuredMindmap(container, data) {
  const root = data?.roots?.[0]
  if (!root) throw new Error('Mindmap root missing')
  const { nodes, links } = flattenMindmapNode(root)
  const natural = getMindmapBounds(nodes, links)

  container.innerHTML = `
    <div class="mindmap-structure-toolbar">
      <span>${escapeHtml(data.mindmapTitle || data.notebookTitle || '结构化思维导图')}</span>
      <div>
        <button type="button" class="mindmap-tool" data-zoom="out" aria-label="缩小">-</button>
        <button type="button" class="mindmap-tool" data-zoom="in" aria-label="放大">+</button>
        <button type="button" class="mindmap-tool" data-zoom="fit" aria-label="适应">⤢</button>
      </div>
    </div>
    <div class="mindmap-structure-canvas"></div>
  `

  const canvas = container.querySelector('.mindmap-structure-canvas')
  const svg = createSvgElement('svg', { class: 'structured-mindmap-svg', role: 'img' })
  const scene = createSvgElement('g')
  svg.appendChild(scene)

  const linkLayer = createSvgElement('g', { class: 'structured-mindmap-links' })
  links.forEach(edge => {
    const startX = edge.parent.parentAnchorX
    const startY = edge.parent.y
    const endX = edge.child.childAnchorX
    const endY = edge.child.y
    const delta = Math.max(80, Math.abs(endX - startX) * 0.46)
    linkLayer.appendChild(createSvgElement('path', {
      class: 'structured-mindmap-link',
      d: `M ${startX} ${startY} C ${startX + delta} ${startY}, ${endX - delta} ${endY}, ${endX} ${endY}`,
    }))
  })
  scene.appendChild(linkLayer)

  const nodeLayer = createSvgElement('g', { class: 'structured-mindmap-nodes' })
  nodes.forEach(node => {
    const group = createSvgElement('g', {
      class: `structured-mindmap-node level-${node.level}`,
      transform: `translate(${node.x} ${node.y - node.height / 2})`,
    })
    group.appendChild(createSvgElement('rect', {
      x: 0,
      y: 0,
      width: node.width,
      height: node.height,
      rx: node.level === 1 ? 11 : 8,
      ry: node.level === 1 ? 11 : 8,
    }))
    if (node.level > 1) {
      group.appendChild(createSvgElement('circle', {
        class: 'structured-mindmap-marker',
        cx: 19,
        cy: node.height / 2,
        r: 5,
      }))
    }
    const text = createSvgElement('text', {
      x: node.level > 1 ? 34 : 20,
      y: node.height / 2 + 1,
    })
    text.textContent = node.title
    group.appendChild(text)
    nodeLayer.appendChild(group)
  })
  scene.appendChild(nodeLayer)
  canvas.appendChild(svg)

  let currentBox = null
  const setViewBox = box => {
    currentBox = { ...box }
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`)
  }
  const fitWidth = () => {
    const ratio = svg.clientWidth && svg.clientHeight ? svg.clientWidth / svg.clientHeight : 16 / 9
    const height = Math.min(natural.height, natural.width / ratio)
    const first = nodes[0]
    const y = Math.max(natural.y, Math.min(natural.y + natural.height - height, first.y - height / 2))
    setViewBox({ x: natural.x, y, width: natural.width, height })
  }
  const zoomAt = (factor, clientX = svg.clientWidth / 2, clientY = svg.clientHeight / 2) => {
    if (!currentBox) return
    const rect = svg.getBoundingClientRect()
    const px = (clientX - rect.left) / rect.width
    const py = (clientY - rect.top) / rect.height
    const width = Math.max(natural.width * 0.18, Math.min(natural.width * 2.4, currentBox.width * factor))
    const height = Math.max(natural.height * 0.18, Math.min(natural.height * 2.4, currentBox.height * factor))
    const anchorX = currentBox.x + currentBox.width * px
    const anchorY = currentBox.y + currentBox.height * py
    setViewBox({ x: anchorX - width * px, y: anchorY - height * py, width, height })
  }

  let dragStart = null
  svg.addEventListener('wheel', event => {
    event.preventDefault()
    zoomAt(event.deltaY > 0 ? 1.12 : 0.88, event.clientX, event.clientY)
  }, { passive: false })
  svg.addEventListener('pointerdown', event => {
    dragStart = { x: event.clientX, y: event.clientY, box: { ...currentBox } }
    svg.classList.add('dragging')
    svg.setPointerCapture(event.pointerId)
  })
  svg.addEventListener('pointermove', event => {
    if (!dragStart) return
    const rect = svg.getBoundingClientRect()
    const dx = ((event.clientX - dragStart.x) / rect.width) * dragStart.box.width
    const dy = ((event.clientY - dragStart.y) / rect.height) * dragStart.box.height
    setViewBox({ ...dragStart.box, x: dragStart.box.x - dx, y: dragStart.box.y - dy })
  })
  const stopDrag = event => {
    dragStart = null
    svg.classList.remove('dragging')
    try { svg.releasePointerCapture(event.pointerId) } catch {}
  }
  svg.addEventListener('pointerup', stopDrag)
  svg.addEventListener('pointerleave', stopDrag)
  container.querySelector('[data-zoom="in"]')?.addEventListener('click', () => zoomAt(0.82))
  container.querySelector('[data-zoom="out"]')?.addEventListener('click', () => zoomAt(1.18))
  container.querySelector('[data-zoom="fit"]')?.addEventListener('click', fitWidth)
  fitWidth()
}

function renderMindmapFallback(container) {
  const image = container.dataset.fallbackImage
  const title = container.dataset.title || '思维导图'
  if (image) {
    container.innerHTML = `
      <div class="mindmap-image-wrapper">
        <img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" class="mindmap-image" loading="lazy">
      </div>
    `
  } else {
    container.innerHTML = '<p class="course-content-loading">结构化思维导图加载失败</p>'
  }
}

function hydrateMindmapStructures() {
  mainContent.querySelectorAll('[data-mindmap-structure]').forEach(async container => {
    const raw = container.dataset.mindmapStructure
    try {
      // If it looks like JSON (starts with { or [), parse directly; otherwise fetch as URL
      const data = (raw.startsWith('{') || raw.startsWith('[')) ? JSON.parse(raw) : await courseContent.loadStructure(raw)
      if (!container.isConnected) return
      renderStructuredMindmap(container, data)
    } catch (err) {
      console.error('Mindmap structure load error:', err)
      renderMindmapFallback(container)
    }
  })
}

// ===== Admin Dashboard =====
let _planPricesCache = null
async function getPlanPrices() {
  if (_planPricesCache) return _planPricesCache
  try {
    const res = await api.get('/api/plans')
    if (res.ok && res.plans) { _planPricesCache = res.plans; return res.plans }
  } catch {}
  return { plus: { month: { current: 50, original: 100 }, year: { current: 500, original: 1000 } }, pro: { month: { current: 100, original: 200 }, year: { current: 1000, original: 2000 } } }
}

// ===== Auth =====
function updateAuthUI() {
  const authButtons = $('#authButtons')
  const userInfo = $('#userInfo')
  const userName = $('#userName')
  const userAvatar = $('#userAvatar')
  const dropdownAdmin = $('#dropdownAdmin')
  const notifBadge = $('#dropdownNotifBadge')

  if (state.user) {
    if (authButtons) authButtons.style.display = 'none'
    if (userInfo) userInfo.style.display = 'flex'
    if (userName) userName.textContent = state.user.name
    if (userAvatar) {
      if (state.user.avatar) {
        userAvatar.innerHTML = `<img src="${escapeHtml(state.user.avatar)}" class="user-avatar-img">`
        userAvatar.style.background = 'none'
      } else {
        userAvatar.textContent = (state.user.name || 'U')[0].toUpperCase()
        userAvatar.style.background = ''
      }
    }
    if (dropdownAdmin) dropdownAdmin.style.display = isAdmin() ? 'block' : 'none'
    if (notifBadge) {
      notifBadge.textContent = state.notificationUnread > 99 ? '99+' : String(state.notificationUnread || '')
      notifBadge.style.display = state.notificationUnread ? 'inline-flex' : 'none'
    }
  } else {
    if (authButtons) authButtons.style.display = 'flex'
    if (userInfo) userInfo.style.display = 'none'
    if (notifBadge) notifBadge.style.display = 'none'
  }
}

async function refreshNotificationUnread() {
  if (!state.user || !api._token()) {
    state.notificationUnread = 0
    updateAuthUI()
    return
  }
  try {
    const res = await api.get('/api/notifications?limit=1')
    if (res.ok) {
      state.notificationUnread = res.unreadCount || 0
      updateAuthUI()
    }
  } catch {
    // noop
  }
}

// ===== Profile Page =====
// ===== Membership Page =====
async function renderMembership() {
  const currentPlan = getEffectivePlan()
  const membershipExpired = isMembershipExpiredClient()
  const expiredPlanName = state.user?.plan === 'pro' ? 'Pro' : 'Plus'
  const currentPeriod = currentPlan === 'free' ? null : state.user?.planPeriod || null

  let planPrices = { plus: { month: { current: 50, original: 100 }, year: { current: 500, original: 1000 } }, pro: { month: { current: 100, original: 200 }, year: { current: 1000, original: 2000 } } }
  try {
    const res = await api.get('/api/plans')
    if (res.ok && res.plans) planPrices = res.plans
  } catch {}

  const fmt = (dollars) => '$' + Math.round(dollars)
  const discountLabel = (orig, cur) => {
    if (orig <= 0 || cur <= 0 || cur >= orig) return ''
    const zhe = cur / orig * 10
    const zheStr = zhe % 1 === 0 ? zhe.toFixed(0) : zhe.toFixed(1)
    return zhe === 10 ? '' : `${zheStr}折`
  }

  const plusM = planPrices.plus?.month || { current: 50, original: 100 }
  const plusY = planPrices.plus?.year || { current: 500, original: 1000 }
  const proM = planPrices.pro?.month || { current: 100, original: 200 }
  const proY = planPrices.pro?.year || { current: 1000, original: 2000 }

  mainContent.innerHTML = `
    <div class="membership-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

      <div class="membership-header">
        <h1 class="membership-title">选择你的会员计划</h1>
        <p class="membership-subtitle">解锁量见全部技术分析课程，系统掌握交易技术</p>
        ${membershipExpired ? `<div class="membership-expired-notice">当前 ${expiredPlanName} 会员已过期，您可以重新购买 Plus 或 Pro，付款后立即恢复对应权益。</div>` : ''}
      </div>

      <div id="membershipCreditSummary" class="membership-credit-summary">
        ${state.user ? '<div class="billing-loading">正在读取返佣邀请信息...</div>' : '<span>登录后可查看返佣邀请信息</span>'}
      </div>

      <div class="membership-cards">
        <!-- 体验版 -->
        <div class="mem-card ${currentPlan === 'free' && !membershipExpired ? 'mem-current' : ''}">
          <div class="mem-card-header mem-free">
            <span class="mem-icon">🆓</span>
            <h3 class="mem-plan-name">体验版</h3>
            <p class="mem-plan-desc">初步感受课程质量</p>
          </div>
          <div class="mem-price-section">
            <span class="mem-price">免费</span>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">✓</span>已公开的59期课程视频（陆续上传）</li>
            <li class="mem-feat"><span class="mem-check">✓</span>量见金融 / 生活感悟语录（陆续更新）</li>
            <li class="mem-feat"><span class="mem-check">✓</span>观看历史记录</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>新视频即时解锁</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>知识图解 & 框架</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>课后测验 + 解析</li>

          </ul>
          <div class="mem-action">
            ${currentPlan === 'free'
              ? `<button class="btn mem-btn mem-btn-current" disabled>${membershipExpired ? '会员已过期' : '当前方案'}</button>`
              : '<button class="btn mem-btn mem-btn-free">当前已是更高方案</button>'}
          </div>
        </div>

        <!-- Plus -->
        <div class="mem-card ${currentPlan === 'plus' ? 'mem-current' : ''}">
          <div class="mem-card-header mem-plus">
            <span class="mem-icon">⭐</span>
            <h3 class="mem-plan-name">Plus</h3>
            <p class="mem-plan-desc">系统学习技术分析</p>
          </div>
          <div class="mem-price-section">
            <div class="mem-price-toggle">
              <button class="price-tab active" data-period="monthly">月付</button>
              <button class="price-tab" data-period="yearly">年付</button>
            </div>
            <div class="mem-price-display">
              <span class="mem-price-original" data-monthly="${plusM.original}" data-yearly="${plusY.original}">${fmt(plusM.original)}</span>
              <span class="mem-price" data-monthly="${plusM.current}" data-yearly="${plusY.current}">${fmt(plusM.current)}</span>
              <span class="mem-price-unit" data-monthly="/月" data-yearly="/年">/ 月</span>
            </div>
            ${discountLabel(plusM.original, plusM.current) ? `<div class="mem-price-discount">限时 ${discountLabel(plusM.original, plusM.current)}</div>` : ''}
            <div class="mem-price-save" style="display:none">年付立省 ${fmt(plusY.original - plusY.current)}，低至 ${fmt(plusY.current / 12)}/月</div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">✓</span>新视频上线即时解锁</li>
            <li class="mem-feat"><span class="mem-check">✓</span>高清知识图解 & 框架</li>
            <li class="mem-feat"><span class="mem-check">✓</span>全部课后测验 + 解析</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>AI全自动交易</li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? '<button class="btn mem-btn mem-btn-free" disabled>当前已是更高方案</button>'
              : currentPlan === 'plus'
                ? (currentPeriod === 'yearly'
                  ? '<button class="btn mem-btn mem-btn-current" disabled>当前方案</button>'
                   : `<button class="btn mem-btn mem-btn-plus" data-plan="plus">续费</button>`)
                : `<button class="btn mem-btn mem-btn-plus" data-plan="plus">USDT 支付</button>`}
          </div>
        </div>

        <!-- Pro -->
        <div class="mem-card ${currentPlan === 'pro' ? 'mem-current' : ''}">
          <div class="mem-card-header mem-pro">
            <span class="mem-icon">💎</span>
            <h3 class="mem-plan-name">Pro</h3>
            <p class="mem-plan-desc">深度学习 · 交易进阶</p>
          </div>
          <div class="mem-price-section">
            <div class="mem-price-toggle">
              <button class="price-tab active" data-period="monthly">月付</button>
              <button class="price-tab" data-period="yearly">年付</button>
            </div>
            <div class="mem-price-display">
              <span class="mem-price-original" data-monthly="${proM.original}" data-yearly="${proY.original}">${fmt(proM.original)}</span>
              <span class="mem-price" data-monthly="${proM.current}" data-yearly="${proY.current}">${fmt(proM.current)}</span>
              <span class="mem-price-unit" data-monthly="/月" data-yearly="/年">/ 月</span>
            </div>
            ${discountLabel(proM.original, proM.current) ? `<div class="mem-price-discount">限时 ${discountLabel(proM.original, proM.current)}</div>` : ''}
            <div class="mem-price-save" style="display:none">年付立省 ${fmt(proY.original - proY.current)}，低至 ${fmt(proY.current / 12)}/月</div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">✓</span>包含 Plus 全部权限</li>
            <li class="mem-feat"><span class="mem-check pro">✓</span>AI全自动交易</li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? (currentPeriod === 'yearly'
                ? '<button class="btn mem-btn mem-btn-current" disabled>当前方案</button>'
                : `<button class="btn mem-btn mem-btn-pro" data-plan="pro">续费</button>`)
                : `<button class="btn mem-btn mem-btn-pro" data-plan="pro">USDT 支付</button>`}
          </div>
        </div>
      </div>

      <div class="membership-comparison">
        <h3 class="faq-title">权益对比</h3>
        <table class="comparison-table">
          <thead>
            <tr>
              <th>功能</th>
              <th>体验版</th>
              <th>Plus</th>
              <th>Pro</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>公开课程视频</td><td>✓</td><td>✓</td><td>✓</td></tr>
            <tr><td>量见语录</td><td>✓</td><td>✓</td><td>✓</td></tr>
            <tr><td>观看历史</td><td>✓</td><td>✓</td><td>✓</td></tr>
            <tr><td>新视频即时解锁</td><td>✗</td><td>✓</td><td>✓</td></tr>
            <tr><td>知识图解 & 框架</td><td>✗</td><td>✓</td><td>✓</td></tr>
            <tr><td>课后测验 + 解析</td><td>✗</td><td>✓</td><td>✓</td></tr>
            <tr><td>AI全自动交易</td><td>✗</td><td>✗</td><td>✓</td></tr>
            <tr><td>月付价格</td><td>免费</td><td>${fmt(plusM.current)}/月</td><td>${fmt(proM.current)}/月</td></tr>
          </tbody>
        </table>
      </div>

      <div class="membership-faq">
        <h3 class="faq-title">常见问题</h3>
        <div class="faq-list">
          <div class="faq-item">
            <div class="faq-q">可以随时更换方案吗？</div>
            <div class="faq-a">可以。升级立即生效，差价自动补齐。</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">支持哪些支付方式？</div>
            <div class="faq-a">支持 USDT / USDC 加密货币支付，覆盖 Ethereum、Tron、Solana、BSC 等主流链。</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">课程内容会持续更新吗？</div>
            <div class="faq-a">是的。量见每周会更新他对当下行情思路的视频。</div>
          </div>
        </div>
      </div>
    </div>
  `

  if (state.user) loadMembershipCreditSummary()
}

async function loadMembershipCreditSummary() {
  const el = document.getElementById('membershipCreditSummary')
  if (!el) return
  try {
    const res = await api.get('/api/referrals/me')
    if (!res.ok || !res.stats) {
      el.innerHTML = `<span>${escapeHtml(res.error || '返佣邀请信息暂时无法读取')}</span>`
      return
    }
    if (false && res.disabled) {
      if (res.mode === 'disabled') {
        el.style.display = 'none'
        return
      }
      el.classList.add('membership-credit-summary-preview')
      el.innerHTML = `
        <div class="membership-credit-preview-text">
          <strong>邀请返佣功能即将开放</strong>
          <span>当前仅展示功能说明，返佣邀请暂未启用。</span>
        </div>
        <div class="membership-credit-item"><span>待确认返佣</span><strong>$0.00</strong></div>
        <div class="membership-credit-item"><span>可用返佣</span><strong>$0.00</strong></div>
        <div class="membership-credit-item"><span>已使用返佣</span><strong>$0.00</strong></div>`
      return
    }
    const stats = res.stats
    el.innerHTML = `
      <div class="membership-credit-item"><span>待确认返佣</span><strong>${formatUsdAmount(stats.pending_credit_amount)}</strong></div>
      <div class="membership-credit-item"><span>可用返佣</span><strong>${formatUsdAmount(stats.available_credit_amount)}</strong></div>
      <div class="membership-credit-item"><span>已使用返佣</span><strong>${formatUsdAmount(stats.used_credit_amount)}</strong></div>
      <div class="membership-credit-link">开放后下单时自动计算可用返佣</div>`
  } catch {
    el.innerHTML = '<span>返佣邀请信息暂时无法读取</span>'
  }
}

// ===== TOS Page =====
function renderTos() {
  mainContent.innerHTML = `
    <div class="tos-page fade-in">
      <button class="back-btn" id="backHome">← 返回</button>
      <div class="tos-card">
        <h1 class="tos-title">用户服务协议</h1>
        <p class="tos-update">最后更新日期：2026年4月12日</p>

        <div class="tos-content">
          <p>欢迎使用 cnfxtrade.com（以下简称"本网站"）。本网站由道诚科技（以下简称"量见"）运营。在注册、访问或使用本网站之前，请仔细阅读以下条款。注册即表示您已阅读、理解并同意受本协议约束。</p>

          <h2>一、服务内容</h2>
          <ol>
            <li>本网站提供技术分析教学视频、行情思路分享、知识图解、课后测验等<strong>教育类内容</strong>。</li>
            <li>所有内容均为量见个人对市场行情的思考和技术教学演示，<strong>不构成任何形式的投资建议、交易指导或资产配置方案</strong>。</li>
            <li>本网站<strong>不提供带单服务、跟单信号、代客理财或任何形式的投资顾问服务</strong>。</li>
          </ol>

          <h2>二、免责声明</h2>
          <ol>
            <li><strong>非投资建议</strong>：本网站发布的所有视频、文字、图表、分析及任何形式的内容，均为量见个人对行情的思考和教学演示，仅供学习参考，<strong>不构成对任何金融产品的买卖建议</strong>。</li>
            <li><strong>投资风险自担</strong>：加密货币、贵金属及其他金融市场交易具有高度风险，可能导致全部本金损失。用户因参考本网站内容而做出的任何投资决策，<strong>风险和后果由用户自行承担</strong>，与本网站及量见无关。</li>
            <li><strong>信息准确性</strong>：我们尽力确保内容的准确性和时效性，但不对内容的完整性、准确性、可靠性或适用性作任何明示或暗示的保证。市场瞬息万变，过往分析不代表未来表现。</li>
            <li><strong>第三方工具</strong>：本网站可能包含指向第三方网站或平台的链接（如 TradingView、交易所等），这些链接仅为便利用户而提供。我们不对第三方网站的内容、安全性或服务质量承担任何责任。</li>
          </ol>

          <h2>三、付费服务与退款政策</h2>
          <ol>
            <li>本网站提供免费体验版及付费会员服务（Plus、Pro）。</li>
            <li><strong>付费会员一经购买，即时生效，不支持退款。</strong>请在购买前充分了解各方案内容。</li>
            <li>我们保留随时调整会员价格和权益内容的权利，已购买的会员在有效期内不受价格调整影响。</li>
            <li>若因技术原因导致服务中断，我们将在合理时间内恢复服务，但不承担因此产生的任何损失。</li>
          </ol>

          <h2>四、用户行为规范</h2>
          <ol>
            <li>用户应提供真实、准确的注册信息，并妥善保管账号和密码。</li>
            <li>用户不得将本网站的付费内容进行录制、截屏、下载、传播、转售或以任何方式分享给未授权的第三方。</li>
            <li>用户不得利用本网站发布违法、侮辱性、骚扰性或侵权内容。</li>
            <li>违反上述规定的用户，我们有权立即终止其账号并不予退款。</li>
          </ol>

          <h2>五、知识产权</h2>
          <ol>
            <li>本网站的所有内容，包括但不限于视频、文字、图表、图片、界面设计、商标及标识，均受知识产权法律保护。</li>
            <li>未经书面许可，任何个人或组织不得复制、修改、分发、展示或以任何方式使用本网站的内容。</li>
          </ol>

          <h2>六、隐私保护</h2>
          <ol>
            <li>我们重视用户隐私，收集的信息（邮箱、昵称、学习进度等）仅用于提供和改善服务。</li>
            <li>我们不会将用户个人信息出售或提供给第三方，法律要求除外。</li>
            <li>用户的密码经加密存储，我们无法也不会查看用户的原始密码。</li>
          </ol>

          <h2>七、责任限制</h2>
          <ol>
            <li><strong>在法律允许的最大范围内，本网站及量见不对用户因使用或无法使用本网站而产生的任何直接、间接、附带、特殊或惩罚性损害承担责任</strong>，包括但不限于投资损失、数据丢失或业务中断。</li>
            <li>本网站提供的服务按"现状"和"可用性"提供，不附带任何形式的明示或暗示保证。</li>
          </ol>

          <h2>八、协议变更</h2>
          <ol>
            <li>我们保留随时修改本协议的权利。修改后的协议将在网站上公布，继续使用本网站即视为接受修改后的条款。</li>
            <li>重大变更将通过网站通知方式告知用户。</li>
          </ol>

          <h2>九、争议解决</h2>
          <ol>
            <li>本协议的解释和执行适用相关法律法规。</li>
            <li>因本协议引起的任何争议，双方应首先友好协商解决。协商不成的，任何一方均有权向有管辖权的法院提起诉讼。</li>
          </ol>

          <h2>十、联系方式</h2>
          <p>如对本协议有任何疑问，请通过以下方式联系我们：</p>
          <p>微信：Jin-DaoCheng</p>
        </div>
      </div>
    </div>
  `
}

// ===== USDT Crypto Payment =====
let _selectedCryptoChain = 'TRON'
let _paymentPollingTimer = null
let _paymentCountdownTimer = null

const CRYPTO_CHAINS = [
  { id: 'TRON', name: 'TRC-20', full: 'Tron', icon: 'T', fee: '~1 USDT', color: '#ff0013', recommended: true, desc: '最常用，费用低' },
  { id: 'ETH', name: 'ERC-20', full: 'Ethereum', icon: 'Ξ', fee: '5-50 USDT', color: '#627eea', desc: '安全性最高，Gas 费较高' },
  { id: 'BSC', name: 'BEP-20', full: 'BNB Chain', icon: 'B', fee: '~0.3 USDT', color: '#f0b90b', desc: '费用低，速度快' },
  { id: 'SOL', name: 'SPL', full: 'Solana', icon: '◎', fee: '~0.001 USDT', color: '#9945ff', desc: '费用极低，速度极快' },
]

function initiateCryptoPayment(plan, period) {
  if (document.getElementById('cryptoChainModal')) return

  _doInitiateCryptoPayment(plan, period)
}

async function _doInitiateCryptoPayment(plan, period) {
  let availableChains = [...CRYPTO_CHAINS]

  try {
    const res = await api.get('/api/payment/mode')
    if (res.ok && res.mode === 'fixed' && res.fixedAddresses) {
      const addrMap = { TRON: res.fixedAddresses.fixed_tron_address, ETH: res.fixedAddresses.fixed_erc20_address, BSC: res.fixedAddresses.fixed_bep20_address, SOL: res.fixedAddresses.fixed_sol_address }
      availableChains = availableChains.filter(c => addrMap[c.id])
    }
  } catch {}

  if (availableChains.length === 0) {
    showToast('支付链未配置，请联系管理员', 'error')
    return
  }

  if (availableChains.length === 1) {
    _selectedCryptoChain = availableChains[0].id
    _doCreateCryptoPayment(plan, period)
    return
  }

  _selectedCryptoChain = availableChains[0].id

  const planNames = { plus: 'Plus', pro: 'Pro' }
  const periodNames = { monthly: '月付', yearly: '年付' }
  const planLabel = `${planNames[plan] || plan} ${periodNames[period] || period}`

  const overlay = document.createElement('div')
  overlay.id = 'cryptoChainModal'
  overlay.className = 'modal-overlay active'
  overlay.innerHTML = `
    <div class="crypto-chain-dialog">
      <div class="modal-header">
        <h3>USDT 支付</h3>
        <button class="modal-close" id="cryptoChainClose">&times;</button>
      </div>
      <div class="crypto-plan-badge">${planLabel}</div>
      <div class="crypto-chain-list">
        ${availableChains.map(c => `
          <div class="crypto-chain-card ${c.id === _selectedCryptoChain ? 'active' : ''}" data-chain="${c.id}">
            <div class="chain-icon-wrap" style="background:${c.color}20; color:${c.color}">${c.icon}</div>
            <div class="chain-info">
              <div class="chain-name">${c.name} <span class="chain-full">(${c.full})</span></div>
              <div class="chain-fee">${c.desc} · Gas ${c.fee}</div>
            </div>
            ${c.recommended ? '<span class="chain-tag">推荐</span>' : ''}
            <div class="chain-radio"></div>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-primary btn-block crypto-confirm-btn" id="cryptoChainConfirm">
        确认支付
      </button>
    </div>
  `
  document.body.appendChild(overlay)

  const closeOverlay = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'cryptoChainClose') closeOverlay()
  })

  overlay.querySelectorAll('.crypto-chain-card').forEach(card => {
    card.addEventListener('click', () => {
      _selectedCryptoChain = card.dataset.chain
      overlay.querySelectorAll('.crypto-chain-card').forEach(c => {
        const isActive = c.dataset.chain === _selectedCryptoChain
        c.classList.toggle('active', isActive)
        c.querySelector('.chain-radio').textContent = isActive ? '✓' : ''
      })
    })
  })

  const confirmBtn = overlay.querySelector('#cryptoChainConfirm')
  let confirmed = false
  confirmBtn.addEventListener('click', () => {
    if (confirmed) return
    confirmed = true
    confirmBtn.disabled = true
    confirmBtn.textContent = '处理中...'
    closeOverlay()
    _doCreateCryptoPayment(plan, period)
  })

  const handleEnter = (e) => {
    if (e.key === 'Enter' && document.getElementById('cryptoChainModal')) {
      e.preventDefault()
      e.stopPropagation()
      confirmBtn.click()
    }
  }
  document.addEventListener('keydown', handleEnter, true)
  const origRemove = overlay.remove.bind(overlay)
  overlay.remove = () => {
    document.removeEventListener('keydown', handleEnter, true)
    origRemove()
  }
}

async function _doCreateCryptoPayment(plan, period) {
  try {
    const res = await api.post('/api/payment', { plan, period, crypto_chain: _selectedCryptoChain })
    if (!res.ok) { showToast(res.error || '创建订单失败', 'error'); return }
    if (res.paid_with_credit) { showToast('支付成功！', 'success'); return }
    _showCryptoPaymentPage(res)
  } catch (err) {
    showToast('网络错误，请重试', 'error')
  }
}

function _showCryptoPaymentPage(order) {
  if (document.getElementById('cryptoPaymentModal')) return

  const chain = CRYPTO_CHAINS.find(c => c.id === order.crypto_chain) || CRYPTO_CHAINS[0]
  const amount = order.crypto_amount || '0'
  const address = order.crypto_address || ''
  const confs = order.required_confirmations || 19
  const label = order.label || 'USDT 支付'
  const qrSrc = order.qr_code || ''

  const overlay = document.createElement('div')
  overlay.id = 'cryptoPaymentModal'
  overlay.className = 'modal-overlay active'
  overlay.innerHTML = `
    <div class="crypto-payment-dialog">
      <div class="modal-header">
        <h3>${escapeHtml(label)}</h3>
        <button class="modal-close" id="cryptoPaymentClose">&times;</button>
      </div>
      <div class="crypto-payment-body">
        <div class="crypto-amount-display">
          <div class="crypto-amount-usd">${amount} <span class="crypto-amount-unit">USDT</span></div>
          <div class="crypto-chain-label" style="background:${chain.color}">
            <span class="crypto-chain-icon">${chain.icon}</span>
            ${chain.name} (${chain.full})
          </div>
        </div>
        <div class="crypto-qr-section">
          <div class="crypto-qr-wrapper">
            ${qrSrc ? `<img src="${qrSrc}" alt="QR Code" class="crypto-qr-img" />` : '<div class="crypto-qr-placeholder">QR 码生成中...</div>'}
          </div>
          <p class="crypto-qr-hint">使用 ${chain.name} 钱包扫描二维码</p>
        </div>
        <div class="crypto-address-section">
          <div class="crypto-address-label">收款地址</div>
          <div class="crypto-address-box">
            <span class="crypto-address-text" id="cryptoPayAddress">${escapeHtml(address)}</span>
            <button class="crypto-copy-btn" id="cryptoCopyBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              复制
            </button>
          </div>
        </div>
        <div class="crypto-warning-box">
          <span class="crypto-warning-icon">⚠️</span>
          <span>请务必转账 <strong>${amount} USDT</strong> 至上述地址（${chain.name} 网络），金额不匹配可能导致到账延迟</span>
        </div>
        <div class="crypto-timer-section">
          <div class="crypto-timer-icon">⏱</div>
          <span>请在 <strong id="cryptoPayCountdown">30:00</strong> 内完成支付</span>
        </div>
        <div class="crypto-status-bar">
          <div class="crypto-status-dot" id="cryptoStatusDot"></div>
          <span id="cryptoPaymentStatus">等待支付...</span>
          <span class="crypto-conf-count">确认数: <strong id="cryptoConfirmations">0</strong> / ${confs}</span>
        </div>
        <button class="btn btn-sm" id="cryptoCancelOrderBtn" style="margin-top:12px; color:var(--text-3);">取消订单</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'cryptoPaymentClose') {
      _stopAllPaymentTimers()
      overlay.remove()
    }
  })

  overlay.querySelector('#cryptoCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(address).then(() => {
      const btn = overlay.querySelector('#cryptoCopyBtn')
      btn.textContent = '✓ 已复制'
      setTimeout(() => { btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 复制' }, 2000)
    }).catch(() => {
      const el = document.getElementById('cryptoPayAddress')
      if (el) { const r = document.createRange(); r.selectNode(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(r) }
      showToast('地址已选中，请按 Ctrl+C 复制', 'info')
    })
  })

  overlay.querySelector('#cryptoCancelOrderBtn')?.addEventListener('click', async () => {
    if (!confirm('确认取消此订单？')) return
    try {
      const res = await api.post(`/api/payment/cancel/${order.orderId}`)
      if (res.ok) {
        showToast('订单已取消', 'success')
        _stopAllPaymentTimers()
        overlay.remove()
      } else {
        showToast(res.error || '取消失败', 'error')
      }
    } catch {
      showToast('网络错误', 'error')
    }
  })

  const expiresAt = order.expires_at ? new Date(order.expires_at.replace(' ', 'T') + '+08:00') : null
  const remainingSeconds = expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : 30 * 60
  _startPaymentCountdown(remainingSeconds)
  _startPaymentPolling(order.orderId, confs)
}

function _startPaymentCountdown(totalSeconds) {
  _stopPaymentCountdown()
  let remaining = totalSeconds
  const tick = () => {
    const el = document.getElementById('cryptoPayCountdown')
    if (!el) { _stopPaymentCountdown(); return }
    if (remaining <= 0) { el.textContent = '00:00'; _stopPaymentCountdown(); const s = document.getElementById('cryptoPaymentStatus'); if (s) s.textContent = '订单已过期'; return }
    const m = Math.floor(remaining / 60), s = remaining % 60
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    remaining--
  }
  tick()
  _paymentCountdownTimer = setInterval(tick, 1000)
}

function _stopPaymentCountdown() { if (_paymentCountdownTimer) { clearInterval(_paymentCountdownTimer); _paymentCountdownTimer = null } }

function _startPaymentPolling(orderId, requiredConfs) {
  _stopPaymentPolling()
  _paymentPollingTimer = setInterval(async () => {
    try {
      const res = await api.get(`/api/payment/status/${orderId}`)
      if (res.ok) {
        const confEl = document.getElementById('cryptoConfirmations')
        const statusEl = document.getElementById('cryptoPaymentStatus')
        const dotEl = document.getElementById('cryptoStatusDot')
        if (confEl) confEl.textContent = res.confirmations || 0
        if (statusEl) statusEl.textContent = res.statusLabel || res.status || '等待支付...'
        if (dotEl) dotEl.className = 'crypto-status-dot ' + (res.status === 'paid' ? 'success' : res.status === 'expired' ? 'error' : 'pending')
        if (res.status === 'paid') {
          _stopAllPaymentTimers()
          showToast('支付成功！会员已激活', 'success')
          document.getElementById('cryptoPaymentModal')?.remove()
          setTimeout(() => location.reload(), 1500)
        } else if (res.status === 'expired') {
          _stopAllPaymentTimers()
          showToast('订单已过期，请重新下单', 'error')
          document.getElementById('cryptoPaymentModal')?.remove()
        }
      }
    } catch (err) { console.error('[Payment] Poll error:', err) }
  }, 5000)
}

function _stopPaymentPolling() { if (_paymentPollingTimer) { clearInterval(_paymentPollingTimer); _paymentPollingTimer = null } }

function _stopAllPaymentTimers() { _stopPaymentPolling(); _stopPaymentCountdown() }

// ===== Tools Page =====
async function renderTools() {
  // Try to load from system config, fallback to hardcoded
  let tools = []
  try {
    const res = await api.get('/api/system-config-public/toolbox')
    if (res.ok && res.items) {
      const toolboxItem = res.items.find(i => i.key === 'items')
      if (toolboxItem) tools = JSON.parse(toolboxItem.value || '[]')
    }
  } catch {}

  // Fallback to hardcoded if config empty
  if (!tools.length) {
    tools = [
    {
      category: '交易所',
      items: [
        {
          name: 'Binance（币安）',
          desc: '全球最大的交易所，交易量和流动性充沛，首选',
          icon: '🪙',
          url: 'https://www.bsmkweb.cc/join?ref=WSBNONAME',
          tag: '首选',
          tagColor: '#f0b90b',
          code: 'WSBNONAME',
          rebate: '返佣 20%',
        },
        {
          name: 'OKX（欧易）',
          desc: '仅次于币安的交易所，合约流动性好，期权功能完善',
          icon: '🔵',
          url: 'https://www.promooboost.com/join/CRYPTO618',
          tag: '',
          tagColor: '',
          code: 'CRYPTO618',
          rebate: '返佣 20%',
        },
        {
          name: 'Bybit',
          desc: '适合交易黄金白银外汇，TradFi 板块手续费低',
          icon: '🟡',
          url: 'https://partner.bybit.com/b/CRYPTO618',
          tag: '',
          tagColor: '',
          code: 'CRYPTO618',
          rebate: '返佣 33%',
          note: '注册需使用梯子（台湾、韩国、澳大利亚等地区IP；不能使用香港、新加坡、美国、日本、欧洲的IP）。登录后国内IP可正常使用。认证支持身份证、驾照、护照，注册时先选居住地为台湾或澳大利亚等，提交证件时选择 China 正常提交。',
        },
        {
          name: 'Bitget',
          desc: '跟单交易平台，一键跟随优质交易员策略',
          icon: '🟢',
          url: 'https://partner.hdmune.cn/bg/v8ju2ccn',
          tag: '',
          tagColor: '',
          code: 'WallStreet',
          rebate: '返佣 40%',
        },
        {
          name: 'BIT 美股交易所',
          desc: '美股交易所开户链接，适合美股相关交易使用',
          icon: '🇺🇸',
          url: 'https://bit.bshareweb.com/newRegister/cn?invite_code=CY3DKV',
          tag: '美股',
          tagColor: '#2563eb',
          code: 'CY3DKV',
        },
      ],
    },
    {
      category: '看盘工具',
      items: [
        {
          name: 'TradingView',
          desc: '量见自用的专业看盘软件，支持技术指标、画线工具、多图表布局，新手必备',
          icon: '📊',
          url: 'https://cn.tradingview.com/?aff_id=158703',
          tag: '量见自用',
          tagColor: '#f7931a',
        },
      ],
    },
    {
      category: '数据工具',
      items: [
        {
          name: 'CoinAnk',
          desc: '专业加密货币数据分析平台，链上数据、资金流向、市场情绪分析',
          icon: '📊',
          url: 'https://coinank.com/zh/invite/register?referral=1458068',
          tag: '',
          tagColor: '',
          code: '1458068',
        },
        {
          name: 'CoinGlass',
          desc: '合约数据看板，爆仓数据、资金费率、持仓量一目了然',
          icon: '📈',
          url: 'https://www.coinglass.com/?ref_code=YDHYYF',
          tag: '',
          tagColor: '',
        },
        {
          name: 'CoinMarketCap',
          desc: '加密货币市值排名、价格追踪、项目信息查询',
          icon: '💹',
          url: 'https://coinmarketcap.com/',
          tag: '',
          tagColor: '',
        },
      ],
    },
  ]
  }

  mainContent.innerHTML = `
    <div class="tools-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

      <div class="tools-header">
        <h1 class="tools-title">🧰 金融工具箱</h1>
        <p class="tools-subtitle">这些是我平时看盘、交易、分析用到的工具和平台，分享给大家</p>
      </div>

      <div class="tools-category">
        <h2 class="tools-cat-title">情绪分析</h2>
        <div class="tools-grid">
          <div class="tool-card sentiment-card" id="sentimentCard">
            <div class="tool-card-top">
              <span class="tool-icon">🌡️</span>
              <span class="tool-tag" style="background:var(--accent)">实时</span>
            </div>
            <h3 class="tool-name">量见晴雨表</h3>
            <p class="tool-desc">各品种交易者持仓多空比例，可作为反向指标参考</p>
            <div class="sentiment-card-preview" id="sentimentPreview">
              <div class="sentiment-gauge-loading" id="sentimentLoading">加载中...</div>
            </div>
            <span class="tool-link">查看详情 ↗</span>
          </div>
        </div>
      </div>

      ${tools.map(cat => `
        <div class="tools-category">
          <h2 class="tools-cat-title">${cat.category}</h2>
          <div class="tools-grid">
            ${cat.items.map(t => `
              <a class="tool-card" href="${t.url}" target="_blank" rel="noopener noreferrer">
                <div class="tool-card-top">
                  <span class="tool-icon">${t.icon}</span>
                  ${t.tag ? `<span class="tool-tag" style="background:${t.tagColor}">${t.tag}</span>` : ''}
                </div>
                <h3 class="tool-name">${t.name} ${t.rebate ? `<span class="tool-rebate">${t.rebate}</span>` : ''}</h3>
                <p class="tool-desc">${t.desc}</p>
                ${t.code ? `<div class="tool-code">邀请码：<span class="tool-code-val">${t.code}</span></div>` : ''}
                ${t.note ? `<div class="tool-note">${t.note}</div>` : ''}
                <span class="tool-link">注册/访问 ↗</span>
              </a>
            `).join('')}
          </div>
        </div>
      `).join('')}

      <div class="tools-disclaimer">
        <p>以上链接仅为个人分享，不构成任何投资建议。请自行判断风险。</p>
      </div>
    </div>
  `

  loadSentimentGauge()

  document.getElementById('sentimentCard')?.addEventListener('click', () => {
    if (window._sentimentData) openSentimentModal(window._sentimentData)
  })
}

let _sentimentData = null

let _sentimentRetryCount = 0
const MAX_SENTIMENT_RETRIES = 3

async function loadSentimentGauge(retryCount = 0) {
  const previewEl = document.getElementById('sentimentPreview')
  if (!previewEl) return

  try {
    const res = await api.get('/api/sentiment')
    if (!res.ok) {
      previewEl.innerHTML = '<div class="sentiment-preview-hint">暂时无法加载</div>'
      return
    }

    if (res.status === 'empty' || res.status === 'fetching') {
      if (retryCount < MAX_SENTIMENT_RETRIES) {
        previewEl.innerHTML = `<div class="sentiment-preview-hint">数据加载中，${30 * (retryCount + 1)}秒后重试...</div>`
        setTimeout(() => loadSentimentGauge(retryCount + 1), 30000)
      } else {
        previewEl.innerHTML = '<div class="sentiment-preview-hint">数据暂不可用，请手动刷新页面</div>'
      }
      return
    }

    if (!res.data || res.data.length === 0) {
      previewEl.innerHTML = '<div class="sentiment-preview-hint">暂无数据</div>'
      return
    }

    const validItems = res.data.filter(d => d.longPct !== null)
    if (validItems.length === 0) {
      previewEl.innerHTML = '<div class="sentiment-preview-hint">数据暂不可用</div>'
      return
    }

    window._sentimentData = res
    _sentimentData = res

    const top4 = validItems.slice(0, 4)

    previewEl.innerHTML = top4.map(item => `
        <div class="sentiment-preview-item">
          <span class="sentiment-preview-name">${item.name}</span>
          <div class="sentiment-preview-bar">
            <div class="sentiment-preview-bull" style="width:${item.longPct}%"></div>
            <div class="sentiment-preview-bear" style="width:${item.shortPct}%"></div>
          </div>
          <span class="sentiment-preview-pct">${item.longPct}%</span>
        </div>
      `).join('') + '<div class="sentiment-preview-hint">点击查看更多</div>'
  } catch (e) {
    if (previewEl) previewEl.innerHTML = '<div class="sentiment-preview-hint">暂时无法加载</div>'
  }
}

function openSentimentModal(data) {
  const modal = document.createElement('div')
  modal.className = 'sentiment-modal-overlay'

  const updatedAt = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  const source = data.source || 'IG'

  const validItems = data.data.filter(d => d.longPct !== null)
  const avgLong = validItems.length ? Math.round(validItems.reduce((s, d) => s + d.longPct, 0) / validItems.length) : 50
  const avgShort = 100 - avgLong

  const categoryOrder = ['商品', '股指', '外汇']
  const grouped = categoryOrder.map(cat => ({
    name: cat,
    items: data.data.filter(d => d.category === cat && d.longPct !== null),
  })).filter(g => g.items.length > 0)

  modal.innerHTML = `
    <div class="sentiment-modal">
      <div class="sentiment-modal-header">
        <div>
          <h3 class="sentiment-modal-title">🌡️ 买卖强弱对比</h3>
          <p class="sentiment-modal-desc">反映各品种交易者持仓多空比例，数值越高代表看多情绪越强。可作为反向指标参考。</p>
        </div>
        <button class="sentiment-modal-close" id="closeSentimentModal">✕</button>
      </div>
      ${updatedAt ? `<div class="sentiment-modal-time">更新于 ${updatedAt} · 数据来源 ${source}</div>` : ''}
      <div class="sentiment-legend">
        <div class="sentiment-legend-bar">
          <div class="sentiment-legend-bull" style="width:${avgLong}%">
            <span class="sentiment-legend-label">多头</span>
          </div>
          <div class="sentiment-legend-bear" style="width:${avgShort}%">
            <span class="sentiment-legend-label">空头</span>
          </div>
        </div>
        <div class="sentiment-legend-scale">
          <span>${avgLong}%</span><span>0</span><span>${avgShort}%</span>
        </div>
        <p class="sentiment-legend-desc">空头占比&gt;80%一般视为买进信号；多头占比&gt;80%一般视为卖出信号</p>
      </div>
      <div class="sentiment-modal-body">
        ${grouped.map(cat => `
          <div class="sentiment-modal-cat">
            <h4 class="sentiment-modal-cat-name">${cat.name}</h4>
            <div class="sentiment-modal-items">
              ${cat.items.map(item => `
                  <div class="sentiment-modal-item">
                    <div class="sentiment-modal-item-info">
                      <span class="sentiment-modal-item-name">${item.name}</span>
                      <div class="sentiment-modal-item-tags">
                        <span class="sentiment-bull-tag">多 ${item.longPct}%</span>
                        <span class="sentiment-bear-tag">空 ${item.shortPct}%</span>
                      </div>
                    </div>
                    <div class="sentiment-modal-bar">
                      <div class="sentiment-bar-bull" style="width:${item.longPct}%">
                        <span class="sentiment-bar-label">${item.longPct}%</span>
                      </div>
                      <div class="sentiment-bar-bear" style="width:${item.shortPct}%">
                        <span class="sentiment-bar-label">${item.shortPct}%</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `

  document.body.appendChild(modal)
  requestAnimationFrame(() => modal.classList.add('sentiment-modal-visible'))

  const close = () => {
    modal.classList.remove('sentiment-modal-visible')
    setTimeout(() => modal.remove(), 300)
  }
  modal.querySelector('#closeSentimentModal').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler) }
  })
}

// Settings tab state
let settingsTab = 'profile'

function renderProfile() {
  const currentPlan = getEffectivePlan()
  const membershipExpired = isMembershipExpiredClient()
  const membershipDisplayName = getMembershipDisplayName()

  mainContent.innerHTML = `
    <div class="settings-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>
      <div class="settings-layout">
        <nav class="settings-nav">
          <div class="settings-nav-title">设置和账单</div>
          <a class="settings-nav-item ${settingsTab === 'profile' ? 'active' : ''}" data-tab="profile">
            <span class="settings-nav-icon">👤</span>个人资料
          </a>
          <a class="settings-nav-item ${settingsTab === 'account' ? 'active' : ''}" data-tab="account">
            <span class="settings-nav-icon">🔐</span>账号设置
          </a>
          <a class="settings-nav-item ${settingsTab === 'notifications' ? 'active' : ''}" data-tab="notifications">
            <span class="settings-nav-icon">🧵</span>论坛通知
            ${state.notificationUnread ? `<span class="settings-nav-badge">${state.notificationUnread > 99 ? '99+' : state.notificationUnread}</span>` : ''}
          </a>
          <div class="settings-nav-divider"></div>
          <div class="settings-nav-section">账单</div>
          <a class="settings-nav-item ${settingsTab === 'subscription' ? 'active' : ''}" data-tab="subscription">
            <span class="settings-nav-icon">💳</span>订阅
          </a>
          <a class="settings-nav-item ${settingsTab === 'credits' ? 'active' : ''}" data-tab="credits">
            <span class="settings-nav-icon">🎟️</span>返佣邀请
          </a>
        </nav>

        <div class="settings-content">
          ${settingsTab === 'profile' ? `
            <!-- 个人资料 -->
            <div class="settings-section">
              <h2 class="settings-section-title">个人资料</h2>
              <p class="settings-section-desc">管理你的头像和昵称</p>

              <div class="settings-card">
                <div class="profile-avatar-section">
                  <div class="profile-avatar-wrap">
                    ${state.user.avatar
                      ? `<img src="${escapeHtml(state.user.avatar)}" class="profile-avatar-img">`
                      : `<span class="profile-avatar-letter">${escapeHtml((state.user.name || 'U')[0].toUpperCase())}</span>`
                    }
                  </div>
                  <div class="profile-avatar-info">
                    <label class="btn btn-ghost btn-sm profile-upload-btn">
                      更换头像
                      <input type="file" accept="image/*" id="avatarInput" style="display:none">
                    </label>
                    <p class="settings-hint">支持 JPG、PNG，自动压缩至 200×200</p>
                  </div>
                </div>
              </div>

              <div class="settings-card">
                <div class="form-group">
                  <label class="form-label">昵称</label>
                  <div class="form-row">
                    <input type="text" class="form-input" id="profileName" value="${state.user.name}">
                    <button class="btn-send-code" id="saveNameBtn">保存</button>
                  </div>
                </div>
              </div>

              <div class="settings-card settings-info-card">
                <div class="profile-info-item">
                  <span class="profile-info-label">UID</span>
                  <span class="profile-info-value" style="font-family:monospace;letter-spacing:1px">${state.user.uid || '—'}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">当前方案</span>
                  <span class="profile-info-value">${membershipDisplayName}${state.user?.planSource === 'gift' && currentPlan !== 'free' ? ' <span class="plan-gift-tag">体验版</span>' : ''}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">Telegram 绑定</span>
                  <span class="profile-info-value">${escapeHtml(getTelegramBindingLabel(state.user?.telegramBinding))}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">已完成课程</span>
                  <span class="profile-info-value">${progress.getCompletedCount()} 课</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">学习中</span>
                  <span class="profile-info-value">${progress.getInProgressCount()} 课</span>
                </div>
              </div>
            </div>
          ` : settingsTab === 'account' ? `
            <!-- 账号设置 -->
            <div class="settings-section">
              <h2 class="settings-section-title">账号设置</h2>
              <p class="settings-section-desc">管理你的邮箱和密码</p>

              ${state.user.email ? `
              <div class="settings-card">
                <div class="account-info-row">
                  <div>
                    <label class="form-label">电子邮箱</label>
                    <span class="account-info-value">${state.user.email}</span>
                  </div>
                  <button class="btn-account-change" id="changeEmailToggle">更换</button>
                </div>
                <div id="changeEmailForm" style="display:none">
                  <div class="form-group">
                    <label class="form-label">原密码</label>
                    <input type="password" class="form-input" id="changeEmailOldPwd" placeholder="输入当前密码">
                  </div>
                  <div class="form-group">
                    <label class="form-label">新邮箱</label>
                    <div class="form-row">
                      <input type="email" class="form-input" id="changeEmailInput" placeholder="请输入新邮箱" style="flex:1">
                      <button class="btn-send-code" id="changeEmailSendCode">发送验证码</button>
                    </div>
                  </div>
                  <div class="form-group" id="changeEmailCodeGroup" style="display:none">
                    <label class="form-label">验证码</label>
                    <input type="text" class="form-input" id="changeEmailCode" placeholder="输入6位验证码" maxlength="6">
                  </div>
                  <button class="btn btn-primary" id="changeEmailBtn" style="width:100%;margin-top:8px;display:none">确认更换</button>
                  <div id="changeEmailMsg" class="settings-msg" style="display:none"></div>
                </div>
              </div>
              ` : ''}

              ${state.user.phone ? `
              <div class="settings-card">
                <div class="account-info-row">
                  <div>
                    <label class="form-label">手机号</label>
                    <span class="account-info-value">${state.user.phone}</span>
                  </div>
                  <button class="btn-account-change" id="changePhoneToggle">更换</button>
                </div>
                <div id="changePhoneForm" style="display:none">
                  <div class="form-group">
                    <label class="form-label">原密码</label>
                    <input type="password" class="form-input" id="changePhoneOldPwd" placeholder="输入当前密码">
                  </div>
                  <div class="form-group">
                    <label class="form-label">新手机号</label>
                    <div class="form-row">
                      <input type="tel" class="form-input" id="changePhoneInput" placeholder="请输入新手机号" style="flex:1">
                      <button class="btn-send-code" id="changePhoneSendCode">发送验证码</button>
                    </div>
                  </div>
                  <div class="form-group" id="changePhoneCodeGroup" style="display:none">
                    <label class="form-label">验证码</label>
                    <input type="text" class="form-input" id="changePhoneCode" placeholder="输入6位验证码" maxlength="6">
                  </div>
                  <button class="btn btn-primary" id="changePhoneBtn" style="width:100%;margin-top:8px;display:none">确认更换</button>
                  <div id="changePhoneMsg" class="settings-msg" style="display:none"></div>
                </div>
              </div>
              ` : ''}

              ${state.user.authMethod === 'email' && !state.user.phone ? `
              <div class="settings-card">
                <h3 class="settings-card-title">绑定手机号</h3>
                <div class="form-group">
                  <label class="form-label">手机号</label>
                  <div class="form-row">
                    <input type="tel" class="form-input" id="bindPhoneInput" placeholder="请输入手机号" style="flex:1">
                    <button class="btn-send-code" id="bindPhoneSendCode">发送验证码</button>
                  </div>
                </div>
                <div class="form-group" id="bindPhoneCodeGroup" style="display:none">
                  <label class="form-label">验证码</label>
                  <input type="text" class="form-input" id="bindPhoneCode" placeholder="输入6位验证码" maxlength="6">
                </div>
                <button class="btn btn-primary" id="bindPhoneBtn" style="width:100%;margin-top:8px;display:none">绑定</button>
                <div id="bindPhoneMsg" class="settings-msg" style="display:none"></div>
              </div>
              ` : ''}

              ${state.user.authMethod === 'phone' && !state.user.email ? `
              <div class="settings-card">
                <h3 class="settings-card-title">绑定邮箱</h3>
                <div class="form-group">
                  <label class="form-label">邮箱</label>
                  <div class="form-row">
                    <input type="email" class="form-input" id="bindEmailInput" placeholder="请输入邮箱" style="flex:1">
                    <button class="btn-send-code" id="bindEmailSendCode">发送验证码</button>
                  </div>
                </div>
                <div class="form-group" id="bindEmailCodeGroup" style="display:none">
                  <label class="form-label">验证码</label>
                  <input type="text" class="form-input" id="bindEmailCode" placeholder="输入6位验证码" maxlength="6">
                </div>
                <button class="btn btn-primary" id="bindEmailBtn" style="width:100%;margin-top:8px;display:none">绑定</button>
                <div id="bindEmailMsg" class="settings-msg" style="display:none"></div>
              </div>
              ` : ''}

              <div class="settings-card">
                <h3 class="settings-card-title">更改密码</h3>
                <div class="pwd-change-tabs">
                  <button class="pwd-tab active" data-pwd-mode="old">使用原密码</button>
                  <button class="pwd-tab" data-pwd-mode="email">使用邮箱验证</button>
                  <button class="pwd-tab" data-pwd-mode="phone">使用手机号验证</button>
                </div>

                <div id="pwdChangeForm">
                  <div id="pwdOldMode">
                    <div class="form-group">
                      <label class="form-label">原密码</label>
                      <input type="password" class="form-input" id="oldPassword" placeholder="输入当前密码">
                    </div>
                  </div>
                  <div id="pwdEmailMode" style="display:none">
                    <div class="form-group">
                      <label class="form-label">邮箱验证</label>
                      <div class="form-row">
                        <input type="text" class="form-input" value="${state.user.email}" disabled style="opacity:0.6;flex:1">
                        <button class="btn-send-code" id="pwdSendCode">发送验证码</button>
                      </div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">验证码</label>
                      <input type="text" class="form-input" id="pwdVerifyCode" placeholder="输入6位验证码" maxlength="6">
                    </div>
                  </div>
                  <div id="pwdPhoneMode" style="display:none">
                    <div class="form-group">
                      <label class="form-label">手机号验证</label>
                      <div class="form-row">
                        <input type="text" class="form-input" value="${state.user.phone || ''}" disabled style="opacity:0.6;flex:1">
                        <button class="btn-send-code" id="pwdPhoneSendCode">发送验证码</button>
                      </div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">验证码</label>
                      <input type="text" class="form-input" id="pwdPhoneVerifyCode" placeholder="输入6位验证码" maxlength="6">
                    </div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">新密码</label>
                    <input type="password" class="form-input" id="newPassword" placeholder="8~32个字符">
                  </div>
                  <div class="form-group">
                    <label class="form-label">确认新密码</label>
                    <input type="password" class="form-input" id="confirmPassword" placeholder="再次输入新密码">
                  </div>
                  <button class="btn btn-primary" id="savePasswordBtn" style="width:100%;margin-top:8px">更改密码</button>
                  <div id="pwdChangeMsg" class="settings-msg" style="display:none"></div>
                </div>
              </div>
            </div>
          ` : settingsTab === 'notifications' ? `
            <div class="settings-section">
              <h2 class="settings-section-title">论坛通知</h2>
              <p class="settings-section-desc">有人回复你、引用你时，会在这里提醒。</p>

              <div class="settings-card">
                <div class="forum-notifications-head">
                  <div class="forum-notifications-meta">
                    <span class="forum-notifications-unread">未读 ${state.notificationUnread || 0}</span>
                    <span class="settings-hint">系统会在你打开通知后自动标记已读</span>
                  </div>
                  <button class="btn btn-ghost btn-sm" id="forumReadAllBtn">全部已读</button>
                </div>
                <div id="forumNotificationsList" class="forum-notifications-list">
                  <div class="billing-loading">加载中...</div>
                </div>
              </div>
            </div>
          ` : settingsTab === 'subscription' ? `
            <!-- 订阅 -->
            <div class="settings-section">
              <h2 class="settings-section-title">订阅</h2>
              <p class="settings-section-desc">管理你的会员方案</p>

              <div class="settings-card sub-current-card">
                <div class="sub-current-header">
                  <div>
                    <div class="sub-current-plan">${membershipDisplayName}${state.user?.planSource === 'gift' && currentPlan !== 'free' ? ' <span class="plan-gift-tag">体验版</span>' : ''}</div>
                    <div class="sub-current-desc">${currentPlan === 'free' ? '公开视频 + 语录' : currentPlan === 'plus' ? '新视频即时解锁 + 图解 + 测验' : '全部权限 + AI信号'}</div>
                    ${state.user?.planExpiresAt ? `<div class="sub-expires">到期时间：${formatDateTime(state.user.planExpiresAt)}</div>` : ''}
                  </div>
                  <span class="sub-current-badge ${membershipExpired ? 'sub-badge-expired' : `sub-badge-${currentPlan}`}">${membershipExpired ? '已过期' : currentPlan === 'free' ? '免费' : currentPlan === 'plus' ? 'Plus' : 'Pro'}</span>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">更改方案</h3>
                <div class="sub-plans">
                  <div class="sub-plan-row ${currentPlan === 'free' && !membershipExpired ? 'sub-plan-active' : ''}" data-plan="free">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">🆓</span>
                      <div>
                        <div class="sub-plan-name">体验版</div>
                        <div class="sub-plan-desc">公开视频 + 语录</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">免费</div>
                    ${currentPlan === 'free' && !membershipExpired ? '<span class="sub-plan-current">当前</span>' : ''}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'plus' ? 'sub-plan-active' : ''} ${currentPlan === 'pro' ? 'sub-plan-disabled' : ''}" data-plan="plus">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">⭐</span>
                      <div>
                        <div class="sub-plan-name">Plus</div>
                        <div class="sub-plan-desc">新视频即时解锁 + 图解 + 测验</div>
                      </div>
                    </div>
                    <div class="sub-plan-price sub-plan-price-plus">$50/月</div>
                    ${currentPlan === 'plus' ? '<span class="sub-plan-current">当前</span>' : currentPlan === 'pro' ? '' : '<button class="btn btn-sm btn-primary sub-plan-btn" data-plan="plus">USDT 支付</button>'}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'pro' ? 'sub-plan-active' : ''}" data-plan="pro">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">💎</span>
                      <div>
                        <div class="sub-plan-name">Pro</div>
                        <div class="sub-plan-desc">全部权限 + AI信号</div>
                      </div>
                    </div>
                    <div class="sub-plan-price sub-plan-price-pro">$100/月</div>
                    ${currentPlan === 'pro' ? '<span class="sub-plan-current">当前</span>' : '<button class="btn btn-sm btn-primary sub-plan-btn" data-plan="pro">USDT 支付</button>'}
                  </div>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">账单历史</h3>
                <div id="billingHistory" class="billing-history">
                  <div class="billing-loading">加载中...</div>
                </div>
              </div>

              <a class="settings-link" id="goMembershipPage">查看完整方案对比 →</a>
            </div>
          ` : settingsTab === 'credits' ? `
            <div class="settings-section">
              <h2 class="settings-section-title">返佣邀请</h2>
              <p class="settings-section-desc">邀请新用户订阅后生成返佣奖励，功能正式开放后可用于后续 Plus 或 Pro 订阅。</p>
              <div id="subscriptionCreditCenter" class="subscription-credit-center">
                <div class="billing-loading">加载中...</div>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `

  // Settings tab click handlers
  mainContent.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      settingsTab = item.dataset.tab
      const accountUrl = settingsTab === 'profile' ? '/account' : `/account?tab=${encodeURIComponent(settingsTab)}`
      window.history.replaceState({ view:'profile' }, '', accountUrl)
      if (localStorage.getItem('ws_token')) {
        refreshCurrentUserProfile({ rerender: true }).catch(() => { renderProfile() })
      } else {
        renderProfile()
      }
    })
  })

  // Password mode tabs
  mainContent.querySelectorAll('.pwd-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      mainContent.querySelectorAll('.pwd-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const mode = tab.dataset.pwdMode
      const oldDiv = document.getElementById('pwdOldMode')
      const emailDiv = document.getElementById('pwdEmailMode')
      const phoneDiv = document.getElementById('pwdPhoneMode')
      if (oldDiv) oldDiv.style.display = mode === 'old' ? 'block' : 'none'
      if (emailDiv) emailDiv.style.display = mode === 'email' ? 'block' : 'none'
      if (phoneDiv) phoneDiv.style.display = mode === 'phone' ? 'block' : 'none'
    })
  })

  // Send verification code for password reset
  const pwdSendBtn = document.getElementById('pwdSendCode')
  if (pwdSendBtn) {
    pwdSendBtn.addEventListener('click', async () => {
      pwdSendBtn.disabled = true
      pwdSendBtn.textContent = '发送中...'
      try {
        const res = await api.post('/api/send-code', {
          email: state.user.email,
          purpose: 'change_password',
        })
        if (res.ok) {
          showFormMsgProfile('验证码已发送', 'ok')
          let cd = 60
          const timer = setInterval(() => {
            cd--
            pwdSendBtn.textContent = `${cd}s`
            if (cd <= 0) { clearInterval(timer); pwdSendBtn.textContent = '发送验证码'; pwdSendBtn.disabled = false }
          }, 1000)
        } else {
          showFormMsgProfile(res.error || '发送失败', 'err')
          pwdSendBtn.disabled = false
          pwdSendBtn.textContent = '发送验证码'
        }
      } catch {
        showFormMsgProfile('发送失败', 'err')
        pwdSendBtn.disabled = false
        pwdSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Send verification code for password reset via phone
  const pwdPhoneSendBtn = document.getElementById('pwdPhoneSendCode')
  if (pwdPhoneSendBtn) {
    pwdPhoneSendBtn.addEventListener('click', async () => {
      pwdPhoneSendBtn.disabled = true
      pwdPhoneSendBtn.textContent = '发送中...'
      try {
        const captchaRes = await api.get('/api/captcha')
        if (!captchaRes.ok) { showFormMsgProfile('图形验证码加载失败', 'err'); pwdPhoneSendBtn.disabled = false; pwdPhoneSendBtn.textContent = '发送验证码'; return }
        showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
          try {
            const res = await api.post('/api/send-code', {
              phone: state.user.phone,
              purpose: 'change_password',
              captchaId,
              captchaAnswer: captchaCode,
            })
            if (res.ok) {
              closeModal()
              showFormMsgProfile('验证码已发送', 'ok')
              let cd = 60
              const timer = setInterval(() => {
                cd--
                pwdPhoneSendBtn.textContent = `${cd}s`
                if (cd <= 0) { clearInterval(timer); pwdPhoneSendBtn.textContent = '发送验证码'; pwdPhoneSendBtn.disabled = false }
              }, 1000)
            } else if (res.error && res.error.includes('验证码')) {
              handleCaptchaError(res, modalOverlay)
              pwdPhoneSendBtn.disabled = false
              pwdPhoneSendBtn.textContent = '发送验证码'
            } else {
              closeModal()
              showFormMsgProfile(res.error || '发送失败', 'err')
              pwdPhoneSendBtn.disabled = false
              pwdPhoneSendBtn.textContent = '发送验证码'
            }
          } catch {
            closeModal()
            showFormMsgProfile('发送失败', 'err')
            pwdPhoneSendBtn.disabled = false
            pwdPhoneSendBtn.textContent = '发送验证码'
          }
        })
      } catch {
        showFormMsgProfile('图形验证码加载失败', 'err')
        pwdPhoneSendBtn.disabled = false
        pwdPhoneSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Save password
  const savePwdBtn = document.getElementById('savePasswordBtn')
  if (savePwdBtn) {
    savePwdBtn.addEventListener('click', async () => {
      const newPwd = document.getElementById('newPassword')?.value
      const confirmPwd = document.getElementById('confirmPassword')?.value
      const msgDiv = document.getElementById('pwdChangeMsg')

      const passwordError = getPasswordRuleError(newPwd)
      if (passwordError) {
        showPwdMsg(msgDiv, passwordError, 'err'); return
      }
      if (newPwd !== confirmPwd) {
        showPwdMsg(msgDiv, '两次输入的密码不一致', 'err'); return
      }

      const activeMode = mainContent.querySelector('.pwd-tab.active')?.dataset.pwdMode || 'old'
      const body = { newPassword: newPwd }

      if (activeMode === 'old') {
        const oldPwd = document.getElementById('oldPassword')?.value
        if (!oldPwd) { showPwdMsg(msgDiv, '请输入原密码', 'err'); return }
        body.oldPassword = oldPwd
      } else if (activeMode === 'phone') {
        const code = document.getElementById('pwdPhoneVerifyCode')?.value
        if (!code || code.length !== 6) { showPwdMsg(msgDiv, '请输入6位验证码', 'err'); return }
        const vRes = await api.post('/api/verify-code', {
          phone: state.user.phone,
          code,
          purpose: 'change_password',
        })
        if (!vRes.ok) { showPwdMsg(msgDiv, vRes.error || '验证码错误', 'err'); return }
        body.verifyToken = vRes.token
      } else {
        const code = document.getElementById('pwdVerifyCode')?.value
        if (!code || code.length !== 6) { showPwdMsg(msgDiv, '请输入6位验证码', 'err'); return }
        const vRes = await api.post('/api/verify-code', {
          email: state.user.email,
          code,
          purpose: 'change_password',
        })
        if (!vRes.ok) { showPwdMsg(msgDiv, vRes.error || '验证码错误', 'err'); return }
        body.verifyToken = vRes.token
      }

      savePwdBtn.disabled = true
      savePwdBtn.textContent = '修改中...'
      try {
        const res = await api.post('/api/change-password', body)
        if (res.ok) {
          if (res.relogin) {
            const email = state.user?.email || ''
            state.user = null
            localStorage.removeItem('ws_user')
            localStorage.removeItem('ws_token')
            clearAuthCookie()
            stopPresenceHeartbeat()
            updateAuthUI()
            state.currentView = 'home'
            renderView()
            showAuthModal('login_password', { email, message: '密码修改成功，请重新登录' })
            return
          }
          showPwdMsg(msgDiv, '密码修改成功', 'ok')
          const fields = ['oldPassword', 'newPassword', 'confirmPassword', 'pwdVerifyCode', 'pwdPhoneVerifyCode']
          fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
        } else {
          showPwdMsg(msgDiv, res.error || '修改失败', 'err')
        }
      } catch {
        showPwdMsg(msgDiv, '修改失败，请稍后重试', 'err')
      }
      savePwdBtn.disabled = false
      savePwdBtn.textContent = '更改密码'
    })
  }

  // Bind phone: send code
  const bindPhoneSendBtn = document.getElementById('bindPhoneSendCode')
  if (bindPhoneSendBtn) {
    bindPhoneSendBtn.addEventListener('click', async () => {
      const phone = document.getElementById('bindPhoneInput')?.value?.trim()
      if (!phone || phone.length < 6) { showSettingsMsg('bindPhoneMsg', '请输入有效手机号', 'err'); return }
      bindPhoneSendBtn.disabled = true
      bindPhoneSendBtn.textContent = '发送中...'
      try {
        const captchaRes = await api.get('/api/captcha')
        if (!captchaRes.ok) { showSettingsMsg('bindPhoneMsg', '验证码加载失败', 'err'); bindPhoneSendBtn.disabled = false; bindPhoneSendBtn.textContent = '发送验证码'; return }
        showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
          try {
            const res = await api.post('/api/send-bind-code', { phone, captchaId, captchaAnswer: captchaCode })
            if (res.ok) {
              closeModal()
              showSettingsMsg('bindPhoneMsg', '验证码已发送', 'ok')
              document.getElementById('bindPhoneCodeGroup').style.display = 'block'
              document.getElementById('bindPhoneBtn').style.display = 'block'
              let cd = 60
              const timer = setInterval(() => {
                cd--
                bindPhoneSendBtn.textContent = `${cd}s`
                if (cd <= 0) { clearInterval(timer); bindPhoneSendBtn.textContent = '发送验证码'; bindPhoneSendBtn.disabled = false }
              }, 1000)
            } else if (res.error && res.error.includes('验证码')) {
              handleCaptchaError(res, modalOverlay)
              bindPhoneSendBtn.disabled = false
              bindPhoneSendBtn.textContent = '发送验证码'
            } else {
              closeModal()
              showSettingsMsg('bindPhoneMsg', res.error || '发送失败', 'err')
              bindPhoneSendBtn.disabled = false
              bindPhoneSendBtn.textContent = '发送验证码'
            }
          } catch {
            closeModal()
            showSettingsMsg('bindPhoneMsg', '发送失败', 'err')
            bindPhoneSendBtn.disabled = false
            bindPhoneSendBtn.textContent = '发送验证码'
          }
        })
      } catch {
        showSettingsMsg('bindPhoneMsg', '验证码加载失败', 'err')
        bindPhoneSendBtn.disabled = false
        bindPhoneSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Bind phone: verify code and bind
  const bindPhoneBtn = document.getElementById('bindPhoneBtn')
  if (bindPhoneBtn) {
    bindPhoneBtn.addEventListener('click', async () => {
      const phone = document.getElementById('bindPhoneInput')?.value?.trim()
      const code = document.getElementById('bindPhoneCode')?.value?.trim()
      if (!phone) { showSettingsMsg('bindPhoneMsg', '请输入手机号', 'err'); return }
      if (!code || code.length !== 6) { showSettingsMsg('bindPhoneMsg', '请输入6位验证码', 'err'); return }
      bindPhoneBtn.disabled = true
      bindPhoneBtn.textContent = '绑定中...'
      try {
        const vRes = await api.post('/api/verify-code', { phone, code, purpose: 'bind' })
        if (!vRes.ok) { showSettingsMsg('bindPhoneMsg', vRes.error || '验证码错误', 'err'); bindPhoneBtn.disabled = false; bindPhoneBtn.textContent = '绑定'; return }
        const res = await api.post('/api/bind-phone', { phone, verifyToken: vRes.token })
        if (res.ok) {
          showSettingsMsg('bindPhoneMsg', '手机绑定成功', 'ok')
          state.user.phone = phone
          localStorage.setItem('ws_user', JSON.stringify(state.user))
          setTimeout(() => renderProfile(), 1500)
        } else {
          showSettingsMsg('bindPhoneMsg', res.error || '绑定失败', 'err')
        }
      } catch {
        showSettingsMsg('bindPhoneMsg', '绑定失败', 'err')
      }
      bindPhoneBtn.disabled = false
      bindPhoneBtn.textContent = '绑定'
    })
  }

  // Bind email: send code
  const bindEmailSendBtn = document.getElementById('bindEmailSendCode')
  if (bindEmailSendBtn) {
    bindEmailSendBtn.addEventListener('click', async () => {
      const email = document.getElementById('bindEmailInput')?.value?.trim()
      if (!email || !email.includes('@')) { showSettingsMsg('bindEmailMsg', '请输入有效邮箱', 'err'); return }
      bindEmailSendBtn.disabled = true
      bindEmailSendBtn.textContent = '发送中...'
      try {
        const captchaRes = await api.get('/api/captcha')
        if (!captchaRes.ok) { showSettingsMsg('bindEmailMsg', '验证码加载失败', 'err'); bindEmailSendBtn.disabled = false; bindEmailSendBtn.textContent = '发送验证码'; return }
        showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
          try {
            const res = await api.post('/api/send-bind-code', { email, captchaId, captchaAnswer: captchaCode })
            if (res.ok) {
              closeModal()
              showSettingsMsg('bindEmailMsg', '验证码已发送', 'ok')
              document.getElementById('bindEmailCodeGroup').style.display = 'block'
              document.getElementById('bindEmailBtn').style.display = 'block'
              let cd = 60
              const timer = setInterval(() => {
                cd--
                bindEmailSendBtn.textContent = `${cd}s`
                if (cd <= 0) { clearInterval(timer); bindEmailSendBtn.textContent = '发送验证码'; bindEmailSendBtn.disabled = false }
              }, 1000)
            } else if (res.error && res.error.includes('验证码')) {
              handleCaptchaError(res, modalOverlay)
              bindEmailSendBtn.disabled = false
              bindEmailSendBtn.textContent = '发送验证码'
            } else {
              closeModal()
              showSettingsMsg('bindEmailMsg', res.error || '发送失败', 'err')
              bindEmailSendBtn.disabled = false
              bindEmailSendBtn.textContent = '发送验证码'
            }
          } catch {
            closeModal()
            showSettingsMsg('bindEmailMsg', '发送失败', 'err')
            bindEmailSendBtn.disabled = false
            bindEmailSendBtn.textContent = '发送验证码'
          }
        })
      } catch {
        showSettingsMsg('bindEmailMsg', '验证码加载失败', 'err')
        bindEmailSendBtn.disabled = false
        bindEmailSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Bind email: verify code and bind
  const bindEmailBtn = document.getElementById('bindEmailBtn')
  if (bindEmailBtn) {
    bindEmailBtn.addEventListener('click', async () => {
      const email = document.getElementById('bindEmailInput')?.value?.trim()
      const code = document.getElementById('bindEmailCode')?.value?.trim()
      if (!email || !email.includes('@')) { showSettingsMsg('bindEmailMsg', '请输入有效邮箱', 'err'); return }
      if (!code || code.length !== 6) { showSettingsMsg('bindEmailMsg', '请输入6位验证码', 'err'); return }
      bindEmailBtn.disabled = true
      bindEmailBtn.textContent = '绑定中...'
      try {
        const vRes = await api.post('/api/verify-code', { email, code, purpose: 'bind' })
        if (!vRes.ok) { showSettingsMsg('bindEmailMsg', vRes.error || '验证码错误', 'err'); bindEmailBtn.disabled = false; bindEmailBtn.textContent = '绑定'; return }
        const res = await api.post('/api/bind-email', { email, verifyToken: vRes.token })
        if (res.ok) {
          showSettingsMsg('bindEmailMsg', '邮箱绑定成功', 'ok')
          state.user.email = email
          localStorage.setItem('ws_user', JSON.stringify(state.user))
          setTimeout(() => renderProfile(), 1500)
        } else {
          showSettingsMsg('bindEmailMsg', res.error || '绑定失败', 'err')
        }
      } catch {
        showSettingsMsg('bindEmailMsg', '绑定失败', 'err')
      }
      bindEmailBtn.disabled = false
      bindEmailBtn.textContent = '绑定'
    })
  }

  // Change email: toggle form
  const changeEmailToggle = document.getElementById('changeEmailToggle')
  if (changeEmailToggle) {
    changeEmailToggle.addEventListener('click', () => {
      const form = document.getElementById('changeEmailForm')
      const isHidden = form.style.display === 'none'
      form.style.display = isHidden ? 'block' : 'none'
      changeEmailToggle.textContent = isHidden ? '收起' : '更换'
    })
  }

  // Change email: send code
  const changeEmailSendBtn = document.getElementById('changeEmailSendCode')
  if (changeEmailSendBtn) {
    changeEmailSendBtn.addEventListener('click', async () => {
      const newEmail = document.getElementById('changeEmailInput')?.value?.trim()
      if (!newEmail || !newEmail.includes('@')) { showSettingsMsg('changeEmailMsg', '请输入有效邮箱', 'err'); return }
      changeEmailSendBtn.disabled = true
      changeEmailSendBtn.textContent = '发送中...'
      try {
        const captchaRes = await api.get('/api/captcha')
        if (!captchaRes.ok) { showSettingsMsg('changeEmailMsg', '图形验证码加载失败', 'err'); changeEmailSendBtn.disabled = false; changeEmailSendBtn.textContent = '发送验证码'; return }
        showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
          try {
            const res = await api.post('/api/send-code', {
              email: newEmail,
              purpose: 'change_email',
              captchaId,
              captchaAnswer: captchaCode,
            })
            if (res.ok) {
              closeModal()
              showSettingsMsg('changeEmailMsg', '验证码已发送', 'ok')
              document.getElementById('changeEmailCodeGroup').style.display = 'block'
              document.getElementById('changeEmailBtn').style.display = 'block'
              let cd = 60
              const timer = setInterval(() => {
                cd--
                changeEmailSendBtn.textContent = `${cd}s`
                if (cd <= 0) { clearInterval(timer); changeEmailSendBtn.textContent = '发送验证码'; changeEmailSendBtn.disabled = false }
              }, 1000)
            } else if (res.error && res.error.includes('验证码')) {
              handleCaptchaError(res, modalOverlay)
              changeEmailSendBtn.disabled = false
              changeEmailSendBtn.textContent = '发送验证码'
            } else {
              closeModal()
              showSettingsMsg('changeEmailMsg', res.error || '发送失败', 'err')
              changeEmailSendBtn.disabled = false
              changeEmailSendBtn.textContent = '发送验证码'
            }
          } catch {
            closeModal()
            showSettingsMsg('changeEmailMsg', '发送失败', 'err')
            changeEmailSendBtn.disabled = false
            changeEmailSendBtn.textContent = '发送验证码'
          }
        })
      } catch {
        showSettingsMsg('changeEmailMsg', '图形验证码加载失败', 'err')
        changeEmailSendBtn.disabled = false
        changeEmailSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Change email: confirm
  const changeEmailBtn = document.getElementById('changeEmailBtn')
  if (changeEmailBtn) {
    changeEmailBtn.addEventListener('click', async () => {
      const oldPwd = document.getElementById('changeEmailOldPwd')?.value
      const newEmail = document.getElementById('changeEmailInput')?.value?.trim()
      const code = document.getElementById('changeEmailCode')?.value?.trim()
      if (!oldPwd) { showSettingsMsg('changeEmailMsg', '请输入原密码', 'err'); return }
      if (!newEmail || !newEmail.includes('@')) { showSettingsMsg('changeEmailMsg', '请输入有效邮箱', 'err'); return }
      if (!code || code.length !== 6) { showSettingsMsg('changeEmailMsg', '请输入6位验证码', 'err'); return }
      changeEmailBtn.disabled = true
      changeEmailBtn.textContent = '更换中...'
      try {
        const vRes = await api.post('/api/verify-code', {
          email: newEmail,
          code,
          purpose: 'change_email',
        })
        if (!vRes.ok) { showSettingsMsg('changeEmailMsg', vRes.error || '验证码错误', 'err'); changeEmailBtn.disabled = false; changeEmailBtn.textContent = '确认更换'; return }
        const res = await api.post('/api/change-email', { oldPassword: oldPwd, newEmail, verifyToken: vRes.token })
        if (res.ok) {
          showSettingsMsg('changeEmailMsg', '邮箱已更换', 'ok')
          state.user.email = newEmail
          localStorage.setItem('ws_user', JSON.stringify(state.user))
          setTimeout(() => renderProfile(), 1500)
        } else {
          showSettingsMsg('changeEmailMsg', res.error || '更换失败', 'err')
        }
      } catch {
        showSettingsMsg('changeEmailMsg', '更换失败', 'err')
      }
      changeEmailBtn.disabled = false
      changeEmailBtn.textContent = '确认更换'
    })
  }

  // Change phone: toggle form
  const changePhoneToggle = document.getElementById('changePhoneToggle')
  if (changePhoneToggle) {
    changePhoneToggle.addEventListener('click', () => {
      const form = document.getElementById('changePhoneForm')
      const isHidden = form.style.display === 'none'
      form.style.display = isHidden ? 'block' : 'none'
      changePhoneToggle.textContent = isHidden ? '收起' : '更换'
    })
  }

  // Change phone: send code
  const changePhoneSendBtn = document.getElementById('changePhoneSendCode')
  if (changePhoneSendBtn) {
    changePhoneSendBtn.addEventListener('click', async () => {
      const newPhone = document.getElementById('changePhoneInput')?.value?.trim()
      if (!newPhone || newPhone.length < 6) { showSettingsMsg('changePhoneMsg', '请输入有效手机号', 'err'); return }
      changePhoneSendBtn.disabled = true
      changePhoneSendBtn.textContent = '发送中...'
      try {
        const captchaRes = await api.get('/api/captcha')
        if (!captchaRes.ok) { showSettingsMsg('changePhoneMsg', '图形验证码加载失败', 'err'); changePhoneSendBtn.disabled = false; changePhoneSendBtn.textContent = '发送验证码'; return }
        showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
          try {
            const res = await api.post('/api/send-code', {
              phone: newPhone,
              purpose: 'change_phone',
              captchaId,
              captchaAnswer: captchaCode,
            })
            if (res.ok) {
              closeModal()
              showSettingsMsg('changePhoneMsg', '验证码已发送', 'ok')
              document.getElementById('changePhoneCodeGroup').style.display = 'block'
              document.getElementById('changePhoneBtn').style.display = 'block'
              let cd = 60
              const timer = setInterval(() => {
                cd--
                changePhoneSendBtn.textContent = `${cd}s`
                if (cd <= 0) { clearInterval(timer); changePhoneSendBtn.textContent = '发送验证码'; changePhoneSendBtn.disabled = false }
              }, 1000)
            } else if (res.error && res.error.includes('验证码')) {
              handleCaptchaError(res, modalOverlay)
              changePhoneSendBtn.disabled = false
              changePhoneSendBtn.textContent = '发送验证码'
            } else {
              closeModal()
              showSettingsMsg('changePhoneMsg', res.error || '发送失败', 'err')
              changePhoneSendBtn.disabled = false
              changePhoneSendBtn.textContent = '发送验证码'
            }
          } catch {
            closeModal()
            showSettingsMsg('changePhoneMsg', '发送失败', 'err')
            changePhoneSendBtn.disabled = false
            changePhoneSendBtn.textContent = '发送验证码'
          }
        })
      } catch {
        showSettingsMsg('changePhoneMsg', '图形验证码加载失败', 'err')
        changePhoneSendBtn.disabled = false
        changePhoneSendBtn.textContent = '发送验证码'
      }
    })
  }

  // Change phone: confirm
  const changePhoneBtn = document.getElementById('changePhoneBtn')
  if (changePhoneBtn) {
    changePhoneBtn.addEventListener('click', async () => {
      const oldPwd = document.getElementById('changePhoneOldPwd')?.value
      const newPhone = document.getElementById('changePhoneInput')?.value?.trim()
      const code = document.getElementById('changePhoneCode')?.value?.trim()
      if (!oldPwd) { showSettingsMsg('changePhoneMsg', '请输入原密码', 'err'); return }
      if (!newPhone || newPhone.length < 6) { showSettingsMsg('changePhoneMsg', '请输入有效手机号', 'err'); return }
      if (!code || code.length !== 6) { showSettingsMsg('changePhoneMsg', '请输入6位验证码', 'err'); return }
      changePhoneBtn.disabled = true
      changePhoneBtn.textContent = '更换中...'
      try {
        const vRes = await api.post('/api/verify-code', {
          phone: newPhone,
          code,
          purpose: 'change_phone',
        })
        if (!vRes.ok) { showSettingsMsg('changePhoneMsg', vRes.error || '验证码错误', 'err'); changePhoneBtn.disabled = false; changePhoneBtn.textContent = '确认更换'; return }
        const res = await api.post('/api/change-phone', { oldPassword: oldPwd, newPhone, verifyToken: vRes.token })
        if (res.ok) {
          showSettingsMsg('changePhoneMsg', '手机号已更换', 'ok')
          state.user.phone = newPhone
          localStorage.setItem('ws_user', JSON.stringify(state.user))
          setTimeout(() => renderProfile(), 1500)
        } else {
          showSettingsMsg('changePhoneMsg', res.error || '更换失败', 'err')
        }
      } catch {
        showSettingsMsg('changePhoneMsg', '更换失败', 'err')
      }
      changePhoneBtn.disabled = false
      changePhoneBtn.textContent = '确认更换'
    })
  }

  // Go to membership page link
  const goMem = document.getElementById('goMembershipPage')
  if (goMem) {
    goMem.addEventListener('click', () => navigate('membership'))
  }

  // Upgrade buttons (USDT payment)
  mainContent.querySelectorAll('.sub-plan-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.user) { showAuthModal('login_password'); return }
      const plan = btn.dataset.plan || 'plus'
      initiateCryptoPayment(plan, 'monthly')
    })
  })

  // Load billing history
  const billingEl = document.getElementById('billingHistory')
  if (billingEl) {
    loadBillingHistory(billingEl)
  }

  const creditCenterEl = document.getElementById('subscriptionCreditCenter')
  if (creditCenterEl) {
    loadSubscriptionCreditCenter(creditCenterEl)
  }

  getPlanPrices().then(prices => {
    const fmt = (dollars) => '$' + Math.round(dollars) + '/月'
    const plusEl = document.querySelector('.sub-plan-price-plus')
    const proEl = document.querySelector('.sub-plan-price-pro')
    if (plusEl && prices.plus) plusEl.textContent = fmt(prices.plus.month?.current || 50)
    if (proEl && prices.pro) proEl.textContent = fmt(prices.pro.month?.current || 100)
  })

  const forumNotificationsEl = document.getElementById('forumNotificationsList')
  if (forumNotificationsEl) {
    loadForumNotifications(forumNotificationsEl)
  }

  const forumReadAllBtn = document.getElementById('forumReadAllBtn')
  if (forumReadAllBtn) {
    forumReadAllBtn.addEventListener('click', async () => {
      forumReadAllBtn.disabled = true
      forumReadAllBtn.textContent = '处理中...'
      try {
        const res = await api.patch('/api/notifications', { markAll: true })
        if (res.ok) {
          state.notificationUnread = res.unreadCount || 0
          updateAuthUI()
          renderProfile()
        } else {
          showToast(res.error || '操作失败', 'error')
        }
      } catch {
        showToast('操作失败，请稍后重试', 'error')
      }
      forumReadAllBtn.disabled = false
      forumReadAllBtn.textContent = '全部已读'
    })
  }

  // Signal push: upgrade button
  const signalUpBtn = document.getElementById('signalGoUpgrade')
  if (signalUpBtn) {
    signalUpBtn.addEventListener('click', () => navigate('membership'))
  }

  // Signal push: get Telegram invite link
  const signalInvBtn = document.getElementById('signalGetInvite')
  if (signalInvBtn) {
    signalInvBtn.addEventListener('click', async () => {
      const msgDiv = document.getElementById('signalMsg')
      signalInvBtn.disabled = true
      signalInvBtn.textContent = '生成中...'
      try {
        const res = await api.post('/api/telegram-entry')
        if (res.success && res.botUrl) {
          window.open(res.botUrl, '_blank', 'noopener')
          if (msgDiv) {
            const bindingHint = state.user?.telegramBinding
              ? '请务必使用当前已绑定的 Telegram 账号打开机器人，否则机器人会拒绝发链。'
              : '在机器人里点 Start 后，它会给你发送专属入群链接。'
            msgDiv.innerHTML = '机器人入口已生成（' + escapeHtml(String(res.expiresInSeconds || 600)) + ' 秒内有效）：<a href="' + escapeHtml(res.botUrl) + '" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600;text-decoration:underline;word-break:break-all;">点击打开 Telegram 机器人</a><br>' + escapeHtml(bindingHint)
            msgDiv.className = 'signal-msg signal-msg-ok'
            msgDiv.style.display = 'block'
          }
          signalInvBtn.textContent = '已生成'
          setTimeout(() => { signalInvBtn.textContent = getTelegramEntryButtonLabel(state.user); signalInvBtn.disabled = false }, 10000)
        } else {
          if (msgDiv) { msgDiv.textContent = res.error || '生成失败'; msgDiv.className = 'signal-msg signal-msg-err'; msgDiv.style.display = 'block' }
          signalInvBtn.disabled = false
          signalInvBtn.textContent = getTelegramEntryButtonLabel(state.user)
        }
      } catch {
        if (msgDiv) { msgDiv.textContent = '生成失败，请稍后重试'; msgDiv.className = 'signal-msg signal-msg-err'; msgDiv.style.display = 'block' }
        signalInvBtn.disabled = false
        signalInvBtn.textContent = getTelegramEntryButtonLabel(state.user)
      }
    })
  }

  const signalRefreshBtn = document.getElementById('signalRefreshStatus')
  if (signalRefreshBtn) {
    signalRefreshBtn.addEventListener('click', async () => {
      const msgDiv = document.getElementById('signalMsg')
      signalRefreshBtn.disabled = true
      signalRefreshBtn.textContent = '刷新中...'
      try {
        const user = await refreshCurrentUserProfile({ rerender: true, syncTelegram: true })
        const nextMsgDiv = document.getElementById('signalMsg')
        if (user && nextMsgDiv) {
          nextMsgDiv.textContent = `状态已刷新，当前绑定：${getTelegramBindingLabel(user.telegramBinding)}`
          nextMsgDiv.className = 'signal-msg signal-msg-ok'
          nextMsgDiv.style.display = 'block'
        } else if (msgDiv) {
          msgDiv.textContent = '状态已刷新'
          msgDiv.className = 'signal-msg signal-msg-ok'
          msgDiv.style.display = 'block'
        }
      } catch {
        if (msgDiv) {
          msgDiv.textContent = '刷新失败，请稍后重试'
          msgDiv.className = 'signal-msg signal-msg-err'
          msgDiv.style.display = 'block'
        }
      }
      const latestRefreshBtn = document.getElementById('signalRefreshStatus')
      if (latestRefreshBtn) {
        latestRefreshBtn.disabled = false
        latestRefreshBtn.textContent = '刷新状态'
      }
    })
  }

}

const BILLING_PAGE_SIZE = 6
let _billingPage = 1

async function loadBillingHistory(container, page = 1) {
  try {
    const data = await api.get('/api/orders')

    if (!data.orders || data.orders.length === 0) {
      container.innerHTML = '<div class="billing-empty">暂无账单记录</div>'
      return
    }

    const statusMap = {
      paid: { label: '已完成', cls: 'billing-paid' },
      pending: { label: '待支付', cls: 'billing-pending' },
      expired: { label: '已过期', cls: 'billing-expired' },
      cancelled: { label: '已取消', cls: 'billing-expired' },
    }

        const planNames = { plus: 'Plus', pro: 'Pro' }
    const periodNames = { month: '月付', year: '年付', lifetime: '终身' }

    const total = data.orders.length
    const totalPages = Math.ceil(total / BILLING_PAGE_SIZE)
    _billingPage = Math.max(1, Math.min(page, totalPages))
    const start = (_billingPage - 1) * BILLING_PAGE_SIZE
    const pageOrders = data.orders.slice(start, start + BILLING_PAGE_SIZE)

    let html = pageOrders.map(o => {
      const s = statusMap[o.status] || { label: o.status, cls: '' }
      const date = o.paidAt || o.createdAt || ''
      const displayDate = formatDateTime(date)
      const paidAmount = o.amountConfirmed || o.amount
      const planLabel = planNames[o.plan] || o.planLabel || o.plan
      const periodLabel = periodNames[o.period] || o.periodLabel || ''
      const orderIdShort = o.orderId ? o.orderId.substring(0, 8) : ''
      return `
        <div class="billing-row">
          <div class="billing-info">
            <div class="billing-plan">${planLabel} ${periodLabel}</div>
            <div class="billing-date">${displayDate}${orderIdShort ? ` · <span class="billing-oid" title="${o.orderId}">#${orderIdShort}</span>` : ''}</div>
          </div>
          <div class="billing-right">
            <span class="billing-amount">${formatUsdAmount(paidAmount)}</span>
            <span class="billing-status ${s.cls}">${s.label}</span>
          </div>
        </div>`
    }).join('')

    if (totalPages > 1) {
      html += `<div class="billing-pagination">
        <button class="btn btn-sm" ${_billingPage <= 1 ? 'disabled' : ''} onclick="window._billingPrev()">上一页</button>
        <span>${_billingPage} / ${totalPages}</span>
        <button class="btn btn-sm" ${_billingPage >= totalPages ? 'disabled' : ''} onclick="window._billingNext()">下一页</button>
      </div>`
    }

    container.innerHTML = html

    window._billingPrev = () => loadBillingHistory(container, _billingPage - 1)
    window._billingNext = () => loadBillingHistory(container, _billingPage + 1)
  } catch (err) {
    console.error('Load billing error:', err)
    container.innerHTML = '<div class="billing-empty">加载失败</div>'
  }
}


async function loadSubscriptionCreditCenter(container) {
  try {
    const res = await api.get('/api/referrals/me')
    if (!res.ok || !res.stats) {
      container.innerHTML = `<div class="billing-empty">${escapeHtml(res.error || '加载失败')}</div>`
      return
    }
    const stats = res.stats
    const recent = Array.isArray(res.recent_commissions) ? res.recent_commissions : []
    const invited = Array.isArray(res.recent_invited_users) ? res.recent_invited_users : []
    if (false && res.disabled) {
      if (res.mode === 'disabled') {
        container.innerHTML = '<div class="billing-empty">邀请返佣功能暂未开放</div>'
        return
      }
      container.innerHTML = `
        <div class="subscription-credit-link-card subscription-credit-disabled" data-referral-disabled="1">
          <div>
            <div class="subscription-credit-label">我的邀请链接</div>
            <div class="subscription-credit-link">正式开放后生成专属邀请链接</div>
          </div>
          <button class="btn btn-primary btn-sm" id="copyReferralLink" disabled>复制链接</button>
        </div>
        <div class="subscription-credit-preview-note">
          <strong>邀请返佣功能即将开放</strong>
          <span>当前仅展示功能说明，暂未开放使用。正式开放后，可通过邀请好友获得返佣奖励。</span>
        </div>
        <div class="subscription-credit-grid">
          <div class="subscription-credit-stat"><span>邀请人数</span><strong>0</strong></div>
          <div class="subscription-credit-stat"><span>付费邀请</span><strong>0</strong></div>
          <div class="subscription-credit-stat"><span>待确认返佣</span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>可用返佣</span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>处理中返佣</span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>已使用返佣</span><strong>$0.00</strong></div>
        </div>
        <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近返佣记录</h3><div class="billing-empty">功能开放后展示返佣记录</div></div>
        <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近邀请用户</h3><div class="billing-empty">功能开放后展示邀请用户</div></div>`
      container.querySelector('[data-referral-disabled]')?.addEventListener('click', () => showFormMsgProfile(res.message || '邀请返佣功能暂未开放', 'ok'))
      return
    }
    container.innerHTML = `
      <div class="subscription-credit-link-card">
        <div>
          <div class="subscription-credit-label">我的邀请链接</div>
          <div class="subscription-credit-link" title="${escapeHtml(res.referral_link)}">${escapeHtml(res.referral_link)}</div>
        </div>
        <button class="btn btn-primary btn-sm" id="copyReferralLink">复制链接</button>
      </div>
      <div class="subscription-credit-grid">
        <div class="subscription-credit-stat"><span>邀请人数</span><strong>${Number(stats.invited_count || 0)}</strong></div>
        <div class="subscription-credit-stat"><span>付费邀请</span><strong>${Number(stats.paid_invited_count || 0)}</strong></div>
        <div class="subscription-credit-stat"><span>待确认返佣</span><strong>${formatUsdAmount(stats.pending_credit_amount)}</strong></div>
        <div class="subscription-credit-stat"><span>可用返佣</span><strong>${formatUsdAmount(stats.available_credit_amount)}</strong></div>
        <div class="subscription-credit-stat"><span>处理中返佣</span><strong>${formatUsdAmount(stats.reserved_credit_amount)}</strong></div>
        <div class="subscription-credit-stat"><span>已使用返佣</span><strong>${formatUsdAmount(stats.used_credit_amount)}</strong></div>
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近返佣记录</h3>
        ${recent.length ? `<div class="subscription-credit-list">${recent.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.plan_label || '')}</strong><div class="billing-date">${formatDateTime(item.created_at) || ''} · ${escapeHtml(item.invited_user?.email_masked || '已邀请用户')}</div></div><div class="subscription-credit-row-right"><span>${formatUsdAmount(item.commission_amount)}</span><em>${escapeHtml(item.status_label || item.status || '')}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">暂无返佣记录</div>'}
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近邀请用户</h3>
        ${invited.length ? `<div class="subscription-credit-list">${invited.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.email_masked || item.uid || '已邀请用户')}</strong><div class="billing-date">${formatDateTime(item.attributed_at) || ''}</div></div><div class="subscription-credit-row-right"><span>${item.paid ? '已订阅' : '未订阅'}</span><em>${formatUsdAmount(item.credit_amount)}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">暂无邀请用户</div>'}
      </div>`
    container.querySelector('#copyReferralLink')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(res.referral_link); showFormMsgProfile('邀请链接已复制', 'ok') }
      catch { showFormMsgProfile('复制失败，请手动复制链接', 'err') }
    })
  } catch (err) {
    console.error('Load subscription credit center error:', err)
    container.innerHTML = '<div class="billing-empty">加载失败</div>'
  }
}

function getNotificationText(notification) {
  if (notification.type === 'reply_quote') {
    return {
      title: '有人引用了你的回复',
      subtitle: notification.meta?.excerpt || notification.postTitle || '去看看新的引用内容',
    }
  }
  if (notification.type === 'system') {
    return {
      title: notification.title || '系统通知',
      subtitle: notification.message || '',
    }
  }
  return {
    title: '你的帖子有了新回复',
    subtitle: notification.meta?.excerpt || notification.postTitle || '去看看新的讨论内容',
  }
}

async function loadForumNotifications(container) {
  try {
    const res = await api.get('/api/notifications?limit=20')
    if (!res.ok || !Array.isArray(res.notifications)) {
      container.innerHTML = '<div class="billing-empty">加载失败</div>'
      return
    }

    state.notificationUnread = res.unreadCount || 0
    updateAuthUI()

    if (!res.notifications.length) {
      container.innerHTML = '<div class="billing-empty">暂时还没有论坛通知</div>'
      return
    }

    container.innerHTML = res.notifications.map(notification => {
      const text = getNotificationText(notification)
      return `
        <button class="forum-notification-item ${notification.isRead ? '' : 'unread'}" data-open-forum-notification="${notification.postId || ''}" data-notification-id="${notification.id}">
          <div class="forum-notification-avatar">
            ${notification.actor?.avatar ? `<img src="${escapeHtml(notification.actor.avatar)}" class="avatar-img">` : escapeHtml((notification.actor?.name || '系').charAt(0).toUpperCase())}
          </div>
          <div class="forum-notification-content">
            <div class="forum-notification-title">${escapeHtml(text.title)}</div>
            <div class="forum-notification-subtitle">${escapeHtml(notification.actor?.name || '系统')} · ${escapeHtml(text.subtitle)}</div>
            <div class="forum-notification-time">${formatDateTime(notification.createdAt)}</div>
          </div>
          ${notification.isRead ? '' : '<span class="forum-notification-dot"></span>'}
        </button>
      `
    }).join('')

    container.querySelectorAll('[data-open-forum-notification]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const notificationId = btn.dataset.notificationId
        if (notificationId) {
          const res = await api.patch('/api/notifications', { id: notificationId })
          btn.classList.remove('unread')
          const dot = btn.querySelector('.forum-notification-dot')
          if (dot) dot.remove()
          if (res.ok) {
            state.notificationUnread = res.unreadCount || 0
            updateAuthUI()
            const headEl = document.querySelector('.forum-notifications-unread')
            if (headEl) headEl.textContent = `未读 ${state.notificationUnread}`
          }
        }
        const postId = btn.dataset.openForumNotification
        if (postId) {
          state.currentPost = postId
          state.replyPage = 1
          navigate('post')
        }
      })
    })
  } catch (err) {
    console.error('Load forum notifications error:', err)
    container.innerHTML = '<div class="billing-empty">加载失败</div>'
  }
}

function showPwdMsg(el, msg, type) {
  if (!el) return
  el.style.display = 'block'
  el.textContent = msg
  el.className = `settings-msg settings-msg-${type}`
  setTimeout(() => { el.style.display = 'none' }, 3000)
}

function showSettingsMsg(elId, msg, type) {
  const el = document.getElementById(elId)
  if (el) {
    el.textContent = msg
    el.className = `settings-msg settings-msg-${type}`
    el.style.display = 'block'
    if (type === 'ok') setTimeout(() => { el.style.display = 'none' }, 4000)
  }
}

function handleCaptchaError(res, modalOverlay) {
  const errEl = modalOverlay.querySelector('.captcha-modal-body')
  const oldMsg = errEl.querySelector('.captcha-err-msg')
  if (oldMsg) oldMsg.remove()
  const msg = document.createElement('p')
  msg.className = 'captcha-err-msg'
  msg.style.cssText = 'color:#ef4444;font-size:13px;margin:8px 0 0;text-align:center'
  msg.textContent = res.error || '验证码错误'
  errEl.appendChild(msg)
  const inputEl = modalOverlay.querySelector('#captchaInput')
  if (inputEl) { inputEl.value = ''; inputEl.focus() }
  api.get('/api/captcha').then(r => {
    if (r.ok) {
      modalOverlay._captchaId = r.id
      modalOverlay.querySelector('#captchaImgWrap').innerHTML = r.svg
    }
  })
}

function showCaptchaModal(captchaId, svg, callback) {
  const overlay = document.createElement('div')
  overlay.className = 'captcha-modal-overlay'
  overlay.innerHTML = `
    <div class="captcha-modal">
      <div class="captcha-modal-header">
        <h3>图形验证</h3>
        <button class="captcha-modal-close" id="captchaModalClose">&times;</button>
      </div>
      <div class="captcha-modal-body">
        <div class="captcha-img-wrap" id="captchaImgWrap">${svg}</div>
        <button class="btn btn-ghost btn-sm" id="captchaRefreshBtn" style="margin-bottom:12px">刷新验证码</button>
        <div class="form-group">
          <input type="text" class="form-input" id="captchaInput" placeholder="请输入验证码" maxlength="4" autocomplete="off">
        </div>
      </div>
      <div class="captcha-modal-footer">
        <button class="btn btn-ghost" id="captchaCancelBtn">取消</button>
        <button class="btn btn-primary" id="captchaVerifyBtn">验证</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('active'))

  const close = () => {
    overlay.classList.remove('active')
    setTimeout(() => overlay.remove(), 300)
  }
  overlay.querySelector('#captchaModalClose').addEventListener('click', close)
  overlay.querySelector('#captchaCancelBtn').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  overlay.querySelector('#captchaRefreshBtn').addEventListener('click', async () => {
    const imgWrap = overlay.querySelector('#captchaImgWrap')
    const res = await api.get('/api/captcha')
    if (res.ok) {
      overlay._captchaId = res.id
      imgWrap.innerHTML = res.svg
    }
  })

  overlay.querySelector('#captchaVerifyBtn').addEventListener('click', () => {
    const code = overlay.querySelector('#captchaInput').value.trim()
    if (!code) return
    callback(overlay._captchaId || captchaId, code, close, overlay)
  })

  overlay.querySelector('#captchaInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#captchaVerifyBtn').click()
  })

  overlay._captchaId = captchaId
}

function getPasswordRuleError(password) {
  if (!password || password.length < 8 || password.length > 32) {
    return '密码长度需要 8-32 个字符'
  }
  if (!/[A-Z]/.test(password)) {
    return '密码需要包含至少一个大写字母'
  }
  if (!/[0-9]/.test(password)) {
    return '密码需要包含至少一个数字'
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return '密码需要包含至少一个特殊字符'
  }
  return null
}

function getAuthPasswordRuleError(password) {
  if (!password || password.length < 8 || password.length > 32) {
    return '密码长度需要 8-32 个字符'
  }
  if (!/[A-Za-z]/.test(password)) {
    return '密码需要包含至少一个字母'
  }
  if (!/[0-9]/.test(password)) {
    return '密码需要包含至少一个数字'
  }
  return null
}

function updateAuthPasswordValidation(form) {
  const passwordInput = form?.elements?.password
  const confirmInput = form?.elements?.confirmPassword
  const rulesHint = form?.querySelector('#pwdRules')
  const confirmHint = form?.querySelector('#confirmPasswordHint')
  if (!passwordInput || !rulesHint) return

  const password = passwordInput.value
  const passwordError = getAuthPasswordRuleError(password)
  if (!password) {
    rulesHint.textContent = '需满足：8-32 位，至少包含一个字母和一个数字'
    rulesHint.className = 'form-hint pwd-rules'
  } else if (passwordError) {
    rulesHint.textContent = passwordError
    rulesHint.className = 'form-hint pwd-rules form-hint-err'
  } else {
    rulesHint.textContent = '密码格式正确'
    rulesHint.className = 'form-hint pwd-rules form-hint-ok'
  }

  if (!confirmInput || !confirmHint) return
  if (!confirmInput.value) {
    confirmHint.textContent = ''
    confirmHint.className = 'form-hint'
  } else if (confirmInput.value !== password) {
    confirmHint.textContent = '两次输入的密码不一致'
    confirmHint.className = 'form-hint form-hint-err'
  } else {
    confirmHint.textContent = '两次输入的密码一致'
    confirmHint.className = 'form-hint form-hint-ok'
  }
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div')
  toast.className = `profile-toast profile-toast-${type === 'error' ? 'err' : type === 'success' ? 'ok' : 'ok'}`
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.classList.add('active'), 10)
  setTimeout(() => { toast.classList.remove('active'); setTimeout(() => toast.remove(), 300) }, 3000)
}

function showFormMsgProfile(msg, type) {
  showToast(msg, type === 'err' ? 'error' : 'success')
}

// Avatar upload with auto-compression
function compressImage(file, maxSize = 200, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      let w = img.width, h = img.height
      // Scale down to maxSize x maxSize
      if (w > maxSize || h > maxSize) {
        if (w > h) { h = Math.round(h * maxSize / w); w = maxSize }
        else { w = Math.round(w * maxSize / h); h = maxSize }
      }
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.src = url
  })
}

document.addEventListener('change', async (e) => {
  if (e.target.id === 'avatarInput' && e.target.files[0]) {
    const file = e.target.files[0]
    showFormMsgProfile('正在处理头像...', 'ok')
    const compressed = await compressImage(file, 200, 0.85)
    showFormMsgProfile('正在上传头像...', 'ok')

    try {
      await api.put('/api/profile', { avatar: compressed })
      state.user.avatar = compressed
      localStorage.setItem('ws_user', JSON.stringify(state.user))
      updateAuthUI()
      renderProfile()
      showFormMsgProfile('头像已更新', 'ok')
    } catch (err) {
      console.error('Avatar upload error:', err)
      showFormMsgProfile('头像上传失败，请重试', 'err')
    }
  }
})

// ===== Email Verification Helpers =====
const AUTH_MODE_META = {
  login_password: {
    title: '登录',
    submitLabel: '登录',
    codePurpose: null,
    passwordLabel: '密码',
    passwordPlaceholder: '请输入密码',
    accountLabel: '账号',
    accountPlaceholder: '邮箱或手机号',
  },
  login_code: {
    title: '验证码登录',
    submitLabel: '登录',
    codePurpose: 'login',
    showAccountInput: true,
    accountLabel: '账号',
    accountPlaceholder: '邮箱或手机号',
  },
  register: {
    title: '注册',
    submitLabel: '注册',
    codePurpose: 'register',
    passwordLabel: '密码',
    passwordPlaceholder: '8-32位，至少包含字母和数字',
    showPasswordRules: true,
    showConfirmPassword: true,
    showTos: true,
  },
  reset_password: {
    title: '忘记密码',
    submitLabel: '重置密码',
    codePurpose: 'reset',
    showAccountInput: true,
    accountLabel: '账号',
    accountPlaceholder: '邮箱或手机号',
    passwordLabel: '新密码',
    passwordPlaceholder: '8-32位，至少包含字母和数字',
    showPasswordRules: true,
    showConfirmPassword: true,
  },
}

function getAuthModeMeta(mode) {
  return AUTH_MODE_META[mode] || AUTH_MODE_META.login_password
}

function getCurrentAuthEmail() {
  return document.getElementById('authEmail')?.value?.trim() || ''
}

function clearAuthCodeTimer() {
  if (state._authCodeTimer) {
    clearInterval(state._authCodeTimer)
    state._authCodeTimer = null
  }
}

function renderAuthModeLinks(mode) {
  const { emailEnabled = true, phoneEnabled = true } = state.authMethods || {}

  if (mode === 'login_password') {
    const links = []
    if (emailEnabled && phoneEnabled) links.push('<a data-auth-mode="login_code">验证码登录</a>')
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'login_code') {
    const links = ['<a data-auth-mode="login_password">密码登录</a>']
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'reset_password') {
    return `<div class="auth-mode-links"><a data-auth-mode="login_password">返回登录</a></div>`
  }
  return ''
}

function renderAuthFooter(mode) {
  const { emailEnabled = true, phoneEnabled = true } = state.authMethods || {}
  if (mode === 'register' || mode === 'register_phone') {
    return '已有账号？<a data-auth-mode="login_password">立即登录</a>'
  }
  if (!emailEnabled && !phoneEnabled) return ''
  return '还没有账号？<a data-auth-mode="register">立即注册</a>'
}

async function handleSendCode() {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  const emailInput = document.getElementById('authEmail')
  const phoneInput = document.getElementById('authPhone')
  const loginIdInput = document.getElementById('authLoginId')
  const sendBtn = document.getElementById('sendCodeBtn')
  const codeGroup = document.getElementById('codeGroup')

  const isPhone = meta.phoneLogin || (meta.codePurpose === 'register' && state.authRegType === 'phone')

  let email = emailInput?.value?.trim() || ''
  let phone = ''
  const phonePrefix = document.getElementById('authPhonePrefix')?.value || '+86'

  if (meta.showAccountInput && loginIdInput) {
    const loginId = loginIdInput.value.trim()
    const isPhoneId = /^(\+?\d{1,3})?\d{7,15}$/.test(loginId.replace(/\s/g, ''))
    if (isPhoneId) {
      phone = loginId.startsWith('+') ? loginId : '+86' + loginId
      email = ''
    } else {
      email = loginId
    }
  } else if (isPhone) {
    const phoneRaw = phoneInput?.value?.trim()
    phone = phoneRaw ? phonePrefix + phoneRaw : ''
  }

  if (isPhone || phone) {
    if (!phone || phone.length < 8) {
      showFormMsg('请先输入有效的手机号', 'err')
      return
    }
  } else {
    if (!email || !email.includes('@')) {
      showFormMsg('请先输入有效的邮箱地址', 'err')
      return
    }
  }

  if (state._codeSending) return

  // Show CAPTCHA first
  try {
    const captchaRes = await api.get('/api/captcha')
    if (!captchaRes.ok) {
      showFormMsg('获取验证码失败，请稍后重试', 'err')
      return
    }

    showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode, closeModal, modalOverlay) => {
      state._codeSending = true
      sendBtn.textContent = '发送中...'
      sendBtn.disabled = true

      try {
        const payload = { purpose: meta.codePurpose, captchaId, captchaAnswer: captchaCode }
        if (isPhone || phone) {
          payload.phone = phone
        } else {
          payload.email = email
        }
        const res = await api.post('/api/send-code', payload)

        if (!res.ok) {
          if (res.error && res.error.includes('验证码')) {
            handleCaptchaError(res, modalOverlay)
            state._codeSending = false
            sendBtn.textContent = '发送验证码'
            sendBtn.disabled = false
            return
          }
          showFormMsg(res.error || '发送失败，请稍后重试', 'err')
          closeModal()
          sendBtn.textContent = '发送验证码'
          sendBtn.disabled = false
          state._codeSending = false
          return
        }

        closeModal()
        // Show code input group
        if (codeGroup) codeGroup.style.display = 'block'
        showFormMsg(res.message || (isPhone ? '验证码已发送到您的手机' : '验证码已发送到您的邮箱'), 'ok')
        state._emailVerified = false
        state._verifyToken = null

        // Lock input after sending
        const lockInput = isPhone ? phoneInput : emailInput
        if (lockInput) {
          lockInput.readOnly = true
          lockInput.style.opacity = '0.7'
        }

        // Start 60s countdown
        clearAuthCodeTimer()
        state._codeCountdown = 120
        state._authCodeTimer = setInterval(() => {
          state._codeCountdown--
          if (state._codeCountdown <= 0) {
            clearAuthCodeTimer()
            sendBtn.textContent = '重新发送'
            sendBtn.disabled = false
            state._codeSending = false
          } else {
            sendBtn.textContent = `${state._codeCountdown}s`
          }
        }, 1000)

      } catch (err) {
        closeModal()
        showFormMsg('网络错误，请检查网络后重试', 'err')
        sendBtn.textContent = '发送验证码'
        sendBtn.disabled = false
        state._codeSending = false
      }
    })
  } catch (err) {
    showFormMsg('获取验证码失败，请稍后重试', 'err')
  }
}

async function handleCodeVerify(code) {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  const emailInput = document.getElementById('authEmail')
  const phoneInput = document.getElementById('authPhone')
  const loginIdInput = document.getElementById('authLoginId')
  const codeStatus = document.getElementById('codeStatus')
  const codeHint = document.getElementById('codeHint')

  const isPhone = meta.phoneLogin || (meta.codePurpose === 'register' && state.authRegType === 'phone')

  let email = emailInput?.value?.trim() || ''
  let phone = ''
  const phonePrefix = document.getElementById('authPhonePrefix')?.value || '+86'

  if (meta.showAccountInput && loginIdInput) {
    const loginId = loginIdInput.value.trim()
    const isPhoneId = /^(\+?\d{1,3})?\d{7,15}$/.test(loginId.replace(/\s/g, ''))
    if (isPhoneId) {
      phone = loginId.startsWith('+') ? loginId : '+86' + loginId
      email = ''
    } else {
      email = loginId
    }
  } else if (isPhone) {
    const phoneRaw = phoneInput?.value?.trim()
    phone = phoneRaw ? phonePrefix + phoneRaw : ''
  }

  if (!code || code.length !== 6) return
  if (!isPhone && !phone && !email) return

  if (codeStatus) { codeStatus.textContent = '...'; codeStatus.className = 'code-status' }

  try {
    const payload = { code, purpose: meta.codePurpose }
    if (isPhone || phone) {
      payload.phone = phone
    } else {
      payload.email = email
    }
    const res = await api.post('/api/verify-code', payload)

    if (res.ok) {
      state._emailVerified = true
      state._verifyToken = res.token
      if (codeStatus) { codeStatus.textContent = '✓'; codeStatus.className = 'code-status code-status-ok' }
      if (codeHint) { codeHint.textContent = (isPhone || phone) ? '手机验证成功' : '邮箱验证成功'; codeHint.className = 'form-hint form-hint-ok' }
    } else {
      state._emailVerified = false
      state._verifyToken = null
      if (codeStatus) { codeStatus.textContent = '✗'; codeStatus.className = 'code-status code-status-err' }
      if (codeHint) { codeHint.textContent = res.error || '验证码错误'; codeHint.className = 'form-hint form-hint-err' }
    }
  } catch (err) {
    console.error('Verify error:', err)
    state._emailVerified = false
    state._verifyToken = null
    if (codeStatus) { codeStatus.textContent = '✗'; codeStatus.className = 'code-status code-status-err' }
    if (codeHint) { codeHint.textContent = '验证失败，请重试'; codeHint.className = 'form-hint form-hint-err' }
  }
}

function showFormMsg(msg, type) {
  const el = document.getElementById('formMsg')
  if (el) {
    el.textContent = msg
    el.className = `form-msg form-msg-${type}`
    el.style.display = 'block'
    if (type === 'ok') setTimeout(() => { el.style.display = 'none' }, 4000)
  }
}

async function loadAuthMethods() {
  try {
    const res = await api.get('/api/auth-methods')
    if (res.ok) {
      state.authMethods = { emailEnabled: res.emailEnabled, phoneEnabled: res.phoneEnabled }
    }
  } catch (e) { /* ignore */ }
}

function showAuthModal(mode, options = {}) {
  const meta = getAuthModeMeta(mode)
  const prefillEmail = (options.email ?? getCurrentAuthEmail() ?? state.authPrefillEmail ?? '').trim()
  const hasNextUrl = Object.prototype.hasOwnProperty.call(options, 'nextUrl')
  const referralCode = mode === 'register'
    ? normalizeReferralDisplayCode(options.referralCode || state.referralInviteCode)
    : ''

  state.authMode = mode
  if (mode === 'register') {
    state.authRegType = state.authRegType || 'email'
  } else {
    state.authRegType = 'email'
  }
  loadAuthMethods()
  state.authPrefillEmail = prefillEmail
  if (referralCode) state.referralInviteCode = referralCode
  if (hasNextUrl) {
    state.authRedirectAfterLogin = getSafeLoginReturnPath(options.nextUrl)
  } else if (!options.preserveRedirect) {
    state.authRedirectAfterLogin = null
  }
  modalTitle.textContent = meta.title

  // Reset verification state
  clearAuthCodeTimer()
  state._emailVerified = false
  state._verifyToken = null
  state._codeSending = false
  state._codeCountdown = 0

  const { emailEnabled = true, phoneEnabled = true } = state.authMethods || {}
  modalBody.innerHTML = `
    <form id="authForm">
      <div class="form-msg" id="formMsg" style="display:none"></div>
      ${mode === 'register' && referralCode ? `
        <div class="auth-referral-box">
          <label class="form-label">邀请码</label>
          <input type="text" class="form-input auth-referral-code" value="${escapeHtml(referralCode)}" readonly aria-readonly="true" tabindex="-1">
          <p class="form-hint">该邀请码来自邀请链接，注册后由后端自动归因，不能修改。</p>
        </div>
      ` : ''}
      ${meta.codePurpose === 'register' && emailEnabled && phoneEnabled ? `
        <div class="auth-reg-tabs">
          <button type="button" class="auth-reg-tab ${state.authRegType === 'phone' ? 'active' : ''}" data-reg-type="phone">手机号注册</button>
          <button type="button" class="auth-reg-tab ${state.authRegType !== 'phone' ? 'active' : ''}" data-reg-type="email">邮箱注册</button>
        </div>
      ` : ''}
      ${state.authRegType === 'phone' && meta.codePurpose === 'register' && phoneEnabled ? `
        <div class="form-group">
          <label class="form-label">手机号</label>
          ${meta.codePurpose ? `
            <div class="form-row">
              <div class="phone-input-wrap">
                <select class="form-select phone-prefix" name="phonePrefix" id="authPhonePrefix">
                  <option value="+86">+86</option>
                </select>
                <input type="tel" class="form-input form-input-phone" name="phone" id="authPhone" required placeholder="请输入手机号">
              </div>
              <button type="button" class="btn-send-code" id="sendCodeBtn">发送验证码</button>
            </div>
          ` : `
            <div class="phone-input-wrap">
              <select class="form-select phone-prefix" name="phonePrefix" id="authPhonePrefix">
                <option value="+86">+86</option>
              </select>
              <input type="tel" class="form-input form-input-phone" name="phone" id="authPhone" required placeholder="请输入手机号">
            </div>
          `}
        </div>
      ` : meta.showAccountInput ? `
        <div class="form-group">
          <label class="form-label">${meta.accountLabel || '账号'}</label>
          ${meta.codePurpose ? `
            <div class="form-row">
              <input type="text" class="form-input" name="loginId" id="authLoginId" required placeholder="${meta.accountPlaceholder || '邮箱或手机号'}" value="${escapeHtml(prefillEmail)}">
              <button type="button" class="btn-send-code" id="sendCodeBtn">发送验证码</button>
            </div>
          ` : `
            <input type="text" class="form-input" name="loginId" id="authLoginId" required placeholder="${meta.accountPlaceholder || '邮箱或手机号'}" value="${escapeHtml(prefillEmail)}">
          `}
        </div>
      ` : mode === 'login_password' ? `
        <div class="form-group">
          <label class="form-label">${meta.accountLabel || '账号'}</label>
          <input type="text" class="form-input" name="loginId" id="authLoginId" required placeholder="${meta.accountPlaceholder || '邮箱或手机号'}" value="${escapeHtml(prefillEmail)}">
        </div>
      ` : meta.phoneLogin ? `
        <div class="form-group">
          <label class="form-label">手机号</label>
          ${meta.codePurpose ? `
            <div class="form-row">
              <div class="phone-input-wrap">
                <select class="form-select phone-prefix" name="phonePrefix" id="authPhonePrefix">
                  <option value="+86">+86</option>
                </select>
                <input type="tel" class="form-input form-input-phone" name="phone" id="authPhone" required placeholder="请输入手机号">
              </div>
              <button type="button" class="btn-send-code" id="sendCodeBtn">发送验证码</button>
            </div>
          ` : `
            <div class="phone-input-wrap">
              <select class="form-select phone-prefix" name="phonePrefix" id="authPhonePrefix">
                <option value="+86">+86</option>
              </select>
              <input type="tel" class="form-input form-input-phone" name="phone" id="authPhone" required placeholder="请输入手机号">
            </div>
          `}
        </div>
      ` : `
        <div class="form-group">
          <label class="form-label">邮箱</label>
          ${meta.codePurpose ? `
            <div class="form-row">
              <input type="email" class="form-input" name="email" id="authEmail" required placeholder="请输入邮箱" value="${escapeHtml(prefillEmail)}">
              <button type="button" class="btn-send-code" id="sendCodeBtn">发送验证码</button>
            </div>
          ` : `
            <input type="email" class="form-input" name="email" id="authEmail" required placeholder="请输入邮箱" value="${escapeHtml(prefillEmail)}">
          `}
        </div>
      `}
      ${(mode === 'register' || mode === 'register_phone') && !(state.authRegType === 'phone' && phoneEnabled && emailEnabled) ? `
        <div class="form-group">
          <label class="form-label">昵称</label>
          <input type="text" class="form-input" name="nickname" id="authNickname" placeholder="给自己取个名字（选填）">
        </div>
      ` : ''}
      ${state.authRegType === 'phone' && phoneEnabled && emailEnabled ? `
        <div class="form-group">
          <label class="form-label">昵称</label>
          <input type="text" class="form-input" name="nickname" id="authNickname" placeholder="给自己取个名字（选填）">
        </div>
      ` : ''}
      ${meta.codePurpose && mode !== 'login_password' ? `
        <div class="form-group" id="codeGroup" style="display:none">
          <label class="form-label">验证码</label>
          <div class="code-input-wrap">
            <input type="text" class="form-input form-input-code" name="code" placeholder="请输入6位验证码" maxlength="6" inputmode="numeric" id="codeInput" autocomplete="one-time-code">
            <span class="code-status" id="codeStatus"></span>
          </div>
          <p class="form-hint" id="codeHint"></p>
        </div>
      ` : ''}
      ${meta.passwordLabel ? `
        <div class="form-group">
          <label class="form-label">${meta.passwordLabel}</label>
          <input type="password" class="form-input" name="password" ${mode === 'login_password' ? 'required' : ''} placeholder="${meta.passwordPlaceholder}">
          ${meta.showPasswordRules ? '<p class="form-hint pwd-rules" id="pwdRules" aria-live="polite">需满足：8-32 位，至少包含一个字母和一个数字</p>' : ''}
        </div>
      ` : ''}
      ${meta.showConfirmPassword ? `
        <div class="form-group">
          <label class="form-label">确认密码</label>
          <input type="password" class="form-input" name="confirmPassword" required placeholder="请再次输入密码">
          <p class="form-hint" id="confirmPasswordHint" aria-live="polite"></p>
        </div>
      ` : ''}
      ${meta.showTos ? `
        <label class="tos-check">
          <input type="checkbox" id="tosAgree">
          <span>我已阅读并同意 <a class="tos-link" id="openTos">《用户服务协议》</a></span>
        </label>
      ` : ''}
      ${renderAuthModeLinks(mode)}
      <button type="submit" class="btn btn-primary btn-lg form-submit">${meta.submitLabel}</button>
      <div class="form-footer">
        ${renderAuthFooter(mode)}
      </div>
    </form>
  `

  modalOverlay.classList.add('active')
  if (options.message) {
    showFormMsg(options.message, options.messageType || 'ok')
  }
}

function closeModal() {
  clearAuthCodeTimer()
  modalOverlay.classList.remove('active')
}

function persistAuthSession(result, { syncProgress = false } = {}) {
  localStorage.setItem('ws_token', result.token)
  setAuthCookie(result.token)
  state.user = result.user
  localStorage.setItem('ws_user', JSON.stringify(state.user))
  const redirectAfterLogin = state.authRedirectAfterLogin
  state.authRedirectAfterLogin = null
  state.referralInviteCode = ''
  updateAuthUI()
  refreshNotificationUnread()
  startPresenceHeartbeat()
  closeModal()
  void checkMembershipExpiryReminder()

  if (redirectAfterLogin) {
    if (syncProgress) progress.syncFromServer().catch(() => {})
    window.location.assign(redirectAfterLogin)
    return
  }

  // Always re-render immediately after login, regardless of sync progress result
  renderView()

  if (syncProgress) {
    progress.syncFromServer().then(() => { renderView() }).catch(() => {})
  }

}

// ===== Trade Records View =====
function renderTrades() {
  const adminUser = isAdmin()
  // UI-only flag: server independently verifies before returning any data


  const tradeTimeline = [
    { date: '2025年10月底', text: '黄金3900看涨4240，完美。', links: ['https://t.co/EQi8J3DsVT'], result: 'win' },
    { date: '2025年10月底', text: '4240做空4280止损，后续4400-5500主升浪踏空。', links: [], result: 'loss' },
    { date: '2026年1月底', text: '白银99刀时明确发文不能买入黄金白银，白银2年内要回到50。', links: ['https://t.co/FhjDzyxqxj'], result: 'win' },
    { date: '2026年1月底', text: '手把手118做空白银，盈利60万刀。', links: ['https://t.co/Ufd06Tmol8', 'https://t.co/88zb1axEGn', 'https://t.co/jzMJM35nvp'], result: 'win' },
    { date: '2026年2月2日', text: '转向黄金多头，认为要反弹到VWAP，到位平多。', links: ['https://t.co/TwZ8EZK7lD', 'https://t.co/FXmGZxeFcA'], result: 'win' },
    { date: '2026年2月5日', text: '刻舟求剑寻找白银78-88，黄金5100-5300机会。', links: ['https://t.co/Szd8T1is5e', 'https://t.co/QEgqVRSYWQ', 'https://t.co/uQVOStHBkK', 'https://t.co/jpeMotHR3L'], result: 'win' },
    { date: '2026年3月初', text: '配合机器人90空到79.9平空，一把70万刀盈利。', links: ['https://t.co/XdiBkFUs1H', 'https://t.co/Eeam1LziQG', 'https://t.co/zBug0ki4hk'], result: 'win' },
    { date: '2026年3月中旬', text: '黄金破位，看空5050到4791。中间4619抄底一次止损。', links: ['https://t.co/FQUfUfj5iq', 'https://t.co/QJV6FztXKZ', 'https://t.co/31S3phsofJ'], result: 'win' },
    { date: '2026年3月22日', text: '黄金4550的时候认为下跌级别放大，判断要去4180-4250，手把手带着在4150抄底，认为未来会重回4800-5000。', links: ['https://t.co/oJzzusqsSv', 'https://t.co/tiobsJUH73', 'https://t.co/w0LVe24WJW', 'https://t.co/rCJ5uqLP0F', 'https://t.co/37cgAAezUm'], result: 'win' },
    { date: '2026年3月25日', text: '黄金上涨到4580，卖出4200买的纸黄金和杠杆，附视频解析+未来重回4800-5000展望。', links: ['https://t.co/yCimZeBZfd', 'https://t.co/JZUJLVxHX4'], result: 'win' },
    { date: '-', text: 'TRUMP爆拉50%，提前判断并参与。', links: ['https://t.co/0DuoMRA32f', 'https://t.co/9AJNoHF7YD'], result: 'win' },
  ]

  const wins = tradeTimeline.filter(t => t.result === 'win').length
  const losses = tradeTimeline.filter(t => t.result === 'loss').length

  mainContent.innerHTML = `
    <div class="trades-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

      <div class="trades-header">
        <h1 class="trades-title">📊 量见历史战绩</h1>
        <p class="trades-subtitle">以下内容整理自量见在推特 X 公开发布的交易观点、操作思路、实盘视频与部分战绩记录。<br>这些内容发布时间早于部分行情验证节点，能够帮助新用户更直观地了解量见的分析框架、执行能力和交易风格。<br>网站的意义很明确：<br>把原本分散在公开平台上的视频思路、经验、复盘，系统化地整理出来，提供给真正有需要的人。<br>你为服务付费，我提供行情思路，为认知提升负责，为交易执行问题提供帮助。</p>
      </div>

      <div class="trades-stats">
        <div class="trades-stat-card">
          <div class="trades-stat-num">${tradeTimeline.length}</div>
          <div class="trades-stat-label">公开交易</div>
        </div>
        <div class="trades-stat-card win">
          <div class="trades-stat-num">${wins}</div>
          <div class="trades-stat-label">盈利</div>
        </div>
        <div class="trades-stat-card loss">
          <div class="trades-stat-num">${losses}</div>
          <div class="trades-stat-label">亏损</div>
        </div>
        <div class="trades-stat-card rate">
          <div class="trades-stat-num">${Math.round(wins / tradeTimeline.length * 100)}%</div>
          <div class="trades-stat-label">胜率</div>
        </div>
      </div>

      <div class="trades-section">
        <h2 class="trades-section-title">交易时间线</h2>
        <p class="trades-section-desc">去年10月发现币圈走熊，流动性极差，黄金白银处于主升浪结束的第一段暴跌，资金没走孕育着巨大机会，开始转向贵金属。</p>
        <div class="trades-timeline">
          ${tradeTimeline.map(t => `
            <div class="timeline-item ${t.result}">
              <div class="timeline-dot"></div>
              <div class="timeline-content">
                <div class="timeline-date">${t.date}</div>
                <div class="timeline-text">${escapeHtml(t.text)}</div>
                ${t.links.length > 0 ? `<div class="timeline-links">${t.links.map((l, i) => `<a href="${escapeHtml(l)}" target="_blank" rel="noopener noreferrer">复盘链接${t.links.length > 1 ? i + 1 : ''}</a>`).join(' ')}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="trades-section">
        <h2 class="trades-section-title">MT5 交易报告</h2>
        <p class="trades-section-desc">以下为 MT5 实盘交易报告截图，包含完整交易记录。</p>
        <div class="trades-reports">
          <div class="trades-report-img">
            <img src="/trades/report1.jpeg" alt="MT5交易报告1" loading="lazy">
          </div>
          <div class="trades-report-img">
            <img src="/trades/report2.jpeg" alt="MT5交易报告2" loading="lazy">
          </div>
        </div>
      </div>

      ${adminUser ? `
        <div class="trades-section">
          <h2 class="trades-section-title">管理：添加战绩记录</h2>
          <div class="trades-admin-form" id="tradesAdminForm" style="display:none">
            <div class="trades-form-grid">
              <input type="date" id="tradeDate" class="trades-input" required>
              <input type="text" id="tradeSymbol" class="trades-input" placeholder="标的（BTC/GOLD/ETH）">
              <select id="tradeDirection" class="trades-input">
                <option value="long">做多 Long</option>
                <option value="short">做空 Short</option>
              </select>
              <select id="tradeResult" class="trades-input">
                <option value="win">盈利</option>
                <option value="loss">亏损</option>
              </select>
              <input type="text" id="tradeEntry" class="trades-input" placeholder="入场价">
              <input type="text" id="tradeExit" class="trades-input" placeholder="出场价">
              <input type="text" id="tradeProfit" class="trades-input" placeholder="盈亏比例（如 +12.5%）">
              <input type="text" id="tradeScreenshot" class="trades-input" placeholder="截图链接（可选）">
            </div>
            <input type="text" id="tradeNotes" class="trades-input" placeholder="备注（可选）" style="width:100%;margin-top:8px">
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="btn btn-primary" id="submitTrade">添加</button>
              <button class="btn btn-ghost" id="cancelAddTrade">取消</button>
            </div>
          </div>
          <button class="btn btn-primary" id="showAddTrade">+ 添加战绩</button>
          <div class="trades-list" id="tradesList" style="margin-top:16px">
            <div class="loading-spinner">加载中...</div>
          </div>
        </div>
      ` : ''}
    </div>
  `

  // Admin handlers
  if (adminUser) {
    loadTradeRecords()
    document.getElementById('showAddTrade')?.addEventListener('click', () => {
      document.getElementById('tradesAdminForm').style.display = 'block'
      document.getElementById('showAddTrade').style.display = 'none'
    })
    document.getElementById('cancelAddTrade')?.addEventListener('click', () => {
      document.getElementById('tradesAdminForm').style.display = 'none'
      document.getElementById('showAddTrade').style.display = 'block'
    })
    document.getElementById('submitTrade')?.addEventListener('click', async () => {
      const btn = document.getElementById('submitTrade')
      btn.disabled = true; btn.textContent = '提交中...'
      const data = {
        trade_date: document.getElementById('tradeDate').value,
        symbol: document.getElementById('tradeSymbol').value.trim().toUpperCase(),
        direction: document.getElementById('tradeDirection').value,
        result: document.getElementById('tradeResult').value,
        entry_price: document.getElementById('tradeEntry').value.trim(),
        exit_price: document.getElementById('tradeExit').value.trim(),
        profit_pct: document.getElementById('tradeProfit').value.trim(),
        notes: document.getElementById('tradeNotes').value.trim(),
        screenshot_url: document.getElementById('tradeScreenshot').value.trim(),
      }
      if (!data.trade_date || !data.symbol) { showToast('请填写日期和标的', 'error'); btn.disabled = false; btn.textContent = '添加'; return }
      const res = await api.post('/api/trades', data)
      if (res.ok) {
        document.getElementById('tradesAdminForm').style.display = 'none'
        document.getElementById('showAddTrade').style.display = 'block'
        loadTradeRecords()
      } else { showToast(res.error || '添加失败', 'error') }
      btn.disabled = false; btn.textContent = '添加'
    })
  }
}

async function loadTradeRecords() {
  const listEl = document.getElementById('tradesList')
  const statsEl = document.getElementById('tradesStats')
  if (!listEl) return

  try {
    const res = await api.get('/api/trades')
    const trades = res.trades || []

    // Calculate stats
    const wins = trades.filter(t => t.result === 'win').length
    const losses = trades.filter(t => t.result === 'loss').length
    const total = trades.length
    const winRate = total > 0 ? Math.round(wins / total * 100) : 0

    if (statsEl) {
      statsEl.innerHTML = `
        <div class="trades-stat-card">
          <div class="trades-stat-num">${total}</div>
          <div class="trades-stat-label">总交易</div>
        </div>
        <div class="trades-stat-card win">
          <div class="trades-stat-num">${wins}</div>
          <div class="trades-stat-label">盈利</div>
        </div>
        <div class="trades-stat-card loss">
          <div class="trades-stat-num">${losses}</div>
          <div class="trades-stat-label">亏损</div>
        </div>
        <div class="trades-stat-card rate">
          <div class="trades-stat-num">${winRate}%</div>
          <div class="trades-stat-label">胜率</div>
        </div>
      `
    }

    if (trades.length === 0) {
      listEl.innerHTML = '<div class="comments-empty">暂无交易记录</div>'
      return
    }

    const adminUser = isAdmin()
    listEl.innerHTML = trades.map(t => `
      <div class="trade-row ${escapeHtml(t.result)}">
        <div class="trade-date">${escapeHtml(t.trade_date)}</div>
        <div class="trade-symbol">${escapeHtml(t.symbol)}</div>
        <div class="trade-direction ${escapeHtml(t.direction)}">${t.direction === 'long' ? '做多' : '做空'}</div>
        <div class="trade-prices">
          ${t.entry_price ? `<span class="trade-entry">入 ${escapeHtml(t.entry_price)}</span>` : ''}
          ${t.exit_price ? `<span class="trade-exit">出 ${escapeHtml(t.exit_price)}</span>` : ''}
        </div>
        <div class="trade-profit ${escapeHtml(t.result)}">${escapeHtml(t.profit_pct) || '-'}</div>
        <div class="trade-result ${escapeHtml(t.result)}">${t.result === 'win' ? '✅ 盈利' : '❌ 亏损'}</div>
        ${t.notes ? `<div class="trade-notes">${escapeHtml(t.notes)}</div>` : ''}
        ${t.screenshot_url ? `<a class="trade-screenshot" href="${escapeHtml(t.screenshot_url)}" target="_blank" rel="noopener noreferrer">📸 查看截图</a>` : ''}
        ${adminUser ? `<button class="btn btn-ghost btn-xs trade-del-btn" data-trade-id="${t.id}" style="color:#ef4444">删除</button>` : ''}
      </div>
    `).join('')

    // Admin delete handlers
    listEl.querySelectorAll('.trade-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确定删除？')) return
        btn.disabled = true
        const r = await api.del(`/api/trades?id=${btn.dataset.tradeId}`)
        if (r.ok) loadTradeRecords()
        else { showToast('删除失败', 'error'); btn.disabled = false }
      })
    })
  } catch (err) {
    console.error('Load trades error:', err)
    listEl.innerHTML = '<div class="comments-empty">加载失败</div>'
  }
}

// ===== Community View =====
const boardMap = {
  ideas: '金融思路分享',
  review: '标的复盘',
  discussion: '交流互相帮助',
}
const forumSortOptions = [
  { key: 'active', label: '最新回复' },
  { key: 'newest', label: '最新发布' },
  { key: 'hot', label: '最热' },
]

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDateTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 3600000))} 小时前`
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 86400000))} 天前`
  return formatDate(dateStr)
}

function renderForumAvatar(user, className = '') {
  const initial = escapeHtml((user?.name || 'U').charAt(0).toUpperCase())
  const avatar = user?.avatar
    ? `<img src="${escapeHtml(user.avatar)}" class="avatar-img">`
    : initial
  return `<div class="post-card-avatar ${className}">${avatar}</div>`
}

function renderIdentityBadge(user, { compact = false } = {}) {
  if (!user) return ''
  if (user.isAdmin) return `<span class="forum-role-badge admin ${compact ? 'compact' : ''}">管理员</span>`
  const plan = getEffectivePlan(user)
  if (plan === 'pro') return `<span class="plan-badge pro ${compact ? 'compact' : ''}">Pro</span>`
  if (plan === 'plus') return `<span class="plan-badge plus ${compact ? 'compact' : ''}">Plus</span>`
  return `<span class="forum-role-badge free ${compact ? 'compact' : ''}">成员</span>`
}

function renderForumTags(tags = [], extraClass = '') {
  if (!tags.length) return ''
  return `<div class="forum-tag-list ${extraClass}">${tags.map(tag => `
    <button class="forum-tag-chip" data-tag-filter="${escapeHtml(tag.slug)}">#${escapeHtml(tag.label)}</button>
  `).join('')}</div>`
}

function renderParticipantAvatars(participants = []) {
  if (!participants.length) return ''
  return `
    <div class="forum-participants" title="最近参与者">
      ${participants.map(user => `
        <div class="forum-participant-avatar" title="${escapeHtml(user.name)}">
          ${user.avatar ? `<img src="${escapeHtml(user.avatar)}" class="avatar-img">` : escapeHtml((user.name || 'U').charAt(0).toUpperCase())}
        </div>
      `).join('')}
    </div>
  `
}

function renderThreadBadges(post) {
  const badges = []
  if (post.isSticky) badges.push('<span class="forum-label sticky">置顶</span>')
  if (post.isFeatured) badges.push('<span class="forum-label featured">精华</span>')
  if (post.isLocked || post.threadLocked) badges.push('<span class="forum-label locked">锁帖</span>')
  badges.push(`<span class="forum-label board">${escapeHtml(boardMap[post.board] || '社区')}</span>`)
  return badges.join('')
}

function renderForumPagination(currentPage, totalPages, dataAttr = 'data-page') {
  if (totalPages <= 1) return ''
  const pages = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) pages.push(i)
  }
  const items = []
  const prevPage = currentPage > 1 ? currentPage - 1 : null
  items.push(`<button class="page-btn page-btn-nav" ${prevPage ? `${dataAttr}="${prevPage}"` : 'disabled'}>上一页</button>`)
  let lastPage = 0
  for (const page of pages) {
    if (lastPage && page - lastPage > 1) items.push('<span class="page-ellipsis">…</span>')
    items.push(`<button class="page-btn ${page === currentPage ? 'active' : ''}" ${dataAttr}="${page}">${page}</button>`)
    lastPage = page
  }
  const nextPage = currentPage < totalPages ? currentPage + 1 : null
  items.push(`<button class="page-btn page-btn-nav" ${nextPage ? `${dataAttr}="${nextPage}"` : 'disabled'}>下一页</button>`)
  return items.join('')
}

function resetReplyQuote() {
  state.replyQuote = null
  renderReplyQuoteComposer()
}

function setReplyQuote(reply) {
  if (!reply) return
  state.replyQuote = {
    id: reply.id,
    floorNumber: reply.floorNumber,
    text: reply.contentText || '',
    user: reply.user,
  }
  renderReplyQuoteComposer()
  document.getElementById('replyInput')?.focus()
}

function renderReplyQuoteComposer() {
  const wrap = document.getElementById('replyQuoteBox')
  if (!wrap) return
  if (!state.replyQuote) {
    wrap.innerHTML = ''
    wrap.style.display = 'none'
    return
  }
  wrap.style.display = 'flex'
  wrap.innerHTML = `
    <div class="reply-quote-box-inner">
      <div class="reply-quote-box-meta">引用 #${state.replyQuote.floorNumber} · ${escapeHtml(state.replyQuote.user?.name || '匿名用户')}</div>
      <div class="reply-quote-box-text">${escapeHtml(state.replyQuote.text || '').replace(/\n/g, '<br>')}</div>
    </div>
    <button type="button" class="reply-quote-box-close" id="clearReplyQuote" aria-label="取消引用">×</button>
  `
}

async function loadCommunityPosts() {
  const board = state.currentBoard
  const page = state.communityPage
  const requestId = state.communityRequestSeq + 1
  state.communityRequestSeq = requestId

  try {
    const searchParams = new URLSearchParams({
      board,
      page: String(page),
      sort: state.communitySort,
    })
    if (state.communityQuery) searchParams.set('q', state.communityQuery)
    if (state.communityTag) searchParams.set('tag', state.communityTag)
    const res = await api.get(`/api/posts?${searchParams.toString()}`)
    if (
      requestId !== state.communityRequestSeq ||
      state.currentView !== 'community' ||
      board !== state.currentBoard ||
      page !== state.communityPage
    ) {
      return false
    }
    state.communityPosts = res.posts || []
    state.communityTotal = res.total || 0
    state.communityTotalPages = res.totalPages || 1
    state.communityTags = res.availableTags || []
    return true
  } catch {
    if (
      requestId !== state.communityRequestSeq ||
      state.currentView !== 'community' ||
      board !== state.currentBoard ||
      page !== state.communityPage
    ) {
      return false
    }
    state.communityPosts = []
    state.communityTotal = 0
    state.communityTotalPages = 1
    state.communityTags = []
    return true
  }
}

function renderCommunity() {
  destroyCommunityEditor()
  resetReplyQuote()
  mainContent.innerHTML = `
    <div class="community-page forum-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>
      <div class="community-header forum-header">
        <div>
          <div class="forum-header-kicker">会员版贴吧</div>
          <h1 class="community-title">💬 交易讨论区</h1>
          <p class="community-subtitle">更高信息密度、更像楼层的回复、更像社区的讨论氛围。</p>
        </div>
        <div class="forum-header-meta">
          <div class="forum-header-stat">
            <span class="forum-header-stat-num">${state.communityTotal || '—'}</span>
            <span class="forum-header-stat-label">当前板块帖子</span>
          </div>
          <div class="forum-header-stat">
            <span class="forum-header-stat-num">${state.communitySort === 'hot' ? '热榜' : state.communitySort === 'newest' ? '新帖' : '活跃'}</span>
            <span class="forum-header-stat-label">当前排序</span>
          </div>
        </div>
      </div>
      <div class="forum-toolbar">
        <div class="community-boards forum-board-tabs">
          ${Object.entries(boardMap).map(([key, label]) => `
            <button class="board-tab ${state.currentBoard === key ? 'active' : ''}" data-board="${key}">${label}</button>
          `).join('')}
        </div>
        <div class="forum-toolbar-row">
          <div class="forum-sort-group">
            ${forumSortOptions.map(option => `
              <button class="forum-sort-btn ${state.communitySort === option.key ? 'active' : ''}" data-community-sort="${option.key}">
                ${option.label}
              </button>
            `).join('')}
          </div>
          <form class="forum-search-form" id="communitySearchForm">
            <input
              type="search"
              class="forum-search-input"
              id="communitySearchInput"
              placeholder="搜索标题或正文摘要"
              value="${escapeHtml(state.communityQuery)}"
              maxlength="40"
            >
            <button class="forum-search-btn" type="submit">搜索</button>
          </form>
        </div>
        <div class="forum-filter-row">
          <button class="forum-tag-filter ${!state.communityTag ? 'active' : ''}" data-tag-filter="">全部话题</button>
          ${state.communityTags.map(tag => `
            <button class="forum-tag-filter ${state.communityTag === tag.slug ? 'active' : ''}" data-tag-filter="${escapeHtml(tag.slug)}">
              #${escapeHtml(tag.label)} <span>${tag.count || 0}</span>
            </button>
          `).join('')}
        </div>
      </div>
      ${isPaid() ? `
        <div class="community-create forum-create-box">
          <button class="btn btn-primary" id="showCreatePost">✏️ 发布新帖</button>
          <div class="forum-create-copy">支持富文本、标签和最多 ${MAX_POST_IMAGES} 张图片</div>
        </div>
        <div class="create-post-form" id="createPostForm" style="display:none">
          <div class="forum-create-head">
            <div>
              <div class="forum-create-title">新建主题</div>
              <div class="forum-create-subtitle">把你的交易观点、复盘和问题写成一个更像论坛的帖子</div>
            </div>
            <div class="forum-create-identity">${renderIdentityBadge(state.user)}</div>
          </div>
          <input type="text" class="post-title-input" id="postTitleInput" placeholder="帖子标题，尽量具体一点" maxlength="200">
          <input type="text" class="post-title-input post-tags-input" id="postTagsInput" placeholder="标签，逗号分隔，例如：黄金, 比特币, 短线" maxlength="60">
          <div class="post-editor-shell">
            <div id="postEditor" class="post-editor"></div>
          </div>
          <div class="post-editor-meta">
            <span class="post-editor-hint">支持标题、引用、列表、链接和图片，最多 ${MAX_POST_IMAGES} 张图</span>
            <span class="post-editor-hint">单张图片不超过 5MB</span>
          </div>
          <div class="create-post-actions">
            <button class="btn btn-ghost" id="cancelCreatePost">取消</button>
            <button class="btn btn-primary" id="submitPost">发布</button>
          </div>
        </div>
      ` : ''}
      <div class="community-posts-list" id="communityPostsList">
        <div class="loading-spinner">加载中...</div>
      </div>
      <div class="community-pagination" id="communityPagination"></div>
    </div>
  `

  if (isPaid()) initCommunityEditor()

  document.getElementById('communitySearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const nextQuery = normalizePlainText(document.getElementById('communitySearchInput')?.value || '').slice(0, 40)
    if (nextQuery === state.communityQuery) return
    state.communityQuery = nextQuery
    state.communityPage = 1
    renderCommunity()
  })

  loadCommunityPosts().then((applied) => {
    if (!applied || state.currentView !== 'community') return
    renderCommunityPosts()
    const filterRow = document.querySelector('.forum-filter-row')
    if (filterRow) {
      filterRow.innerHTML = `
        <button class="forum-tag-filter ${!state.communityTag ? 'active' : ''}" data-tag-filter="">全部话题</button>
        ${state.communityTags.map(tag => `
          <button class="forum-tag-filter ${state.communityTag === tag.slug ? 'active' : ''}" data-tag-filter="${escapeHtml(tag.slug)}">
            #${escapeHtml(tag.label)} <span>${tag.count || 0}</span>
          </button>
        `).join('')}
      `
    }
  })
}

function renderCommunityPosts() {
  const listEl = document.getElementById('communityPostsList')
  if (!listEl) return

  if (!state.communityPosts.length) {
    listEl.innerHTML = `
      <div class="community-empty forum-empty">
        <div class="forum-empty-icon">🧵</div>
        <div class="forum-empty-title">这个板块暂时还没有符合条件的帖子</div>
        <div class="forum-empty-desc">${state.communityQuery || state.communityTag ? '换个关键词或话题试试，或者直接发第一篇。' : '现在发一篇，让讨论真正动起来。'}</div>
      </div>
    `
  } else {
    listEl.innerHTML = state.communityPosts.map(post => `
      <article class="post-card forum-thread-card" data-post-id="${post.id}">
        <div class="forum-thread-main">
          <div class="forum-thread-topline">
            <div class="forum-thread-badges">
              ${renderThreadBadges(post)}
              ${renderForumTags(post.tags || [], 'inline')}
            </div>
            <div class="forum-thread-last-active">最后活跃 ${formatRelativeTime(post.lastRepliedAt)}</div>
          </div>
          <h3 class="post-card-title forum-thread-title">${escapeHtml(post.title)}</h3>
          <p class="post-card-preview forum-thread-preview">${escapeHtml(post.preview || '')}</p>
          <div class="forum-thread-meta">
            <div class="forum-thread-authorline">
              ${renderForumAvatar(post.user, 'forum-thread-avatar')}
              <div class="forum-thread-authorinfo">
                <div class="forum-thread-authorname">${escapeHtml(post.user.name)} ${renderIdentityBadge(post.user, { compact: true })}</div>
                <div class="forum-thread-authorsub">发表于 ${formatDateTime(post.createdAt)}${post.lastReplyUser ? ` · 最后回复 ${escapeHtml(post.lastReplyUser.name)}` : ''}</div>
              </div>
            </div>
            ${renderParticipantAvatars(post.participants || [])}
          </div>
        </div>
        <div class="forum-thread-stats">
          <div class="forum-thread-stat"><span>回复</span><strong>${post.replyCount || 0}</strong></div>
          <div class="forum-thread-stat"><span>浏览</span><strong>${post.viewCount || 0}</strong></div>
          <div class="forum-thread-stat"><span>图片</span><strong>${post.imageCount || 0}</strong></div>
          ${post.canDelete ? `<button class="post-delete-btn forum-delete-btn" data-delete-post="${post.id}" title="删除帖子">删除</button>` : ''}
        </div>
      </article>
    `).join('')
  }

  const pagEl = document.getElementById('communityPagination')
  if (pagEl) pagEl.innerHTML = renderForumPagination(state.communityPage, state.communityTotalPages, 'data-page')
}

function renderReplyItem(reply) {
  return `
    <article class="reply-item forum-floor-card" data-reply-id="${reply.id}">
      <div class="forum-floor-aside">
        ${renderForumAvatar(reply.user, 'reply-avatar forum-floor-avatar')}
        <div class="forum-floor-side-label">${renderIdentityBadge(reply.user, { compact: true })}</div>
      </div>
      <div class="forum-floor-main">
        <div class="reply-header forum-floor-header">
          <div class="forum-floor-userline">
            <span class="reply-author forum-floor-author">${escapeHtml(reply.user.name)}</span>
            <span class="reply-time forum-floor-time">${formatDateTime(reply.createdAt)}</span>
          </div>
          <div class="forum-floor-meta">
            <span class="forum-floor-number">#${reply.floorNumber || 0}</span>
            ${reply.canDelete ? `<button class="reply-delete-btn" data-delete-reply="${reply.id}" title="删除">✕</button>` : ''}
          </div>
        </div>
        ${reply.quote ? `
          <button class="forum-floor-quote" data-quote-reply="${reply.quote.id}">
            <span class="forum-floor-quote-label">引用 #${reply.quote.floorNumber}</span>
            <span class="forum-floor-quote-text">${escapeHtml(reply.quote.user?.name || '')}：${escapeHtml(reply.quote.text || '')}</span>
          </button>
        ` : ''}
        <div class="reply-body ${reply.contentHtml ? 'reply-body-rich post-detail-content-rich' : ''}">
          ${reply.contentHtml ? sanitizeRichHtml(reply.contentHtml) : escapeHtml(reply.content || '').replace(/\n/g, '<br>')}
        </div>
        <div class="forum-floor-actions">
          <button class="forum-floor-action" data-open-reply-quote="${reply.id}">引用</button>
          <button class="forum-floor-action" data-report-reply="${reply.id}">举报</button>
        </div>
      </div>
    </article>
  `
}

async function loadPostReplies(postId) {
  const data = await api.get(`/api/post-replies?post=${postId}&page=${state.replyPage}`)
  state.currentReplies = data.replies || []
  state.replyTotal = data.total || 0
  state.replyTotalPages = data.totalPages || 1
  return data
}

async function renderPost() {
  resetReplyDraftImages()
  releasePostImageObjectUrls()
  state.currentReplies = []

  mainContent.innerHTML = `
    <div class="post-page fade-in">
      <button class="back-btn" id="backCommunity">← 返回社区</button>
      <div class="loading-spinner">加载中...</div>
    </div>
  `

  try {
    const res = await api.get(`/api/posts?id=${state.currentPost}`)
    const post = res.post
    state.currentPostData = post || null
    if (!post) {
      mainContent.innerHTML = `
        <div class="post-page fade-in">
          <button class="back-btn" id="backCommunity">← 返回社区</button>
          <div class="community-empty">帖子不存在</div>
        </div>`
      return
    }

    const locked = post.locked
    const paid = isPaid()
    const richContent = (!locked || paid) && post.contentFormat === 'rich'

    mainContent.innerHTML = `
      <div class="post-page forum-thread-page fade-in">
        <button class="back-btn" id="backCommunity">← 返回社区</button>
        <div class="post-detail-card forum-thread-detail">
          <div class="forum-thread-detail-top">
            <div class="forum-thread-badges">${renderThreadBadges(post)}</div>
            <div class="forum-thread-detail-tags">${renderForumTags(post.tags || [])}</div>
          </div>
          <div class="post-detail-header forum-thread-detail-header">
            ${renderForumAvatar(post.user, 'forum-thread-detail-avatar')}
            <div class="post-card-meta forum-thread-detail-meta">
              <span class="post-card-author">${escapeHtml(post.user.name)} ${renderIdentityBadge(post.user)}</span>
              <span class="post-card-time">发布于 ${formatDateTime(post.createdAt)}${post.lastRepliedAt ? ` · 最后活跃 ${formatRelativeTime(post.lastRepliedAt)}` : ''}</span>
            </div>
            <div class="forum-thread-detail-participants">${renderParticipantAvatars(post.participants || [])}</div>
          </div>
          <div class="forum-thread-detail-stats">
            <span class="forum-thread-stat-pill">回复 ${post.replyCount || 0}</span>
            <span class="forum-thread-stat-pill">浏览 ${post.viewCount || 0}</span>
            <span class="forum-thread-stat-pill">图片 ${post.imageCount || 0}</span>
          </div>
          <div class="forum-thread-detail-actions">
            <button class="forum-action-btn" data-post-report="${post.id}">举报</button>
            ${post.canModerate ? `
              <button class="forum-action-btn admin ${post.isSticky ? 'active' : ''}" data-post-pin="${post.id}" data-next-pin="${post.isSticky ? '0' : '1'}">${post.isSticky ? '取消置顶' : '置顶'}</button>
              <button class="forum-action-btn admin ${post.isFeatured ? 'active' : ''}" data-post-feature="${post.id}" data-next-feature="${post.isFeatured ? '0' : '1'}">${post.isFeatured ? '取消精华' : '设为精华'}</button>
              <button class="forum-action-btn admin ${post.threadLocked ? 'active' : ''}" data-post-lock="${post.id}" data-next-lock="${post.threadLocked ? '0' : '1'}">${post.threadLocked ? '解锁主题' : '锁定主题'}</button>
            ` : ''}
            ${post.canDelete ? `<button class="post-delete-detail-btn" data-delete-post="${post.id}">删除帖子</button>` : ''}
          </div>
          <h1 class="post-detail-title">${escapeHtml(post.title)}</h1>
          <div class="post-detail-body-wrap">
            ${locked && !paid ? `
              <div class="post-blur-content">${escapeHtml(post.preview || '此内容仅限付费会员查看...').replace(/\n/g, '<br>')}</div>
              <div class="post-paywall-overlay">
                <div class="post-paywall-box">
                  <div class="post-paywall-icon">🔒</div>
                  <h3>仅限付费会员查看</h3>
                  <p>升级会员解锁全部社区内容</p>
                  <button class="btn btn-primary" id="goUpgradeCommunity">升级会员</button>
                </div>
              </div>
            ` : `
              <div class="post-detail-content ${richContent ? 'post-detail-content-rich' : ''}" id="${richContent ? 'postRichContent' : ''}">${richContent ? sanitizeRichHtml(post.contentHtml || '') : escapeHtml(post.content || '').replace(/\n/g, '<br>')}</div>
            `}
          </div>
        </div>
        ${locked && !paid ? `
          <div class="post-replies-section post-replies-locked">
            <h3 class="replies-title">回复</h3>
            <p class="reply-login-hint">${state.user ? '升级付费会员后可查看回复并参与讨论' : '登录并升级会员后可查看回复与参与讨论'}</p>
            <div class="reply-locked-actions">
              ${state.user ? '' : '<button class="btn btn-ghost btn-sm" id="commentLoginBtn">登录</button>'}
              <button class="btn btn-primary btn-sm" id="goUpgradeCommunityReplies">升级会员</button>
            </div>
          </div>
        ` : `
          <div class="post-replies-section">
            <div class="forum-replies-head">
              <div>
                <h3 class="replies-title">全部回复</h3>
                <p class="forum-replies-subtitle">${post.threadLocked ? '当前主题已锁帖，只能阅读历史回复。' : '按楼层顺序查看，每一层都像真正论坛里那样可引用、可带图。'}</p>
              </div>
              <div class="forum-replies-summary">${post.replyCount || 0} 楼</div>
            </div>
            <div id="repliesList" class="replies-list"><div class="replies-loading">加载回复中...</div></div>
            <div class="community-pagination reply-pagination" id="replyPagination"></div>
            ${paid && !post.threadLocked ? `
              <div class="reply-input-wrap">
                <textarea id="replyInput" class="reply-textarea" placeholder="写下你的回复，可附上图片..." rows="3"></textarea>
                <div id="replyQuoteBox" class="reply-quote-box" style="display:none"></div>
                <div class="reply-toolbar">
                  <button type="button" class="btn btn-ghost btn-sm" id="replyImageBtn">添加图片</button>
                  <span class="reply-toolbar-hint">可添加多张图片，单张不超过 5MB</span>
                  <input type="file" id="replyImageInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
                </div>
                <div id="replyImageList" class="reply-image-list"></div>
                <div class="reply-input-footer">
                  <span class="reply-char-count" id="replyCharCount">0 字 · 0 图</span>
                  <button class="btn btn-primary btn-sm" id="submitReplyBtn">发布回复</button>
                </div>
              </div>
            ` : `<p class="reply-login-hint">${post.threadLocked ? '帖子已锁定，当前不接受新回复' : (state.user ? '升级付费会员参与回复' : '登录后参与回复')}</p>`}
          </div>
        `}
      </div>
    `

    if (richContent) {
      await hydrateProtectedPostImages(document.getElementById('postRichContent'))
    }

    if (!locked || paid) {
      try {
        const replyData = await loadPostReplies(post.id)
        const listEl = document.getElementById('repliesList')
        if (!listEl || state.currentView !== 'post') return
        if (!replyData.replies?.length) {
          listEl.innerHTML = '<p class="replies-empty">暂无回复，来发表第一条回复吧</p>'
        } else {
          listEl.innerHTML = replyData.replies.map(renderReplyItem).join('')
          enhanceReplyImageLayouts(listEl)
          if (replyData.replies.some(reply => reply.contentHtml)) {
            await hydrateProtectedPostImages(listEl, { imageClass: 'reply-rich-image' })
          }
        }
        const replyPagEl = document.getElementById('replyPagination')
        if (replyPagEl) {
          replyPagEl.innerHTML = renderForumPagination(state.replyPage, state.replyTotalPages, 'data-reply-page')
        }
      } catch (err) {
        console.error('Load replies error:', err)
        const listEl = document.getElementById('repliesList')
        if (listEl) listEl.innerHTML = '<p class="replies-empty">加载回复失败</p>'
      }

      renderReplyDraftImages()
      updateReplyComposerMeta()
      renderReplyQuoteComposer()
    }
  } catch (err) {
    console.error('Load post error:', err)
    mainContent.innerHTML = `
      <div class="post-page fade-in">
        <button class="back-btn" id="backCommunity">← 返回社区</button>
        <div class="community-empty">加载失败，请稍后重试</div>
      </div>`
  }
}

// ===== Load Market Menu from Config =====
async function loadMarketMenu() {
  const menu = document.getElementById('marketResearchMenu')
  if (!menu) return
  try {
    const res = await api.get('/api/system-config-public/market_menu')
    if (res.ok && res.items) {
      const menuItem = res.items.find(i => i.key === 'items')
      if (menuItem) {
        const items = JSON.parse(menuItem.value || '[]')
        menu.innerHTML = items.map((item, i) => `
          <a class="header-market-item" href="${escapeHtml(item.url)}" role="menuitem" tabindex="-1">
            <span class="header-market-icon" aria-hidden="true">${escapeHtml(item.icon)}</span>
            <span class="header-market-label">${escapeHtml(item.name)}</span>
          </a>
        `).join('')
      }
    }
  } catch (err) {
    console.error('Load market menu error:', err)
  }
}

// ===== Event Handling =====
function setupGlobalEvents() {
  const userMenuWrap = $('#userMenuWrap')
  const userDropdown = $('#userDropdown')
  const marketToggle = $('#navMarketToggle')
  const marketMenu = $('#marketResearchMenu')
  const marketMenuItems = marketMenu ? Array.from(marketMenu.querySelectorAll('.header-market-item')) : []

  function setMarketMenuOpen(isOpen) {
    if (!marketToggle || !marketMenu) return
    marketToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    marketToggle.setAttribute('aria-label', isOpen ? '关闭股票市场研究菜单' : '打开股票市场研究菜单')
    marketMenu.classList.toggle('active', isOpen)
    marketMenu.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
    marketMenuItems.forEach((item) => {
      if (isOpen) {
        item.removeAttribute('tabindex')
      } else {
        item.setAttribute('tabindex', '-1')
      }
    })
  }

  function closeMarketMenu() {
    setMarketMenuOpen(false)
  }

  function positionMarketMenu() {
    if (!marketToggle || !marketMenu) return
    const headerRect = document.querySelector('.header')?.getBoundingClientRect()
    const toggleRect = marketToggle.getBoundingClientRect()
    const gutter = window.innerWidth <= 768 ? 12 : 16
    const menuWidth = window.innerWidth <= 768 ? Math.max(0, window.innerWidth - gutter * 2) : 300
    const centeredLeft = toggleRect.left + (toggleRect.width / 2) - (menuWidth / 2)
    const left = window.innerWidth <= 768
      ? gutter
      : Math.max(gutter, Math.min(centeredLeft, window.innerWidth - menuWidth - gutter))
    const top = Math.round((headerRect?.bottom || toggleRect.bottom) + 8)

    marketMenu.style.setProperty('--market-menu-top', `${top}px`)
    marketMenu.style.setProperty('--market-menu-left', `${Math.round(left)}px`)
    marketMenu.style.setProperty('--market-menu-width', `${Math.round(menuWidth)}px`)
    marketMenu.style.setProperty('--market-menu-right', 'auto')
  }

  function toggleMarketMenu() {
    if (!marketToggle || !marketMenu) return
    const isOpen = marketToggle.getAttribute('aria-expanded') === 'true'
    if (!isOpen) positionMarketMenu()
    setMarketMenuOpen(!isOpen)
    userDropdown.classList.remove('active')
    closeAIMenu()
  }

  // ===== AI dropdown menu =====
  const aiToggle = $('#navAIToggle')
  const aiMenu = $('#aiDropdownMenu')

  function setAIMenuOpen(isOpen) {
    if (!aiToggle || !aiMenu) return
    aiToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    aiMenu.classList.toggle('active', isOpen)
    aiMenu.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
  }

  function closeAIMenu() {
    setAIMenuOpen(false)
  }

  function positionAIMenu() {
    if (!aiToggle || !aiMenu) return
    const headerRect = document.querySelector('.header')?.getBoundingClientRect()
    const toggleRect = aiToggle.getBoundingClientRect()
    const menuWidth = 260
    const left = toggleRect.left + (toggleRect.width / 2) - (menuWidth / 2)
    const top = Math.round((headerRect?.bottom || toggleRect.bottom) + 8)
    aiMenu.style.setProperty('--ai-menu-top', `${top}px`)
    aiMenu.style.setProperty('--ai-menu-left', `${Math.round(left)}px`)
    aiMenu.style.setProperty('--ai-menu-right', 'auto')
  }

  function toggleAIMenu() {
    if (!aiToggle || !aiMenu) return
    const isOpen = aiToggle.getAttribute('aria-expanded') === 'true'
    if (!isOpen) positionAIMenu()
    setAIMenuOpen(!isOpen)
    userDropdown.classList.remove('active')
    closeMarketMenu()
  }

  aiToggle?.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleAIMenu()
  })

  // AI 实验室拥有独立认证前端；主站只负责导航，不在这里拦截登录。
  aiMenu?.querySelector('.header-ai-dropdown-item:not(.header-ai-dropdown-disabled)')?.addEventListener('click', () => {
    closeAIMenu()
    if (localStorage.getItem('ws_token')) syncAuthCookieFromStorage()
  })

  function bindProtectedMarketNav(selector, targetPath) {
    $(selector)?.addEventListener('click', (e) => {
      closeMarketMenu()
      handleProtectedStaticNav(e, targetPath)
    })
  }

  $('#logoHome').addEventListener('click', () => navigate('home'))
  $('#navCourses')?.addEventListener('click', (e) => {
    e.preventDefault()
    navigate('courses')
  })
  marketToggle?.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMarketMenu()
  })
  bindProtectedMarketNav('#navEarnings', '/earnings/')
  bindProtectedMarketNav('#navAiBubble', '/ai泡沫周报/')
  bindProtectedMarketNav('#navAiWeekly', '/weekly/')
  bindProtectedMarketNav('#navResearch', '/research/')
  $('#navTools').addEventListener('click', () => {
    if (!requireLogin()) return
    navigate('tools')
  })
  $('#navCommunity').addEventListener('click', () => {
    if (!requireLogin()) return
    state.currentBoard = 'ideas'
    state.communityPage = 1
    navigate('community')
  })
  $('#navMembership').addEventListener('click', () => navigate('membership'))
  $('#footerCourses')?.addEventListener('click', (e) => { e.preventDefault(); navigate('courses') })
  $('#footerCourseCraft')?.addEventListener('click', (e) => { e.preventDefault(); navigate('courseCraft') })
  $('#footerCourseAi')?.addEventListener('click', (e) => { e.preventDefault(); navigate('courseAi') })

  $('#loginBtn').addEventListener('click', () => showAuthModal('login_password'))
  $('#registerBtn').addEventListener('click', () => showAuthModal('register'))
  $('#adminBtn').addEventListener('click', () => { window.location.href = '/admin/' })

  // User dropdown menu — click to toggle, click elsewhere to close
  $('#userMenuTrigger').addEventListener('click', (e) => {
    e.stopPropagation()
    userDropdown.classList.toggle('active')
    closeMarketMenu()
    closeAIMenu()
  })

  document.addEventListener('click', (e) => {
    if (!userMenuWrap.contains(e.target)) {
      userDropdown.classList.remove('active')
    }
    if (marketMenu && marketToggle && !marketMenu.contains(e.target) && !marketToggle.contains(e.target)) {
      closeMarketMenu()
    }
    if (aiMenu && aiToggle && !aiMenu.contains(e.target) && !aiToggle.contains(e.target)) {
      closeAIMenu()
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePostImageLightbox()
      userDropdown.classList.remove('active')
      closeMarketMenu()
    }
  })
  window.addEventListener('resize', () => {
    if (marketMenu?.classList.contains('active')) positionMarketMenu()
  })

  $('#dropdownProfile').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    openMainAccountCenter('overview')
  })
  $('#dropdownNotifications').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    openMainAccountCenter('notifications')
  })
  $('#dropdownAdmin').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    window.location.href = '/admin/'
  })
  // Dark mode toggle
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    const dropdownIcon = $('#themeIcon')
    const dropdownLabel = $('#themeLabel')
    const headerIcon = $('#headerThemeIcon')
    const headerLabel = $('#headerThemeLabel')
    if (dropdownIcon) dropdownIcon.textContent = dark ? '☀️' : '🌙'
    if (dropdownLabel) dropdownLabel.textContent = dark ? '浅色模式' : '深色模式'
    if (headerIcon) headerIcon.textContent = dark ? '☀️' : '🌙'
    if (headerLabel) headerLabel.textContent = dark ? '浅色' : '深色'
    syncArticleFrameTheme()
    mainAccountCenterFrame?.contentWindow?.postMessage({ type:'account-center-theme',theme:dark ? 'dark' : 'light' },window.location.origin)
  }
  function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    const next = !isDark
    localStorage.setItem('ws_theme', next ? 'dark' : 'light')
    applyTheme(next)
    userDropdown.classList.remove('active')
    closeMarketMenu()
  }
  // Init theme from localStorage
  applyTheme(localStorage.getItem('ws_theme') === 'dark')

  $('#themeToggle').addEventListener('click', toggleTheme)
  $('#dropdownTheme').addEventListener('click', toggleTheme)

  $('#dropdownLogout').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    localStorage.removeItem('ws_token')
    localStorage.removeItem('authToken')
    localStorage.setItem('ws_session_event', JSON.stringify({ type:'logout', at:Date.now() }))
    clearAuthCookie()
    closeMainAccountCenter()
    applyMainLoggedOutState()
  })

  window.addEventListener('storage', (event) => {
    if (!['ws_session_event', 'ws_token', 'authToken'].includes(event.key)) return
    if (localStorage.getItem('ws_token') || localStorage.getItem('authToken')) return
    closeMainAccountCenter()
    applyMainLoggedOutState()
  })

  mainAccountCenterModal?.querySelectorAll('[data-close-main-account]').forEach(node => node.addEventListener('click',closeMainAccountCenter))

  $('#modalClose').addEventListener('click', closeModal)
  modalOverlay.addEventListener('pointerdown', (e) => {
    authModalBackdropPress = e.target === modalOverlay
  })
  modalOverlay.addEventListener('pointerup', (e) => {
    if (authModalBackdropPress && e.target === modalOverlay) {
      closeModal()
    }
    authModalBackdropPress = false
  })
  modalOverlay.addEventListener('pointercancel', () => {
    authModalBackdropPress = false
  })
  modalOverlay.addEventListener('click', (e) => {
    if (e.target !== modalOverlay) {
      authModalBackdropPress = false
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMainAccountCenter()
      closeModal()
    }
  })

  modalBody.addEventListener('click', (e) => {
    const modeLink = e.target.closest('[data-auth-mode]')
    if (modeLink) {
      e.preventDefault()
      showAuthModal(modeLink.dataset.authMode, { email: getCurrentAuthEmail(), preserveRedirect: true })
      return
    }
    const regTab = e.target.closest('[data-reg-type]')
    if (regTab) {
      e.preventDefault()
      state.authRegType = regTab.dataset.regType
      showAuthModal(state.authMode, { email: getCurrentAuthEmail(), preserveRedirect: true })
      return
    }
    if (e.target.id === 'sendCodeBtn') {
      handleSendCode()
    }
    if (e.target.id === 'openTos') {
      e.preventDefault()
      closeModal()
      navigate('tos')
    }
  })

  // Auto-verify when 6-digit code is entered
  modalBody.addEventListener('input', (e) => {
    if (e.target.id === 'authEmail' || e.target.id === 'authPhone') {
      state._emailVerified = false
      state._verifyToken = null
    }
    if (e.target.id === 'codeInput') {
      const val = e.target.value.replace(/\D/g, '').slice(0, 6)
      e.target.value = val
      state._emailVerified = false
      state._verifyToken = null
      const codeStatus = document.getElementById('codeStatus')
      const codeHint = document.getElementById('codeHint')
      if (val.length < 6) {
        if (codeStatus) { codeStatus.textContent = ''; codeStatus.className = 'code-status' }
        if (codeHint) { codeHint.textContent = ''; codeHint.className = 'form-hint' }
      }
      if (val.length === 6) {
        handleCodeVerify(val)
      }
    }
    if (e.target.name === 'password' || e.target.name === 'confirmPassword') {
      updateAuthPasswordValidation(e.target.form)
    }
  })

  modalBody.addEventListener('submit', async (e) => {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.target))
    const mode = state.authMode
    const submitBtn = e.target.querySelector('.form-submit')
    const setSubmitting = (submitting) => {
      if (!submitBtn || !submitBtn.isConnected) return
      submitBtn.disabled = submitting
      submitBtn.textContent = submitting ? '提交中...' : getAuthModeMeta(mode).submitLabel
    }

    if (mode === 'register') {
      const tosCheck = document.getElementById('tosAgree')
      if (!tosCheck?.checked) {
        showFormMsg('请阅读并同意《用户服务协议》', 'err')
        return
      }
      const isPhoneReg = state.authRegType === 'phone'
      if (isPhoneReg) {
        if (!state._emailVerified) {
          showFormMsg('请先完成手机验证', 'err')
          return
        }
      } else {
        if (!state._emailVerified) {
          showFormMsg('请先完成邮箱验证', 'err')
          return
        }
      }
      const pwdError = getAuthPasswordRuleError(data.password)
      if (pwdError) {
        showFormMsg(pwdError, 'err')
        return
      }
      if (data.password !== data.confirmPassword) {
        showFormMsg('两次输入的密码不一致', 'err')
        return
      }

      const phonePrefix = document.getElementById('authPhonePrefix')?.value || '+86'
      const registerPayload = {
        nickname: data.nickname || '',
        password: data.password,
        verifyToken: state._verifyToken,
        tosAgree: true,
        tosVersion: TOS_AGREEMENT_VERSION,
      }
      if (isPhoneReg) {
        registerPayload.phone = phonePrefix + (data.phone || '')
        registerPayload.authMethod = 'phone'
      } else {
        registerPayload.email = data.email
        registerPayload.authMethod = 'email'
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/register', registerPayload)
        if (result.ok) {
          persistAuthSession(result)
        } else {
          showFormMsg(result.error || '注册失败，请稍后重试', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_password') {
      if (!data.password) {
        showFormMsg('请输入密码', 'err')
        return
      }
      const loginId = (data.loginId || '').trim()
      if (!loginId) {
        showFormMsg('请输入邮箱或手机号', 'err')
        return
      }
      const isPhone = /^(\+?\d{1,3})?\d{7,15}$/.test(loginId.replace(/\s/g, ''))
      const loginPayload = { method: 'password', password: data.password }
      if (isPhone) {
        loginPayload.phone = loginId.startsWith('+') ? loginId : '+86' + loginId
      } else {
        loginPayload.email = loginId
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', loginPayload)
        if (result.ok) {
          persistAuthSession(result, { syncProgress: true })
        } else {
          showFormMsg(result.error || '登录失败，账号或密码错误', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_code') {
      if (!state._emailVerified || !state._verifyToken) {
        showFormMsg('请先完成验证', 'err')
        return
      }
      const loginId = (data.loginId || '').trim()
      if (!loginId) {
        showFormMsg('请输入邮箱或手机号', 'err')
        return
      }
      const isPhoneLogin = /^(\+?\d{1,3})?\d{7,15}$/.test(loginId.replace(/\s/g, ''))
      const codePayload = { method: 'code', verifyToken: state._verifyToken }
      if (isPhoneLogin) {
        codePayload.phone = loginId.startsWith('+') ? loginId : '+86' + loginId
      } else {
        codePayload.email = loginId
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', codePayload)
        if (result.ok) {
          persistAuthSession(result, { syncProgress: true })
        } else {
          showFormMsg(result.error || '登录失败，请稍后重试', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_phone') {
      const phonePrefix = document.getElementById('authPhonePrefix')?.value || '+86'
      const phoneRaw = data.phone?.trim()
      const phone = phoneRaw ? phonePrefix + phoneRaw : ''
      if (!phone) {
        showFormMsg('请输入手机号', 'err')
        return
      }
      if (!data.password) {
        showFormMsg('请输入密码', 'err')
        return
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', {
          method: 'password',
          phone,
          password: data.password,
        })
        if (result.ok) {
          persistAuthSession(result, { syncProgress: true })
        } else {
          showFormMsg(result.error || '登录失败，手机号或密码错误', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_phone_code') {
      const phonePrefix = document.getElementById('authPhonePrefix')?.value || '+86'
      const phoneRaw = data.phone?.trim()
      const phone = phoneRaw ? phonePrefix + phoneRaw : ''
      if (!phone) {
        showFormMsg('请输入手机号', 'err')
        return
      }
      if (!state._emailVerified || !state._verifyToken) {
        showFormMsg('请先完成手机验证', 'err')
        return
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', {
          method: 'code',
          phone,
          verifyToken: state._verifyToken,
        })
        if (result.ok) {
          persistAuthSession(result, { syncProgress: true })
        } else {
          showFormMsg(result.error || '登录失败，请稍后重试', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'reset_password') {
      if (!state._emailVerified || !state._verifyToken) {
        showFormMsg('请先完成验证', 'err')
        return
      }
      const loginId = (data.loginId || '').trim()
      if (!loginId) {
        showFormMsg('请输入邮箱或手机号', 'err')
        return
      }
      const isPhoneReset = /^(\+?\d{1,3})?\d{7,15}$/.test(loginId.replace(/\s/g, ''))
      const resetPayload = { verifyToken: state._verifyToken, newPassword: data.password }
      if (isPhoneReset) {
        resetPayload.phone = loginId.startsWith('+') ? loginId : '+86' + loginId
      } else {
        resetPayload.email = loginId
      }

      const pwdError = getAuthPasswordRuleError(data.password)
      if (pwdError) {
        showFormMsg(pwdError, 'err')
        return
      }
      if (data.password !== data.confirmPassword) {
        showFormMsg('两次输入的密码不一致', 'err')
        return
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/reset-password', resetPayload)
        if (result.ok) {
          showAuthModal('login_password', {
            message: result.message || '密码已更新，请重新登录',
          })
        } else {
          showFormMsg(result.error || '重置失败，请稍后重试', 'err')
        }
      } catch (err) {
        showFormMsg('服务器连接失败，请检查网络后重试', 'err')
      } finally {
        setSubmitting(false)
      }
    }
  })

  mainContent.addEventListener('click', async (e) => {
    const target = e.target

    const courseRoute = target.closest('[data-course-route]')
    if (courseRoute) {
      navigate(courseRoute.dataset.courseRoute)
      return
    }

    const courseTrial = target.closest('[data-course-trial]')
    if (courseTrial) {
      if (!requireLogin()) return
      const firstFreeCourse = episodes.find((ep) => {
        const level = state.videoAccessMap[ep.id] || ep.accessLevel || 'free'
        const hasPlayableVideo = ep.hasStreamVideo || Boolean(ep.youtubeId)
        return level === 'free' && hasPlayableVideo && !isArticleEpisode(ep)
      })
      if (firstFreeCourse) {
        navigateToEpisode(firstFreeCourse)
      } else {
        navigate('home')
        requestAnimationFrame(() => document.querySelector('.tabs')?.scrollIntoView({ behavior: 'smooth' }))
      }
      return
    }

    const card = target.closest('.episode-card')
    if (card) {
      if (!requireLogin()) return
      const ep = episodes.find(ep => ep.id === parseInt(card.dataset.episodeId))
      if (!ep) return
      navigateToEpisode(ep)
      return
    }

    const progressItem = target.closest('.progress-item')
    if (progressItem) {
      if (!requireLogin()) return
      const ep = episodes.find(ep => ep.id === parseInt(progressItem.dataset.episodeId))
      if (ep) navigateToEpisode(ep)
      return
    }

    const historyItem = target.closest('.history-item')
    if (historyItem) {
      if (!requireLogin()) return
      const ep = episodes.find(ep => ep.id === parseInt(historyItem.dataset.episodeId))
      if (ep) navigateToEpisode(ep)
      return
    }

    const updateItem = target.closest('.update-item')
    if (updateItem && updateItem.dataset.updateTarget) {
      try {
        const t = JSON.parse(updateItem.dataset.updateTarget)
        if (t.type === 'episode') {
          if (!requireLogin()) return
          const ep = episodes.find(e => e.id === t.id)
          if (ep) navigateToEpisode(ep)
        } else if (t.type === 'category') {
          state.currentCategory = t.id
          navigate('home')
        } else if (t.type === 'path') {
          const loginReturnPath = getSafeLoginReturnPath(t.url)
          if (loginReturnPath) {
            openProtectedLoginPath(loginReturnPath)
            return
          }
          if (t.url === '/') navigate('home')
          else if (t.url === '/community') { if (!requireLogin()) return; navigate('community') }
          else if (t.url === '/trades') navigate('trades')
          else if (t.url === '/tools') { if (!requireLogin()) return; navigate('tools') }
          else if (t.url === '/membership') navigate('membership')
          else window.location.href = t.url
        }
      } catch (e) {
        console.error('invalid update target', e)
      }
      return
    }

    const tab = target.closest('.tab')
    if (tab) {
      state.currentCategory = tab.dataset.category
      renderHome()
      return
    }

    if (target.id === 'backHome') { navigate('home'); return }
    if (target.closest('.quotes-card')) { if (!requireLogin()) return; navigate('quotes'); return }

    const courseAttachmentButton = target.closest('[data-course-attachment-download]')
    if (courseAttachmentButton) {
      await downloadCourseAttachment(
        courseAttachmentButton.dataset.courseAttachmentDownload,
        courseAttachmentButton.dataset.courseAttachmentName,
        courseAttachmentButton,
      )
      return
    }

    if (target.id === 'goUpgrade' || target.id === 'goUpgrade2' || target.id === 'goUpgradeCommunity' || target.id === 'goUpgradeCommunityReplies') { navigate('membership'); return }
    if (target.id === 'goUpgradeVideo' || target.id === 'goUpgradeAttachments') { if (!state.user) { showAuthModal('login_password') } else { navigate('membership') }; return }

    // Membership: subscribe button — USDT payment
    if (target.closest('.mem-btn-plus, .mem-btn-pro')) {
      const btn = target.closest('.mem-btn-plus, .mem-btn-pro')
      if (!state.user) { showAuthModal('login_password'); return }
      const plan = btn.dataset.plan
      const card = btn.closest('.mem-card')
      const activeTab = card?.querySelector('.price-tab.active')
      const period = activeTab?.dataset.period || 'monthly'
      initiateCryptoPayment(plan, period)
      return
    }// Membership price toggle (月付/年付)
    const priceTab = target.closest('.price-tab')
    if (priceTab) {
      const card = priceTab.closest('.mem-card')
      if (!card) return
      const period = priceTab.dataset.period
      card.querySelectorAll('.price-tab').forEach(t => t.classList.remove('active'))
      priceTab.classList.add('active')
      const priceEl = card.querySelector('.mem-price')
      const originalEl = card.querySelector('.mem-price-original')
      const unitEl = card.querySelector('.mem-price-unit')
      const saveEl = card.querySelector('.mem-price-save')
      if (priceEl) priceEl.textContent = '$' + priceEl.dataset[period]
      if (originalEl) originalEl.textContent = '$' + originalEl.dataset[period]
      if (unitEl) unitEl.textContent = '/ ' + (period === 'monthly' ? '月' : '年')
      if (saveEl) saveEl.style.display = period === 'yearly' ? 'block' : 'none'
      return
    }

    const forumSortBtn = target.closest('[data-community-sort]')
    if (forumSortBtn) {
      const nextSort = forumSortBtn.dataset.communitySort
      if (!nextSort || nextSort === state.communitySort) return
      state.communitySort = nextSort
      state.communityPage = 1
      renderCommunity()
      return
    }

    const tagFilterBtn = target.closest('[data-tag-filter]')
    if (tagFilterBtn && (state.currentView === 'community' || state.currentView === 'post')) {
      state.communityTag = tagFilterBtn.dataset.tagFilter || ''
      state.communityPage = 1
      if (state.currentView === 'community') {
        renderCommunity()
      } else {
        navigate('community')
      }
      return
    }

    // Community: board tab switch
    const boardTab = target.closest('.board-tab')
    if (boardTab) {
      state.currentBoard = boardTab.dataset.board
      state.communityPage = 1
      renderCommunity()
      return
    }

    // Community: delete post (list or detail)
    const deleteBtn = target.closest('[data-delete-post]')
    if (deleteBtn) {
      const postId = deleteBtn.dataset.deletePost
      if (!confirm('确定要删除这篇帖子吗？删除后不可恢复。')) return
      try {
        const res = await api.del(`/api/posts?id=${postId}`)
        if (res.ok || res.success) {
          if (state.currentView === 'post') {
            navigate('community')
          } else {
            renderCommunity()
          }
        } else {
          showToast(res.error || '删除失败', 'error')
        }
      } catch (err) {
        console.error('Delete post error:', err)
        showToast('删除失败，请检查网络', 'error')
      }
      return
    }

    // Community: submit reply
    if (target.id === 'submitReplyBtn') {
      const input = document.getElementById('replyInput')
      const text = normalizePlainText(input?.value || '')
      if (!text && replyDraftImages.length === 0) return
      const btn = target
      btn.disabled = true
      btn.textContent = '发布中...'
      let uploadedAssetIds = []
      try {
        const payload = {
          postId: state.currentPost,
          content: text,
        }
        if (state.replyQuote?.id) {
          payload.quoteReplyId = state.replyQuote.id
        }

        if (replyDraftImages.length > 0) {
          const uploaded = await uploadReplyDraftImages(btn)
          uploadedAssetIds = uploaded.assetIds
          payload.assetIds = uploaded.assetIds
          payload.contentHtml = buildReplyContentHtml(text, uploaded.urls)
        }

        const res = await api.post('/api/post-replies', payload)
        if (res.success) {
          resetReplyQuote()
          renderPost()
        } else {
          await cleanupTemporaryPostImages(uploadedAssetIds)
          showToast(res.error || '发布失败', 'error')
          btn.disabled = false
          btn.textContent = '发布回复'
        }
      } catch (err) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        console.error('Submit reply error:', err)
        showToast(err?.message || '发布失败，请检查网络', 'error')
        btn.disabled = false
        btn.textContent = '发布回复'
      }
      return
    }

    if (target.id === 'clearReplyQuote') {
      resetReplyQuote()
      return
    }

    if (target.id === 'replyImageBtn') {
      document.getElementById('replyImageInput')?.click()
      return
    }

    const removeReplyImageBtn = target.closest('[data-remove-reply-image]')
    if (removeReplyImageBtn) {
      removeReplyDraftImage(removeReplyImageBtn.dataset.removeReplyImage)
      return
    }

    // Community: delete reply
    const deleteReplyBtn = target.closest('[data-delete-reply]')
    if (deleteReplyBtn) {
      if (!confirm('确定要删除这条回复吗？')) return
      const replyId = deleteReplyBtn.dataset.deleteReply
      try {
        const res = await api.del(`/api/post-replies?id=${replyId}`)
        if (res.success) {
          renderPost()
        } else {
          showToast(res.error || '删除失败', 'error')
        }
      } catch (err) {
        console.error('Delete reply error:', err)
        showToast('删除失败，请检查网络', 'error')
      }
      return
    }

    const openReplyQuoteBtn = target.closest('[data-open-reply-quote]')
    if (openReplyQuoteBtn) {
      const reply = state.currentReplies.find(item => item.id === openReplyQuoteBtn.dataset.openReplyQuote)
      if (reply) setReplyQuote(reply)
      return
    }

    const quoteJumpBtn = target.closest('[data-quote-reply]')
    if (quoteJumpBtn) {
      const el = document.querySelector(`[data-reply-id="${quoteJumpBtn.dataset.quoteReply}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('flash')
        setTimeout(() => el.classList.remove('flash'), 1200)
      }
      return
    }

    const reportReplyBtn = target.closest('[data-report-reply]')
    if (reportReplyBtn) {
      if (!requireLogin()) return
      const reason = prompt('请输入举报原因，例如：广告、辱骂、人身攻击、刷屏')
      if (!reason) return
      const detail = prompt('补充说明（选填）') || ''
      const res = await api.post('/api/post-reports', { replyId: reportReplyBtn.dataset.reportReply, reason, detail })
      showToast(res.ok ? (res.message || '举报已提交') : (res.error || '举报失败'), res.ok ? 'success' : 'error')
      return
    }

    // Community: click post card
    const postCard = target.closest('.post-card')
    if (postCard) {
      state.currentPost = postCard.dataset.postId
      state.replyPage = 1
      state.replyQuote = null
      navigate('post')
      return
    }

    // Community: pagination
    const pageBtn = target.closest('.page-btn')
    if (pageBtn && state.currentView === 'community') {
      const nextPage = Number(pageBtn.dataset.page)
      if (!Number.isFinite(nextPage) || nextPage === state.communityPage) return
      state.communityPage = nextPage
      renderCommunity()
      return
    }

    const replyPageBtn = target.closest('[data-reply-page]')
    if (replyPageBtn && state.currentView === 'post') {
      const nextPage = Number(replyPageBtn.dataset.replyPage)
      if (!Number.isFinite(nextPage) || nextPage === state.replyPage) return
      state.replyPage = nextPage
      renderPost()
      return
    }

    // Community: show create form
    if (target.id === 'showCreatePost') {
      const form = document.getElementById('createPostForm')
      if (form) {
        const nextVisible = form.style.display === 'none'
        form.style.display = nextVisible ? 'block' : 'none'
        if (nextVisible) {
          initCommunityEditor()?.focus()
        }
      }
      return
    }
    if (target.id === 'cancelCreatePost') {
      resetCommunityComposer()
      return
    }

    // Community: submit post
    if (target.id === 'submitPost') {
      const title = document.getElementById('postTitleInput')?.value?.trim()
      const tags = document.getElementById('postTagsInput')?.value || ''
      const editor = initCommunityEditor()
      const plainText = normalizePlainText(editor?.getText() || '')
      if (!title || !plainText) { showToast('标题和内容不能为空', 'error'); return }
      if ((editor?.root && getPostImageCount(editor.root) > MAX_POST_IMAGES)) {
        showToast(`最多上传 ${MAX_POST_IMAGES} 张图片`, 'error')
        return
      }
      const btn = target
      btn.disabled = true
      btn.textContent = '发布中...'
      const uploadedAssetIds = []
      try {
        const editorRoot = editor?.root?.cloneNode(true)
        if (!editorRoot) {
          throw new Error('编辑器初始化失败')
        }

        const newAssetIds = await uploadEditorImages(editorRoot, btn)
        uploadedAssetIds.push(...newAssetIds)

        const contentHtml = editorRoot.innerHTML
        const res = await api.post('/api/posts', {
          board: state.currentBoard,
          title,
          tags,
          contentHtml,
          contentText: plainText,
          assetIds: uploadedAssetIds,
        })
        if (res.ok || res.success) {
          resetCommunityComposer()
          state.communityPage = 1
          renderCommunity()
        } else {
          await cleanupTemporaryPostImages(uploadedAssetIds)
          showToast(res.error || '发帖失败', 'error')
          btn.disabled = false
          btn.textContent = '发布'
        }
      } catch (error) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        showToast(error?.message || '发帖失败，请检查网络', 'error')
        btn.disabled = false
        btn.textContent = '发布'
      }
      return
    }

    const postReportBtn = target.closest('[data-post-report]')
    if (postReportBtn) {
      if (!requireLogin()) return
      const reason = prompt('请输入举报原因，例如：广告、辱骂、人身攻击、刷屏')
      if (!reason) return
      const detail = prompt('补充说明（选填）') || ''
      const res = await api.post('/api/post-reports', { postId: postReportBtn.dataset.postReport, reason, detail })
      showToast(res.ok ? (res.message || '举报已提交') : (res.error || '举报失败'), res.ok ? 'success' : 'error')
      return
    }

    const postPinBtn = target.closest('[data-post-pin]')
    if (postPinBtn) {
      const res = await api.patch('/api/posts/pin', {
        postId: postPinBtn.dataset.postPin,
        sticky: postPinBtn.dataset.nextPin === '1',
      })
      if (!res.ok) {
        showToast(res.error || '操作失败', 'error')
        return
      }
      renderPost()
      return
    }

    const postFeatureBtn = target.closest('[data-post-feature]')
    if (postFeatureBtn) {
      const res = await api.patch('/api/posts/feature', {
        postId: postFeatureBtn.dataset.postFeature,
        featured: postFeatureBtn.dataset.nextFeature === '1',
      })
      if (!res.ok) {
        showToast(res.error || '操作失败', 'error')
        return
      }
      renderPost()
      return
    }

    const postLockBtn = target.closest('[data-post-lock]')
    if (postLockBtn) {
      const res = await api.patch('/api/posts/lock', {
        postId: postLockBtn.dataset.postLock,
        locked: postLockBtn.dataset.nextLock === '1',
      })
      if (!res.ok) {
        showToast(res.error || '操作失败', 'error')
        return
      }
      renderPost()
      return
    }

    const richImage = target.closest('.post-rich-image, .reply-rich-image')
    if (richImage && richImage.getAttribute('src')) {
      showPostImageLightbox(richImage.getAttribute('src'), richImage.getAttribute('alt') || '帖子图片')
      return
    }

    // Community: back to community
    if (target.id === 'backCommunity') { navigate('community'); return }
    if (target.id === 'backVideo' || target.id === 'backVideo2') { navigateToEpisode(state.currentEpisode); return }
    if (target.id === 'startQuiz') {
      if (!requireLogin()) return
      if (!isPaid() || !progress.get(state.currentEpisode.id)?.completed) return
      if (!getEpisodeContentEntry(state.currentEpisode.id)?.quizCount) return
      navigate('quiz'); return
    }
    if (target.id === 'showMindmap') {
      if (!requireLogin()) return
      if (!isPaid()) return
      if (!getEpisodeContentEntry(state.currentEpisode.id)?.mindmapCount) return
      navigate('mindmap'); return
    }
    if (target.id === 'showKnowledge') {
      if (!requireLogin()) return
      if (!isPaid()) return
      if (!getEpisodeContentEntry(state.currentEpisode.id)?.knowledgeCount) return
      navigate('knowledge'); return
    }
    if (target.id === 'commentLoginBtn') { showAuthModal('login_password'); return }

    // Profile page handlers
    if (target.id === 'saveNameBtn') {
      const nameInput = document.getElementById('profileName')
      if (nameInput && nameInput.value.trim()) {
        const newName = nameInput.value.trim()
        try {
          await api.put('/api/profile', { name: newName })
          state.user.name = newName
          localStorage.setItem('ws_user', JSON.stringify(state.user))
          updateAuthUI()
          showFormMsgProfile('用户名已更新', 'ok')
        } catch (err) {
          console.error('Name update error:', err)
          showFormMsgProfile('更新失败，请检查网络', 'err')
        }
      }
      return
    }

    if (target.id === 'goNextEp') {
      const nextEp = episodes.find(e => e.id === parseInt(target.dataset.nextId))
      if (nextEp) navigateToEpisode(nextEp)
      return
    }

    const option = target.closest('.quiz-option')
    if (option && !state.quizState.answered) {
      const selected = parseInt(option.dataset.option)
      const ep = state.currentEpisode
      const questions = courseContent.getCachedQuiz(ep.id) || []
      const q = questions[state.quizState.currentQuestion]
      if (!q) return
      state.quizState.answers[state.quizState.currentQuestion] = selected
      state.quizState.answered = true
      const isCorrect = selected === q.answer
      if (!isCorrect) {
        state.quizState.attempt++
        if (state.quizState.attempt >= 2) state.quizState.wrongCount++
      }
      renderQuiz()
      // 带解释/提示的题目停留在当前题，让用户读完后手动继续。
      if (isCorrect && !hasQuizInsight(q)) {
        setTimeout(() => {
          state.quizState.currentQuestion++
          state.quizState.answered = false
          state.quizState.attempt = 0
          renderQuiz()
        }, 800)
      }
      return
    }

    if (target.id === 'nextQ') {
      state.quizState.currentQuestion++
      state.quizState.answered = false
      state.quizState.attempt = 0
      renderQuiz()
      return
    }
    if (target.id === 'finishQuiz') {
      state.quizState.currentQuestion = (courseContent.getCachedQuiz(state.currentEpisode.id) || []).length
      renderQuiz()
      return
    }
    if (target.id === 'retryThis') {
      state.quizState.answered = false
      state.quizState.answers[state.quizState.currentQuestion] = undefined
      renderQuiz()
      return
    }
    if (target.id === 'retryQuiz') {
      state.quizState = { currentQuestion: 0, answers: [], answered: false, wrongCount: 0, attempt: 0 }
      renderQuiz()
      return
    }
  })

  mainContent.addEventListener('input', (e) => {
    if (e.target.id === 'replyInput') {
      updateReplyComposerMeta()
    }
  })

  mainContent.addEventListener('change', (e) => {
    if (e.target.id === 'replyImageInput') {
      handleReplyImageSelection(e.target.files)
      e.target.value = ''
    }
  })

  // ===== 回到顶部 浮动按钮（所有页面通用，滑动超过 400px 显示）=====
  if (!document.getElementById('backToTopBtn')) {
    const btn = document.createElement('button')
    btn.id = 'backToTopBtn'
    btn.className = 'back-to-top-btn'
    btn.setAttribute('aria-label', '回到顶部')
    btn.innerHTML = '↑'
    document.body.appendChild(btn)

    let ticking = false
    function updateVisibility() {
      if (window.scrollY > 400) btn.classList.add('visible')
      else btn.classList.remove('visible')
      ticking = false
    }
    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(updateVisibility)
        ticking = true
      }
    }, { passive: true })

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }
}

// ===== Start =====
window.__buildVersion = '20260701110000'
init().catch(err => {
  console.error('App init error:', err)
  courseCatalog.apply(staticEpisodes, 'static')
  renderView()
})
