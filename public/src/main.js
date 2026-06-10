import { episodes as staticEpisodes, categories } from './data/episodes.js'
import { siteUpdates } from './data/updates.js'
import { api } from './lib/api.js'
import { createCourseContent } from './lib/course-content.js'
import Quill from 'https://esm.sh/quill@2.0.3'
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
      status: item.status || 'published',
      sortOrder: Number(item.sortOrder || item.sort_order || id),
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

function formatMinorUsd(cents) {
  const value = Number(cents || 0)
  return `$${(Math.max(0, value) / 100).toFixed(2)}`
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
      alert('回复仅支持 JPEG、PNG、WebP、GIF 图片')
      continue
    }

    if (file.size > MAX_POST_IMAGE_BYTES) {
      alert('单张图片不能超过 5MB')
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
    alert(`最多上传 ${MAX_POST_IMAGES} 张图片`)
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > MAX_POST_IMAGE_BYTES) {
      alert('单张图片不能超过 5MB')
      return
    }
    if (getPostImageCount(editor.root) >= MAX_POST_IMAGES) {
      alert(`最多上传 ${MAX_POST_IMAGES} 张图片`)
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

// ===== 街哥语录 =====
const allQuotes = [
  '太阳底下没有新鲜事，人性不会变，大多数人会在类似的位置犯同样的错。',
  '放弃太拥挤的交易，大多数时间假突破后参与反向，比追突破胜率高。',
  '任何交易在参与之前都要想好在哪挂止损或者亏本金的多少钱止损。',
  '左侧交易是试图改变运动方向，右侧交易是试图跟随运动方向。',
  '头寸上大多数时间要保持空仓，才能客观的看待市场。',
  '买在无人问津，卖在人声鼎沸。',
  '不要下重注，持仓不要高于总资金的10%，不要加大杠杆，这是概率游戏，细水长流，站在概率的一方，才可能赚钱，否则必亏。',
  '正常走势：会技术的和庄家一起推动盘面，收割不懂技术的韭菜。非正常走势：不懂技术的韭菜爆完了，再收割"到位了"的那些懂技术的人。',
  '世界经济史是一部基于假象和谎言的连续剧。要获得财富，做法就是认清其假象，投入其中，然后在假象被公众认识之前退出游戏。',
  '当你认为一定会挣钱的时候，亏损就会来临。',
  '再优秀的交易者都无法避免对行情的预测，交易区别于赌博正是在于通过对行情的预测和把握能够达到正预期，只是会及时向市场低头，不会陷入执念罢了。',
  '当个人是一个孤立的个体时，他有着自己鲜明的个性化特征，而当这个人融入了群体后，他的所有个性都会被这个群体所淹没，他的思想立刻就会被群体的思想所取代。',
  '关于技术分析，真的不存在所谓的"屠龙之术"，学会就可以一劳永逸了。',
  'Buy the rumor，sell the news。买消息，卖事实。',
  '市场情绪高涨的时候，极其乐观没有人敢做空，流动性最好，是现货跑路的好时机。',
  '交易是一场反人性的赌博，而市场没有对错，需以各路分析师为镜，可以正观点明多空找反指。',
  '是标的和趋势成就人，而不是人成就标的。一流标的成就一流的人，敢于参与核心标的。最终会发现，80%的收益来自于一次战役。',
  '交易一开始是看到机会，再后面是表达机会，再后面是品味机会。品味机会在于等待与选择，品味在于不干什么。',
  '财富会呆在令人意想不到的那一边。',
  '一个人持续亏钱，从来都不会是因为"一无所知"，只会是"屡教不改"。',
  '大部分交易是完全不值得参与的，并且会让人失去对趋势的判断力。',
  '在某个年纪之前，可以靠透支身体、小聪明和老天给的运气，一直取巧地活着。然而到了某个年纪之后，真正能让我们走远的，都是自律、积极和认知补足。',
  '每次大行情都会有人封神，但是没有谁可以永远对。高手和平庸者的区别在于，看对的行情心狠手辣赚的盆满钵满，看错的行情一样心狠手辣割完就跑。韭菜呢，看对的行情不敢拿，做错的行情死扛。',
  '没有人天生是赌鬼，每一个赌鬼都起源于赢小钱。',
  '市场永远是爸爸，我每次以为我是高手的时候，就是该被抽耳光爆仓的时候了。',
  '在华尔街，做空的人能赚钱，做多的人也能赚钱，唯独贪婪的人永远赚不到钱。',
  '赚钱了一定要舍得离开赌桌。',
  '做交易要懂得随缘，别想着每一段都吃到，跟你谈恋爱一样选跟你最舒服的那个人在一起。',
  '如果你在一个标的上屡次亏钱，就放弃，不要想着捞回来，同理你在一个女人上屡次栽跟头就结束这段关系。',
  '敢于接受自己的失败，承认市场是对的，你的交易会上升一个高度。',
  '该来的行情自然会来，不该来的永远不会来，别把你预测的行情当成一定发生的事件，不要通过预测证明自己，要通过盈利证明自己。',
  '在金融这场大型游戏里，你永远猜不到未来会发生什么。',
  '你可以犯错，但是不能在同一个地方屡次犯错。',
  '做多年轻人，就是做多整个世界。',
]

// ===== State =====
const state = {
  currentView: 'home',
  currentEpisode: null,
  currentCategory: 'all',
  sortOrder: 'latest',
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
  adminCourses: [],
  adminQuizQuestions: [],
  adminQuizEpisodeId: null,
  replyPage: 1,
  replyTotal: 0,
  replyTotalPages: 1,
  replyQuote: null,
  notificationUnread: 0,
  paidVideoEpisodes: [], // episode IDs with CF Stream paid videos
  videoAccessMap: {},    // { episodeId: access_level } — universal access control
  adminRefreshTimer: null, // admin page auto-refresh timer
  authMode: 'login_password',
  authPrefillEmail: '',
  authRedirectAfterLogin: null,
  referralInviteCode: '',
  paymentStatus: null,
}

const AUTH_COOKIE_NAME = 'ws_token'
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const PUBLIC_ALPHA_GROUP_URL = 'https://t.me/+Y6g4eA6DkXllOGNl'
const PUBLIC_ALPHA_NOTICE_ID = 'public-alpha-group-2026-05-28'
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
  '/membership',
  '/quotes',
  '/admin',
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

let publicAlphaNoticeVisible = false
let publicAlphaNoticeChecking = false

function getPublicAlphaNoticeStorageKey(user = state.user) {
  const identity = user?.uid || user?.email || user?.id
  if (!identity) return ''
  return `ws_notice_${PUBLIC_ALPHA_NOTICE_ID}:${identity}`
}

function hasSeenPublicAlphaNotice(user = state.user) {
  const key = getPublicAlphaNoticeStorageKey(user)
  return Boolean(key && localStorage.getItem(key) === '1')
}

function markPublicAlphaNoticeSeen(user = state.user) {
  const key = getPublicAlphaNoticeStorageKey(user)
  if (key) localStorage.setItem(key, '1')
}

function syncPublicAlphaNoticeSeenToServer(source = 'local-sync') {
  if (!hasClientAuth()) return
  api.post('/api/user-notices', {
    noticeId: PUBLIC_ALPHA_NOTICE_ID,
    source,
  }).catch(() => {})
}

async function consumePublicAlphaNotice() {
  if (!hasClientAuth()) return false

  if (hasSeenPublicAlphaNotice()) {
    syncPublicAlphaNoticeSeenToServer('local-sync')
    return false
  }

  try {
    const result = await api.post('/api/user-notices', {
      noticeId: PUBLIC_ALPHA_NOTICE_ID,
      source: 'popup',
    })

    if (result?.ok && result.shouldShow === true) {
      markPublicAlphaNoticeSeen()
      return true
    }

    if (result?.ok && result.shouldShow === false) {
      markPublicAlphaNoticeSeen()
      return false
    }
  } catch (err) {
    console.warn('Public alpha notice server state unavailable:', err)
  }

  // Fail closed for repeat spam: if the API is temporarily unavailable, still
  // mark this browser as consumed before showing the announcement once.
  markPublicAlphaNoticeSeen()
  return true
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function closePublicAlphaNotice() {
  const overlay = document.getElementById('publicAlphaNoticeOverlay')
  if (!overlay) return
  overlay.classList.remove('active')
  setTimeout(() => {
    overlay.remove()
    publicAlphaNoticeVisible = false
  }, 220)
}

async function maybeShowPublicAlphaNotice() {
  if (!hasClientAuth() || publicAlphaNoticeVisible || publicAlphaNoticeChecking) return

  publicAlphaNoticeChecking = true
  const shouldShow = await consumePublicAlphaNotice()
  publicAlphaNoticeChecking = false

  if (!shouldShow || !hasClientAuth() || publicAlphaNoticeVisible) return
  publicAlphaNoticeVisible = true

  const overlay = document.createElement('div')
  overlay.className = 'alpha-notice-overlay'
  overlay.id = 'publicAlphaNoticeOverlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'publicAlphaNoticeTitle')
  overlay.innerHTML = `
    <div class="alpha-notice-card">
      <div class="alpha-notice-kicker">公开群聊提醒</div>
      <h2 id="publicAlphaNoticeTitle">华尔街没有名字公开alpha群聊</h2>
      <p class="alpha-notice-copy">公开 Alpha 群用于同步公开市场观察、站内更新和群聊讨论。你可以复制链接保存，也可以直接跳转加入。</p>
      <div class="alpha-notice-link" aria-label="Telegram 群链接">${escapeHtml(PUBLIC_ALPHA_GROUP_URL)}</div>
      <div class="alpha-notice-actions">
        <button type="button" class="btn btn-ghost alpha-copy-btn" id="publicAlphaCopyBtn">点击复制链接</button>
        <button type="button" class="btn btn-primary alpha-join-btn" id="publicAlphaJoinBtn">点击加入群聊</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const copyBtn = overlay.querySelector('#publicAlphaCopyBtn')
  const joinBtn = overlay.querySelector('#publicAlphaJoinBtn')

  copyBtn?.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(PUBLIC_ALPHA_GROUP_URL)
      markPublicAlphaNoticeSeen()
      syncPublicAlphaNoticeSeenToServer('copy')
      copyBtn.textContent = '已复制'
      setTimeout(closePublicAlphaNotice, 450)
    } catch {
      copyBtn.textContent = '复制失败，请长按链接复制'
    }
  })

  joinBtn?.addEventListener('click', () => {
    markPublicAlphaNoticeSeen()
    syncPublicAlphaNoticeSeenToServer('join')
    closePublicAlphaNotice()
    const opened = window.open(PUBLIC_ALPHA_GROUP_URL, '_blank')
    if (opened) opened.opener = null
    if (!opened) window.location.href = PUBLIC_ALPHA_GROUP_URL
  })

  requestAnimationFrame(() => overlay.classList.add('active'))
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
  return user?.planExpiresAt || user?.plan_expires_at || ''
}

function isPlanActiveClient(user = state.user) {
  if (!user || !user.plan || user.plan === 'free') return false
  const expiresAt = getPlanExpiresAt(user)
  if (!expiresAt) return false
  const expiresTime = new Date(`${expiresAt}T23:59:59+08:00`).getTime()
  return Number.isFinite(expiresTime) && expiresTime >= Date.now()
}

function getEffectivePlan(user = state.user) {
  const plan = user?.plan || 'free'
  if (plan === 'plus' || plan === 'pro') {
    return isPlanActiveClient(user) ? plan : 'free'
  }
  return plan
}

async function refreshCurrentUserProfile({ rerender = false, syncTelegram = false, showPublicAlphaNotice = false } = {}) {
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
      if (rerender || state.paymentStatus === 'success' || planChanged || adminChanged || bindingChanged) renderView()
      if (showPublicAlphaNotice) setTimeout(maybeShowPublicAlphaNotice, 320)
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

// ===== Admin Auto-Refresh (60s) =====
function startAdminAutoRefresh() {
  stopAdminAutoRefresh()
  state.adminRefreshTimer = setInterval(() => {
    if (state.currentView !== 'admin') { stopAdminAutoRefresh(); return }
    const tasks = [loadAdminCourses(), loadAdminReferrals(), loadAdminConfig()]
    Promise.allSettled(tasks).catch(() => {})
  }, 60000)
}

function stopAdminAutoRefresh() {
  if (state.adminRefreshTimer) {
    clearInterval(state.adminRefreshTimer)
    state.adminRefreshTimer = null
  }
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
        user: c.user || { name: 'Unknown', email: '' },
        text: c.text,
        timestamp: c.timestamp ? new Date(c.timestamp).getTime() : Date.now(),
        likes: c.isLiked ? [state.user?.email] : [],
        _likeCount: c.likes || 0,
        _isLiked: c.isLiked || false,
        replies: (c.replies || []).map(r => ({
          id: r.id,
          user: r.user || { name: 'Unknown', email: '' },
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
      alert('发布评论失败，请检查网络后重试')
    }
  },

  async delete(episodeId, index) {
    const data = this._getData()
    const comment = data[episodeId]?.[index]
    if (!comment?.id) return
    if (!state.user || comment.user.email !== state.user.email) return
    try {
      await api.del(`/api/comments?id=${comment.id}`)
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Delete comment error:', err)
      alert('删除评论失败，请检查网络后重试')
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
      alert('回复失败，请检查网络后重试')
    }
  },

  // 删除回复
  async deleteReply(episodeId, commentIndex, replyIndex) {
    const data = this._getData()
    const reply = data[episodeId]?.[commentIndex]?.replies?.[replyIndex]
    if (!reply?.id) return
    if (!state.user || reply.user.email !== state.user.email) return
    try {
      await api.del(`/api/comments?id=${reply.id}`)
      await this.fetchFromServer(episodeId)
      if (state.currentView === 'video' && state.currentEpisode?.id === episodeId) renderVideo()
    } catch (err) {
      console.error('Delete reply error:', err)
      alert('删除回复失败，请检查网络后重试')
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

// ===== YouTube Player =====
let ytPlayer = null
let watchTimer = null
let accumulatedTime = 0

const ytReady = new Promise(resolve => {
  if (window.YT && window.YT.Player) { resolve(); return }
  window.onYouTubeIframeAPIReady = resolve
  const tag = document.createElement('script')
  tag.src = 'https://www.youtube.com/iframe_api'
  document.head.appendChild(tag)
})

// ===== Bilibili Player =====
let biliPlayer = null
const biliDurationCache = {}

function fetchBiliDuration(bvid, epId) {
  api.get(`/api/bilibili-duration/${bvid}`).then(r => {
    if (r.ok && r.duration) {
      biliDurationCache[epId] = r.duration
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

  // Bilibili embed iframe
  container.innerHTML = '<iframe id="biliPlayer" src="//player.bilibili.com/player.html?bvid=' + bvid + '&high_quality=1&danmaku=0" allowfullscreen allow="autoplay; encrypted-media" style="width:100%;height:100%;border:none;"></iframe>'

  biliPlayer = document.getElementById('biliPlayer')
  // Bilibili doesn't have a JS API for progress tracking,
  // so we use a timer-based approach
  startWatchTimer()
}

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
  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null }
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
    // YouTube or CF Stream has native duration; Bilibili uses episode duration
    const nativeDuration = ytPlayer?.getDuration?.() || 0
    const duration = nativeDuration || getEpisodeDuration()
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

async function initYouTubePlayer(videoId) {
  await ytReady

  const ep = state.currentEpisode
  if (ep) {
    const p = progress.get(ep.id)
    accumulatedTime = p.watchedSeconds || 0
  }

  ytPlayer = new YT.Player('ytPlayer', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        const duration = ytPlayer.getDuration()
        if (ep && state.user) {
          const entry = progress.get(ep.id)
          updateProgressUI({ ...entry, totalDuration: duration }, duration)
        }
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          startWatchTimer()
        } else {
          stopWatchTimer()
        }
      },
    },
  })
}

// ===== DOM References =====
const $ = (sel) => document.querySelector(sel)
const mainContent = $('#mainContent')
const modalOverlay = $('#modalOverlay')
const modalTitle = $('#modalTitle')
const modalBody = $('#modalBody')
let authModalBackdropPress = false

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
  if (paymentStatus) {
    // Clean URL
    window.history.replaceState({}, '', '/')
    state.currentView = 'home'
    if (paymentStatus === 'success') {
      setTimeout(() => {
        alert('🎉 支付成功！你的会员已升级，请重新登录以刷新状态。')
      }, 500)
    } else if (paymentStatus === 'failed') {
      setTimeout(() => {
        alert('支付未完成，如有问题请联系客服。')
      }, 500)
    }
  } else {
    // Restore view from URL path on initial load
    const route = pathToRoute(window.location.pathname)
    state.currentView = route.view
    if (route.episode) state.currentEpisode = route.episode
    if (route.postId) state.currentPost = route.postId
    const routePath = route.canonicalPath || window.location.pathname
    if (isLoginRequiredAppPath(routePath) && !hasClientAuth()) {
      initialLoginNext = routePath
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
      initialLoginNext ? '/' : routePath
    )
  }

  renderView()
  updateAuthUI()
  setupGlobalEvents()
  startPresenceHeartbeat()
  loadMarketMenu()
  if (await handleAuthGateRedirect(authGateNext) === 'redirect') return
  if (!authGateNext && initialLoginNext) {
    showLoginRequiredModal(initialLoginNext)
  }

  courseContent.loadManifest().then(() => {
    if (shouldRerenderForCourseManifest()) renderView()
  }).catch(() => {})

  // Load video access map (public, no sensitive data — only episode IDs + access_level)
  api.get('/api/video-stream').then(r => {
    if (r.episodes) {
      state.paidVideoEpisodes = r.episodes.map(e => e.id)
      state.videoAccessMap = {}
      r.episodes.forEach(e => { state.videoAccessMap[e.id] = e.access_level || 'plus_pro' })
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
    refreshCurrentUserProfile({ showPublicAlphaNotice: true }).catch(() => {})
  }
}

// ===== Routing =====
function renderView() {
  switch (state.currentView) {
    case 'home': renderHome(); break
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
    case 'admin': renderAdmin(); break
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
  return ep.number ? `进入第${ep.number}期` : `进入${escapeHtml(ep.title)}`
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
    case 'article': return episode ? `/article/${episode.id}` : '/article'
    case 'video': return episode ? `/video/${episode.id}` : '/video'
    case 'quiz': return state.currentEpisode ? `/quiz/${state.currentEpisode.id}` : '/quiz'
    case 'knowledge': return state.currentEpisode ? `/knowledge/${state.currentEpisode.id}` : '/knowledge'
    case 'mindmap': return state.currentEpisode ? `/mindmap/${state.currentEpisode.id}` : '/mindmap'
    case 'trades': return '/trades'
    case 'tools': return '/tools'
    case 'community': return '/community'
    case 'post': return state.currentPost ? `/post/${state.currentPost}` : '/community'
    case 'profile': return '/profile'
    case 'membership': return '/membership'
    case 'quotes': return '/quotes'
    case 'tos': return '/tos'
    case 'admin': return '/admin'
    default: return '/'
  }
}

function pathToRoute(path) {
  const clean = path.replace(/\/$/, '') || '/'
  if (clean === '/') return { view: 'home' }
  if (clean === '/trades') return { view: 'trades' }
  if (clean === '/tools') return { view: 'tools' }
  if (clean === '/community') return { view: 'community' }
  if (clean === '/profile') return { view: 'profile' }
  if (clean === '/membership') return { view: 'membership' }
  if (clean === '/quotes') return { view: 'quotes' }
  if (clean === '/tos') return { view: 'tos' }
  if (clean === '/admin') return { view: 'admin' }

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
  stopAdminAutoRefresh()
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
  const isMobileHome = window.matchMedia('(max-width: 1024px)').matches
  const statsHtml = renderSidebarStats()
  const quotesHtml = renderSidebarQuotes()
  const updatesHtml = renderSidebarUpdates()
  const historyHtml = renderSidebarHistory()
  const mobileBelowCoursesHtml = `${updatesHtml}${historyHtml}${quotesHtml}${statsHtml}`
  const sidebarHtml = `${statsHtml}${quotesHtml}${updatesHtml}${historyHtml}`

  mainContent.innerHTML = `
    <div class="home-layout fade-in">
      <div class="home-main">
        ${!isMobileHome ? `
        <div class="home-quotes">
          <p class="quote-hero">做空的人能赚钱，做多的人也能赚钱，<br>唯独<span class="quote-gold">贪婪</span>的人永远赚不到钱。</p>
          <div class="quote-divider"></div>
          <p class="quote-detail"><span class="quote-label">正常走势</span>会技术的和主力一起推动盘面，收割不懂技术的韭菜</p>
          <p class="quote-detail"><span class="quote-label quote-label-warn">非正常走势</span>不懂技术的韭菜爆完了，再收割"到位了"的那些懂技术的人</p>
          <a href="https://x.com/WallStreet0Name" target="_blank" rel="noopener noreferrer" class="quote-author">— 华尔街没有名字 ↗</a>
        </div>
        ` : ''}

        <div class="tabs">
          ${categories.map(cat => `
            <button class="tab ${state.currentCategory === cat.id ? 'active' : ''}" data-category="${cat.id}">
              ${cat.name}
            </button>
          `).join('')}
        </div>

        ${state.currentCategory === 'all' ? `
        <div class="sort-bar">
          <button class="sort-btn ${state.sortOrder === 'default' ? 'active' : ''}" data-sort="default">默认</button>
          <button class="sort-btn ${state.sortOrder === 'latest' ? 'active' : ''}" data-sort="latest">最新</button>
        </div>
        ` : ''}

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

}

function getCardBackground(ep) {
  if (ep.cover) return `background-image: url('${ep.cover}'); background-size: cover; background-position: center;`
  if (ep.youtubeId) return `background-image: url('https://img.youtube.com/vi/${ep.youtubeId}/hqdefault.jpg'); background-size: cover; background-position: center;`
  return `background: ${ep.gradient};`
}

function renderEpisodeCard(ep) {
  const hasPaidVideo = ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)
  const hasCover = ep.cover || ep.youtubeId || hasPaidVideo
  const completed = state.user && progress.isCompleted(ep.id)
  const quizPassed = state.user && progress.isQuizPassed(ep.id)
  const locked = state.user && !progress.isUnlocked(ep.id)
  const percent = state.user ? progress.getPercent(ep.id) : 0
  const accessBadge = getAccessBadge(ep.id)

  return `
    <div class="episode-card ${completed ? 'completed' : ''} ${locked ? 'locked' : ''}" data-episode-id="${ep.id}">
      <div class="card-thumbnail">
        <div class="card-thumbnail-bg" style="${getCardBackground(ep)}">
          ${!hasCover && ep.number ? `
            <span class="ep-label">EP</span>
            <span class="ep-number">${String(ep.number).padStart(2, '0')}</span>
          ` : ''}
          ${locked ? '<div class="card-lock-overlay"><span class="lock-icon">🔒</span></div>' : ''}
        </div>
        ${ep.youtubeId || ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id) ? `<span class="card-duration">${ep.duration}</span>` : ''}
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
  const shuffled = [...allQuotes].sort(() => Math.random() - 0.5)
  const sidebarQuotes = shuffled.slice(0, 5)

  return `
    <div class="sidebar-card sidebar-quote-card quotes-card" style="cursor:pointer">
      <h3>街哥语录</h3>
      <ul class="sidebar-quote-list">
        ${sidebarQuotes.map((q, i) => `
          <li class="sidebar-quote-item">
            <span class="sidebar-quote-num">${allQuotes.indexOf(q) + 1}</span>
            <span class="sidebar-quote-text">${q.length > 30 ? q.substring(0, 30) + '...' : q}</span>
          </li>
        `).join('')}
      </ul>
      <div class="sidebar-quote-more">查看全部 ${allQuotes.length} 条语录 →</div>
    </div>
  `
}

function renderSidebarUpdates() {
  if (!siteUpdates || siteUpdates.length === 0) return ''
  const items = siteUpdates.slice(0, 8)
  const now = new Date()

  return `
    <div class="sidebar-card sidebar-updates-card">
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

function hasEpisodeVideo(ep) {
  return Boolean(ep?.youtubeId) || Boolean(ep?.hasStreamVideo) || state.paidVideoEpisodes.includes(ep?.id)
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
      return ARTICLE_THEME_URL_CANDIDATES[0]
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
  if (!link) {
    link = doc.createElement('link')
    link.id = 'wsArticleTheme'
    link.rel = 'stylesheet'
    doc.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) {
    link.setAttribute('href', href)
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
          ? ((!ep.youtubeId && !hasPaidVideo)
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

function renderEpisodeDetailShell({ ep, viewClass, mediaHtml, showProgress }) {
  const progressRecord = state.user ? progress.get(ep.id) : null
  const percent = progressRecord
    ? Math.min(100, Math.round((progressRecord.watchedSeconds / (progressRecord.totalDuration || 1)) * 100))
    : 0

  mainContent.innerHTML = `
    <div class="${viewClass} fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

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

      <div class="video-info">
        <h1 class="video-title">${ep.number ? `第${ep.number}期 · ` : ''}${escapeHtml(ep.title)}</h1>
        <p class="video-description">${escapeHtml(ep.description)}</p>
        ${renderEpisodeActions(ep, progressRecord)}
      </div>
    </div>
  `
}

function getFilteredEpisodes() {
  let list
  if (state.currentCategory === 'all') {
    // 视频课程：显示有YouTube视频或CF Stream付费视频的
    // 视频课程分类：文章课程即使挂了视频讲解也不混入此列表
    list = episodes.filter(ep => !isArticleEpisode(ep) && (ep.youtubeId || ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)))
    if (state.sortOrder === 'latest') {
      list = [...list].sort((a, b) => b.number - a.number)
    } else {
      list = [...list].sort((a, b) => a.number - b.number)
    }
  } else {
    // 其他分类：文章课程始终保留；无视频的占位课程也显示
    list = episodes.filter(ep => ep.category === state.currentCategory && (isArticleEpisode(ep) || (!ep.youtubeId && !ep.hasStreamVideo && !state.paidVideoEpisodes.includes(ep.id))))
  }
  return list
}

function renderArticle() {
  const ep = state.currentEpisode
  if (!ep) return navigate('home')
  if (!isArticleEpisode(ep)) return renderVideo()

  const hasPaidVideo = state.paidVideoEpisodes.includes(ep.id)
  const hasAccess = canAccessVideo(ep.id)

  renderEpisodeDetailShell({
    ep,
    viewClass: 'article-view',
    showProgress: state.user && hasPaidVideo && hasAccess,
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
      <div class="article-container" id="articleContainer">
        <div class="article-loading">正在加载文章...</div>
        <iframe
          class="article-frame"
          id="articleFrame"
          title="${escapeHtml(ep.title)}"
          src="${ep.articleUrl}"
          loading="eager"
          scrolling="no"
        ></iframe>
      </div>
    `,
  })

  initArticleFrame(ep)

  // 若当前用户可观看该文章配套视频，则拉取 CF Stream 并嵌入播放
  if (hasPaidVideo && hasAccess) {
    api.get(`/api/video-stream?episode=${ep.id}`).then(r => {
      if (state.currentEpisode?.id !== ep.id) return
      if (!r.ok) throw new Error(r.error || '视频加载失败')

      // Priority: Bilibili > Local > Qiniu > YouTube
      if (r.bilibiliId) {
        initBiliPlayer(r.bilibiliId)
      } else if (r.localPath) {
        initLocalPlayer(r.localPath)
      } else if (r.qiniuKey) {
        const domain = r.qiniuDomain || ''
        initQiniuPlayer(domain + '/' + r.qiniuKey)
      } else if (r.youtubeId) {
        initYouTubePlayer(r.youtubeId)
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
        container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;margin-bottom:12px;">视频加载失败</p><button class="btn btn-primary" onclick="location.reload()">点击重试</button></div></div>'
      }
    }).catch(err => {
      console.error('CF Stream fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = `<div class="video-placeholder" style="background:var(--bg-secondary)">
          <div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <p style="font-size:16px;margin-bottom:12px;">视频加载失败</p>
            <button class="btn btn-primary" onclick="location.reload()">点击重试</button>
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
  if (!_hasPaid && ep.youtubeId && ytPlayer) return

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
          <h3 class="warning-title">街哥警告</h3>
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
    showProgress: state.user && (ep.youtubeId || (hasPaidVideo && hasAccess)),
    mediaHtml: (() => {
      if (!ep.youtubeId && !hasPaidVideo) return ''
      return `<div class="video-container" id="videoContainer">
        ${hasPaidVideo && hasAccess
          ? `<div class="video-placeholder" style="background: ${ep.gradient}" id="cfVideoLoading">
              <span style="color:rgba(255,255,255,0.7);font-size:14px;">正在加载视频...</span>
            </div>`
          : ep.youtubeId && !hasPaidVideo
            ? (hasAccess
              ? '<div id="ytPlayer"></div>'
              : `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                  <div class="video-lock-icon">🔒</div>
                  <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '登录后可观看')}</h3>
                  <p class="video-lock-text">请先登录后查看</p>
                  <button class="btn btn-primary" id="goUpgradeVideo">登录</button>
                </div>`)
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
        if (container) {
          container.innerHTML = '<iframe id="biliPlayer" src="//player.bilibili.com/player.html?bvid=' + r.bilibiliId + '&high_quality=1&danmaku=0" allowfullscreen allow="autoplay; encrypted-media" style="width:100%;height:100%;border:none;"></iframe>'
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
      } else if (r.youtubeId) {
        initYouTubePlayer(r.youtubeId)
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
            <button class="btn btn-primary" onclick="location.reload()">点击重试</button>
          </div>
        </div>`
      }
    })
  } else if (ep.youtubeId && hasAccess) {
    initYouTubePlayer(ep.youtubeId)
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
          <h2>课后测试${ep.number ? ` · 第${ep.number}期` : ''}</h2>
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
        <h1 class="quotes-title">街哥语录</h1>
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
        <h2>${ep.number ? `第${ep.number}期 · ` : ''}知识点</h2>
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
      <h2>${ep.number ? `第${ep.number}期 · ` : ''}知识点</h2>
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
        <h2>${ep.number ? `第${ep.number}期 · ` : ''}思维导图与知识点</h2>
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
      <h2>${ep.number ? `第${ep.number}期 · ` : ''}思维导图与知识点</h2>
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
function renderAdmin() {
  if (!isAdmin()) return navigate('home')

  // Show loading state
  mainContent.innerHTML = `
    <div class="admin-dashboard fade-in">
      <button class="back-btn" id="backHome">← 返回首页</button>
      <h1 class="admin-title">📊 管理后台</h1>
      <div class="loading-spinner" style="padding:60px 0;text-align:center;">加载数据中...</div>
    </div>
  `
  document.getElementById('backHome')?.addEventListener('click', () => navigate('home'))

  // Fetch real data from backend
  api.get('/api/admin-users').then(data => {
    if (!data.ok || !data.stats) {
      mainContent.querySelector('.loading-spinner').textContent = '加载失败: ' + (data.error || '未知错误')
      return
    }
    renderAdminContent(data)
    startAdminAutoRefresh()
  })
}

function renderCourseOptionList(selectedId = '') {
  const list = state.adminCourses.length ? state.adminCourses : episodes
  return list
    .slice()
    .sort((a, b) => (a.sortOrder || a.id) - (b.sortOrder || b.id))
    .map(ep => {
      const label = `${ep.number ? `第${ep.number}期 · ` : `#${ep.id} · `}${ep.title}`
      return `<option value="${ep.id}" ${Number(selectedId) === ep.id ? 'selected' : ''}>${escapeHtml(label)}</option>`
    }).join('')
}

function renderAdminCourseSection() {
  return `
    <div class="admin-section" id="adminCourseManager">
      <div class="admin-section-header">
        <h2>课程管理</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-ghost btn-xs" id="refreshAdminCourses">刷新</button>
          <button class="btn btn-primary btn-sm" id="addCourseBtn">+ 新增课程</button>
        </div>
      </div>
      <div id="adminCourseList"></div>
      <div class="stream-upload-result" id="adminCourseResult" style="display:none"></div>
    </div>
  `
}

function renderAdminQuizSection() {
  return `
    <div class="admin-section" id="adminQuizManager">
      <div class="admin-section-header">
        <h2>题库管理</h2>
      </div>
      <div class="stream-upload-form admin-quiz-toolbar">
        <select class="stream-input" id="adminQuizEpisode">
          ${renderCourseOptionList(state.adminQuizEpisodeId || episodes[0]?.id || '')}
        </select>
        <button class="btn btn-primary" id="loadAdminQuiz" type="button">加载题目</button>
      </div>
      <form class="admin-cms-form" id="adminQuizForm">
        <input type="hidden" id="quizQuestionId">
        <div class="admin-cms-grid">
          <label>排序<input class="stream-input" id="quizSortOrder" type="number" min="0" value="0"></label>
          <label>正确答案
            <select class="stream-input" id="quizAnswer">
              <option value="0">A</option>
              <option value="1">B</option>
              <option value="2">C</option>
              <option value="3">D</option>
            </select>
          </label>
          <label>状态
            <select class="stream-input" id="quizStatus">
              <option value="published">已发布</option>
              <option value="draft">草稿</option>
              <option value="archived">已归档</option>
            </select>
          </label>
        </div>
        <label>题干<textarea class="stream-input admin-cms-textarea" id="quizQuestion" rows="2" required></textarea></label>
        <label>选项（每行一个）<textarea class="stream-input admin-cms-textarea" id="quizOptions" rows="4" required></textarea></label>
        <label>逐项解析（每行对应一个选项）<textarea class="stream-input admin-cms-textarea" id="quizExplanations" rows="4"></textarea></label>
        <label>通用解释<textarea class="stream-input admin-cms-textarea" id="quizExplanation" rows="2"></textarea></label>
        <label>提示<textarea class="stream-input admin-cms-textarea" id="quizHint" rows="2"></textarea></label>
        <div class="admin-cms-actions">
          <button class="btn btn-primary" type="submit">保存题目</button>
          <button class="btn btn-ghost" id="resetAdminQuiz" type="button">清空题目</button>
        </div>
        <div class="stream-upload-result" id="adminQuizResult" style="display:none"></div>
      </form>
      <div id="adminQuizList" class="admin-quiz-list">
        <div class="comments-empty">选择课程后加载题目</div>
      </div>
    </div>
  `
}

function renderAdminContent(data) {
  const { stats, users: userList } = data
  const realtimeOnlineUsers = Number(stats.realtimeOnlineUsers || 0)
  const todayOnlineUsers = Number(stats.todayOnlineUsers || 0)
  const weekOnlineUsers = Number(stats.weekOnlineUsers || 0)
  const realtimeWindowMinutes = Number(stats.realtimeWindowMinutes || 5)
  const plusUsers = userList.filter(u => u.plan === 'plus')
  const proUsers = userList.filter(u => u.plan === 'pro')
  const memberUsers = userList.filter(u => u.plan === 'plus' || u.plan === 'pro')
  const learningRanked = userList
    .filter(u => u.progress?.completed > 0)
    .sort((a, b) => (b.progress.completed - a.progress.completed) || (b.progress.quizPassed - a.progress.quizPassed))
  const paidOrderRows = userList
    .flatMap(u => (u.orders || [])
      .filter(o => o.status === 'paid')
      .map(o => ({ user: u, order: o }))
    )
    .sort((a, b) => String(b.order.paidAt || b.order.createdAt || '').localeCompare(String(a.order.paidAt || a.order.createdAt || '')))

  // Plan label helper
  function planLabel(plan, expiresAt) {
    if (!plan || plan === 'free') return '<span class="admin-badge badge-free">免费</span>'
    const label = plan === 'pro' ? 'PRO' : 'Plus'
    const expired = expiresAt && new Date(expiresAt + 'T23:59:59+08:00') < new Date()
    if (expired) return `<span class="admin-badge badge-expired">${label} (已过期)</span>`
    return `<span class="admin-badge badge-paid">${label}</span>`
  }

  function orderPlanLabel(order) {
    const plan = order.plan === 'pro' ? 'PRO' : order.plan === 'plus' ? 'Plus' : (order.plan || '-')
    const period = order.period === 'yearly' ? '年付' : order.period === 'monthly' ? '月付' : (order.period || '')
    return `${plan}${period ? ' ' + period : ''}`
  }

  function orderStatusLabel(status) {
    if (status === 'paid') return '已完成'
    if (status === 'processing') return '处理中'
    if (status === 'pending') return '待支付'
    if (status === 'expired') return '已过期'
    return status || '-'
  }

  mainContent.innerHTML = `
    <div class="admin-dashboard fade-in">
      <button class="back-btn" id="backHome">← 返回首页</button>
      <h1 class="admin-title">📊 管理后台</h1>

      <div class="admin-board-tabs" role="tablist" aria-label="管理后台板块">
        <button class="admin-board-tab active" type="button" data-admin-board="resources">课程资源</button>
        <button class="admin-board-tab" type="button" data-admin-board="users">用户会员</button>
        <button class="admin-board-tab" type="button" data-admin-board="referrals">返佣邀请</button>
        <button class="admin-board-tab" type="button" data-admin-board="config">系统配置</button>
      </div>

      <div class="admin-presence-grid" aria-label="在线人数统计">
        <div class="admin-presence-card">
          <div class="admin-presence-label">实时在线人数</div>
          <div class="admin-presence-value">${realtimeOnlineUsers}</div>
          <div class="admin-presence-sub">最近 ${realtimeWindowMinutes} 分钟活跃</div>
        </div>
        <div class="admin-presence-card">
          <div class="admin-presence-label">今天在线人数</div>
          <div class="admin-presence-value">${todayOnlineUsers}</div>
          <div class="admin-presence-sub">北京时间今日去重用户</div>
        </div>
        <div class="admin-presence-card">
          <div class="admin-presence-label">本周在线人数</div>
          <div class="admin-presence-value">${weekOnlineUsers}</div>
          <div class="admin-presence-sub">北京时间本周去重用户</div>
        </div>
      </div>

      <div class="admin-board admin-board-active" id="adminResourcesBoard">
        ${renderAdminCourseSection()}
      </div>

      <div class="admin-board" id="adminUsersBoard" hidden>

      <div class="admin-stats-grid">
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="all">
          <div class="admin-stat-icon">👥</div>
          <div class="admin-stat-value">${stats.totalUsers}</div>
          <div class="admin-stat-label">注册用户总数</div>
          <div class="admin-stat-sub">今日新增 ${stats.todayNewUsers}</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="members">
          <div class="admin-stat-icon">⭐</div>
          <div class="admin-stat-value">${plusUsers.length}</div>
          <div class="admin-stat-label">Plus 会员</div>
          <div class="admin-stat-sub">转化率 ${stats.totalUsers > 0 ? Math.round(plusUsers.length / stats.totalUsers * 100) : 0}%</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="members">
          <div class="admin-stat-icon">💎</div>
          <div class="admin-stat-value">${proUsers.length}</div>
          <div class="admin-stat-label">Pro 会员</div>
          <div class="admin-stat-sub">转化率 ${stats.totalUsers > 0 ? Math.round(proUsers.length / stats.totalUsers * 100) : 0}%</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="orders">
          <div class="admin-stat-icon">💵</div>
          <div class="admin-stat-value">$${stats.totalRevenue.toLocaleString()}</div>
          <div class="admin-stat-label">总收入</div>
          <div class="admin-stat-sub">${stats.paidOrderCount} 笔订单</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">📚</div>
          <div class="admin-stat-value">${episodes.length}</div>
          <div class="admin-stat-label">课程总数</div>
          <div class="admin-stat-sub">${episodes.filter(hasEpisodeVideo).length} 期已上线</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">💬</div>
          <div class="admin-stat-value">${stats.totalComments || 0}</div>
          <div class="admin-stat-label">总评论数</div>
          <div class="admin-stat-sub">${stats.totalReplies || 0} 条回复</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">📝</div>
          <div class="admin-stat-value">${stats.totalPosts || 0}</div>
          <div class="admin-stat-label">社区帖子</div>
          <div class="admin-stat-sub">社区互动</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="learning">
          <div class="admin-stat-icon">🏆</div>
          <div class="admin-stat-value">${learningRanked.length}</div>
          <div class="admin-stat-label">学习排行榜</div>
          <div class="admin-stat-sub">${learningRanked.length > 0 ? '🥇 ' + escapeHtml(learningRanked[0].name || '未命名') + ' · ' + learningRanked[0].progress.completed + '课' : '暂无数据'}</div>
        </div>
      </div>

      <div class="admin-board-tabs admin-user-subtabs" id="adminUserSubTabs" role="tablist" aria-label="用户会员子版块">
        <button class="admin-board-tab active" type="button" data-admin-user-tab="all">全部用户列表</button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="members">会员列表</button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="orders">订单充值</button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="learning">学习进度排名</button>
      </div>

      <!-- 用户列表 -->
      <div class="admin-section admin-user-panel" id="adminUserList" data-admin-user-panel="all">
        <div class="admin-section-header">
          <h2>全部用户列表</h2>
          <span class="admin-section-badge">${stats.totalUsers} 人</span>
        </div>
        <div class="admin-table-wrapper">
          <table class="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>邮箱</th>
                <th>注册时间</th>
                <th>会员</th>
                <th>到期日</th>
                <th>付费</th>
                <th>学习/互动</th>
                <th>最近</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${userList.length > 0
                ? userList.map(u => `
                  <tr>
                    <td>
                      <div class="admin-user-cell">
                        <span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span>
                        <div>
                          <div>${escapeHtml(u.name || '未命名')}${u.isAdmin ? ' <span class="admin-badge badge-admin">管理员</span>' : ''}</div>
                          <div class="admin-uid" title="${escapeHtml(u.uid || '')}">${escapeHtml((u.uid || '').substring(0, 10))}</div>
                        </div>
                      </div>
                    </td>
                    <td class="admin-email" title="${escapeHtml(u.email)}">${escapeHtml(u.email.length > 22 ? u.email.substring(0, 20) + '..' : u.email)}</td>
                    <td style="font-size:12px;white-space:nowrap;">${u.createdAt ? u.createdAt.substring(5, 16) : '-'}</td>
                    <td>${planLabel(u.plan, u.planExpiresAt)}</td>
                    <td style="font-size:12px;">${u.planExpiresAt || '-'}</td>
                    <td>${u.totalPaid > 0 ? '<strong>$' + u.totalPaid.toLocaleString() + '</strong>' : '-'}</td>
                    <td style="font-size:11px;white-space:nowrap;">
                      ${u.progress?.total > 0 ? `▶${u.progress.total} ` : ''}${u.progress?.completed > 0 ? `✅${u.progress.completed} ` : ''}${u.progress?.quizPassed > 0 ? `🎯${u.progress.quizPassed} ` : ''}${u.commentCount > 0 ? `💬${u.commentCount} ` : ''}${u.postCount > 0 ? `📝${u.postCount} ` : ''}${u.replyCount > 0 ? `↩${u.replyCount} ` : ''}${u.commentCount + u.postCount + u.replyCount === 0 && !u.progress?.total ? '-' : ''}
                    </td>
                    <td style="font-size:12px;white-space:nowrap;">${u.lastActivity ? escapeHtml(u.lastActivity.substring(5, 16)) : '-'}</td>
                    <td>
                      <div class="admin-actions">
                        <button class="btn btn-primary btn-xs admin-edit-user" data-user-id="${u.id}" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-plan="${u.plan || 'free'}" data-expires="${u.planExpiresAt || ''}">编辑</button>
                        <button class="btn btn-xs admin-view-orders" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}">订单</button>
                      </div>
                    </td>
                  </tr>`
                ).join('')
                : '<tr><td colspan="9" style="text-align:center; color:var(--text-3); padding:32px;">暂无注册用户</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>

      <!-- 会员列表 -->
      <div class="admin-section admin-user-panel" id="adminMemberList" data-admin-user-panel="members" hidden>
        <div class="admin-section-header">
          <h2>会员列表</h2>
          <span class="admin-section-badge">${memberUsers.length} 人</span>
        </div>
        ${memberUsers.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th>用户</th><th>邮箱</th><th>UID</th><th>会员等级</th><th>到期日</th><th>已付</th><th>操作</th></tr></thead>
                <tbody>
                  ${memberUsers.map(u => `
                    <tr>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '未命名')}</div></div></div></td>
                      <td class="admin-email" title="${escapeHtml(u.email)}">${escapeHtml(u.email.length > 22 ? u.email.substring(0, 20) + '..' : u.email)}</td>
                      <td class="admin-uid">${escapeHtml(u.uid || '-')}</td>
                      <td>${planLabel(u.plan, u.planExpiresAt)}</td>
                      <td style="font-size:12px;">${u.planExpiresAt || '-'}</td>
                      <td>${u.totalPaid > 0 ? '<strong>$' + u.totalPaid.toLocaleString() + '</strong>' : '-'}</td>
                      <td>
                        <div class="admin-actions">
                          <button class="btn btn-primary btn-xs admin-edit-user" data-user-id="${u.id}" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-plan="${u.plan || 'free'}" data-expires="${u.planExpiresAt || ''}">编辑</button>
                          <button class="btn btn-xs admin-view-orders" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}">订单</button>
                        </div>
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`
          : '<div class="comments-empty">暂无会员</div>'
        }
      </div>

      <!-- 订单充值 -->
      <div class="admin-section admin-user-panel" id="adminPaidList" data-admin-user-panel="orders" hidden>
        <div class="admin-section-header">
          <h2>订单充值</h2>
          <span class="admin-section-badge">${paidOrderRows.length} 笔</span>
        </div>
        ${paidOrderRows.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th>用户</th><th>UID</th><th>方案</th><th>金额</th><th>状态</th><th>支付/创建时间</th></tr></thead>
                <tbody>
                  ${paidOrderRows.map(({ user: u, order: o }) => `
                    <tr>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '未命名')}</div></div></div></td>
                      <td class="admin-uid">${escapeHtml((u.uid || '').substring(0, 10))}</td>
                      <td><span class="admin-badge badge-paid">${escapeHtml(orderPlanLabel(o))}</span></td>
                      <td><strong>$${escapeHtml(String(o.amountConfirmed || o.amount || 0))}</strong></td>
                      <td><span class="admin-badge ${o.status === 'paid' ? 'badge-paid' : 'badge-free'}">${escapeHtml(orderStatusLabel(o.status))}</span></td>
                      <td style="font-size:12px;white-space:nowrap;">${escapeHtml(o.paidAt || o.createdAt || '-')}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`
          : '<div class="comments-empty">暂无付费记录</div>'
        }
      </div>

      <!-- 学习排行榜 -->
      <div class="admin-section admin-user-panel" id="adminLeaderboard" data-admin-user-panel="learning" hidden>
        <div class="admin-section-header">
          <h2>🏆 学习进度排名</h2>
          <span class="admin-section-badge">${learningRanked.length} 人完成过课程</span>
        </div>
        ${learningRanked.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th style="width:50px">排名</th><th>用户</th><th>UID</th><th>会员</th><th style="text-align:center">✅ 完成</th><th style="text-align:center">🎯 答题</th><th style="text-align:center">▶ 观看</th></tr></thead>
                <tbody>
                  ${learningRanked.map((u, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''
                    return `
                    <tr${i < 3 ? ' style="background:var(--bg-2);"' : ''}>
                      <td style="text-align:center;font-weight:600;font-size:${i < 3 ? '18px' : '13px'};">${medal || (i + 1)}</td>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '未命名')}</div></div></div></td>
                      <td class="admin-uid">${escapeHtml((u.uid || '').substring(0, 10))}</td>
                      <td>${planLabel(u.plan, u.planExpiresAt)}</td>
                      <td style="text-align:center;font-weight:700;font-size:16px;color:var(--accent);">${u.progress.completed}</td>
                      <td style="text-align:center;">${u.progress.quizPassed || 0}</td>
                      <td style="text-align:center;">${u.progress.total || 0}</td>
                    </tr>`
                  }).join('')}
                </tbody>
              </table>
            </div>`
          : '<div class="comments-empty">暂无学习记录</div>'
        }
      </div>

      <!-- 订单详情弹窗 -->
      <div class="admin-order-modal" id="adminOrderModal" style="display:none">
        <div class="admin-order-modal-content">
          <div class="admin-order-modal-header">
            <h3 id="adminOrderModalTitle">订单详情</h3>
            <button class="admin-order-modal-close" id="adminOrderModalClose">&times;</button>
          </div>
          <div id="adminOrderModalBody"></div>
        </div>
      </div>

      <!-- 审计日志 -->
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>📋 审计日志</h2>
        </div>
        <div class="audit-filters">
          <select id="auditDays" class="form-select">
            <option value="all">全部时间</option>
            <option value="1">最近1天</option>
            <option value="7">最近7天</option>
            <option value="30">最近30天</option>
          </select>
          <select id="auditActionType" class="form-select">
            <option value="all">全部类型</option>
            <option value="login">登录</option>
            <option value="register">注册</option>
            <option value="profile_update">修改资料</option>
            <option value="comment_create">发表评论</option>
            <option value="post_create">发帖</option>
            <option value="reply_create">回复</option>
            <option value="admin_change_plan">管理套餐</option>
            <option value="trade_create">添加战绩</option>
          </select>
          <input type="text" id="auditSearch" class="form-input" placeholder="搜索用户邮箱、昵称、详情...">
          <button class="btn btn-primary" id="loadAuditLogs">查询</button>
        </div>
        <div id="auditLogContainer" class="admin-audit-container">
          <p style="color:var(--text-3);padding:12px 0;">点击「查询」查看操作记录</p>
        </div>
      </div>
      </div>

      <div class="admin-board" id="adminReferralsBoard" hidden>
        ${renderAdminReferralsSection()}
      </div>

      <div class="admin-board" id="adminConfigBoard" hidden>
        ${renderAdminConfigSection()}
      </div>
    </div>
  `

  setupAdminBoardTabs()
  setupAdminUserTabs()
  setupAdminCourseManager()
  loadAdminReferrals()
  loadAdminConfig()

  // Audit log handler
  const auditBtn = document.getElementById('loadAuditLogs')
  if (auditBtn) {
    let auditPage = 1
    const loadAudit = async (page = 1) => {
      const container = document.getElementById('auditLogContainer')
      if (!container) return
      container.innerHTML = '<div class="loading-spinner">加载中...</div>'
      const days = document.getElementById('auditDays')?.value || 'all'
      const action = document.getElementById('auditActionType')?.value || 'all'
      const search = document.getElementById('auditSearch')?.value || ''
      const r = await api.get(`/api/admin-audit?page=${page}&limit=30&days=${days}&action=${action}&search=${encodeURIComponent(search)}`)
      if (!r.logs) {
        container.innerHTML = `<p style="color:var(--text-3);padding:12px 0;">${escapeHtml(r.error || '加载失败')}</p>`
        return
      }
      if (r.logs.length === 0) {
        container.innerHTML = '<p style="color:var(--text-3);padding:12px 0;">暂无日志</p>'
        return
      }
      const actionLabels = {
        login: '登录', register: '注册', change_password: '修改密码',
        profile_update: '修改资料', comment_create: '发表评论', comment_delete: '删除评论',
        post_create: '发帖', post_delete: '删除帖子', reply_create: '回复',
        reply_delete: '删除回复', admin_change_plan: '管理套餐',
        admin_delete_comment: '管理员删评论', admin_delete_post: '管理员删帖',
        admin_delete_reply: '管理员删回复', trade_create: '添加战绩',
        course_resources_upload: '上传课程资料',
        trade_delete: '删除战绩', mt5_credentials_access: '查看MT5账号',
      }
      container.innerHTML = `
        <table class="admin-table" style="font-size:13px;">
          <thead><tr><th>#</th><th>时间</th><th>操作者</th><th>IP</th><th>操作</th><th>详情</th></tr></thead>
          <tbody>${r.logs.map((l, i) => `<tr>
            <td>${(page - 1) * 30 + i + 1}</td>
            <td style="white-space:nowrap;">${escapeHtml(l.created_at || '-')}</td>
            <td>${escapeHtml(l.user_nickname || l.user_email || '-')}<br><span style="font-size:11px;color:var(--text-3);">${escapeHtml(l.user_email || '')}</span></td>
            <td style="font-family:monospace;font-size:11px;">${escapeHtml(l.ip || '-')}</td>
            <td>${escapeHtml(actionLabels[l.action] || l.action)}</td>
            <td><button class="btn btn-ghost btn-xs audit-detail" data-id="${l.id}">详情</button></td>
          </tr>`).join('')}</tbody>
        </table>
        <div style="display:flex;gap:8px;padding:12px 0;justify-content:center;">
          ${page > 1 ? `<button class="btn btn-ghost btn-xs audit-page" data-page="${page - 1}">← 上一页</button>` : ''}
          <span style="color:var(--text-3);font-size:13px;">第 ${page}/${r.totalPages} 页 (共 ${r.total} 条)</span>
          ${page < r.totalPages ? `<button class="btn btn-ghost btn-xs audit-page" data-page="${page + 1}">下一页 →</button>` : ''}
        </div>
      `
      container.querySelectorAll('.audit-page').forEach(btn => {
        btn.addEventListener('click', () => loadAudit(Number(btn.dataset.page)))
      })
      container.querySelectorAll('.audit-detail').forEach(btn => {
        btn.addEventListener('click', () => {
          const log = r.logs.find(l => l.id === Number(btn.dataset.id))
          if (log) {
            alert(`操作: ${actionLabels[log.action] || log.action}\n用户: ${log.user_nickname || log.user_email}\nIP: ${log.ip || '-'}\n时间: ${log.created_at}\n详情: ${log.detail || '-'}`)
          }
        })
      })
    }
    auditBtn.addEventListener('click', () => loadAudit(1))
  }

  // Stream upload handlers
  const fileInput = document.getElementById('streamFileInput')
  const uploadBtn = document.getElementById('streamUploadBtn')

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0]
      if (file) {
        document.getElementById('streamFileName').textContent = `${file.name} (${formatFileSize(file.size)})`
        if (uploadBtn) uploadBtn.disabled = false
        if (!document.getElementById('courseTitle')?.value) {
          document.getElementById('courseTitle').value = file.name.replace(/\.[^.]+$/, '')
        }
      }
    })
  }

  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => startStreamUpload())
  }
}


function renderAdminReferralsSection() {
  return `
    <div class="admin-section">
      <div class="admin-section-header">
        <h2>返佣邀请管理</h2>
        <button class="btn btn-ghost btn-xs" id="adminReferralRefresh">刷新</button>
      </div>
      <div id="adminReferralContent" class="admin-referral-content">
        <div class="loading-spinner">加载中...</div>
      </div>
    </div>
  `
}

function adminReferralStatusBadge(status) {
  if (status === 'approved') return '<span class="admin-badge badge-paid">已审核</span>'
  if (status === 'voided') return '<span class="admin-badge badge-expired">已作废</span>'
  return '<span class="admin-badge badge-free">待确认</span>'
}

async function loadAdminReferrals() {
  const container = document.getElementById('adminReferralContent')
  if (!container) return
  const currentStatus = document.getElementById('adminReferralStatusFilter')?.value || ''
  container.innerHTML = '<div class="loading-spinner">加载中...</div>'
  try {
    const statusQuery = currentStatus ? `?status=${encodeURIComponent(currentStatus)}` : ''
    const [overview, commissions, rules] = await Promise.all([
      api.get('/api/admin/referrals/overview'),
      api.get(`/api/admin/referrals/commissions${statusQuery}`),
      api.get('/api/admin/referrals/rules'),
    ])
    if (!overview.ok || !commissions.ok || !rules.ok) {
      container.innerHTML = `<div class="comments-empty">${escapeHtml(overview.error || commissions.error || rules.error || '加载失败')}</div>`
      return
    }
    const stats = overview.stats || {}
    const rows = commissions.commissions || []
    const ruleRows = rules.rules || []
    const referralDisabled = Boolean(overview.disabled || commissions.disabled || rules.disabled)
    const disabledMessage = overview.message || commissions.message || rules.message || '邀请返佣功能暂未开放'
    container.innerHTML = `
      ${referralDisabled ? `<div class="admin-referral-disabled-note">当前返佣系统处于预览关闭状态，暂不允许审核、作废或修改规则。</div>` : ''}
      <div class="admin-stats-grid admin-referral-stats">
        <div class="admin-stat-card"><div class="admin-stat-value">${Number(stats.total_invites || 0)}</div><div class="admin-stat-label">总邀请数</div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${Number(stats.paid_invites || 0)}</div><div class="admin-stat-label">付费邀请</div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${formatMinorUsd(stats.pending_credit_cents)}</div><div class="admin-stat-label">待确认返佣</div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${formatMinorUsd(stats.available_credit_cents)}</div><div class="admin-stat-label">可用返佣</div></div>
      </div>

      <div class="admin-section admin-referral-inner">
        <div class="admin-section-header">
          <h2>返佣记录</h2>
          <select class="admin-plan-select" id="adminReferralStatusFilter">
            <option value="">全部状态</option>
            <option value="pending" ${currentStatus === 'pending' ? 'selected' : ''}>待确认</option>
            <option value="approved" ${currentStatus === 'approved' ? 'selected' : ''}>已审核</option>
            <option value="voided" ${currentStatus === 'voided' ? 'selected' : ''}>已作废</option>
          </select>
        </div>
        ${rows.length ? `
          <div class="admin-table-wrapper">
            <table class="admin-table">
              <thead><tr><th>邀请人</th><th>被邀请用户</th><th>订单</th><th>现金实付</th><th>返佣金额</th><th>状态</th><th>可用时间</th><th>操作</th></tr></thead>
              <tbody>
                ${rows.map(row => `
                  <tr>
                    <td><div>${escapeHtml(row.referrer?.name || row.referrer?.uid || '-')}</div><div class="admin-uid">${escapeHtml(row.referrer?.email || '')}</div></td>
                    <td><div>${escapeHtml(row.invited_user?.name || row.invited_user?.uid || '-')}</div><div class="admin-uid">${escapeHtml(row.invited_user?.email || '')}</div></td>
                    <td><span class="admin-uid">${escapeHtml(String(row.order_id || '-'))}</span><br>${escapeHtml(row.plan || '')} ${escapeHtml(row.period || '')}</td>
                    <td>${formatMinorUsd(row.source_cash_amount_cents)}</td>
                    <td><strong>${formatMinorUsd(row.amount_cents)}</strong><br><span class="admin-uid">${Number(row.rate_bps || 0) / 100}%</span></td>
                    <td>${adminReferralStatusBadge(row.status)}</td>
                    <td class="admin-uid">${escapeHtml(row.available_at || '-')}</td>
                    <td><div class="admin-actions">
                      ${row.status === 'pending' ? `<button class="btn btn-primary btn-xs" data-referral-approve="${escapeHtml(row.id)}" ${referralDisabled ? 'disabled' : ''}>审核通过</button>` : ''}
                      ${row.status !== 'voided' ? `<button class="btn btn-ghost btn-xs" data-referral-void="${escapeHtml(row.id)}" ${referralDisabled ? 'disabled' : ''}>作废</button>` : ''}
                    </div></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>` : '<div class="comments-empty">暂无返佣记录</div>'}
      </div>

      <div class="admin-section admin-referral-inner">
        <div class="admin-section-header">
          <h2>返佣比例规则</h2>
          <span class="admin-section-badge">上限 20%</span>
        </div>
        <div class="admin-table-wrapper"><table class="admin-table">
          <thead><tr><th>方案</th><th>周期</th><th>rate_bps</th><th>启用</th><th>操作</th></tr></thead>
          <tbody>${ruleRows.map(rule => `
            <tr>
              <td>${escapeHtml(rule.plan)}</td>
              <td>${escapeHtml(rule.period)}</td>
              <td><input class="admin-plan-input admin-referral-rate" data-rule-rate="${escapeHtml(rule.plan)}_${escapeHtml(rule.period)}" value="${Number(rule.rate_bps || 0)}" type="number" min="0" max="2000" ${referralDisabled ? 'disabled' : ''}></td>
              <td><select class="admin-plan-select admin-referral-enabled" data-rule-enabled="${escapeHtml(rule.plan)}_${escapeHtml(rule.period)}" ${referralDisabled ? 'disabled' : ''}>
                <option value="1" ${Number(rule.enabled) === 1 ? 'selected' : ''}>启用</option>
                <option value="0" ${Number(rule.enabled) === 0 ? 'selected' : ''}>停用</option>
              </select></td>
              <td><button class="btn btn-primary btn-xs admin-referral-rule-save" data-plan="${escapeHtml(rule.plan)}" data-period="${escapeHtml(rule.period)}" ${referralDisabled ? 'disabled' : ''}>保存</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>`

    document.getElementById('adminReferralRefresh')?.addEventListener('click', loadAdminReferrals)
    document.getElementById('adminReferralStatusFilter')?.addEventListener('change', loadAdminReferrals)
    if (referralDisabled) {
      container.querySelectorAll('[data-referral-approve], [data-referral-void], .admin-referral-rule-save').forEach(btn => {
        btn.addEventListener('click', () => alert(disabledMessage))
      })
      return
    }
    container.querySelectorAll('[data-referral-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const res = await api.patch(`/api/admin/referrals/commissions/${encodeURIComponent(btn.dataset.referralApprove)}`, { action: 'approve' })
        if (!res.ok) alert(res.error || '审核失败')
        loadAdminReferrals()
      })
    })
    container.querySelectorAll('[data-referral-void]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reason = prompt('请输入作废原因')
        if (!reason) return
        btn.disabled = true
        const res = await api.patch(`/api/admin/referrals/commissions/${encodeURIComponent(btn.dataset.referralVoid)}`, { action: 'void', reason })
        if (!res.ok) alert(res.error || '作废失败')
        loadAdminReferrals()
      })
    })
    container.querySelectorAll('.admin-referral-rule-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const plan = btn.dataset.plan
        const period = btn.dataset.period
        const key = `${plan}_${period}`
        const rate = Number(container.querySelector(`[data-rule-rate="${key}"]`)?.value || 0)
        const enabled = Number(container.querySelector(`[data-rule-enabled="${key}"]`)?.value || 0)
        btn.disabled = true
        const res = await api.patch('/api/admin/referrals/rules', { plan, period, rate_bps: rate, enabled })
        if (!res.ok) alert(res.error || '保存失败')
        loadAdminReferrals()
      })
    })
  } catch (err) {
    console.error('Load admin referrals error:', err)
    container.innerHTML = '<div class="comments-empty">加载失败</div>'
  }
}

// ===== System Config Section =====
let adminConfigData = {}
let adminConfigSubTab = 'smtp'

function renderAdminConfigSection() {
  return `
    <div class="admin-section">
      <div class="admin-section-header">
        <h2>系统配置</h2>
        <button class="btn btn-ghost btn-xs" id="adminConfigRefresh">刷新</button>
      </div>
      <div class="admin-board-tabs admin-config-subtabs" role="tablist" aria-label="系统配置板块">
        <button class="admin-board-tab active" type="button" data-config-tab="smtp">发件邮箱</button>
        <button class="admin-board-tab" type="button" data-config-tab="qiniu">七牛云存储</button>
        <button class="admin-board-tab" type="button" data-config-tab="toolbox">金融工具箱</button>
        <button class="admin-board-tab" type="button" data-config-tab="market_menu">股票研究菜单</button>
      </div>
      <div id="adminConfigContent" class="admin-config-content">
        <div class="loading-spinner">加载中...</div>
      </div>
    </div>
  `
}

async function loadAdminConfig() {
  try {
    const res = await api.get('/api/system-config')
    if (!res.ok) {
      console.error('Load config error:', res.error)
      return
    }
    adminConfigData = res.config || {}
    renderAdminConfigContent()
    setupAdminConfigTabs()
  } catch (err) {
    console.error('Load config error:', err)
  }
}

function setupAdminConfigTabs() {
  const tabs = [...document.querySelectorAll('[data-config-tab]')]
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      adminConfigSubTab = tab.dataset.configTab
      tabs.forEach(t => t.classList.toggle('active', t === tab))
      renderAdminConfigContent()
    })
  })
  document.getElementById('adminConfigRefresh')?.addEventListener('click', loadAdminConfig)
}

function renderAdminConfigContent() {
  const container = document.getElementById('adminConfigContent')
  if (!container) return

  switch (adminConfigSubTab) {
    case 'smtp':
      renderSmtpConfig(container)
      break
    case 'qiniu':
      renderQiniuConfig(container)
      break
    case 'toolbox':
      renderToolboxConfig(container)
      break
    case 'market_menu':
      renderMarketMenuConfig(container)
      break
  }
}

function renderSmtpConfig(container) {
  const items = adminConfigData.smtp || []
  const getVal = (key) => items.find(i => i.key === key)?.value || ''

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-row">
        <label>SMTP 服务器</label>
        <input type="text" class="admin-plan-input" id="smtpHost" value="${escapeHtml(getVal('host'))}" placeholder="smtp.qq.com">
      </div>
      <div class="admin-config-row">
        <label>端口</label>
        <input type="text" class="admin-plan-input" id="smtpPort" value="${escapeHtml(getVal('port'))}" placeholder="587">
      </div>
      <div class="admin-config-row">
        <label>用户名</label>
        <input type="text" class="admin-plan-input" id="smtpUser" value="${escapeHtml(getVal('user'))}" placeholder="your@email.com">
      </div>
      <div class="admin-config-row">
        <label>密码</label>
        <input type="password" class="admin-plan-input" id="smtpPass" value="${escapeHtml(getVal('pass'))}" placeholder="授权码">
      </div>
      <div class="admin-config-row">
        <label>发件人邮箱</label>
        <input type="text" class="admin-plan-input" id="smtpFrom" value="${escapeHtml(getVal('from'))}" placeholder="noreply@yourdomain.com">
      </div>
      <div class="admin-config-row">
        <label>发件人名称</label>
        <input type="text" class="admin-plan-input" id="smtpFromName" value="${escapeHtml(getVal('from_name') || '街哥课堂')}" placeholder="街哥课堂">
      </div>
      <div class="admin-config-row">
        <label>SSL/TLS</label>
        <select class="admin-plan-select" id="smtpSecure">
          <option value="false" ${getVal('secure') === 'false' ? 'selected' : ''}>否 (STARTTLS)</option>
          <option value="true" ${getVal('secure') === 'true' ? 'selected' : ''}>是 (SSL)</option>
        </select>
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveSmtpConfig">保存配置</button>
        <button class="btn btn-ghost" id="testSmtpConfig">发送测试邮件</button>
      </div>
      <div id="smtpTestResult" class="admin-config-test-result"></div>
    </div>
  `

  document.getElementById('saveSmtpConfig')?.addEventListener('click', async () => {
    const items = [
      { key: 'host', value: document.getElementById('smtpHost').value, label: 'SMTP 服务器', sort_order: 0 },
      { key: 'port', value: document.getElementById('smtpPort').value, label: '端口', sort_order: 1 },
      { key: 'user', value: document.getElementById('smtpUser').value, label: '用户名', sort_order: 2 },
      { key: 'pass', value: document.getElementById('smtpPass').value, label: '密码', sort_order: 3 },
      { key: 'from', value: document.getElementById('smtpFrom').value, label: '发件人邮箱', sort_order: 4 },
      { key: 'from_name', value: document.getElementById('smtpFromName').value, label: '发件人名称', sort_order: 5 },
      { key: 'secure', value: document.getElementById('smtpSecure').value, label: 'SSL/TLS', sort_order: 6 },
    ]
    const res = await api.put('/api/system-config/smtp', { items })
    if (res.ok) {
      alert('SMTP 配置已保存')
      loadAdminConfig()
    } else {
      alert(res.error || '保存失败')
    }
  })

  document.getElementById('testSmtpConfig')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('smtpTestResult')
    const testEmail = prompt('请输入测试收件邮箱：')
    if (!testEmail) return
    resultEl.innerHTML = '<span style="color:var(--text-3)">发送中...</span>'
    const res = await api.post('/api/system-config/smtp/test', { to: testEmail })
    if (res.ok) {
      resultEl.innerHTML = '<span style="color:#10b981">✓ 测试邮件已发送，请检查收件箱</span>'
    } else {
      resultEl.innerHTML = `<span style="color:#ef4444">✗ ${escapeHtml(res.error || '发送失败')}</span>`
    }
  })
}

function renderQiniuConfig(container) {
  const items = adminConfigData.qiniu || []
  const getVal = (key) => items.find(i => i.key === key)?.value || ''

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-row">
        <label>Access Key</label>
        <input type="text" class="admin-plan-input" id="qiniuAK" value="${escapeHtml(getVal('access_key'))}" placeholder="Access Key">
      </div>
      <div class="admin-config-row">
        <label>Secret Key</label>
        <input type="password" class="admin-plan-input" id="qiniuSK" value="${escapeHtml(getVal('secret_key'))}" placeholder="Secret Key">
      </div>
      <div class="admin-config-row">
        <label>存储桶名称</label>
        <input type="text" class="admin-plan-input" id="qiniuBucket" value="${escapeHtml(getVal('bucket'))}" placeholder="my-bucket">
      </div>
      <div class="admin-config-row">
        <label>访问域名</label>
        <input type="text" class="admin-plan-input" id="qiniuDomain" value="${escapeHtml(getVal('domain'))}" placeholder="https://cdn.example.com">
      </div>
      <div class="admin-config-row">
        <label>区域</label>
        <select class="admin-plan-select" id="qiniuRegion">
          <option value="z0" ${getVal('region') === 'z0' ? 'selected' : ''}>华东 (z0)</option>
          <option value="cn-east" ${getVal('region') === 'cn-east' ? 'selected' : ''}>华东 (cn-east)</option>
          <option value="cn-south" ${getVal('region') === 'cn-south' ? 'selected' : ''}>华南 (cn-south)</option>
          <option value="cn-north" ${getVal('region') === 'cn-north' ? 'selected' : ''}>华北 (cn-north)</option>
          <option value="us-north" ${getVal('region') === 'us-north' ? 'selected' : ''}>北美 (us-north)</option>
          <option value="ap-southeast" ${getVal('region') === 'ap-southeast' ? 'selected' : ''}>东南亚 (ap-southeast)</option>
        </select>
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveQiniuConfig">保存配置</button>
      </div>
    </div>
  `

  document.getElementById('saveQiniuConfig')?.addEventListener('click', async () => {
    const items = [
      { key: 'access_key', value: document.getElementById('qiniuAK').value, label: 'Access Key', sort_order: 0 },
      { key: 'secret_key', value: document.getElementById('qiniuSK').value, label: 'Secret Key', sort_order: 1 },
      { key: 'bucket', value: document.getElementById('qiniuBucket').value, label: '存储桶名称', sort_order: 2 },
      { key: 'domain', value: document.getElementById('qiniuDomain').value, label: '访问域名', sort_order: 3 },
      { key: 'region', value: document.getElementById('qiniuRegion').value, label: '区域', sort_order: 4 },
    ]
    const res = await api.put('/api/system-config/qiniu', { items })
    if (res.ok) {
      alert('七牛云配置已保存')
      loadAdminConfig()
    } else {
      alert(res.error || '保存失败')
    }
  })
}

function renderToolboxConfig(container) {
  const items = adminConfigData.toolbox || []
  const toolboxItem = items.find(i => i.key === 'items')
  let categories = []
  try { categories = JSON.parse(toolboxItem?.value || '[]') } catch {}

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-header-row">
        <h3>金融工具箱配置</h3>
        <button class="btn btn-primary btn-sm" id="addToolCategory">+ 添加分类</button>
      </div>
      <div id="toolboxCategories">
        ${categories.map((cat, ci) => renderToolboxCategory(cat, ci)).join('')}
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveToolboxConfig">保存全部</button>
      </div>
    </div>
  `

  setupToolboxEvents(categories)
}

function renderToolboxCategory(cat, ci) {
  return `
    <div class="admin-toolbox-category" data-cat-index="${ci}">
      <div class="admin-toolbox-cat-header">
        <input type="text" class="admin-plan-input admin-toolbox-cat-name" value="${escapeHtml(cat.category)}" placeholder="分类名称">
        <button class="btn btn-ghost btn-xs admin-toolbox-cat-delete" data-ci="${ci}">删除分类</button>
      </div>
      <div class="admin-toolbox-items">
        ${(cat.items || []).map((item, ii) => renderToolboxItem(item, ci, ii)).join('')}
      </div>
      <button class="btn btn-ghost btn-xs admin-toolbox-add-item" data-ci="${ci}">+ 添加工具</button>
    </div>
  `
}

function renderToolboxItem(item, ci, ii) {
  return `
    <div class="admin-toolbox-item" data-ci="${ci}" data-ii="${ii}">
      <div class="admin-toolbox-item-grid">
        <div class="admin-config-row">
          <label>名称</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="name" value="${escapeHtml(item.name || '')}">
        </div>
        <div class="admin-config-row">
          <label>图标</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="icon" value="${escapeHtml(item.icon || '')}" placeholder="🪙">
        </div>
        <div class="admin-config-row">
          <label>链接</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="url" value="${escapeHtml(item.url || '')}">
        </div>
        <div class="admin-config-row">
          <label>描述</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="desc" value="${escapeHtml(item.desc || '')}">
        </div>
        <div class="admin-config-row">
          <label>标签</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="tag" value="${escapeHtml(item.tag || '')}" placeholder="可选">
        </div>
        <div class="admin-config-row">
          <label>标签颜色</label>
          <input type="color" class="admin-plan-input toolbox-field" data-field="tagColor" value="${escapeHtml(item.tagColor || '#2563eb')}" style="height:36px;padding:2px 4px;">
        </div>
        <div class="admin-config-row">
          <label>邀请码</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="code" value="${escapeHtml(item.code || '')}" placeholder="可选">
        </div>
        <div class="admin-config-row">
          <label>返佣</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="rebate" value="${escapeHtml(item.rebate || '')}" placeholder="可选">
        </div>
      </div>
      <button class="btn btn-ghost btn-xs admin-toolbox-delete-item" data-ci="${ci}" data-ii="${ii}">删除</button>
    </div>
  `
}

function setupToolboxEvents(categories) {
  const getCategories = () => {
    const cats = []
    document.querySelectorAll('.admin-toolbox-category').forEach(catEl => {
      const catName = catEl.querySelector('.admin-toolbox-cat-name')?.value || ''
      const items = []
      catEl.querySelectorAll('.admin-toolbox-item').forEach(itemEl => {
        const item = {}
        itemEl.querySelectorAll('.toolbox-field').forEach(f => {
          item[f.dataset.field] = f.value
        })
        items.push(item)
      })
      cats.push({ category: catName, items })
    })
    return cats
  }

  document.getElementById('addToolCategory')?.addEventListener('click', () => {
    categories.push({ category: '新分类', items: [] })
    document.getElementById('toolboxCategories').innerHTML = categories.map((cat, ci) => renderToolboxCategory(cat, ci)).join('')
    setupToolboxEvents(categories)
  })

  document.getElementById('toolboxCategories')?.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.admin-toolbox-add-item')
    if (addBtn) {
      const ci = Number(addBtn.dataset.ci)
      categories = getCategories()
      categories[ci].items.push({ name: '', icon: '', url: '', desc: '', tag: '', tagColor: '#2563eb', code: '', rebate: '' })
      document.getElementById('toolboxCategories').innerHTML = categories.map((cat, i) => renderToolboxCategory(cat, i)).join('')
      setupToolboxEvents(categories)
      return
    }
    const delItem = e.target.closest('.admin-toolbox-delete-item')
    if (delItem) {
      categories = getCategories()
      const ci = Number(delItem.dataset.ci)
      const ii = Number(delItem.dataset.ii)
      categories[ci].items.splice(ii, 1)
      document.getElementById('toolboxCategories').innerHTML = categories.map((cat, i) => renderToolboxCategory(cat, i)).join('')
      setupToolboxEvents(categories)
      return
    }
    const delCat = e.target.closest('.admin-toolbox-cat-delete')
    if (delCat) {
      categories = getCategories()
      const ci = Number(delCat.dataset.ci)
      categories.splice(ci, 1)
      document.getElementById('toolboxCategories').innerHTML = categories.map((cat, i) => renderToolboxCategory(cat, i)).join('')
      setupToolboxEvents(categories)
      return
    }
  })

  document.getElementById('saveToolboxConfig')?.addEventListener('click', async () => {
    categories = getCategories()
    const items = [{ key: 'items', value: JSON.stringify(categories), label: '金融工具箱', sort_order: 0 }]
    const res = await api.put('/api/system-config/toolbox', { items })
    if (res.ok) {
      alert('金融工具箱配置已保存')
      loadAdminConfig()
    } else {
      alert(res.error || '保存失败')
    }
  })
}

function renderMarketMenuConfig(container) {
  const items = adminConfigData.market_menu || []
  const menuItem = items.find(i => i.key === 'items')
  let menuItems = []
  try { menuItems = JSON.parse(menuItem?.value || '[]') } catch {}

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-header-row">
        <h3>股票市场研究菜单</h3>
        <button class="btn btn-primary btn-sm" id="addMenuItem">+ 添加菜单项</button>
      </div>
      <div id="marketMenuItems">
        ${menuItems.map((item, i) => renderMarketMenuItem(item, i)).join('')}
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveMarketMenuConfig">保存全部</button>
      </div>
    </div>
  `

  setupMarketMenuEvents(menuItems)
}

function renderMarketMenuItem(item, i) {
  return `
    <div class="admin-market-menu-item" data-index="${i}">
      <div class="admin-toolbox-item-grid">
        <div class="admin-config-row">
          <label>名称</label>
          <input type="text" class="admin-plan-input menu-field" data-field="name" value="${escapeHtml(item.name || '')}">
        </div>
        <div class="admin-config-row">
          <label>图标</label>
          <input type="text" class="admin-plan-input menu-field" data-field="icon" value="${escapeHtml(item.icon || '')}" placeholder="📅">
        </div>
        <div class="admin-config-row">
          <label>链接</label>
          <input type="text" class="admin-plan-input menu-field" data-field="url" value="${escapeHtml(item.url || '')}">
        </div>
      </div>
      <button class="btn btn-ghost btn-xs admin-menu-delete-item" data-i="${i}">删除</button>
    </div>
  `
}

function setupMarketMenuEvents(menuItems) {
  const getItems = () => {
    const items = []
    document.querySelectorAll('.admin-market-menu-item').forEach(el => {
      const item = {}
      el.querySelectorAll('.menu-field').forEach(f => {
        item[f.dataset.field] = f.value
      })
      items.push(item)
    })
    return items
  }

  document.getElementById('addMenuItem')?.addEventListener('click', () => {
    menuItems = getItems()
    menuItems.push({ name: '', icon: '', url: '' })
    document.getElementById('marketMenuItems').innerHTML = menuItems.map((item, i) => renderMarketMenuItem(item, i)).join('')
    setupMarketMenuEvents(menuItems)
  })

  document.getElementById('marketMenuItems')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.admin-menu-delete-item')
    if (delBtn) {
      menuItems = getItems()
      const i = Number(delBtn.dataset.i)
      menuItems.splice(i, 1)
      document.getElementById('marketMenuItems').innerHTML = menuItems.map((item, idx) => renderMarketMenuItem(item, idx)).join('')
      setupMarketMenuEvents(menuItems)
    }
  })

  document.getElementById('saveMarketMenuConfig')?.addEventListener('click', async () => {
    menuItems = getItems()
    const items = [{ key: 'items', value: JSON.stringify(menuItems), label: '股票市场研究菜单', sort_order: 0 }]
    const res = await api.put('/api/system-config/market_menu', { items })
    if (res.ok) {
      alert('菜单配置已保存')
      loadAdminConfig()
    } else {
      alert(res.error || '保存失败')
    }
  })
}

function setupAdminBoardTabs() {
  const tabs = [...document.querySelectorAll('[data-admin-board]')]
  const boards = {
    resources: document.getElementById('adminResourcesBoard'),
    users: document.getElementById('adminUsersBoard'),
    referrals: document.getElementById('adminReferralsBoard'),
    config: document.getElementById('adminConfigBoard'),
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.adminBoard
      tabs.forEach(item => item.classList.toggle('active', item === tab))
      Object.entries(boards).forEach(([key, board]) => {
        if (!board) return
        const active = key === target
        board.hidden = !active
        board.classList.toggle('admin-board-active', active)
      })
      // Auto-activate first sub-tab when switching to users board
      if (target === 'users') {
        activateAdminUserTab('all')
      }
    })
  })
}

function activateAdminUserTab(target, { scroll = false } = {}) {
  const tabs = [...document.querySelectorAll('#adminUserSubTabs [data-admin-user-tab]')]
  const panels = [...document.querySelectorAll('[data-admin-user-panel]')]
  if (!tabs.length || !panels.length) return

  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.adminUserTab === target))
  panels.forEach(panel => {
    const active = panel.dataset.adminUserPanel === target
    panel.hidden = !active
    panel.classList.toggle('admin-user-panel-active', active)
  })

  if (scroll) {
    document.getElementById('adminUserSubTabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function setupAdminUserTabs() {
  const tabs = [...document.querySelectorAll('#adminUserSubTabs [data-admin-user-tab]')]
  tabs.forEach(tab => {
    tab.addEventListener('click', () => activateAdminUserTab(tab.dataset.adminUserTab))
  })
}

function setAdminInlineResult(id, message, ok = true) {
  const el = document.getElementById(id)
  if (!el) return
  el.style.display = 'block'
  el.innerHTML = `<div class="stream-result-success ${ok ? '' : 'error'}">${escapeHtml(message)}</div>`
}

function syncAdminResourceChoiceInputs() {
  ;['attachQuiz', 'attachMindmap', 'attachInfographic'].forEach(id => {
    const checkbox = document.getElementById(id)
    checkbox?.closest('.admin-resource-choice')?.classList.toggle('disabled', !checkbox.checked)
  })
}

function syncAdminVideoUploadMode() {
  const isNewVideo = !getSelectedResourceEpisodeId()
  const field = document.getElementById('adminVideoUploadField')
  const input = document.getElementById('streamFileInput')
  const label = document.getElementById('streamFileName')
  const progress = document.getElementById('streamProgressWrap')
  if (field) field.style.display = isNewVideo ? 'grid' : 'none'
  if (!isNewVideo) {
    if (input) input.value = ''
    if (label) label.textContent = '上传新视频'
    if (progress) progress.style.display = 'none'
  }
}

function getAdminResourceUploadFiles() {
  const folderFiles = [...(document.getElementById('resourceBundleFiles')?.files || [])]
  const looseFiles = [...(document.getElementById('resourceLooseFiles')?.files || [])]
  return [...folderFiles, ...looseFiles]
}

function updateResourceUploadFileLabels() {
  const folderFiles = [...(document.getElementById('resourceBundleFiles')?.files || [])]
  const looseFiles = [...(document.getElementById('resourceLooseFiles')?.files || [])]
  const folderLabel = document.getElementById('resourceBundleFileName')
  const looseLabel = document.getElementById('resourceLooseFileName')
  if (folderLabel) {
    const firstPath = folderFiles[0]?.webkitRelativePath || folderFiles[0]?.name || ''
    const folderName = firstPath.split('/').filter(Boolean)[0]
    folderLabel.textContent = folderFiles.length
      ? `${folderName || '已选文件夹'} · ${folderFiles.length} 个文件`
      : '选择 NotebookLM 文件夹'
  }
  if (looseLabel) {
    looseLabel.textContent = looseFiles.length
      ? `补充文件 · ${looseFiles.length} 个`
      : '补充选择单个文件'
  }
  applyNotebookMetadata(folderFiles)
}

async function applyNotebookMetadata(files) {
  const metadataFile = files.find(file => {
    const path = file.webkitRelativePath || file.name || ''
    return path.split('/').pop() === 'metadata.json'
  })
  if (!metadataFile) return
  try {
    const metadata = JSON.parse(await metadataFile.text())
    const selectedEpisodeId = getSelectedResourceEpisodeId()
    const titleInput = document.getElementById('courseTitle')
    const numberInput = document.getElementById('courseNumber')
    const youtubeInput = document.getElementById('courseYoutubeId')
    const title = metadata.title || metadata.sourceTitle || metadata.date
    const number = String(metadata.episode || '').match(/\d+/)?.[0]
    const youtubeId = String(metadata.url || '').match(/[?&]v=([^&]+)/)?.[1] || ''
    if (!selectedEpisodeId && titleInput && title && !titleInput.value.trim()) titleInput.value = title
    if (!selectedEpisodeId && numberInput && number) numberInput.value = number
    if (youtubeInput && youtubeId && !youtubeInput.value) youtubeInput.value = youtubeId
  } catch (err) {
    console.warn('Notebook metadata parse failed:', err)
  }
}

function resetAdminCourseForm() {
  // No-op: form is now in modal
}

function fillAdminCourseForm(course) {
  openCourseModal(course)
}

function getAdminCoursePayload() {
  return {
    episodeId: document.getElementById('courseEpisodeId')?.value || undefined,
    number: Number(document.getElementById('courseNumber')?.value || 0),
    title: document.getElementById('courseTitle')?.value || '',
    description: document.getElementById('courseDescription')?.value || '',
    category: document.getElementById('courseCategory')?.value || 'strategy',
    contentType: document.getElementById('courseContentType')?.value || 'video',
    status: document.getElementById('courseStatus')?.value || 'published',
    accessLevel: document.getElementById('courseAccessLevel')?.value || 'free',
    duration: document.getElementById('courseDuration')?.value || '',
    youtubeId: document.getElementById('courseYoutubeId')?.value || '',
    bilibiliId: document.getElementById('courseBilibiliId')?.value || '',
    cover: document.getElementById('courseCover')?.value || '',
    sortOrder: Number(document.getElementById('courseSortOrder')?.value || 0),
    articleUrl: document.getElementById('courseArticleUrl')?.value || '',
    articleObjectKey: document.getElementById('courseArticleObjectKey')?.value || '',
  }
}

function refreshAdminCourseSelects() {
  const options = renderCourseOptionList(state.adminQuizEpisodeId || episodes[0]?.id || '')
  const quizSelect = document.getElementById('adminQuizEpisode')
  if (quizSelect) quizSelect.innerHTML = options
}

function getSelectedResourceEpisodeId() {
  return Number(document.getElementById('courseEpisodeId')?.value || 0)
}

function getMindmapItemStats(items = []) {
  const infoCount = items.filter(item =>
    String(item.title || '').includes('信息图') ||
    String(item.image || '').includes('信息图') ||
    String(item.image || '').toLowerCase().includes('infographic')
  ).length
  const structureCount = items.filter(item => item.structure).length
  const mindmapCount = items.filter(item =>
    item.structure ||
    String(item.title || '').includes('思维导图') ||
    String(item.image || '').includes('思维导图') ||
    String(item.image || '').toLowerCase().includes('mindmap')
  ).length
  return { infoCount, mindmapCount, structureCount }
}

function renderAdminResourceSummary(data, fallbackStats = null) {
  const el = document.getElementById('adminResourceSummary')
  if (!el) return
  if (!data?.ok) {
    el.textContent = data?.error || '资料状态加载失败'
    return
  }
  const assets = data.assets || []
  const uploadedInfoCount = assets.filter(item => item.assetType === 'infographic').length
  const uploadedMindmapCount = assets.filter(item => item.assetType === 'mindmap_image').length
  const uploadedStructureCount = assets.filter(item => item.assetType === 'mindmap_structure').length
  const infoCount = uploadedInfoCount || fallbackStats?.infoCount || 0
  const mindmapCount = uploadedMindmapCount || fallbackStats?.mindmapCount || 0
  const structureCount = uploadedStructureCount || fallbackStats?.structureCount || 0
  el.innerHTML = `
    <span>题目 ${Number(data.quizCount || 0)}</span>
    <span>信息图 ${infoCount}</span>
    <span>思维导图 ${mindmapCount}</span>
    <span>结构 JSON ${structureCount}</span>
  `
}

async function loadAdminCourseResources(episodeId = getSelectedResourceEpisodeId()) {
  const el = document.getElementById('adminResourceSummary')
  if (!episodeId) {
    if (el) el.textContent = '选择课程后查看资料状态'
    return
  }
  if (el) el.textContent = '资料状态加载中...'
  const data = await api.get(`/api/admin-course-resources?episode=${episodeId}`)
  let fallbackStats = null
  if (data?.ok && !(data.assets || []).length) {
    const items = await courseContent.loadMindmaps(episodeId).catch(() => [])
    fallbackStats = getMindmapItemStats(items)
  }
  renderAdminResourceSummary(data, fallbackStats)
}

function selectAdminCourse(episodeId) {
  const id = Number(episodeId)
  if (!id) {
    state.adminQuizEpisodeId = null
    return
  }
  state.adminQuizEpisodeId = id
  const course = state.adminCourses.find(item => item.id === id) || episodes.find(item => item.id === id)
  if (course) openCourseModal(course)
}

let adminCoursePage = 1
const ADMIN_COURSE_PAGE_SIZE = 10

function renderAdminCourseList(courses) {
  const el = document.getElementById('adminCourseList')
  if (!el) return
  if (!courses.length) {
    el.innerHTML = '<div class="comments-empty">暂无课程，点击“新增课程”创建</div>'
    return
  }
  const totalPages = Math.ceil(courses.length / ADMIN_COURSE_PAGE_SIZE)
  if (adminCoursePage > totalPages) adminCoursePage = totalPages
  if (adminCoursePage < 1) adminCoursePage = 1
  const start = (adminCoursePage - 1) * ADMIN_COURSE_PAGE_SIZE
  const pageItems = courses.slice(start, start + ADMIN_COURSE_PAGE_SIZE)

  el.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>ID</th><th>课程</th><th>类型</th><th>状态</th><th>资料</th><th>操作</th></tr></thead>
      <tbody>
        ${pageItems.map(course => `
          <tr>
            <td class="admin-uid">#${course.id}</td>
            <td>
              <strong>${course.number ? `第${course.number}期 · ` : ''}${escapeHtml(course.title)}</strong>
              <div class="admin-uid">${escapeHtml(course.category || '-')} · ${escapeHtml(course.duration || '-')}</div>
            </td>
            <td>${course.contentType === 'article' ? '文章' : '视频'}</td>
            <td><span class="admin-badge ${course.status === 'published' ? 'badge-paid' : course.status === 'draft' ? 'badge-free' : 'badge-expired'}">${course.status === 'published' ? '已发布' : course.status === 'draft' ? '草稿' : '已归档'}</span></td>
            <td style="font-size:12px;">
              ${course.bilibiliId ? 'B站 ' : ''}${course.youtubeId ? 'YouTube ' : ''}${course.hasStreamVideo ? '本地 ' : ''}${course.articleUrl ? '文章 ' : ''}${course.quizCount ? `答题${course.quizCount} ` : ''}${course.mindmapCount ? `导图${course.mindmapCount}` : ''}
            </td>
            <td>
              <div class="admin-actions">
                <button class="btn btn-primary btn-xs admin-course-edit" data-course-id="${course.id}">编辑</button>
                <button class="btn btn-ghost btn-xs admin-course-archive" data-course-id="${course.id}">删除</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${totalPages > 1 ? `
      <div class="admin-course-pagination">
        <button class="btn btn-ghost btn-xs" ${adminCoursePage <= 1 ? 'disabled' : ''} data-page="${adminCoursePage - 1}">上一页</button>
        <span class="admin-course-page-info">${adminCoursePage} / ${totalPages}</span>
        <button class="btn btn-ghost btn-xs" ${adminCoursePage >= totalPages ? 'disabled' : ''} data-page="${adminCoursePage + 1}">下一页</button>
      </div>
    ` : ''}
  `
  el.querySelectorAll('.admin-course-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const course = state.adminCourses.find(item => item.id === Number(btn.dataset.courseId))
      if (course) openCourseModal(course)
    })
  })
  el.querySelectorAll('.admin-course-archive').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这门课程？删除后不可恢复！')) return
      const r = await api.del(`/api/admin-course-items?episode=${btn.dataset.courseId}`)
      if (r.ok) {
        await loadAdminCourses()
        await reloadCourseCatalog()
      } else alert(r.error || '删除失败')
    })
  })
  el.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      adminCoursePage = Number(btn.dataset.page)
      renderAdminCourseList(state.adminCourses)
    })
  })
}

function openCourseModal(course = null) {
  const isEdit = !!course
  const modal = document.createElement('div')
  modal.className = 'course-modal-overlay'
  modal.innerHTML = `
    <div class="course-modal">
      <div class="course-modal-header">
        <h3>${isEdit ? '编辑课程' : '新增课程'}</h3>
        <button class="course-modal-close" id="closeCourseModal">✕</button>
      </div>
      <div class="course-modal-body">
        <input type="hidden" id="courseEpisodeId" value="${isEdit ? course.id : ''}">
        <input type="hidden" id="courseNumber" value="${isEdit ? course.number || 0 : 0}">
        <input type="hidden" id="courseDescription" value="${isEdit ? escapeHtml(course.description || '') : ''}">
        <input type="hidden" id="courseStatus" value="${isEdit ? course.status : 'published'}">
        <input type="hidden" id="courseDuration" value="${isEdit ? escapeHtml(course.duration || '') : ''}">
        <input type="hidden" id="courseCover" value="${isEdit ? escapeHtml(course.cover || '') : ''}">
        <input type="hidden" id="courseSortOrder" value="${isEdit ? course.sortOrder || course.id : 0}">
        <input type="hidden" id="courseYoutubeId" value="${isEdit ? escapeHtml(course.youtubeId || '') : ''}">
        <input type="hidden" id="courseArticleObjectKey" value="${isEdit ? escapeHtml(course.articleObjectKey || '') : ''}">

        <div class="course-form-grid">
          <div class="course-form-group">
            <label>标题 <span class="required">*</span></label>
            <input class="stream-input" id="courseTitle" value="${isEdit ? escapeHtml(course.title) : ''}" placeholder="例如：第63期 交易计划" required>
          </div>
          <div class="course-form-row">
            <div class="course-form-group">
              <label>分类</label>
              <select class="stream-input" id="courseCategory">
                ${['strategy','basics','analysis','psychology','risk'].map(v => `<option value="${v}" ${(isEdit ? course.category : 'strategy') === v ? 'selected' : ''}>${{strategy:'策略',basics:'基础',analysis:'分析',psychology:'心理',risk:'风控'}[v]}</option>`).join('')}
              </select>
            </div>
            <div class="course-form-group">
              <label>类型</label>
              <select class="stream-input" id="courseContentType">
                <option value="video" ${(!isEdit || course.contentType === 'video') ? 'selected' : ''}>视频</option>
                <option value="article" ${(isEdit && course.contentType === 'article') ? 'selected' : ''}>文章</option>
              </select>
            </div>
            <div class="course-form-group">
              <label>权限</label>
              <select class="stream-input" id="courseAccessLevel">
                ${['free','logged_in','plus_pro','pro_only'].map(v => `<option value="${v}" ${(isEdit ? course.accessLevel : 'plus_pro') === v ? 'selected' : ''}>${{free:'公开免费',logged_in:'登录可看',plus_pro:'Plus/Pro',pro_only:'仅Pro'}[v]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="course-form-group">
            <label>B站BV号</label>
            <input class="stream-input" id="courseBilibiliId" value="${isEdit ? escapeHtml(course.bilibiliId || '') : ''}" placeholder="BV1xx411c7mD">
          </div>
          <div class="course-form-group">
            <label>文章链接</label>
            <input class="stream-input" id="courseArticleUrl" value="${isEdit ? escapeHtml(course.articleUrl || '') : ''}" placeholder="https://... 或 /articles/xxx.html">
          </div>
          <div class="course-form-group">
            <label>视频文件</label>
            <label class="stream-file-label" id="adminVideoUploadField">
              <span id="streamFileName">点击选择视频文件</span>
              <input type="file" id="streamFileInput" accept="video/*" style="display:none">
            </label>
            <div class="stream-progress-wrap" id="streamProgressWrap" style="display:none">
              <div class="stream-progress-bar">
                <div class="stream-progress-fill" id="streamProgressFill"></div>
              </div>
              <span class="stream-progress-text" id="streamProgressText">准备上传...</span>
            </div>
          </div>
          <div class="course-form-group">
            <label>课程资源（答题 / 导图 / 信息图）</label>
            <div style="display:flex;gap:12px;margin-bottom:8px;">
              <label class="admin-resource-choice"><input type="checkbox" id="attachQuiz" checked><span>答题</span></label>
              <label class="admin-resource-choice"><input type="checkbox" id="attachMindmap" checked><span>导图</span></label>
              <label class="admin-resource-choice"><input type="checkbox" id="attachInfographic" checked><span>信息图</span></label>
            </div>
            <label class="stream-file-label">
              <span id="resourceBundleFileName">选择 NotebookLM 文件夹</span>
              <input type="file" id="resourceBundleFiles" webkitdirectory directory multiple style="display:none">
            </label>
            <label class="stream-file-label secondary">
              <span id="resourceLooseFileName">补充单个文件</span>
              <input type="file" id="resourceLooseFiles" multiple accept=".json,application/json,image/*" style="display:none">
            </label>
            <div id="adminResourceSummary" class="admin-resource-summary" style="margin-top:8px;">${isEdit ? '加载中...' : ''}</div>
          </div>
        </div>
      </div>
      <div class="course-modal-footer">
        <button class="btn btn-ghost" id="cancelCourseModal">取消</button>
        <button class="btn btn-primary" id="saveResourceAll">保存</button>
      </div>
      <div class="stream-upload-result" id="adminCourseResult" style="display:none"></div>
    </div>
  `
  document.body.appendChild(modal)
  requestAnimationFrame(() => modal.classList.add('course-modal-visible'))

  // Close handlers
  const close = () => {
    modal.classList.remove('course-modal-visible')
    setTimeout(() => modal.remove(), 300)
  }
  modal.querySelector('#closeCourseModal').addEventListener('click', close)
  modal.querySelector('#cancelCourseModal').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // File label sync
  const streamInput = document.getElementById('streamFileInput')
  if (streamInput) streamInput.addEventListener('change', () => {
    const label = document.getElementById('streamFileName')
    if (label) label.textContent = streamInput.files?.[0]?.name || '点击选择视频文件'
  })
  syncAdminResourceChoiceInputs()
  updateResourceUploadFileLabels()

  // Form submit
  modal.querySelector('form#adminCourseFormInner')?.addEventListener('submit', e => e.preventDefault())
  modal.querySelector('#saveResourceAll').addEventListener('click', async () => {
    await saveAdminResourceBundle()
  })

  // Load resources if editing
  if (isEdit) loadAdminCourseResources(course.id)
}

async function loadAdminCourses() {
  const data = await api.get('/api/admin-course-items')
  if (!data.ok || !Array.isArray(data.courses)) return
  state.adminCourses = data.courses
  renderAdminCourseList(data.courses)
  refreshAdminCourseSelects()
}

async function reloadCourseCatalog() {
  courseCatalog.loaded = false
  courseCatalog.promise = null
  await courseCatalog.load()
}

function setStreamProgress(message, percent = null, error = false) {
  const wrap = document.getElementById('streamProgressWrap')
  const fill = document.getElementById('streamProgressFill')
  const text = document.getElementById('streamProgressText')
  if (wrap) wrap.style.display = 'block'
  if (text) text.textContent = message
  if (fill && percent !== null) {
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`
    fill.style.background = error ? '#ef4444' : 'var(--accent-gradient)'
  }
}

async function uploadStreamVideoForResource(file, title) {
  setStreamProgress('正在上传视频...', 5)

  const formData = new FormData()
  formData.append('file', file, file.name || 'video.mp4')
  formData.append('title', title || '')

  const xhr = new XMLHttpRequest()
  const uploadResult = await new Promise((resolve, reject) => {
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) {
        const pct = Math.round(event.loaded / event.total * 100)
        setStreamProgress(`正在上传视频 ${pct}%`, pct)
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        try { resolve(JSON.parse(xhr.responseText)) }
        catch { reject(new Error('上传响应解析失败')) }
      } else reject(new Error(`上传失败: HTTP ${xhr.status}`))
    })
    xhr.addEventListener('error', () => reject(new Error('上传网络错误')))
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')))
    xhr.open('POST', '/api/video-upload')
    xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('ws_token') || ''))
    xhr.send(formData)
  })

  if (!uploadResult.ok) throw new Error(uploadResult.error || '上传失败')
  setStreamProgress('上传完成', 100)
  return uploadResult.url
}

function appendResourceFiles(form, episodeId, files) {
  files.forEach(file => {
    const path = file.webkitRelativePath || file.name
    form.append('files', file, `ep${episodeId}/${path}`)
  })
}

function collectSelectedResourceFiles(episodeId) {
  const form = new FormData()
  form.append('episodeId', episodeId)
  const quizChecked = document.getElementById('attachQuiz')?.checked
  const mindmapChecked = document.getElementById('attachMindmap')?.checked
  const infoChecked = document.getElementById('attachInfographic')?.checked
  const files = getAdminResourceUploadFiles()

  if (!quizChecked && !mindmapChecked && !infoChecked && files.length) {
    throw new Error('请选择要导入的内容类型')
  }
  if ((quizChecked || mindmapChecked || infoChecked) && !files.length) {
    throw new Error('请选择 NotebookLM 文件夹或补充文件')
  }

  form.append('includeQuiz', quizChecked ? '1' : '0')
  form.append('includeMindmap', mindmapChecked ? '1' : '0')
  form.append('includeInfographic', infoChecked ? '1' : '0')
  appendResourceFiles(form, episodeId, files)
  return { form, count: files.length }
}

async function saveAdminResourceBundle() {
  const saveBtn = document.getElementById('saveResourceAll')
  try {
    const selectedEpisodeId = getSelectedResourceEpisodeId()
    const videoFile = document.getElementById('streamFileInput')?.files?.[0]
    const bilibiliId = document.getElementById('courseBilibiliId')?.value?.trim()
    const titleInput = document.getElementById('courseTitle')
    if (videoFile && titleInput && !titleInput.value.trim()) {
      titleInput.value = videoFile.name.replace(/\.[^.]+$/, '')
    }
    if (!selectedEpisodeId && !videoFile && !bilibiliId) throw new Error('请选择已有视频、上传新视频、或填写B站BV号')
    if (!titleInput?.value.trim()) throw new Error('请填写标题')

    saveBtn.disabled = true
    saveBtn.textContent = '保存中...'

    let streamUid = null
    if (videoFile) {
      setAdminInlineResult('adminCourseResult', '正在上传视频...')
      streamUid = await uploadStreamVideoForResource(videoFile, titleInput.value.trim())
    }

    setAdminInlineResult('adminCourseResult', '正在保存课程...')
    const courseRes = await api.post('/api/admin-course-items', getAdminCoursePayload())
    if (!courseRes.ok || !courseRes.course) throw new Error(courseRes.error || '保存课程失败')

    const episodeId = Number(courseRes.course.id)
    document.getElementById('courseEpisodeId').value = episodeId
    state.adminQuizEpisodeId = episodeId

    if (streamUid) {
      const link = await api.post('/api/video-stream', {
        episodeId,
        localPath: streamUid,
        title: titleInput.value.trim(),
        accessLevel: document.getElementById('courseAccessLevel')?.value || 'plus_pro',
      })
      if (!link.ok) throw new Error(link.error || '关联 Stream 视频失败')
    }

    const { form, count } = collectSelectedResourceFiles(episodeId)
    if (count > 0) {
      setAdminInlineResult('adminCourseResult', '正在上传资料...')
      const resourceRes = await api.postForm('/api/admin-course-resources', form)
      if (!resourceRes.ok) throw new Error(resourceRes.error || '上传资料失败')
      const skipped = Array.isArray(resourceRes.skipped) ? resourceRes.skipped.length : 0
      setAdminInlineResult('adminCourseResult',
        `保存完成：题目 ${resourceRes.quizFiles || 0}，文件 ${resourceRes.assetFiles || 0}${skipped ? `，跳过 ${skipped}` : ''}`
      )
      courseContent.quizzes.delete(episodeId)
      courseContent.mindmaps.delete(episodeId)
      courseContent.structures.clear()
    }

    await loadAdminCourses()
    await reloadCourseCatalog()
    setAdminInlineResult('adminCourseResult', '保存完成')
    // Close modal after successful save
    const overlay = document.querySelector('.course-modal-overlay')
    if (overlay) {
      overlay.classList.remove('course-modal-visible')
      setTimeout(() => overlay.remove(), 300)
    }
  } catch (err) {
    console.error('[SaveAdminCourse] Error:', err)
    const progressVisible = document.getElementById('streamProgressWrap')?.style.display === 'block'
    if (progressVisible) setStreamProgress(err.message || '保存失败', 100, true)
    setAdminInlineResult('adminCourseResult', err.message || '保存失败', false)
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false
      saveBtn.textContent = '保存'
    }
  }
}

function setupAdminCourseManager() {
  loadAdminCourses().catch(err => console.error('Admin course load error:', err))
  document.getElementById('refreshAdminCourses')?.addEventListener('click', () => loadAdminCourses())
  document.getElementById('addCourseBtn')?.addEventListener('click', () => openCourseModal())
}

function resetAdminQuizForm() {
  const form = document.getElementById('adminQuizForm')
  if (!form) return
  form.reset()
  document.getElementById('quizQuestionId').value = ''
  document.getElementById('quizSortOrder').value = String(state.adminQuizQuestions.length || 0)
  document.getElementById('quizStatus').value = 'published'
  document.getElementById('adminQuizResult').style.display = 'none'
}

function fillAdminQuizForm(question) {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? '' }
  set('quizQuestionId', question.id || '')
  set('quizSortOrder', question.sortOrder || 0)
  set('quizAnswer', question.answer || 0)
  set('quizStatus', question.status || 'published')
  set('quizQuestion', question.question || '')
  set('quizOptions', (question.options || []).join('\n'))
  set('quizExplanations', (question.explanations || []).join('\n'))
  set('quizExplanation', question.explanation || '')
  set('quizHint', question.hint || '')
  document.getElementById('adminQuizForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderAdminQuizList(questions) {
  const el = document.getElementById('adminQuizList')
  if (!el) return
  if (!questions.length) {
    el.innerHTML = '<div class="comments-empty">暂无题目</div>'
    return
  }
  el.innerHTML = questions.map((question, index) => `
    <div class="admin-quiz-item">
      <div>
        <strong>${index + 1}. ${escapeHtml(question.question)}</strong>
        <div class="admin-uid">${escapeHtml((question.options || []).map((opt, i) => `${['A', 'B', 'C', 'D'][i] || i + 1}. ${opt}`).join(' / '))}</div>
      </div>
      <div class="admin-actions">
        <span class="admin-badge ${question.status === 'published' ? 'badge-paid' : 'badge-free'}">${question.status === 'published' ? '已发布' : question.status}</span>
        <button class="btn btn-primary btn-xs admin-quiz-edit" data-question-id="${question.id}">编辑</button>
        <button class="btn btn-ghost btn-xs admin-quiz-delete" data-question-id="${question.id}">删除</button>
      </div>
    </div>
  `).join('')
  el.querySelectorAll('.admin-quiz-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = state.adminQuizQuestions.find(item => String(item.id) === String(btn.dataset.questionId))
      if (q) fillAdminQuizForm(q)
    })
  })
  el.querySelectorAll('.admin-quiz-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这道题？')) return
      const r = await api.del(`/api/admin-quiz?id=${encodeURIComponent(btn.dataset.questionId)}`)
      if (r.ok) {
        courseContent.quizzes.delete(Number(state.adminQuizEpisodeId))
        await loadAdminQuiz()
        await reloadCourseCatalog()
      }
      else alert(r.error || '删除失败')
    })
  })
}

async function loadAdminQuiz() {
  const episodeId = document.getElementById('adminQuizEpisode')?.value || state.adminQuizEpisodeId
  if (!episodeId) return
  state.adminQuizEpisodeId = Number(episodeId)
  const el = document.getElementById('adminQuizList')
  if (el) el.innerHTML = '<div class="loading-spinner">加载题目...</div>'
  const data = await api.get(`/api/admin-quiz?episode=${episodeId}`)
  if (!data.ok || !Array.isArray(data.questions)) {
    if (el) el.innerHTML = `<div class="comments-empty">${escapeHtml(data.error || '加载题目失败')}</div>`
    return
  }
  state.adminQuizQuestions = data.questions
  renderAdminQuizList(data.questions)
  resetAdminQuizForm()
}

function setupAdminQuizManager() {
  document.getElementById('loadAdminQuiz')?.addEventListener('click', () => loadAdminQuiz())
  document.getElementById('resetAdminQuiz')?.addEventListener('click', () => resetAdminQuizForm())
  document.getElementById('adminQuizEpisode')?.addEventListener('change', event => {
    state.adminQuizEpisodeId = Number(event.target.value)
  })
  document.getElementById('adminQuizForm')?.addEventListener('submit', async event => {
    event.preventDefault()
    const episodeId = document.getElementById('adminQuizEpisode')?.value
    const options = (document.getElementById('quizOptions')?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
    const explanations = (document.getElementById('quizExplanations')?.value || '').split('\n').map(s => s.trim())
    const payload = {
      id: document.getElementById('quizQuestionId')?.value || undefined,
      episodeId,
      sortOrder: Number(document.getElementById('quizSortOrder')?.value || 0),
      answer: Number(document.getElementById('quizAnswer')?.value || 0),
      status: document.getElementById('quizStatus')?.value || 'published',
      question: document.getElementById('quizQuestion')?.value || '',
      options,
      explanations,
      explanation: document.getElementById('quizExplanation')?.value || '',
      hint: document.getElementById('quizHint')?.value || '',
    }
    const r = await api.post('/api/admin-quiz', payload)
    if (r.ok) {
      setAdminInlineResult('adminQuizResult', '题目已保存')
      courseContent.quizzes.delete(Number(episodeId))
      await loadAdminQuiz()
      await reloadCourseCatalog()
    } else {
      setAdminInlineResult('adminQuizResult', r.error || '保存题目失败', false)
    }
  })
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}

function formatDuration(seconds) {
  if (!seconds) return '-'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

async function startStreamUpload() {
  const fileInput = document.getElementById('streamFileInput')
  const file = fileInput?.files[0]
  if (!file) return

  const title = document.getElementById('streamVideoTitle')?.value?.trim() || file.name
  const uploadBtn = document.getElementById('streamUploadBtn')
  const progressWrap = document.getElementById('streamProgressWrap')
  const progressFill = document.getElementById('streamProgressFill')
  const progressText = document.getElementById('streamProgressText')
  const resultDiv = document.getElementById('streamUploadResult')

  uploadBtn.disabled = true
  uploadBtn.textContent = '上传中...'
  progressWrap.style.display = 'block'
  resultDiv.style.display = 'none'

  try {
    // Step 1: Get direct upload URL from our backend
    progressText.textContent = '获取上传链接...'
    const createRes = await api.post('/api/stream', { title })
    if (!createRes.ok && !createRes.uploadURL) {
      throw new Error(createRes.error || '获取上传链接失败')
    }

    const { uploadURL, uid } = createRes

    // Step 2: Upload file directly to Cloudflare via XHR (for progress tracking)
    progressText.textContent = '正在上传...'
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100)
          progressFill.style.width = pct + '%'
          progressText.textContent = `上传中... ${pct}% (${formatFileSize(e.loaded)} / ${formatFileSize(e.total)})`
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 400) {
          resolve()
        } else {
          reject(new Error(`上传失败: HTTP ${xhr.status}`))
        }
      })

      xhr.addEventListener('error', () => reject(new Error('网络错误')))
      xhr.addEventListener('abort', () => reject(new Error('上传被取消')))

      const formData = new FormData()
      formData.append('file', file)

      xhr.open('POST', uploadURL)
      xhr.send(formData)
    })

    // Step 3: Show success
    progressFill.style.width = '100%'
    progressFill.style.background = 'var(--accent-gradient)'
    progressText.textContent = '上传完成！视频正在处理中...'

    resultDiv.style.display = 'block'
    const linkableCourses = state.adminCourses.length ? state.adminCourses : episodes
    const epOptions = linkableCourses.map(e => `<option value="${e.id}">${e.number ? `第${e.number}期` : `#${e.id}`} - ${escapeHtml(e.title)}</option>`).join('')
    resultDiv.innerHTML = `
      <div class="stream-result-success">
        <div class="stream-result-title">✅ 上传成功</div>
        <div class="stream-result-row">
          <span>Video ID:</span>
          <code class="stream-uid-code">${uid}</code>
          <button class="btn btn-ghost btn-xs" id="copyStreamUid">复制</button>
        </div>
        <div class="stream-result-row" style="margin-top:8px">
          <span>关联到课程：</span>
          <select id="streamLinkEpisode" class="stream-input" style="flex:1;min-width:120px">
            <option value="">-- 选择集数 --</option>
            ${epOptions}
          </select>
          <button class="btn btn-primary btn-xs" id="streamLinkBtn">关联</button>
        </div>
      </div>
    `

    document.getElementById('copyStreamUid')?.addEventListener('click', () => {
      navigator.clipboard.writeText(uid).then(() => {
        document.getElementById('copyStreamUid').textContent = '已复制!'
        setTimeout(() => { document.getElementById('copyStreamUid').textContent = '复制' }, 2000)
      })
    })

    document.getElementById('streamLinkBtn')?.addEventListener('click', async () => {
      const epId = document.getElementById('streamLinkEpisode')?.value
      if (!epId) { alert('请选择集数'); return }
      const linkBtn = document.getElementById('streamLinkBtn')
      linkBtn.disabled = true; linkBtn.textContent = '关联中...'
      const r = await api.post('/api/video-stream', { episodeId: Number(epId), cfStreamId: uid, title })
      if (r.ok) {
        linkBtn.textContent = '✓ 已关联'
        // Refresh paid video list + access map
        const listRes = await api.get('/api/video-stream')
        if (listRes.episodes) {
          state.paidVideoEpisodes = listRes.episodes.map(e => e.id)
          state.videoAccessMap = {}
          listRes.episodes.forEach(e => { state.videoAccessMap[e.id] = e.access_level || 'plus_pro' })
        }
      } else { alert(r.error || '关联失败'); linkBtn.disabled = false; linkBtn.textContent = '关联' }
    })

    // Refresh video list after a short delay
    setTimeout(() => loadStreamVideos(), 3000)

  } catch (err) {
    console.error('Stream upload error:', err)
    progressText.textContent = '上传失败: ' + err.message
    progressFill.style.width = '100%'
    progressFill.style.background = '#ef4444'
  } finally {
    uploadBtn.textContent = '上传视频'
    uploadBtn.disabled = false
  }
}

async function loadStreamVideos() {
  const listEl = document.getElementById('streamVideoList')
  if (!listEl) return

  try {
    const [res, mappingRes] = await Promise.all([
      api.get('/api/stream'),
      api.get('/api/video-stream'),
    ])
    const videos = res.videos || []
    const epList = mappingRes.episodes || []
    state.paidVideoEpisodes = epList.map(e => e.id)
    state.videoAccessMap = {}
    epList.forEach(e => { state.videoAccessMap[e.id] = e.access_level || 'plus_pro' })

    if (videos.length === 0) {
      listEl.innerHTML = '<div class="comments-empty">暂无视频，上传第一个吧</div>'
      return
    }

    // Build reverse map: cfStreamId → { episodeId, access_level }
    let streamToEp = {}
    let epToAccess = {}
    try {
      const mapRes = await api.get('/api/video-stream?list=all')
      if (mapRes.mappings) mapRes.mappings.forEach(m => {
        streamToEp[m.cf_stream_id] = m.episode_id
        epToAccess[m.episode_id] = m.access_level || 'plus_pro'
      })
    } catch {}
    const accessLevelOptions = `<option value="free">公开</option><option value="logged_in">登录可看</option><option value="plus_pro">Plus/Pro会员</option><option value="pro_only">仅Pro</option>`

    const linkableCourses = state.adminCourses.length ? state.adminCourses : episodes
    const epOptions = linkableCourses.map(e => `<option value="${e.id}">${e.number ? `第${e.number}期` : `#${e.id}`} - ${escapeHtml(e.title)}</option>`).join('')

    listEl.innerHTML = videos.map(v => {
      const linkedEp = streamToEp[v.uid]
      const linkedLabel = linkedEp ? `已关联 → 第${linkedEp}期` : ''
      return `
      <div class="stream-video-card" data-stream-uid="${v.uid}">
        <div class="stream-video-thumb">
          ${v.thumbnail ? `<img src="${escapeHtml(v.thumbnail)}" alt="${escapeHtml(v.name)}">` : '<div class="stream-thumb-placeholder">🎬</div>'}
          ${v.readyToStream ? '<span class="stream-status-badge ready">可播放</span>' : `<span class="stream-status-badge processing">${v.status === 'inprogress' ? `处理中 ${v.pctComplete || ''}` : v.status}</span>`}
        </div>
        <div class="stream-video-info">
          <div class="stream-video-name">${escapeHtml(v.name)}</div>
          <div class="stream-video-meta">
            <span>${formatDuration(v.duration)}</span>
            <span>${formatFileSize(v.size)}</span>
            <span>${v.created ? new Date(v.created).toLocaleDateString('zh-CN') : ''}</span>
          </div>
          <div class="stream-video-uid">
            ${linkedEp
              ? `<span style="color:var(--primary);font-weight:600">${linkedLabel}</span>
                 <select class="stream-access-select" data-access-ep="${linkedEp}" style="font-size:12px;padding:2px 4px;border:1px solid #ddd;border-radius:4px;margin:0 4px">
                   ${accessLevelOptions.replace(`value="${epToAccess[linkedEp] || 'plus_pro'}"`, `value="${epToAccess[linkedEp] || 'plus_pro'}" selected`)}
                 </select>
                 <button class="btn btn-ghost btn-xs stream-unlink-btn" data-unlink-ep="${linkedEp}" style="color:#ef4444">取消关联</button>`
              : `<select class="stream-link-select" data-link-uid="${v.uid}" style="font-size:12px;padding:2px 4px;border:1px solid #ddd;border-radius:4px">
                  <option value="">关联到集数</option>
                  ${epOptions}
                </select>
                <button class="btn btn-ghost btn-xs stream-link-save-btn" data-link-uid="${v.uid}">关联</button>`}
            <button class="btn btn-ghost btn-xs stream-copy-btn" data-copy-uid="${v.uid}">复制ID</button>
            <button class="btn btn-ghost btn-xs stream-delete-btn" data-del-uid="${v.uid}" style="color:#ef4444">删除</button>
          </div>
        </div>
      </div>`
    }).join('')

    // Link/unlink handlers
    listEl.querySelectorAll('.stream-link-save-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const uid = btn.dataset.linkUid
        const select = listEl.querySelector(`.stream-link-select[data-link-uid="${uid}"]`)
        const epId = select?.value
        if (!epId) { alert('请选择集数'); return }
        btn.disabled = true; btn.textContent = '关联中...'
        const r = await api.post('/api/video-stream', { episodeId: Number(epId), cfStreamId: uid })
        if (r.ok) { loadStreamVideos() } else { alert(r.error || '关联失败'); btn.disabled = false; btn.textContent = '关联' }
      })
    })

    // Access level change handlers
    listEl.querySelectorAll('.stream-access-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation()
        const epId = sel.dataset.accessEp
        const newLevel = sel.value
        const r = await api.patch(`/api/video-stream?episode=${epId}`, { accessLevel: newLevel })
        if (r.ok) {
          state.videoAccessMap[Number(epId)] = newLevel
          sel.style.borderColor = 'var(--primary)'
          setTimeout(() => { sel.style.borderColor = '#ddd' }, 1500)
        } else { alert(r.error || '修改失败') }
      })
    })

    listEl.querySelectorAll('.stream-unlink-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('确定取消关联？')) return
        btn.disabled = true; btn.textContent = '取消中...'
        const r = await api.del(`/api/video-stream?episode=${btn.dataset.unlinkEp}`)
        if (r.ok) { loadStreamVideos() } else { alert(r.error || '取消失败'); btn.disabled = false; btn.textContent = '取消关联' }
      })
    })

    // Copy and delete handlers
    listEl.querySelectorAll('.stream-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(btn.dataset.copyUid).then(() => {
          btn.textContent = '已复制!'
          setTimeout(() => { btn.textContent = '复制ID' }, 2000)
        })
      })
    })

    listEl.querySelectorAll('.stream-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('确定删除这个视频？删除后不可恢复。')) return
        btn.textContent = '删除中...'
        btn.disabled = true
        try {
          const res = await api.del(`/api/stream?uid=${btn.dataset.delUid}`)
          if (res.ok || res.success) {
            btn.closest('.stream-video-card')?.remove()
          } else {
            alert(res.error || '删除失败')
            btn.textContent = '删除'
            btn.disabled = false
          }
        } catch (err) {
          alert('删除失败')
          btn.textContent = '删除'
          btn.disabled = false
        }
      })
    })
  } catch (err) {
    console.error('Load stream videos error:', err)
    listEl.innerHTML = '<div class="comments-empty">加载视频列表失败</div>'
  }
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
function renderMembership() {
  const currentPlan = getEffectivePlan()
  const currentPeriod = currentPlan === 'free' ? null : state.user?.planPeriod || null  // 'monthly' | 'yearly' | null

  mainContent.innerHTML = `
    <div class="membership-page fade-in">
      <button class="back-btn" id="backHome">← 返回课程列表</button>

      <div class="membership-header">
        <h1 class="membership-title">选择你的会员计划</h1>
        <p class="membership-subtitle">解锁街哥全部技术分析课程，系统掌握交易技术</p>
      </div>

      <div id="membershipCreditSummary" class="membership-credit-summary">
        ${state.user ? '<div class="billing-loading">正在读取返佣邀请信息...</div>' : '<span>登录后可查看返佣邀请信息</span>'}
      </div>

      <div class="membership-cards">
        <!-- 体验版 -->
        <div class="mem-card ${currentPlan === 'free' ? 'mem-current' : ''}">
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
            <li class="mem-feat"><span class="mem-check">✓</span>街哥金融 / 生活感悟语录（陆续更新）</li>
            <li class="mem-feat"><span class="mem-check">✓</span>观看历史记录</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>新视频即时解锁</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>知识图解 & 框架</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>课后测验 + 解析</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>专属街家军身份标识</li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'free'
              ? '<button class="btn mem-btn mem-btn-current" disabled>当前方案</button>'
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
              <span class="mem-price" data-monthly="50" data-yearly="480">$50</span>
              <span class="mem-price-unit" data-monthly="/月" data-yearly="/年">/ 月</span>
            </div>
            <div class="mem-price-save" style="display:none">年付立省 $120，低至 $40/月</div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">✓</span>新视频上线即时解锁</li>
            <li class="mem-feat"><span class="mem-check">✓</span>高清知识图解 & 框架</li>
            <li class="mem-feat"><span class="mem-check">✓</span>全部课后测验 + 解析</li>
            <li class="mem-feat disabled"><span class="mem-x">✗</span>AI 机器人信号推送</li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? '<button class="btn mem-btn mem-btn-free" disabled>当前已是更高方案</button>'
              : currentPlan === 'plus'
                ? (currentPeriod === 'yearly'
                  ? '<button class="btn mem-btn mem-btn-current" disabled>当前方案</button>'
                  : `<button class="btn mem-btn mem-btn-plus" data-plan="plus" data-force-yearly="1">切换为年付</button>`)
                : `<button class="btn mem-btn mem-btn-plus" data-plan="plus">立即订阅</button>`}
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
              <span class="mem-price" data-monthly="100" data-yearly="960">$100</span>
              <span class="mem-price-unit" data-monthly="/月" data-yearly="/年">/ 月</span>
            </div>
            <div class="mem-price-save" style="display:none">年付立省 $240，低至 $80/月</div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">✓</span>包含 Plus 全部权限</li>
            <li class="mem-feat"><span class="mem-check pro">✓</span>华尔街 AI 机器人信号专属推送</li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? (currentPeriod === 'yearly'
                ? '<button class="btn mem-btn mem-btn-current" disabled>当前方案</button>'
                : `<button class="btn mem-btn mem-btn-pro" data-plan="pro" data-force-yearly="1">切换为年付</button>`)
              : `<button class="btn mem-btn mem-btn-pro" data-plan="pro">立即订阅</button>`}
          </div>
        </div>
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
            <div class="faq-a">是的。街哥每周会更新他对当下行情思路的视频。</div>
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
    if (res.disabled) {
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
      <div class="membership-credit-item"><span>待确认返佣</span><strong>${formatMinorUsd(stats.pending_credit_cents)}</strong></div>
      <div class="membership-credit-item"><span>可用返佣</span><strong>${formatMinorUsd(stats.available_credit_cents)}</strong></div>
      <div class="membership-credit-item"><span>已使用返佣</span><strong>${formatMinorUsd(stats.used_credit_cents)}</strong></div>
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
          <p>欢迎使用 wall-street-skill.com（以下简称"本网站"）。本网站由华尔街没有名字（<a href="https://x.com/WallStreet0Name" target="_blank">@WallStreet0Name</a>，以下简称"街哥"）运营。在注册、访问或使用本网站之前，请仔细阅读以下条款。注册即表示您已阅读、理解并同意受本协议约束。</p>

          <h2>一、服务内容</h2>
          <ol>
            <li>本网站提供技术分析教学视频、行情思路分享、知识图解、课后测验等<strong>教育类内容</strong>。</li>
            <li>所有内容均为街哥个人对市场行情的思考和技术教学演示，<strong>不构成任何形式的投资建议、交易指导或资产配置方案</strong>。</li>
            <li>本网站<strong>不提供带单服务、跟单信号、代客理财或任何形式的投资顾问服务</strong>。</li>
          </ol>

          <h2>二、免责声明</h2>
          <ol>
            <li><strong>非投资建议</strong>：本网站发布的所有视频、文字、图表、分析及任何形式的内容，均为街哥个人对行情的思考和教学演示，仅供学习参考，<strong>不构成对任何金融产品的买卖建议</strong>。</li>
            <li><strong>投资风险自担</strong>：加密货币、贵金属及其他金融市场交易具有高度风险，可能导致全部本金损失。用户因参考本网站内容而做出的任何投资决策，<strong>风险和后果由用户自行承担</strong>，与本网站及街哥无关。</li>
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
            <li><strong>在法律允许的最大范围内，本网站及街哥不对用户因使用或无法使用本网站而产生的任何直接、间接、附带、特殊或惩罚性损害承担责任</strong>，包括但不限于投资损失、数据丢失或业务中断。</li>
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
          <p>X (Twitter)：<a href="https://x.com/WallStreet0Name" target="_blank">@WallStreet0Name</a></p>
        </div>
      </div>
    </div>
  `
}

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
          desc: '街哥自用的专业看盘软件，支持技术指标、画线工具、多图表布局，新手必备',
          icon: '📊',
          url: 'https://cn.tradingview.com/?aff_id=158703',
          tag: '街哥自用',
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
}

// Settings tab state
let settingsTab = 'profile'

function renderProfile() {
  const currentPlan = getEffectivePlan()
  const planNames = { free: '体验版（免费）', plus: '⭐ Plus', pro: '💎 Pro' }

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
          <a class="settings-nav-item ${settingsTab === 'alerts' ? 'active' : ''}" data-tab="alerts">
            <span class="settings-nav-icon">🔔</span>Agent信号推送
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
                  <span class="profile-info-value">${planNames[currentPlan] || '体验版'}</span>
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

              <div class="settings-card">
                <div class="form-group">
                  <label class="form-label">电子邮箱</label>
                  <input type="email" class="form-input" value="${state.user.email}" disabled style="opacity:0.6">
                  <p class="settings-hint">暂不支持更改邮箱，如需更改请联系管理员</p>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">更改密码</h3>
                <div class="pwd-change-tabs">
                  <button class="pwd-tab active" data-pwd-mode="old">使用原密码</button>
                  <button class="pwd-tab" data-pwd-mode="email">使用邮箱验证</button>
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
                    <div class="sub-current-plan">${planNames[currentPlan] || '体验版'}</div>
                    <div class="sub-current-desc">${currentPlan === 'free' ? '公开视频 + 语录' : currentPlan === 'plus' ? '新视频即时解锁 + 图解 + 测验' : '全部权限 + AI信号'}</div>
                    ${state.user?.planExpiresAt ? `<div class="sub-expires">到期时间：${state.user.planExpiresAt}</div>` : ''}
                  </div>
                  <span class="sub-current-badge sub-badge-${currentPlan}">${currentPlan === 'free' ? '免费' : currentPlan === 'plus' ? 'Plus' : 'Pro'}</span>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">更改方案</h3>
                <div class="sub-plans">
                  <div class="sub-plan-row ${currentPlan === 'free' ? 'sub-plan-active' : ''}" data-plan="free">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">🆓</span>
                      <div>
                        <div class="sub-plan-name">体验版</div>
                        <div class="sub-plan-desc">公开视频 + 语录</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">免费</div>
                    ${currentPlan === 'free' ? '<span class="sub-plan-current">当前</span>' : ''}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'plus' ? 'sub-plan-active' : ''} ${currentPlan === 'pro' ? 'sub-plan-disabled' : ''}" data-plan="plus">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">⭐</span>
                      <div>
                        <div class="sub-plan-name">Plus</div>
                        <div class="sub-plan-desc">新视频即时解锁 + 图解 + 测验</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">$50/月</div>
                    ${currentPlan === 'plus' ? '<span class="sub-plan-current">当前</span>' : currentPlan === 'pro' ? '' : '<button class="btn btn-sm btn-primary sub-plan-btn" data-upgrade="plus">升级</button>'}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'pro' ? 'sub-plan-active' : ''}" data-plan="pro">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">💎</span>
                      <div>
                        <div class="sub-plan-name">Pro</div>
                        <div class="sub-plan-desc">全部权限 + AI信号</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">$100/月</div>
                    ${currentPlan === 'pro' ? '<span class="sub-plan-current">当前</span>' : '<button class="btn btn-sm btn-primary sub-plan-btn" data-upgrade="pro">升级</button>'}
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
          ` : settingsTab === 'alerts' ? `
            <!-- 信号推送 -->
            <div class="settings-section">
              <h2 class="settings-section-title">信号推送</h2>
              <p class="settings-section-desc">接收街哥的交易信号和市场提醒</p>

              ${currentPlan !== 'pro' ? `
                <div class="settings-card signal-upgrade">
                  <div class="signal-upgrade-icon">🔒</div>
                  <h3 class="signal-upgrade-title">Pro 会员专属功能</h3>
                  <p class="signal-upgrade-desc">升级到 Pro 会员即可加入街哥的 Telegram 信号群，接收实时交易警报和市场信号推送。</p>
                  <button class="btn btn-primary" id="signalGoUpgrade">升级 Pro 会员</button>
                </div>
              ` : `
                <div class="settings-card signal-telegram">
                  <div class="signal-tg-header">
                    <img class="signal-tg-icon" src="/tg-signal.jpg" alt="信号群" />
                    <div>
                      <h3 class="signal-tg-title">Telegram 信号群</h3>
                      <p class="signal-tg-subtitle">街哥AI信号推送 · Pro 会员专属</p>
                    </div>
                  </div>
                  <p class="signal-tg-desc">${state.user?.telegramBinding
                    ? `当前已永久绑定 ${escapeHtml(getTelegramBindingLabel(state.user.telegramBinding))}。系统后续只认这个 Telegram 账号，不支持更换。`
                    : '点击下方按钮先联系 Telegram 机器人。机器人会识别你的网站账号，并私聊发送专属入群链接。'}</p>
                  ${state.user?.telegramBinding ? `
                    <div class="signal-tg-binding">
                      绑定账号：${escapeHtml(getTelegramBindingLabel(state.user.telegramBinding))}
                      ${state.user.telegramBinding.name && state.user.telegramBinding.username ? ` · ${escapeHtml(state.user.telegramBinding.name)}` : ''}
                      <br>当前状态：${escapeHtml(getTelegramBindingStatus(state.user.telegramBinding) || 'bound')}
                      ${state.user.telegramBinding.lastInviteSentAt ? ` · 最近发链：${escapeHtml(state.user.telegramBinding.lastInviteSentAt)}` : ''}
                      <br>绑定规则：一个网站账号只认一个 Telegram 账号，不支持更换。
                      ${getTelegramBindingHint(state.user.telegramBinding) ? `<br>${escapeHtml(getTelegramBindingHint(state.user.telegramBinding))}` : ''}
                    </div>
                  ` : ''}
                  ${(state.user?.telegramBinding || canGenerateTelegramEntry(state.user)) ? `
                    <div class="signal-tg-actions">
                      ${canGenerateTelegramEntry(state.user) ? `<button class="btn btn-primary" id="signalGetInvite">${escapeHtml(getTelegramEntryButtonLabel(state.user))}</button>` : ''}
                      ${state.user?.telegramBinding ? '<button class="btn btn-ghost" id="signalRefreshStatus">刷新状态</button>' : ''}
                    </div>
                  ` : ''}
                  <div class="signal-msg" id="signalMsg"></div>
                </div>
              `}

              <div class="settings-card signal-features">
                <h3 class="signal-features-title">推送内容包括</h3>
                <ul class="signal-features-list">
                  <li>📊 街哥训练的AI机器人信号推送，根据街哥的交易模型匹配大机会</li>
                  <li>🎬 新课程上线通知</li>
                  <li>📢 Pro会员专属公告</li>
                </ul>
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
      if (oldDiv) oldDiv.style.display = mode === 'old' ? 'block' : 'none'
      if (emailDiv) emailDiv.style.display = mode === 'email' ? 'block' : 'none'
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
      } else {
        const code = document.getElementById('pwdVerifyCode')?.value
        if (!code || code.length !== 6) { showPwdMsg(msgDiv, '请输入6位验证码', 'err'); return }
        // First verify code to get token
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
          const fields = ['oldPassword', 'newPassword', 'confirmPassword', 'pwdVerifyCode']
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

  // Go to membership page link
  const goMem = document.getElementById('goMembershipPage')
  if (goMem) {
    goMem.addEventListener('click', () => navigate('membership'))
  }

  // Upgrade buttons (placeholder)
  mainContent.querySelectorAll('.sub-plan-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate('membership'))
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
          alert(res.error || '操作失败')
        }
      } catch {
        alert('操作失败，请稍后重试')
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

async function loadBillingHistory(container) {
  try {
    const data = await api.get('/api/orders')

    if (!data.orders || data.orders.length === 0) {
      container.innerHTML = '<div class="billing-empty">暂无账单记录</div>'
      return
    }

    const statusMap = {
      paid: { label: '已完成', cls: 'billing-paid' },
      pending: { label: '待支付', cls: 'billing-pending' },
      processing: { label: '处理中', cls: 'billing-pending' },
      expired: { label: '已过期', cls: 'billing-expired' },
    }

    container.innerHTML = data.orders.map(o => {
      const s = statusMap[o.status] || { label: o.status, cls: '' }
      const date = o.paidAt || o.createdAt || ''
      const displayDate = date.substring(0, 16)
      const paidAmount = o.amountConfirmed || o.amount
      const amountDiff = o.amountConfirmed && o.amountConfirmed !== o.amount
        ? ` <span class="billing-diff">(${formatMinorUsd(o.amount)})</span>` : ''
      const orderIdShort = o.orderId ? o.orderId.substring(0, 8) : ''
      return `
        <div class="billing-row">
          <div class="billing-info">
            <div class="billing-plan">${o.planLabel} ${o.periodLabel}</div>
            <div class="billing-date">${displayDate}${orderIdShort ? ` · <span class="billing-oid" title="${o.orderId}">#${orderIdShort}</span>` : ''}</div>
          </div>
          <div class="billing-right">
            <span class="billing-amount">${formatMinorUsd(paidAmount)}${amountDiff}</span>
            <span class="billing-status ${s.cls}">${s.label}</span>
          </div>
        </div>`
    }).join('')
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
    if (res.disabled) {
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
        <div class="subscription-credit-stat"><span>待确认返佣</span><strong>${formatMinorUsd(stats.pending_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>可用返佣</span><strong>${formatMinorUsd(stats.available_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>处理中返佣</span><strong>${formatMinorUsd(stats.reserved_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>已使用返佣</span><strong>${formatMinorUsd(stats.used_credit_cents)}</strong></div>
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近返佣记录</h3>
        ${recent.length ? `<div class="subscription-credit-list">${recent.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.plan_label || '')}</strong><div class="billing-date">${escapeHtml(item.created_at || '')} · ${escapeHtml(item.invited_user?.email_masked || '已邀请用户')}</div></div><div class="subscription-credit-row-right"><span>${formatMinorUsd(item.amount_cents)}</span><em>${escapeHtml(item.status_label || item.status || '')}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">暂无返佣记录</div>'}
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">最近邀请用户</h3>
        ${invited.length ? `<div class="subscription-credit-list">${invited.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.email_masked || item.uid || '已邀请用户')}</strong><div class="billing-date">${escapeHtml(item.attributed_at || '')}</div></div><div class="subscription-credit-row-right"><span>${item.paid ? '已订阅' : '未订阅'}</span><em>${formatMinorUsd(item.credit_cents)}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">暂无邀请用户</div>'}
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
          await api.patch('/api/notifications', { notificationId })
        }
        await refreshNotificationUnread()
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

function showFormMsgProfile(msg, type) {
  // Simple toast for profile page
  const toast = document.createElement('div')
  toast.className = `profile-toast profile-toast-${type}`
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.classList.add('active'), 10)
  setTimeout(() => { toast.classList.remove('active'); setTimeout(() => toast.remove(), 300) }, 2500)
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
  },
  login_code: {
    title: '邮箱验证码登录',
    submitLabel: '登录',
    codePurpose: 'login',
  },
  register: {
    title: '注册',
    submitLabel: '注册',
    codePurpose: 'register',
    passwordLabel: '密码',
    passwordPlaceholder: '8-32位，含大写字母、数字、特殊字符',
    showPasswordRules: true,
    showConfirmPassword: true,
    showTos: true,
  },
  reset_password: {
    title: '忘记密码',
    submitLabel: '重置密码',
    codePurpose: 'reset',
    passwordLabel: '新密码',
    passwordPlaceholder: '8-32位，含大写字母、数字、特殊字符',
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
  if (mode === 'login_password') {
    return `
      <div class="auth-mode-links">
        <a data-auth-mode="login_code">使用邮箱验证码登录</a>
        <a data-auth-mode="reset_password">忘记密码</a>
      </div>
    `
  }
  if (mode === 'login_code') {
    return `
      <div class="auth-mode-links">
        <a data-auth-mode="login_password">使用密码登录</a>
        <a data-auth-mode="reset_password">忘记密码</a>
      </div>
    `
  }
  if (mode === 'reset_password') {
    return `
      <div class="auth-mode-links">
        <a data-auth-mode="login_password">返回密码登录</a>
        <a data-auth-mode="login_code">使用验证码登录</a>
      </div>
    `
  }
  return ''
}

function renderAuthFooter(mode) {
  if (mode === 'register') {
    return '已有账号？<a data-auth-mode="login_password">立即登录</a>'
  }
  return '还没有账号？<a data-auth-mode="register">立即注册</a>'
}

async function handleSendCode() {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  const emailInput = document.getElementById('authEmail')
  const sendBtn = document.getElementById('sendCodeBtn')
  const codeGroup = document.getElementById('codeGroup')

  if (!emailInput || !emailInput.value || !emailInput.value.includes('@')) {
    showFormMsg('请先输入有效的邮箱地址', 'err')
    return
  }

  if (state._codeSending) return
  state._codeSending = true
  sendBtn.textContent = '发送中...'
  sendBtn.disabled = true

  try {
    const res = await api.post('/api/send-code', {
      email: emailInput.value,
      purpose: meta.codePurpose,
    })

    if (!res.ok) {
      showFormMsg(res.error || '发送失败，请稍后重试', 'err')
      sendBtn.textContent = '发送验证码'
      sendBtn.disabled = false
      state._codeSending = false
      return
    }

    // Show code input group
    if (codeGroup) codeGroup.style.display = 'block'
    showFormMsg(res.message || '验证码已发送到您的邮箱', 'ok')
    state._emailVerified = false
    state._verifyToken = null

    // Lock email input after sending
    emailInput.readOnly = true
    emailInput.style.opacity = '0.7'

    // Start 60s countdown
    clearAuthCodeTimer()
    state._codeCountdown = 60
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
    showFormMsg('网络错误，请检查网络后重试', 'err')
    sendBtn.textContent = '发送验证码'
    sendBtn.disabled = false
    state._codeSending = false
  }
}

async function handleCodeVerify(code) {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  const emailInput = document.getElementById('authEmail')
  const codeStatus = document.getElementById('codeStatus')
  const codeHint = document.getElementById('codeHint')

  if (!emailInput || !code || code.length !== 6) return

  if (codeStatus) { codeStatus.textContent = '...'; codeStatus.className = 'code-status' }

  try {
    const res = await api.post('/api/verify-code', {
      email: emailInput.value,
      code,
      purpose: meta.codePurpose,
    })

    if (res.ok) {
      state._emailVerified = true
      state._verifyToken = res.token
      if (codeStatus) { codeStatus.textContent = '✓'; codeStatus.className = 'code-status code-status-ok' }
      if (codeHint) { codeHint.textContent = '邮箱验证成功'; codeHint.className = 'form-hint form-hint-ok' }
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

function showAuthModal(mode, options = {}) {
  const meta = getAuthModeMeta(mode)
  const prefillEmail = (options.email ?? getCurrentAuthEmail() ?? state.authPrefillEmail ?? '').trim()
  const hasNextUrl = Object.prototype.hasOwnProperty.call(options, 'nextUrl')
  const referralCode = mode === 'register'
    ? normalizeReferralDisplayCode(options.referralCode || state.referralInviteCode)
    : ''

  state.authMode = mode
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
      ${mode === 'register' ? `
        <div class="form-group">
          <label class="form-label">昵称</label>
          <input type="text" class="form-input" name="nickname" id="authNickname" placeholder="给自己取个名字（选填）">
        </div>
      ` : ''}
      ${meta.codePurpose ? `
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
          ${meta.showPasswordRules ? '<p class="form-hint pwd-rules" id="pwdRules">需包含：大写字母、数字、特殊字符（如 !@#$%）</p>' : ''}
        </div>
      ` : ''}
      ${meta.showConfirmPassword ? `
        <div class="form-group">
          <label class="form-label">确认密码</label>
          <input type="password" class="form-input" name="confirmPassword" required placeholder="请再次输入密码">
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

  if (redirectAfterLogin) {
    if (syncProgress) progress.syncFromServer().catch(() => {})
    window.location.assign(redirectAfterLogin)
    return
  }

  if (syncProgress) {
    progress.syncFromServer().then(() => { renderView() }).catch(() => {})
  }
  if (state.currentView === 'home') {
    renderHome()
  }
  setTimeout(maybeShowPublicAlphaNotice, 320)
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
        <h1 class="trades-title">📊 街哥历史战绩</h1>
        <p class="trades-subtitle">以下内容整理自街哥在推特 X 公开发布的交易观点、操作思路、实盘视频与部分战绩记录。<br>这些内容发布时间早于部分行情验证节点，能够帮助新用户更直观地了解街哥的分析框架、执行能力和交易风格。<br>网站的意义很明确：<br>把原本分散在公开平台上的视频思路、经验、复盘，系统化地整理出来，提供给真正有需要的人。<br>你为服务付费，我提供行情思路，为认知提升负责，为交易执行问题提供帮助。</p>
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
      if (!data.trade_date || !data.symbol) { alert('请填写日期和标的'); btn.disabled = false; btn.textContent = '添加'; return }
      const res = await api.post('/api/trades', data)
      if (res.ok) {
        document.getElementById('tradesAdminForm').style.display = 'none'
        document.getElementById('showAddTrade').style.display = 'block'
        loadTradeRecords()
      } else { alert(res.error || '添加失败') }
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
        else { alert('删除失败'); btn.disabled = false }
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
          ${reply.contentHtml || escapeHtml(reply.content || '').replace(/\n/g, '<br>')}
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
              <div class="post-detail-content ${richContent ? 'post-detail-content-rich' : ''}" id="${richContent ? 'postRichContent' : ''}">${richContent ? (post.contentHtml || '') : escapeHtml(post.content || '').replace(/\n/g, '<br>')}</div>
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
  }

  function bindProtectedMarketNav(selector, targetPath) {
    $(selector)?.addEventListener('click', (e) => {
      closeMarketMenu()
      handleProtectedStaticNav(e, targetPath)
    })
  }

  $('#logoHome').addEventListener('click', () => navigate('home'))
  $('#navTrades').addEventListener('click', () => navigate('trades'))
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
  $('#navAI').addEventListener('click', (e) => {
    if (!requireLogin()) return
    e.preventDefault()
    const token = localStorage.getItem('ws_token')
    const url = `/ai?token=${encodeURIComponent(token)}`
    window.open(url, '_blank')
  })

  $('#loginBtn').addEventListener('click', () => showAuthModal('login_password'))
  $('#registerBtn').addEventListener('click', () => showAuthModal('register'))
  $('#adminBtn').addEventListener('click', () => navigate('admin'))

  // User dropdown menu — click to toggle, click elsewhere to close
  $('#userMenuTrigger').addEventListener('click', (e) => {
    e.stopPropagation()
    userDropdown.classList.toggle('active')
    closeMarketMenu()
  })

  document.addEventListener('click', (e) => {
    if (!userMenuWrap.contains(e.target)) {
      userDropdown.classList.remove('active')
    }
    if (marketMenu && marketToggle && !marketMenu.contains(e.target) && !marketToggle.contains(e.target)) {
      closeMarketMenu()
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
    navigate('profile')
  })
  $('#dropdownNotifications').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    settingsTab = 'notifications'
    navigate('profile')
  })
  $('#dropdownAdmin').addEventListener('click', () => {
    userDropdown.classList.remove('active')
    navigate('admin')
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
    state.user = null
    state.notificationUnread = 0
    localStorage.removeItem('ws_user')
    localStorage.removeItem('ws_token')
    clearAuthCookie()
    stopPresenceHeartbeat()
    updateAuthUI()
    renderView()
  })

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
    if (e.key === 'Escape') closeModal()
  })

  modalBody.addEventListener('click', (e) => {
    const modeLink = e.target.closest('[data-auth-mode]')
    if (modeLink) {
      e.preventDefault()
      showAuthModal(modeLink.dataset.authMode, { email: getCurrentAuthEmail(), preserveRedirect: true })
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
    if (e.target.id === 'authEmail') {
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
      if (!state._emailVerified) {
        showFormMsg('请先完成邮箱验证', 'err')
        return
      }
      const pwdError = getPasswordRuleError(data.password)
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
        const result = await api.post('/api/register', {
          email: data.email,
          nickname: data.nickname || '',
          password: data.password,
          verifyToken: state._verifyToken,
          tosAgree: true,
          tosVersion: TOS_AGREEMENT_VERSION,
        })
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

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', {
          method: 'password',
          email: data.email,
          password: data.password,
        })
        if (result.ok) {
          persistAuthSession(result, { syncProgress: true })
        } else {
          showFormMsg(result.error || '登录失败，邮箱或密码错误', 'err')
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
        showFormMsg('请先完成邮箱验证', 'err')
        return
      }

      setSubmitting(true)
      try {
        const result = await api.post('/api/login', {
          method: 'code',
          email: data.email,
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
        showFormMsg('请先完成邮箱验证', 'err')
        return
      }

      const pwdError = getPasswordRuleError(data.password)
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
        const result = await api.post('/api/reset-password', {
          email: data.email,
          verifyToken: state._verifyToken,
          newPassword: data.password,
        })
        if (result.ok) {
          showAuthModal('login_password', {
            email: data.email,
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

    const sortBtn = target.closest('.sort-btn')
    if (sortBtn) {
      state.sortOrder = sortBtn.dataset.sort
      renderHome()
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

    // 管理后台：点击统计卡片跳转到对应区域
    const statCard = target.closest('.admin-stat-clickable')
    if (statCard) {
      if (statCard.dataset.adminUserTab) {
        activateAdminUserTab(statCard.dataset.adminUserTab, { scroll: true })
        return
      }
      const targetId = statCard.dataset.scrollTo
      const el = document.getElementById(targetId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    // 管理后台：打开编辑用户弹窗
    const editUserBtn = target.closest('.admin-edit-user')
    if (editUserBtn) {
      const userId = Number(editUserBtn.dataset.userId)
      const userUid = editUserBtn.dataset.uid
      const userName = editUserBtn.dataset.name
      const userEmail = editUserBtn.dataset.email
      const currentPlan = editUserBtn.dataset.plan || 'free'
      const currentExpires = editUserBtn.dataset.expires || ''
      const currentAvatar = editUserBtn.dataset.avatar || ''
      const modal = document.getElementById('adminOrderModal')
      const modalBody = document.getElementById('adminOrderModalBody')
      const modalTitle = document.getElementById('adminOrderModalTitle')
      if (!modal) return
      modalTitle.textContent = `编辑用户 - ${userName} (${userUid})`
      const defaultExpiry = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0]
      modalBody.innerHTML = `
        <div class="admin-plan-form" style="display:flex;flex-direction:column;gap:14px;">
          <div class="admin-plan-field">
            <label>UID：</label>
            <span style="font-family:monospace;">${escapeHtml(userUid)}</span>
          </div>
          <div class="admin-plan-field">
            <label for="editUserEmail">邮箱：</label>
            <input type="email" id="editUserEmail" class="admin-plan-input" value="${escapeHtml(userEmail)}">
          </div>
          <div class="admin-plan-field">
            <label for="editUserNickname">昵称：</label>
            <input type="text" id="editUserNickname" class="admin-plan-input" value="${escapeHtml(userName)}">
          </div>
          <div class="admin-plan-field">
            <label for="editUserPassword">新密码（留空不修改）：</label>
            <input type="password" id="editUserPassword" class="admin-plan-input" placeholder="留空则不修改">
          </div>
          <div class="admin-plan-field">
            <label for="editUserPlan">套餐：</label>
            <select id="editUserPlan" class="admin-plan-select">
              <option value="free" ${currentPlan === 'free' ? 'selected' : ''}>免费 (Free)</option>
              <option value="plus" ${currentPlan === 'plus' ? 'selected' : ''}>Plus 会员</option>
              <option value="pro" ${currentPlan === 'pro' ? 'selected' : ''}>Pro 会员</option>
            </select>
          </div>
          <div class="admin-plan-field" id="editUserExpiresField">
            <label for="editUserExpires">到期日期：</label>
            <input type="date" id="editUserExpires" class="admin-plan-input" value="${currentExpires || defaultExpiry}">
            <div class="admin-plan-shortcuts">
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="30">+1个月</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="90">+3个月</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="180">+半年</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="365">+1年</button>
            </div>
          </div>
          <div class="admin-plan-actions">
            <button class="btn btn-primary" id="adminEditUserSaveBtn" data-user-id="${userId}">保存</button>
            <button class="btn btn-ghost" id="adminEditUserCancelBtn">取消</button>
          </div>
          <div id="adminEditUserResult" style="display:none"></div>
        </div>
      `
      modal.style.display = 'flex'

      document.getElementById('adminEditUserCancelBtn')?.addEventListener('click', () => modal.style.display = 'none')
      document.getElementById('adminEditUserSaveBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('adminEditUserSaveBtn')
        btn.disabled = true; btn.textContent = '保存中...'
        const resultEl = document.getElementById('adminEditUserResult')
        try {
          const payload = { userId }
          const email = document.getElementById('editUserEmail').value.trim()
          const nickname = document.getElementById('editUserNickname').value.trim()
          const password = document.getElementById('editUserPassword').value
          const plan = document.getElementById('editUserPlan').value
          const expiresAt = document.getElementById('editUserExpires').value
          if (email) payload.email = email
          if (nickname) payload.nickname = nickname
          if (password) payload.password = password
          payload.plan = plan
          if (plan !== 'free') payload.expiresAt = expiresAt
          const r = await api.put('/api/admin-users', payload)
          if (r.ok) {
            resultEl.style.display = 'block'
            resultEl.innerHTML = '<div class="stream-result-success">保存成功</div>'
            setTimeout(() => { modal.style.display = 'none'; activateAdminUserTab('all') }, 800)
          } else {
            resultEl.style.display = 'block'
            resultEl.innerHTML = `<div class="stream-result-success error">${escapeHtml(r.error || '保存失败')}</div>`
          }
        } catch (e) {
          resultEl.style.display = 'block'
          resultEl.innerHTML = `<div class="stream-result-success error">请求失败</div>`
        }
        btn.disabled = false; btn.textContent = '保存'
      })

      // Expiry shortcuts
      modal.querySelectorAll('.admin-expires-shortcut').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetId = btn.dataset.target || 'adminExpiresInput'
          const input = document.getElementById(targetId)
          if (input) {
            const d = new Date(Date.now() + Number(btn.dataset.days) * 86400000)
            input.value = d.toISOString().split('T')[0]
          }
        })
      })
      return
    }

    // 管理后台：打开套餐管理弹窗
    const editPlanBtn = target.closest('.admin-edit-plan')
    if (editPlanBtn) {
      const userId = Number(editPlanBtn.dataset.userId)
      const userName = editPlanBtn.dataset.name
      const currentPlan = editPlanBtn.dataset.plan || 'free'
      const currentExpires = editPlanBtn.dataset.expires || ''
      const modal = document.getElementById('adminOrderModal')
      const modalBody = document.getElementById('adminOrderModalBody')
      const modalTitle = document.getElementById('adminOrderModalTitle')
      if (!modal) return
      modalTitle.textContent = `管理套餐 - ${userName} (ID: ${userId})`
      // Default expiry: 1 year from now
      const defaultExpiry = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0]
      modalBody.innerHTML = `
        <div class="admin-plan-form">
          <div class="admin-plan-field">
            <label>当前状态：</label>
            <span>${currentPlan === 'free' ? '免费用户' : currentPlan.toUpperCase() + ' 会员'}${currentExpires ? '，到期日 ' + currentExpires : ''}</span>
          </div>
          <div class="admin-plan-field">
            <label for="adminPlanSelect">设置套餐：</label>
            <select id="adminPlanSelect" class="admin-plan-select">
              <option value="free" ${currentPlan === 'free' ? 'selected' : ''}>免费 (Free)</option>
              <option value="plus" ${currentPlan === 'plus' ? 'selected' : ''}>Plus 会员</option>
              <option value="pro" ${currentPlan === 'pro' ? 'selected' : ''}>Pro 会员</option>
            </select>
          </div>
          <div class="admin-plan-field" id="adminExpiresField">
            <label for="adminExpiresInput">到期日期：</label>
            <input type="date" id="adminExpiresInput" class="admin-plan-input" value="${currentExpires || defaultExpiry}">
            <div class="admin-plan-shortcuts">
              <button class="btn btn-xs admin-expires-shortcut" data-days="30">+1个月</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="90">+3个月</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="180">+半年</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="365">+1年</button>
            </div>
          </div>
          <div class="admin-plan-actions">
            <button class="btn btn-primary" id="adminPlanSaveBtn" data-user-id="${userId}">保存</button>
            <button class="btn btn-ghost" id="adminPlanCancelBtn">取消</button>
          </div>
        </div>
      `
      modal.style.display = 'flex'
      // Toggle expires field based on plan selection
      const planSelect = document.getElementById('adminPlanSelect')
      const expiresField = document.getElementById('adminExpiresField')
      const toggleExpires = () => { expiresField.style.display = planSelect.value === 'free' ? 'none' : '' }
      toggleExpires()
      planSelect.addEventListener('change', toggleExpires)
      return
    }

    // 管理后台：到期日期快捷按钮
    const expiresShortcut = target.closest('.admin-expires-shortcut')
    if (expiresShortcut) {
      const days = Number(expiresShortcut.dataset.days)
      const input = document.getElementById('adminExpiresInput')
      if (input) {
        const d = new Date(Date.now() + days * 86400000)
        input.value = d.toISOString().split('T')[0]
      }
      return
    }

    // 管理后台：保存套餐
    if (target.id === 'adminPlanSaveBtn') {
      const userId = Number(target.dataset.userId)
      const plan = document.getElementById('adminPlanSelect')?.value
      const expiresAt = document.getElementById('adminExpiresInput')?.value
      if (!plan) return
      target.disabled = true
      target.textContent = '保存中...'
      api.post('/api/admin-users', { userId, plan, expiresAt: plan === 'free' ? null : expiresAt }).then(r => {
        if (r.ok) {
          document.getElementById('adminOrderModal').style.display = 'none'
          renderAdmin()
        } else {
          alert('操作失败: ' + (r.error || '未知错误'))
          target.disabled = false
          target.textContent = '保存'
        }
      })
      return
    }

    // 管理后台：取消弹窗
    if (target.id === 'adminPlanCancelBtn') {
      document.getElementById('adminOrderModal').style.display = 'none'
      return
    }

    // 管理后台：查看用户订单
    const viewOrdersBtn = target.closest('.admin-view-orders')
    if (viewOrdersBtn) {
      const uid = viewOrdersBtn.dataset.uid
      const name = viewOrdersBtn.dataset.name
      const modal = document.getElementById('adminOrderModal')
      const modalBody = document.getElementById('adminOrderModalBody')
      const modalTitle = document.getElementById('adminOrderModalTitle')
      if (!modal || !uid) return
      modalTitle.textContent = `${name} 的订单记录`
      modalBody.innerHTML = '<div class="loading-spinner">加载中...</div>'
      modal.style.display = 'flex'
      api.get(`/api/orders?uid=${uid}`).then(r => {
        if (!r.ok || !r.orders) {
          modalBody.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:20px;">${escapeHtml(r.error || '获取失败')}</p>`
          return
        }
        if (r.orders.length === 0) {
          modalBody.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:20px;">暂无订单</p>'
          return
        }
        modalBody.innerHTML = `
          <table class="admin-table" style="margin:0;">
            <thead><tr><th>订单号</th><th>方案</th><th>金额</th><th>实付</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>
              ${r.orders.map(o => `<tr>
                <td style="font-size:12px;">${escapeHtml(o.orderId || '-')}</td>
                <td>${escapeHtml(o.planLabel)} ${escapeHtml(o.periodLabel)}</td>
                <td>$${escapeHtml(String(o.amount))}</td>
                <td>${o.amountConfirmed ? '$' + escapeHtml(String(o.amountConfirmed)) : '-'}</td>
                <td><span class="admin-badge ${o.status === 'paid' ? 'badge-paid' : 'badge-free'}">${escapeHtml(o.statusLabel)}</span></td>
                <td>${escapeHtml(o.paidAt || o.createdAt)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        `
      })
      return
    }

    // 关闭订单弹窗
    if (target.id === 'adminOrderModalClose' || target.classList.contains('admin-order-modal')) {
      const modal = document.getElementById('adminOrderModal')
      if (modal) modal.style.display = 'none'
      return
    }
    if (target.id === 'goUpgrade' || target.id === 'goUpgrade2' || target.id === 'goUpgradeCommunity' || target.id === 'goUpgradeCommunityReplies') { navigate('membership'); return }
    if (target.id === 'goUpgradeVideo') { if (!state.user) { showAuthModal('login_password') } else { navigate('membership') }; return }

    // Membership: subscribe button
    const memSubBtn = target.closest('.mem-btn-plus, .mem-btn-pro')
    if (memSubBtn) {
      if (!requireLogin()) return
      const plan = memSubBtn.dataset.plan
      const forceYearly = memSubBtn.dataset.forceYearly === '1'
      const card = memSubBtn.closest('.mem-card')
      const activeTab = card?.querySelector('.price-tab.active')
      const period = forceYearly ? 'yearly' : (activeTab?.dataset.period || 'monthly')
      const originalText = memSubBtn.textContent

      memSubBtn.disabled = true
      memSubBtn.textContent = '计算价格...'

      try {
        const preview = await api.get(`/api/payment?preview=1&plan=${plan}&period=${period}&use_referral_credit=1`)
        if (preview.error) {
          alert(preview.error)
          memSubBtn.disabled = false
          memSubBtn.textContent = originalText
          return
        }

        let confirmMsg = `${preview.label}\n`
        if (preview.credit > 0 || Number(preview.referral_credit_applied_cents || 0) > 0) {
          confirmMsg += `\n原价：$${preview.fullPrice}`
          if (preview.credit > 0) confirmMsg += `\n当前方案剩余 ${preview.daysRemaining} 天，抵扣：-$${preview.credit}`
          if (Number(preview.referral_credit_applied_cents || 0) > 0) confirmMsg += `\n返佣邀请优惠：-${formatMinorUsd(preview.referral_credit_applied_cents)}`
          confirmMsg += `\n实际支付：$${preview.finalAmount}`
        } else {
          confirmMsg += `\n支付金额：$${preview.finalAmount}`
        }
        confirmMsg += `\n\n确认支付？`

        if (!confirm(confirmMsg)) {
          memSubBtn.disabled = false
          memSubBtn.textContent = originalText
          return
        }

        memSubBtn.textContent = '正在创建订单...'
        const res = await api.post('/api/payment', { plan, period, use_referral_credit: true })
        if (res.paid_with_credit) {
          alert('返佣邀请优惠已使用，本次订阅已开通。')
          await refreshCurrentUserProfile({ rerender: false }).catch(() => null)
          renderMembership()
        } else if (res.checkout_url) {
          window.location.href = res.checkout_url
        } else {
          alert(res.error || '创建订单失败')
          memSubBtn.disabled = false
          memSubBtn.textContent = originalText
        }
      } catch (err) {
        alert('网络错误，请稍后重试')
        memSubBtn.disabled = false
        memSubBtn.textContent = originalText
      }
      return
    }

    // Settings page: upgrade button
    const upgradeBtn = target.closest('.sub-plan-btn')
    if (upgradeBtn) {
      const plan = upgradeBtn.dataset.upgrade
      if (plan && plan !== 'free') {
        navigate('membership')
      }
      return
    }

    // Membership price toggle (月付/年付)
    const priceTab = target.closest('.price-tab')
    if (priceTab) {
      const card = priceTab.closest('.mem-card')
      if (!card) return
      const period = priceTab.dataset.period
      card.querySelectorAll('.price-tab').forEach(t => t.classList.remove('active'))
      priceTab.classList.add('active')
      const priceEl = card.querySelector('.mem-price')
      const unitEl = card.querySelector('.mem-price-unit')
      const saveEl = card.querySelector('.mem-price-save')
      if (priceEl) priceEl.textContent = '$' + priceEl.dataset[period]
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
          alert(res.error || '删除失败')
        }
      } catch (err) {
        console.error('Delete post error:', err)
        alert('删除失败，请检查网络')
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
          alert(res.error || '发布失败')
          btn.disabled = false
          btn.textContent = '发布回复'
        }
      } catch (err) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        console.error('Submit reply error:', err)
        alert(err?.message || '发布失败，请检查网络')
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
          alert(res.error || '删除失败')
        }
      } catch (err) {
        console.error('Delete reply error:', err)
        alert('删除失败，请检查网络')
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
      alert(res.ok ? (res.message || '举报已提交') : (res.error || '举报失败'))
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
      if (!title || !plainText) { alert('标题和内容不能为空'); return }
      if ((editor?.root && getPostImageCount(editor.root) > MAX_POST_IMAGES)) {
        alert(`最多上传 ${MAX_POST_IMAGES} 张图片`)
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
          alert(res.error || '发帖失败')
          btn.disabled = false
          btn.textContent = '发布'
        }
      } catch (error) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        alert(error?.message || '发帖失败，请检查网络')
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
      alert(res.ok ? (res.message || '举报已提交') : (res.error || '举报失败'))
      return
    }

    const postPinBtn = target.closest('[data-post-pin]')
    if (postPinBtn) {
      const res = await api.patch('/api/posts/pin', {
        postId: postPinBtn.dataset.postPin,
        sticky: postPinBtn.dataset.nextPin === '1',
      })
      if (!res.ok) {
        alert(res.error || '操作失败')
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
        alert(res.error || '操作失败')
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
        alert(res.error || '操作失败')
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
window.__buildVersion = '20260531111245'
init().catch(err => {
  console.error('App init error:', err)
  courseCatalog.apply(staticEpisodes, 'static')
  renderView()
})
