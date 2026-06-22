import { episodes as staticEpisodes, categories } from './data/episodes.js'
import { loadSiteUpdates } from './data/updates.js'
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

function formatMinorUsd(cents) {
  const value = Number(cents || 0)
  return `$${(Math.max(0, value) / 100).toFixed(2)}`
}

function planLabel(plan, expiresAt) {
  if (!plan || plan === 'free') return '<span class="admin-badge badge-free">鍏嶈垂</span>'
  const label = plan === 'pro' ? 'PRO' : 'Plus'
  const expStr = expiresAt instanceof Date ? expiresAt.toISOString().substring(0, 10) : String(expiresAt || '').substring(0, 10)
  const expired = expStr && new Date(expStr + 'T23:59:59+08:00') < new Date()
  if (expired) return `<span class="admin-badge badge-expired">${label} (宸茶繃鏈?</span>`
  return `<span class="admin-badge badge-paid">${label}</span>`
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
      <button type="button" class="reply-image-card-remove" data-remove-reply-image="${image.id}" aria-label="绉婚櫎鍥剧墖">脳</button>
    </div>
  `).join('')
}

function updateReplyComposerMeta() {
  const count = document.getElementById('replyCharCount')
  if (!count) return

  const textLength = String(document.getElementById('replyInput')?.value || '').length
  count.textContent = `${textLength} 瀛?路 ${replyDraftImages.length} 鍥綻
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
      alert('鍥炲浠呮敮鎸?JPEG銆丳NG銆乄ebP銆丟IF 鍥剧墖')
      continue
    }

    if (file.size > MAX_POST_IMAGE_BYTES) {
      alert('鍗曞紶鍥剧墖涓嶈兘瓒呰繃 5MB')
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
      `<img src="${escapeHtml(url)}" alt="鍥炲鍥剧墖 ${index + 1}">`
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
      submitBtn.textContent = `涓婁紶鍥剧墖 ${index + 1}/${replyDraftImages.length}...`
    }

    const response = await api.postForm('/api/post-images', formData)
    if (!response.ok || !response.assetId || !response.url) {
      throw new Error(response.error || '涓婁紶鍥炲鍥剧墖澶辫触')
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

function showPostImageLightbox(src, alt = '甯栧瓙鍥剧墖') {
  closePostImageLightbox()
  const overlay = document.createElement('div')
  overlay.className = 'post-image-lightbox active'
  overlay.innerHTML = `
    <button class="post-image-lightbox-close" aria-label="鍏抽棴棰勮">脳</button>
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
    placeholder: '鍐欎笅浣犵殑鎯虫硶锛屾敮鎸佹钀姐€佸紩鐢ㄣ€佸垪琛ㄣ€侀摼鎺ュ拰鍥剧墖...',
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
    alert(`鏈€澶氫笂浼?${MAX_POST_IMAGES} 寮犲浘鐗嘸)
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > MAX_POST_IMAGE_BYTES) {
      alert('鍗曞紶鍥剧墖涓嶈兘瓒呰繃 5MB')
      return
    }
    if (getPostImageCount(editor.root) >= MAX_POST_IMAGES) {
      alert(`鏈€澶氫笂浼?${MAX_POST_IMAGES} 寮犲浘鐗嘸)
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
    throw new Error(`鏈€澶氫笂浼?${MAX_POST_IMAGES} 寮犲浘鐗嘸)
  }

  for (let index = 0; index < dataImages.length; index++) {
    const image = dataImages[index]
    const source = image.getAttribute('src') || ''
    const blob = dataUrlToBlob(source)
    if (!blob) {
      throw new Error('鍥剧墖鏍煎紡鏃犳晥锛岃閲嶆柊鎻掑叆')
    }
    if (blob.size > MAX_POST_IMAGE_BYTES) {
      throw new Error('鍗曞紶鍥剧墖涓嶈兘瓒呰繃 5MB')
    }

    const formData = new FormData()
    formData.append('file', blob, `post-image-${index + 1}.${getImageExtension(blob.type)}`)

    if (submitBtn) {
      submitBtn.textContent = `涓婁紶鍥剧墖 ${index + 1}/${dataImages.length}...`
    }

    const response = await api.postForm('/api/post-images', formData)
    if (!response.ok || !response.assetId || !response.url) {
      throw new Error(response.error || '涓婁紶鍥剧墖澶辫触')
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
      image.alt = '甯栧瓙鍥剧墖鍔犺浇澶辫触'
    }
  }))
}

// ===== 琛楀摜璇綍 =====
const allQuotes = [
  '澶槼搴曚笅娌℃湁鏂伴矞浜嬶紝浜烘€т笉浼氬彉锛屽ぇ澶氭暟浜轰細鍦ㄧ被浼肩殑浣嶇疆鐘悓鏍风殑閿欍€?,
  '鏀惧純澶嫢鎸ょ殑浜ゆ槗锛屽ぇ澶氭暟鏃堕棿鍋囩獊鐮村悗鍙備笌鍙嶅悜锛屾瘮杩界獊鐮磋儨鐜囬珮銆?,
  '浠讳綍浜ゆ槗鍦ㄥ弬涓庝箣鍓嶉兘瑕佹兂濂藉湪鍝寕姝㈡崯鎴栬€呬簭鏈噾鐨勫灏戦挶姝㈡崯銆?,
  '宸︿晶浜ゆ槗鏄瘯鍥炬敼鍙樿繍鍔ㄦ柟鍚戯紝鍙充晶浜ゆ槗鏄瘯鍥捐窡闅忚繍鍔ㄦ柟鍚戙€?,
  '澶村涓婂ぇ澶氭暟鏃堕棿瑕佷繚鎸佺┖浠擄紝鎵嶈兘瀹㈣鐨勭湅寰呭競鍦恒€?,
  '涔板湪鏃犱汉闂触锛屽崠鍦ㄤ汉澹伴紟娌搞€?,
  '涓嶈涓嬮噸娉紝鎸佷粨涓嶈楂樹簬鎬昏祫閲戠殑10%锛屼笉瑕佸姞澶ф潬鏉嗭紝杩欐槸姒傜巼娓告垙锛岀粏姘撮暱娴侊紝绔欏湪姒傜巼鐨勪竴鏂癸紝鎵嶅彲鑳借禋閽憋紝鍚﹀垯蹇呬簭銆?,
  '姝ｅ父璧板娍锛氫細鎶€鏈殑鍜屽簞瀹朵竴璧锋帹鍔ㄧ洏闈紝鏀跺壊涓嶆噦鎶€鏈殑闊彍銆傞潪姝ｅ父璧板娍锛氫笉鎳傛妧鏈殑闊彍鐖嗗畬浜嗭紝鍐嶆敹鍓?鍒颁綅浜?鐨勯偅浜涙噦鎶€鏈殑浜恒€?,
  '涓栫晫缁忔祹鍙叉槸涓€閮ㄥ熀浜庡亣璞″拰璋庤█鐨勮繛缁墽銆傝鑾峰緱璐㈠瘜锛屽仛娉曞氨鏄娓呭叾鍋囪薄锛屾姇鍏ュ叾涓紝鐒跺悗鍦ㄥ亣璞¤鍏紬璁よ瘑涔嬪墠閫€鍑烘父鎴忋€?,
  '褰撲綘璁や负涓€瀹氫細鎸ｉ挶鐨勬椂鍊欙紝浜忔崯灏变細鏉ヤ复銆?,
  '鍐嶄紭绉€鐨勪氦鏄撹€呴兘鏃犳硶閬垮厤瀵硅鎯呯殑棰勬祴锛屼氦鏄撳尯鍒簬璧屽崥姝ｆ槸鍦ㄤ簬閫氳繃瀵硅鎯呯殑棰勬祴鍜屾妸鎻¤兘澶熻揪鍒版棰勬湡锛屽彧鏄細鍙婃椂鍚戝競鍦轰綆澶达紝涓嶄細闄峰叆鎵у康缃簡銆?,
  '褰撲釜浜烘槸涓€涓绔嬬殑涓綋鏃讹紝浠栨湁鐫€鑷繁椴滄槑鐨勪釜鎬у寲鐗瑰緛锛岃€屽綋杩欎釜浜鸿瀺鍏ヤ簡缇や綋鍚庯紝浠栫殑鎵€鏈変釜鎬ч兘浼氳杩欎釜缇や綋鎵€娣规病锛屼粬鐨勬€濇兂绔嬪埢灏变細琚兢浣撶殑鎬濇兂鎵€鍙栦唬銆?,
  '鍏充簬鎶€鏈垎鏋愶紝鐪熺殑涓嶅瓨鍦ㄦ墍璋撶殑"灞犻緳涔嬫湳"锛屽浼氬氨鍙互涓€鍔虫案閫镐簡銆?,
  'Buy the rumor锛宻ell the news銆備拱娑堟伅锛屽崠浜嬪疄銆?,
  '甯傚満鎯呯华楂樻定鐨勬椂鍊欙紝鏋佸叾涔愯娌℃湁浜烘暍鍋氱┖锛屾祦鍔ㄦ€ф渶濂斤紝鏄幇璐ц窇璺殑濂芥椂鏈恒€?,
  '浜ゆ槗鏄竴鍦哄弽浜烘€х殑璧屽崥锛岃€屽競鍦烘病鏈夊閿欙紝闇€浠ュ悇璺垎鏋愬笀涓洪暅锛屽彲浠ユ瑙傜偣鏄庡绌烘壘鍙嶆寚銆?,
  '鏄爣鐨勫拰瓒嬪娍鎴愬氨浜猴紝鑰屼笉鏄汉鎴愬氨鏍囩殑銆備竴娴佹爣鐨勬垚灏变竴娴佺殑浜猴紝鏁簬鍙備笌鏍稿績鏍囩殑銆傛渶缁堜細鍙戠幇锛?0%鐨勬敹鐩婃潵鑷簬涓€娆℃垬褰广€?,
  '浜ゆ槗涓€寮€濮嬫槸鐪嬪埌鏈轰細锛屽啀鍚庨潰鏄〃杈炬満浼氾紝鍐嶅悗闈㈡槸鍝佸懗鏈轰細銆傚搧鍛虫満浼氬湪浜庣瓑寰呬笌閫夋嫨锛屽搧鍛冲湪浜庝笉骞蹭粈涔堛€?,
  '璐㈠瘜浼氬憜鍦ㄤ护浜烘剰鎯充笉鍒扮殑閭ｄ竴杈广€?,
  '涓€涓汉鎸佺画浜忛挶锛屼粠鏉ラ兘涓嶄細鏄洜涓?涓€鏃犳墍鐭?锛屽彧浼氭槸"灞℃暀涓嶆敼"銆?,
  '澶ч儴鍒嗕氦鏄撴槸瀹屽叏涓嶅€煎緱鍙備笌鐨勶紝骞朵笖浼氳浜哄け鍘诲瓒嬪娍鐨勫垽鏂姏銆?,
  '鍦ㄦ煇涓勾绾箣鍓嶏紝鍙互闈犻€忔敮韬綋銆佸皬鑱槑鍜岃€佸ぉ缁欑殑杩愭皵锛屼竴鐩村彇宸у湴娲荤潃銆傜劧鑰屽埌浜嗘煇涓勾绾箣鍚庯紝鐪熸鑳借鎴戜滑璧拌繙鐨勶紝閮芥槸鑷緥銆佺Н鏋佸拰璁ょ煡琛ヨ冻銆?,
  '姣忔澶ц鎯呴兘浼氭湁浜哄皝绁烇紝浣嗘槸娌℃湁璋佸彲浠ユ案杩滃銆傞珮鎵嬪拰骞冲焊鑰呯殑鍖哄埆鍦ㄤ簬锛岀湅瀵圭殑琛屾儏蹇冪嫚鎵嬭荆璧氱殑鐩嗘弧閽垫弧锛岀湅閿欑殑琛屾儏涓€鏍峰績鐙犳墜杈ｅ壊瀹屽氨璺戙€傞煭鑿滃憿锛岀湅瀵圭殑琛屾儏涓嶆暍鎷匡紝鍋氶敊鐨勮鎯呮鎵涖€?,
  '娌℃湁浜哄ぉ鐢熸槸璧岄锛屾瘡涓€涓祵楝奸兘璧锋簮浜庤耽灏忛挶銆?,
  '甯傚満姘歌繙鏄埜鐖革紝鎴戞瘡娆′互涓烘垜鏄珮鎵嬬殑鏃跺€欙紝灏辨槸璇ヨ鎶借€冲厜鐖嗕粨鐨勬椂鍊欎簡銆?,
  '鍦ㄥ崕灏旇锛屽仛绌虹殑浜鸿兘璧氶挶锛屽仛澶氱殑浜轰篃鑳借禋閽憋紝鍞嫭璐┆鐨勪汉姘歌繙璧氫笉鍒伴挶銆?,
  '璧氶挶浜嗕竴瀹氳鑸嶅緱绂诲紑璧屾銆?,
  '鍋氫氦鏄撹鎳傚緱闅忕紭锛屽埆鎯崇潃姣忎竴娈甸兘鍚冨埌锛岃窡浣犺皥鎭嬬埍涓€鏍烽€夎窡浣犳渶鑸掓湇鐨勯偅涓汉鍦ㄤ竴璧枫€?,
  '濡傛灉浣犲湪涓€涓爣鐨勪笂灞℃浜忛挶锛屽氨鏀惧純锛屼笉瑕佹兂鐫€鎹炲洖鏉ワ紝鍚岀悊浣犲湪涓€涓コ浜轰笂灞℃鏍借窡澶村氨缁撴潫杩欐鍏崇郴銆?,
  '鏁簬鎺ュ彈鑷繁鐨勫け璐ワ紝鎵胯甯傚満鏄鐨勶紝浣犵殑浜ゆ槗浼氫笂鍗囦竴涓珮搴︺€?,
  '璇ユ潵鐨勮鎯呰嚜鐒朵細鏉ワ紝涓嶈鏉ョ殑姘歌繙涓嶄細鏉ワ紝鍒妸浣犻娴嬬殑琛屾儏褰撴垚涓€瀹氬彂鐢熺殑浜嬩欢锛屼笉瑕侀€氳繃棰勬祴璇佹槑鑷繁锛岃閫氳繃鐩堝埄璇佹槑鑷繁銆?,
  '鍦ㄩ噾铻嶈繖鍦哄ぇ鍨嬫父鎴忛噷锛屼綘姘歌繙鐚滀笉鍒版湭鏉ヤ細鍙戠敓浠€涔堛€?,
  '浣犲彲浠ョ姱閿欙紝浣嗘槸涓嶈兘鍦ㄥ悓涓€涓湴鏂瑰薄娆＄姱閿欍€?,
  '鍋氬骞磋交浜猴紝灏辨槸鍋氬鏁翠釜涓栫晫銆?,
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
  videoAccessMap: {},    // { episodeId: access_level } 鈥?universal access control
  adminRefreshTimer: null, // admin page auto-refresh timer
  authMode: 'login_password',
  authPrefillEmail: '',
  authRedirectAfterLogin: null,
  referralInviteCode: '',
  paymentStatus: null,
}

const AUTH_COOKIE_NAME = 'ws_token'
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const LOGIN_REQUIRED_STATIC_PREFIXES = ['/research', '/earnings', '/ai娉℃搏鍛ㄦ姤', '/weekly']
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
    message: '璇峰厛鐧诲綍鍚庤闂鏉垮潡',
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

function courseContentLoadingHtml(label = '璇剧▼璧勬枡鍔犺浇涓?..') {
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
  if (!binding) return '鏈粦瀹?
  if (binding.username) return `@${binding.username}`
  if (binding.name) return binding.name
  return '宸茬粦瀹?Telegram 璐﹀彿'
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
  if (status === 'left' || status === 'kicked') return '閲嶆柊鑾峰彇鍏ョ兢閾炬帴'
  if (status === 'bound') return '閲嶆柊鑾峰彇鏈哄櫒浜哄叆鍙?
  return '鑱旂郴鏈哄櫒浜鸿幏鍙栧叆缇ら摼鎺?
}

function getTelegramBindingHint(binding) {
  const status = getTelegramBindingStatus(binding)
  if (status === 'left') return '浣犱箣鍓嶅凡缁忛€€鍑虹兢鑱婏紝鍙互缁х画鐢ㄨ繖涓?Telegram 璐﹀彿閲嶆柊鑾峰彇鍏ョ兢閾炬帴銆?
  if (status === 'bound') return '濡傛灉浣犱笂娆℃病杩涚兢锛屾垨鑰呴個璇烽摼鎺ヨ繃鏈熶簡锛屽彲浠ョ户缁敤杩欎釜 Telegram 璐﹀彿閲嶆柊鑾峰彇銆?
  if (status === 'kicked') return '濡傛灉浣犲凡缁忛噸鏂扮画璐癸紝鍙互缁х画鐢ㄨ繖涓?Telegram 璐﹀彿閲嶆柊鑾峰彇鍏ョ兢閾炬帴銆?
  if (status === 'grace') return '浣犲綋鍓嶈繕鍦ㄥ闄愭湡鍐咃紝鏆傛椂涓嶉渶瑕侀噸鏂扮敓鎴愬叆鍙ｃ€?
  if (status === 'joined') return '浣犲綋鍓嶅凡缁忓湪缇ら噷锛屼笉闇€瑕侀噸鏂扮敓鎴愬叆鍙ｃ€?
  return ''
}

function getPlanExpiresAt(user = state.user) {
  const raw = user?.planExpiresAt || user?.plan_expires_at || ''
  // mysql2 may return Date objects; extract YYYY-MM-DD portion
  if (raw && typeof raw === 'string' && raw.length >= 10) return raw.substring(0, 10)
  if (raw instanceof Date) return raw.toISOString().substring(0, 10)
  return String(raw)
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

  // 娴嬮獙閫氳繃璁板綍
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

  // 璇剧▼鏄惁瑙ｉ攣锛氭墍鏈夎绋嬪潎鍙嚜鐢辫繘鍏ワ紝鏃犻『搴忛檺鍒?
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

  // 缁熻鎬绘暟锛堣瘎璁?+ 鍥炲锛?
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
      alert('鍙戝竷璇勮澶辫触锛岃妫€鏌ョ綉缁滃悗閲嶈瘯')
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
      alert('鍒犻櫎璇勮澶辫触锛岃妫€鏌ョ綉缁滃悗閲嶈瘯')
    }
  },

  // 鐐硅禐/鍙栨秷鐐硅禐
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

  // 鍥炲鐐硅禐
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

  // 娣诲姞鍥炲
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
      alert('鍥炲澶辫触锛岃妫€鏌ョ綉缁滃悗閲嶈瘯')
    }
  },

  // 鍒犻櫎鍥炲
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
      alert('鍒犻櫎鍥炲澶辫触锛岃妫€鏌ョ綉缁滃悗閲嶈瘯')
    }
  },

  formatTime(ts) {
    const d = new Date(ts)
    const now = new Date()
    const diff = now - d
    if (diff < 60000) return '鍒氬垰'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 鍒嗛挓鍓峘
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 灏忔椂鍓峘
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 澶╁墠`
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

  container.innerHTML = '<video id="localPlayer" controls preload="metadata" style="width:100%;height:100%;"><source src="' + escapeHtml(videoUrl) + '" type="video/mp4">鎮ㄧ殑娴忚鍣ㄤ笉鏀寔瑙嗛鎾斁</video>'

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
  if (text) text.textContent = `宸茶鐪?${percent}%` + (entry.completed ? ' 路 宸插畬鎴? : ` 路 闇€杈惧埌 60%`)

  // 瀹屾垚鎻愮ず + 瑙ｉ攣绛旈鎸夐挳
  if (entry.completed) {
    if (fill) fill.style.background = 'var(--accent-gradient)'
    const badge = document.getElementById('completeBadge')
    if (badge) badge.style.display = 'inline-flex'
    const quizBtn = document.querySelector('.video-actions button[disabled][title="瑙傜湅60%鍚庤В閿?]')
    if (quizBtn) {
      quizBtn.disabled = false
      quizBtn.className = 'btn btn-primary btn-lg'
      quizBtn.id = 'startQuiz'
      quizBtn.removeAttribute('title')
      quizBtn.textContent = '寮€濮嬬瓟棰?
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
    showFormMsgProfile('閭€璇烽摼鎺ヤ粎鐢ㄤ簬鏂扮敤鎴锋敞鍐?, 'ok')
    return
  }
  try {
    const res = await api.post('/api/referrals/track', { code })
    if (res.disabled) {
      showFormMsgProfile(res.message || '閭€璇疯繑浣ｅ姛鑳芥殏鏈紑鏀?, 'ok')
    }
    if (res.ok || res.disabled) {
      window.history.replaceState(window.history.state || {}, '', nextUrl || '/')
      if (res.ok) {
        state.referralInviteCode = code
        showAuthModal('register', {
          referralCode: code,
          message: '宸茶瘑鍒個璇烽摼鎺ワ紝璇峰畬鎴愭敞鍐?,
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

  mainContent.innerHTML = '<div class="loading-spinner" style="padding:60px 0;text-align:center;">鍔犺浇璇剧▼涓?..</div>'
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
        alert('馃帀 鏀粯鎴愬姛锛佷綘鐨勪細鍛樺凡鍗囩骇锛岃閲嶆柊鐧诲綍浠ュ埛鏂扮姸鎬併€?)
      }, 500)
    } else if (paymentStatus === 'failed') {
      setTimeout(() => {
        alert('鏀粯鏈畬鎴愶紝濡傛湁闂璇疯仈绯诲鏈嶃€?)
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

  // Load video access map (public, no sensitive data 鈥?only episode IDs + access_level)
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
    refreshCurrentUserProfile().catch(() => {})
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

// 鏈櫥褰曟椂鎷︽埅鎿嶄綔锛屽脊鍑虹櫥褰曟彁绀?
function requireLogin() {
  if (hasClientAuth()) return true
  showAuthModal('login_password')
  return false
}

// 鏄惁浠樿垂浼氬憳锛坧lus 鎴?pro锛?
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
  if (level === 'logged_in') return '鐧诲綍鍙湅'
  if (level === 'plus_pro') return '浠?Plus / Pro 浼氬憳鍙鐪?
  if (level === 'pro_only') return '浠?Pro 浼氬憳鍙鐪?
  return ''
}

// Get short badge text for episode card
function getAccessBadge(episodeId) {
  const ep = episodes.find(item => item.id === Number(episodeId))
  const level = state.videoAccessMap[episodeId] || ep?.accessLevel
  if (!level || level === 'free') return ''
  if (level === 'logged_in') return '鐧诲綍鍙湅'
  if (level === 'plus_pro') return '浼氬憳涓撳睘'
  if (level === 'pro_only') return 'Pro 涓撳睘'
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
  return isArticleEpisode(ep) ? '鈫?杩斿洖鏂囩珷' : '鈫?杩斿洖瑙嗛'
}

function getNextEpisodeLabel(ep) {
  if (!ep) return '杩涘叆涓嬩竴绡?
  return `杩涘叆${escapeHtml(ep.title)}`
}

// 娓叉煋鐢ㄦ埛澶村儚锛堟敮鎸佽嚜瀹氫箟澶村儚鎴栭瀛楁瘝锛?
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
  const mobileUpdatesHtml = renderSidebarUpdates(null, true)
  const historyHtml = renderSidebarHistory()
  const mobileBelowCoursesHtml = `${mobileUpdatesHtml}${historyHtml}${quotesHtml}${statsHtml}`
  const sidebarHtml = `${statsHtml}${quotesHtml}${updatesHtml}${historyHtml}`

  mainContent.innerHTML = `
    <div class="home-layout fade-in">
      <div class="home-main">
        ${!isMobileHome ? `
        <div class="home-quotes">
          <p class="quote-hero">鍋氱┖鐨勪汉鑳借禋閽憋紝鍋氬鐨勪汉涔熻兘璧氶挶锛?br>鍞嫭<span class="quote-gold">璐┆</span>鐨勪汉姘歌繙璧氫笉鍒伴挶銆?/p>
          <div class="quote-divider"></div>
          <p class="quote-detail"><span class="quote-label">姝ｅ父璧板娍</span>浼氭妧鏈殑鍜屼富鍔涗竴璧锋帹鍔ㄧ洏闈紝鏀跺壊涓嶆噦鎶€鏈殑闊彍</p>
          <p class="quote-detail"><span class="quote-label quote-label-warn">闈炴甯歌蛋鍔?/span>涓嶆噦鎶€鏈殑闊彍鐖嗗畬浜嗭紝鍐嶆敹鍓?鍒颁綅浜?鐨勯偅浜涙噦鎶€鏈殑浜?/p>
          <a href="https://x.com/WallStreet0Name" target="_blank" rel="noopener noreferrer" class="quote-author">鈥?鍗庡皵琛楁病鏈夊悕瀛?鈫?/a>
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
          <button class="sort-btn ${state.sortOrder === 'default' ? 'active' : ''}" data-sort="default">榛樿</button>
          <button class="sort-btn ${state.sortOrder === 'latest' ? 'active' : ''}" data-sort="latest">鏈€鏂?/button>
        </div>
        ` : ''}

        <div class="episode-grid">
          ${filtered.map(ep => renderEpisodeCard(ep)).join('')}
        </div>

        ${filtered.length === 0 ? '<p style="text-align:center; color:var(--text-3); padding:48px 0;">鏈壘鍒板尮閰嶇殑璇剧▼</p>' : ''}

        <div class="home-mobile-below-courses">
          ${mobileBelowCoursesHtml}
        </div>
      </div>

      <div class="home-sidebar">
        ${sidebarHtml}
      </div>
    </div>
  `

  // 寮傛浠?API 鍔犺浇鏈€鏂版洿鏂帮紙鐢ㄧ湡瀹炴暟鎹浛鎹㈤潤鎬佸悗澶囷級
  refreshSidebarUpdates()

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
          ${locked ? '<div class="card-lock-overlay"><span class="lock-icon">馃敀</span></div>' : ''}
        </div>
        ${(ep.youtubeId || ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)) && ep.duration ? `<span class="card-duration">${ep.duration}</span>` : ''}
        ${ep.number ? `<span class="card-ep-badge">EP.${String(ep.number).padStart(2, '0')}</span>` : ''}
        ${isArticleEpisode(ep) ? '<span class="card-type-badge">鏂囩珷</span>' : ''}
        ${accessBadge && !isArticleEpisode(ep) ? `<span class="card-paid-badge">${accessBadge}</span>` : ''}
        ${completed && quizPassed ? '<span class="card-complete-badge">宸查€氳繃</span>' : completed ? '<span class="card-complete-badge" style="background:rgba(247,147,26,0.9)">寰呯瓟棰?/span>' : ''}
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
      <h3>瀛︿範缁熻</h3>
      ${!state.user ? '<p class="login-hint">鐧诲綍鍚庢煡鐪嬪涔犺繘搴?/p>' : `
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-number">${episodes.length}</div>
            <div class="stat-label">鎬昏绋?/div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${completedCount}</div>
            <div class="stat-label">宸插畬鎴?/div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${inProgressCount}</div>
            <div class="stat-label">瀛︿範涓?/div>
          </div>
          <div class="stat-box">
            <div class="stat-number">${Math.round(completedCount / episodes.length * 100)}%</div>
            <div class="stat-label">瀹屾垚鐜?/div>
          </div>
        </div>
      `}
    </div>
  `
}

function renderSidebarQuotes() {
  // 渚ц竟鏍忛殢鏈烘樉绀?鏉¤褰?
  const shuffled = [...allQuotes].sort(() => Math.random() - 0.5)
  const sidebarQuotes = shuffled.slice(0, 5)

  return `
    <div class="sidebar-card sidebar-quote-card quotes-card" style="cursor:pointer">
      <h3>琛楀摜璇綍</h3>
      <ul class="sidebar-quote-list">
        ${sidebarQuotes.map((q, i) => `
          <li class="sidebar-quote-item">
            <span class="sidebar-quote-num">${allQuotes.indexOf(q) + 1}</span>
            <span class="sidebar-quote-text">${q.length > 30 ? q.substring(0, 30) + '...' : q}</span>
          </li>
        `).join('')}
      </ul>
      <div class="sidebar-quote-more">鏌ョ湅鍏ㄩ儴 ${allQuotes.length} 鏉¤褰?鈫?/div>
    </div>
  `
}

function renderSidebarUpdates(data = null, isMobile = false) {
  const updates = data || []
  const cardId = isMobile ? 'mobile-updates-card' : 'sidebar-updates-card'
  if (!updates || updates.length === 0) {
    // 椤甸潰鍔犺浇鏃跺紓姝ヨ幏鍙栵紝鍏堟樉绀哄崰浣?
    return `
      <div class="sidebar-card sidebar-updates-card" id="${cardId}">
        <h3>鏈€杩戞洿鏂?/h3>
        <ul class="updates-list">
          <li class="update-item" style="justify-content:center;opacity:0.5">鍔犺浇涓€?/li>
        </ul>
      </div>
    `
  }
  const items = updates.slice(0, 5)
  const now = new Date()

  return `
    <div class="sidebar-card sidebar-updates-card" id="${cardId}">
      <h3>馃摙 鏈€杩戞洿鏂?/h3>
      <ul class="updates-list">
        ${items.map((u, idx) => {
          const isNew = isRecent(u.date, now, 3) // 3 澶╁唴鏍?鏂?
          const targetAttr = u.target ? `data-update-target='${escapeHtml(JSON.stringify(u.target))}'` : ''
          return `
            <li class="update-item" ${targetAttr}>
              <div class="update-icon">${u.icon || '路'}</div>
              <div class="update-info">
                <div class="update-title">${escapeHtml(u.title)}${isNew ? '<span class="update-new-badge">鏂?/span>' : ''}</div>
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
  if (diffDays === 0) return '浠婂ぉ'
  if (diffDays === 1) return '鏄ㄥぉ'
  if (diffDays < 7) return `${diffDays}澶╁墠`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}鍛ㄥ墠`
  // 瓒呰繃 30 澶╂樉绀哄叿浣撴棩鏈燂紙鍘诲勾灏卞甫骞翠唤锛?
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
          <div class="update-title">${escapeHtml(u.title)}${isNew ? '<span class="update-new-badge">鏂?/span>' : ''}</div>
          <div class="update-date">${formatUpdateDate(u.date, now)}</div>
        </div>
      </li>
    `
  }).join('')
  // 鍚屾椂鏇存柊妗岄潰绔拰绉诲姩绔袱涓崱鐗?
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
      <h3>瑙傜湅鍘嗗彶</h3>
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
                ${p.completed ? '<span class="history-done-badge">鉁?/span>' : ''}
              </div>
              <div class="history-info">
                <div class="history-title">${ep.title.length > 20 ? ep.title.substring(0, 20) + '...' : ep.title}</div>
                <div class="history-meta">
                  <span class="history-time">鐪嬪埌 ${timeStr}</span>
                  ${ago ? `<span class="history-ago">${ago}</span>` : ''}
                </div>
                <div class="history-progress-bar">
                  <div class="history-progress-fill ${p.completed ? 'completed' : ''}" style="width:${percent}%"></div>
                </div>
              </div>
              <span class="history-play">鈻?/span>
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
  if (mins < 1) return '鍒氬垰'
  if (mins < 60) return `${mins}鍒嗛挓鍓峘
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}灏忔椂鍓峘
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}澶╁墠`
  return `${Math.floor(days / 30)}涓湀鍓峘
}

// Category labels matching homepage tabs
const CATEGORY_LABELS = { strategy: '浜ゆ槗绛栫暐', indicator: '鎶€鏈寚鏍?, pattern: '褰㈡€佸垎鏋?, advanced: '鎶€鏈ā鍨?, basics: '鍩虹', analysis: '鍒嗘瀽', psychology: '蹇冪悊', risk: '椋庢帶' }
function getCategoryLabel(cat) { return CATEGORY_LABELS[cat] || cat || '' }

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
    // 閬垮厤 body { min-height: 100vh } 涓?iframe 鑷€傚簲楂樺害褰㈡垚鍙嶉寰幆
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
        <button class="btn btn-ghost btn-lg" disabled>璇剧▼璧勬枡鍔犺浇涓?..</button>
      </div>
    `
  }

  if (!hasQuiz && !hasMindmap && !hasKnowledge) return ''

  const unlockItems = [hasQuiz ? '绛旈' : null, hasMindmap ? '鎬濈淮瀵煎浘' : null, hasKnowledge ? '鐭ヨ瘑鐐? : null].filter(Boolean).join('銆?)

  return `
    <div class="video-actions">
      ${!isPaid() ? `
        ${hasQuiz ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>馃敀 绛旈锛堜細鍛樹笓灞烇級</button>' : ''}
        ${hasMindmap ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>馃敀 鎬濈淮瀵煎浘锛堜細鍛樹笓灞烇級</button>' : ''}
        ${hasKnowledge ? '<button class="btn btn-ghost btn-lg paid-lock" disabled>馃敀 鐭ヨ瘑鐐癸紙浼氬憳涓撳睘锛?/button>' : ''}
        <p class="paid-hint">鍗囩骇浼氬憳瑙ｉ攣${unlockItems} <a class="paid-hint-link" id="goUpgrade">鏌ョ湅鏂规 鈫?/a></p>
      ` : `
        ${hasQuiz
          ? ((!ep.youtubeId && !hasPaidVideo)
              ? '<button class="btn btn-primary btn-lg" id="startQuiz">寮€濮嬬瓟棰?/button>'
              : !progressRecord?.completed
                ? '<button class="btn btn-ghost btn-lg" disabled title="瑙傜湅60%鍚庤В閿?>瑙傜湅60%鍚庡彲绛旈</button>'
                : '<button class="btn btn-primary btn-lg" id="startQuiz">寮€濮嬬瓟棰?/button>')
          : ''
        }
        ${hasMindmap ? '<button class="btn btn-ghost btn-lg" id="showMindmap">鎬濈淮瀵煎浘</button>' : ''}
        ${hasKnowledge ? '<button class="btn btn-ghost btn-lg" id="showKnowledge">鐭ヨ瘑鐐?/button>' : ''}
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
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>

      ${mediaHtml}

      ${showProgress ? `
        <div class="watch-progress-bar">
          <div class="watch-progress-fill" id="watchFill" style="width:${percent}%; ${progressRecord?.completed ? 'background:var(--accent-gradient)' : ''}"></div>
        </div>
        <div class="watch-progress-info">
          <span id="watchText">${progressRecord?.completed ? `宸茶鐪?${percent}% 路 宸插畬鎴恅 : percent > 0 ? `宸茶鐪?${percent}% 路 闇€杈惧埌 60%` : '寮€濮嬭鐪嬭棰戯紝瑙傜湅 60% 鍗冲彲瀹屾垚璇剧▼'}</span>
          <span class="complete-badge" id="completeBadge" style="display:${progressRecord?.completed ? 'inline-flex' : 'none'}">宸插畬鎴?/span>
        </div>
      ` : ''}

      <div class="video-info">
        <h1 class="video-title">${escapeHtml(ep.title)}</h1>
        <p class="video-description">${escapeHtml(ep.description)}</p>
        ${renderEpisodeActions(ep, progressRecord)}
      </div>
    </div>
  `
}

function getFilteredEpisodes() {
  let list
  if (state.currentCategory === 'all') {
    // 瑙嗛璇剧▼锛氭樉绀烘湁YouTube瑙嗛鎴朇F Stream浠樿垂瑙嗛鐨?
    // 瑙嗛璇剧▼鍒嗙被锛氭枃绔犺绋嬪嵆浣挎寕浜嗚棰戣瑙ｄ篃涓嶆贩鍏ユ鍒楄〃
    list = episodes.filter(ep => !isArticleEpisode(ep) && (ep.youtubeId || ep.hasStreamVideo || state.paidVideoEpisodes.includes(ep.id)))
    list = [...list].sort((a, b) => state.sortOrder === 'latest'
      ? new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      : new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
  } else {
    // 鍏朵粬鍒嗙被锛氭枃绔犺绋嬪缁堜繚鐣欙紱鏃犺棰戠殑鍗犱綅璇剧▼涔熸樉绀?
    list = episodes.filter(ep => ep.category === state.currentCategory && (isArticleEpisode(ep) || (!ep.youtubeId && !ep.hasStreamVideo && !state.paidVideoEpisodes.includes(ep.id))))
    list = [...list].sort((a, b) => state.sortOrder === 'latest'
      ? new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      : new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
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
          <h3 class="article-video-title">馃摵 瑙嗛璁茶В</h3>
          <div class="video-container" id="videoContainer">
            ${hasAccess
              ? `<div class="video-placeholder" style="background: ${ep.gradient}" id="cfVideoLoading">
                  <span style="color:rgba(255,255,255,0.7);font-size:14px;">姝ｅ湪鍔犺浇瑙嗛...</span>
                </div>`
              : `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                  <div class="video-lock-icon">馃敀</div>
                  <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '浼氬憳涓撳睘瑙嗛')}</h3>
                  <p class="video-lock-text">${!state.user ? '璇峰厛鐧诲綍鍚庢煡鐪? : '鍗囩骇浼氬憳鍗冲彲瑙傜湅'}</p>
                  <button class="btn btn-primary" id="goUpgradeVideo">${!state.user ? '鐧诲綍' : '鍗囩骇浼氬憳'}</button>
                </div>`
            }
          </div>
        </div>
        <div class="article-study-order">
          <span class="article-study-order-icon">馃摎</span>
          <span class="article-study-order-text">瀛︿範椤哄簭锛氬厛鐪嬪浘瑙ｇ殑鏂囧瓧鐭ヨ瘑鐐癸紝鍐嶇湅瑙嗛鏁欏</span>
        </div>
      ` : ''}
      <div class="article-container" id="articleContainer">
        <div class="article-loading">姝ｅ湪鍔犺浇鏂囩珷...</div>
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

  // 鑻ュ綋鍓嶇敤鎴峰彲瑙傜湅璇ユ枃绔犻厤濂楄棰戯紝鍒欐媺鍙?CF Stream 骞跺祵鍏ユ挱鏀?
  if (hasPaidVideo && hasAccess) {
    api.get(`/api/video-stream?episode=${ep.id}`).then(r => {
      if (state.currentEpisode?.id !== ep.id) return
      if (!r.ok) throw new Error(r.error || '瑙嗛鍔犺浇澶辫触')

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
          container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;">鏆傛棤瑙嗛婧?/p></div></div>'
        }
      }
    }).catch(err => {
      console.error('Video fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;margin-bottom:12px;">瑙嗛鍔犺浇澶辫触</p><button class="btn btn-primary" onclick="location.reload()">鐐瑰嚮閲嶈瘯</button></div></div>'
      }
    }).catch(err => {
      console.error('CF Stream fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = `<div class="video-placeholder" style="background:var(--bg-secondary)">
          <div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <p style="font-size:16px;margin-bottom:12px;">瑙嗛鍔犺浇澶辫触</p>
            <button class="btn btn-primary" onclick="location.reload()">鐐瑰嚮閲嶈瘯</button>
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

  // 姣忔杩涘叆瑙嗛椤靛脊鍑哄涔犳彁閱掞紙鏃犺棰戠殑璇剧▼璺宠繃锛?
  const hasVideo = hasEpisodeVideo(ep)
  if (hasVideo && !state._videoWarningShown) {
    state._videoWarningShown = true
    setTimeout(() => {
      const overlay = document.createElement('div')
      overlay.className = 'warning-overlay active'
      overlay.innerHTML = `
        <div class="warning-modal">
          <div class="warning-icon">鈿狅笍</div>
          <h3 class="warning-title">琛楀摜璀﹀憡</h3>
          <p class="warning-text">璇峰姟蹇呰€愬績銆佸畬鏁淬€佽繛缁湴瀛︿範锛岄伩鍏嶈烦璺冨紡瑙傜湅銆傜湅浼煎浼氬疄鎴樺嵈渚濈劧浜忛挶锛屽線寰€璇存槑骞舵病鏈夌湡姝ｆ帉鎻°€備笉瑕佽鑷繁鍋滅暀鍦ㄥ崐鎳備笉鎳傜殑鐘舵€侊紝瀛﹀緱鎱㈠苟涓嶅彲鑰伙紝鐪熸閲嶈鐨勬槸瀛︿細涔嬪悗鑳藉鐔熺粌杩愮敤銆?/p>
          <button class="btn btn-primary btn-lg warning-confirm" id="warningConfirm">鎴戠煡閬撲簡锛岃鐪熷涔?/button>
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
              <span style="color:rgba(255,255,255,0.7);font-size:14px;">姝ｅ湪鍔犺浇瑙嗛...</span>
            </div>`
          : ep.youtubeId && !hasPaidVideo
            ? (hasAccess
              ? '<div id="ytPlayer"></div>'
              : `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                  <div class="video-lock-icon">馃敀</div>
                  <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '鐧诲綍鍚庡彲瑙傜湅')}</h3>
                  <p class="video-lock-text">璇峰厛鐧诲綍鍚庢煡鐪?/p>
                  <button class="btn btn-primary" id="goUpgradeVideo">鐧诲綍</button>
                </div>`)
            : hasPaidVideo && !hasAccess
              ? `<div class="video-placeholder video-paywall-overlay" style="background: ${ep.gradient}">
                  <div class="video-lock-icon">馃敀</div>
                  <h3 class="video-lock-title">${escapeHtml(getAccessLabel(ep.id) || '浼氬憳涓撳睘瑙嗛')}</h3>
                  <p class="video-lock-text">${!state.user ? '璇峰厛鐧诲綍鍚庢煡鐪? : '鍗囩骇浼氬憳鍗冲彲瑙傜湅'}</p>
                  <button class="btn btn-primary" id="goUpgradeVideo">${!state.user ? '鐧诲綍' : '鍗囩骇浼氬憳'}</button>
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
      if (!r.ok) throw new Error(r.error || '瑙嗛鍔犺浇澶辫触')

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
        container.innerHTML = '<div class="video-placeholder" style="background:var(--bg-secondary)"><div style="text-align:center;color:var(--text-secondary);padding:20px;"><p style="font-size:16px;">瑙嗛鍔犺浇澶辫触</p><button class="btn btn-primary" onclick="location.reload()">鐐瑰嚮閲嶈瘯</button></div></div>'
      }
    }).catch(err => {
      console.error('CF Stream fetch error:', err)
      const container = document.getElementById('videoContainer')
      if (container) {
        container.innerHTML = `<div class="video-placeholder" style="background:var(--bg-secondary)">
          <div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <p style="font-size:16px;margin-bottom:12px;">瑙嗛鍔犺浇澶辫触</p>
            <button class="btn btn-primary" onclick="location.reload()">鐐瑰嚮閲嶈瘯</button>
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
          <div class="quiz-insight-label">${isCorrect ? '瑙ｉ噴' : '浣犻€夋嫨鐨勮В閲?}</div>
          <p>${escapeHtml(primaryExplanation)}</p>
        </div>
      ` : ''}
      ${showCorrectExplanation ? `
        <div class="quiz-explanation">
          <div class="quiz-insight-label">姝ｇ‘鎬濊矾</div>
          <p>${escapeHtml(correctExplanation)}</p>
        </div>
      ` : ''}
      ${q.hint ? `
        <details class="quiz-hint">
          <summary>鏌ョ湅鎻愮ず</summary>
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
        <div class="quiz-card">${courseContentLoadingHtml('姝ｅ湪鍔犺浇璇惧悗娴嬭瘯...')}</div>
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

  // 鍏ㄩ儴绛斿畬 鈫?缁撴灉椤?
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
              ? '馃帀 鍏ㄩ儴绛斿锛屽凡瑙ｉ攣涓嬩竴鏈熻绋嬶紒'
              : `绛旈敊浜?${wrongCount} 棰橈紝闇€瑕佸叏閮ㄧ瓟瀵规墠鑳借В閿佷笅涓€鏈焋
            }</p>
            <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
              ${passed && nextEp
                  ? `<button class="btn btn-primary btn-lg" id="goNextEp" data-next-id="${nextEp.id}">${getNextEpisodeLabel(nextEp)}</button>`
                : ''
              }
              ${!passed
                ? '<button class="btn btn-primary btn-lg" id="retryQuiz">閲嶆柊绛旈</button>'
                : ''
              }
              <button class="btn btn-ghost btn-lg" id="backVideo2">${getEpisodeBackLabel(ep).replace('鈫?', '')}</button>
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
          <h2>璇惧悗娴嬭瘯</h2>
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
              ${hasAnswered && isCorrect && i === q.answer ? '<span class="option-check">鉁?/span>' : ''}
              ${hasAnswered && i === selectedAnswer && !isCorrect ? '<span class="option-cross">鉁?/span>' : ''}
            </div>`
          }).join('')}
        </div>
        ${hasAnswered ? `
          <div class="quiz-feedback ${isCorrect ? 'feedback-correct' : 'feedback-wrong'}">
            ${isCorrect
              ? '鉁?鍥炵瓟姝ｇ‘锛?
              : state.quizState.attempt === 1
                ? '鉂?绛旈敊浜嗭紝鍐嶇粰浣犱竴娆℃満浼?
                : '鉂?涓ゆ閮界瓟閿欎簡锛岄渶瑕佷粠澶寸瓟棰?
            }
          </div>
          ${renderQuizInsight(q, selectedAnswer, isCorrect)}
          <div class="quiz-actions">
            ${isCorrect
              ? (currentQuestion < total - 1
                  ? '<button class="btn btn-primary" id="nextQ">涓嬩竴棰?鈫?/button>'
                  : '<button class="btn btn-primary" id="finishQuiz">鏌ョ湅缁撴灉</button>')
              : state.quizState.attempt === 1
                ? '<button class="btn btn-primary" id="retryThis">鍐嶈瘯涓€娆?/button>'
                : '<button class="btn btn-primary" id="retryQuiz">浠庡ご绛旈</button>'
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
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>
      <div class="quotes-header">
        <h1 class="quotes-title">琛楀摜璇綍</h1>
        <p class="quotes-subtitle">鍏?${allQuotes.length} 鏉′氦鏄撴櫤鎱?/p>
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
        <h2>鐭ヨ瘑鐐?/h2>
        ${courseContentLoadingHtml('姝ｅ湪鍔犺浇鐭ヨ瘑鐐?..')}
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
      <h2>鐭ヨ瘑鐐?/h2>
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
          : '<p style="color: var(--text-3); padding: 24px 0;">鏈湡鏆傛棤鐭ヨ瘑鐐?/p>'
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
        <h2>鎬濈淮瀵煎浘涓庣煡璇嗙偣</h2>
        ${courseContentLoadingHtml('姝ｅ湪鍔犺浇鎬濈淮瀵煎浘...')}
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
      <h2>鎬濈淮瀵煎浘涓庣煡璇嗙偣</h2>
      <div class="mindmap-list">
        ${mindmapItems.length > 0
          ? mindmapItems.map(renderMindmapItemHtml).join('')
          : '<p style="color: var(--text-3); padding: 24px 0;">鏈湡鏆傛棤鎬濈淮瀵煎浘</p>'
        }
      </div>
    </div>
  `
  hydrateMindmapStructures()
}

function renderMindmapItemHtml(item, index) {
  const title = item.title || `鎬濈淮瀵煎浘 ${index + 1}`
  if (item.structure) {
    const structureJson = typeof item.structure === 'string' ? item.structure : JSON.stringify(item.structure)
    return `
      <div class="mindmap-item">
        <h3>${escapeHtml(title)}</h3>
        <div class="mindmap-structure-wrapper"
          data-mindmap-structure='${escapeHtml(structureJson)}'
          data-fallback-image="${escapeHtml(item.image || '')}"
          data-title="${escapeHtml(title)}">
          ${courseContentLoadingHtml('姝ｅ湪缁樺埗缁撴瀯鍖栨€濈淮瀵煎浘...')}
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
            <a href="${escapeHtml(item.pdf)}" target="_blank" class="btn btn-ghost btn-sm pdf-download">鍦ㄦ柊绐楀彛鎵撳紑 PDF</a>
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
      <span>${escapeHtml(data.mindmapTitle || data.notebookTitle || '缁撴瀯鍖栨€濈淮瀵煎浘')}</span>
      <div>
        <button type="button" class="mindmap-tool" data-zoom="out" aria-label="缂╁皬">-</button>
        <button type="button" class="mindmap-tool" data-zoom="in" aria-label="鏀惧ぇ">+</button>
        <button type="button" class="mindmap-tool" data-zoom="fit" aria-label="閫傚簲">猡?/button>
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
  const title = container.dataset.title || '鎬濈淮瀵煎浘'
  if (image) {
    container.innerHTML = `
      <div class="mindmap-image-wrapper">
        <img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" class="mindmap-image" loading="lazy">
      </div>
    `
  } else {
    container.innerHTML = '<p class="course-content-loading">缁撴瀯鍖栨€濈淮瀵煎浘鍔犺浇澶辫触</p>'
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
      <button class="back-btn" id="backHome">鈫?杩斿洖棣栭〉</button>
      <h1 class="admin-title">馃搳 绠＄悊鍚庡彴</h1>
      <div class="loading-spinner" style="padding:60px 0;text-align:center;">鍔犺浇鏁版嵁涓?..</div>
    </div>
  `
  document.getElementById('backHome')?.addEventListener('click', () => navigate('home'))

  // Fetch real data from backend
  api.get('/api/admin-users').then(data => {
    if (!data.ok || !data.stats) {
      mainContent.querySelector('.loading-spinner').textContent = '鍔犺浇澶辫触: ' + (data.error || '鏈煡閿欒')
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
      const label = ep.title
      return `<option value="${ep.id}" ${Number(selectedId) === ep.id ? 'selected' : ''}>${escapeHtml(label)}</option>`
    }).join('')
}

function renderAdminCourseSection() {
  return `
    <div class="admin-section" id="adminCourseManager">
      <div class="admin-section-header">
        <h2>璇剧▼绠＄悊</h2>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-ghost btn-xs" id="refreshAdminCourses">鍒锋柊</button>
          <button class="btn btn-primary btn-sm" id="addCourseBtn">+ 鏂板璇剧▼</button>
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
        <h2>棰樺簱绠＄悊</h2>
      </div>
      <div class="stream-upload-form admin-quiz-toolbar">
        <select class="stream-input" id="adminQuizEpisode">
          ${renderCourseOptionList(state.adminQuizEpisodeId || episodes[0]?.id || '')}
        </select>
        <button class="btn btn-primary" id="loadAdminQuiz" type="button">鍔犺浇棰樼洰</button>
      </div>
      <form class="admin-cms-form" id="adminQuizForm">
        <input type="hidden" id="quizQuestionId">
        <div class="admin-cms-grid">
          <label>鎺掑簭<input class="stream-input" id="quizSortOrder" type="number" min="0" value="0"></label>
          <label>姝ｇ‘绛旀
            <select class="stream-input" id="quizAnswer">
              <option value="0">A</option>
              <option value="1">B</option>
              <option value="2">C</option>
              <option value="3">D</option>
            </select>
          </label>
          <label>鐘舵€?
            <select class="stream-input" id="quizStatus">
              <option value="published">宸插彂甯?/option>
              <option value="draft">鑽夌</option>
              <option value="archived">宸插綊妗?/option>
            </select>
          </label>
        </div>
        <label>棰樺共<textarea class="stream-input admin-cms-textarea" id="quizQuestion" rows="2" required></textarea></label>
        <label>閫夐」锛堟瘡琛屼竴涓級<textarea class="stream-input admin-cms-textarea" id="quizOptions" rows="4" required></textarea></label>
        <label>閫愰」瑙ｆ瀽锛堟瘡琛屽搴斾竴涓€夐」锛?textarea class="stream-input admin-cms-textarea" id="quizExplanations" rows="4"></textarea></label>
        <label>閫氱敤瑙ｉ噴<textarea class="stream-input admin-cms-textarea" id="quizExplanation" rows="2"></textarea></label>
        <label>鎻愮ず<textarea class="stream-input admin-cms-textarea" id="quizHint" rows="2"></textarea></label>
        <div class="admin-cms-actions">
          <button class="btn btn-primary" type="submit">淇濆瓨棰樼洰</button>
          <button class="btn btn-ghost" id="resetAdminQuiz" type="button">娓呯┖棰樼洰</button>
        </div>
        <div class="stream-upload-result" id="adminQuizResult" style="display:none"></div>
      </form>
      <div id="adminQuizList" class="admin-quiz-list">
        <div class="comments-empty">閫夋嫨璇剧▼鍚庡姞杞介鐩?/div>
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
    // planLabel is now at module level


  function orderPlanLabel(order) {
    const plan = order.plan === 'pro' ? 'PRO' : order.plan === 'plus' ? 'Plus' : (order.plan || '-')
    const period = order.period === 'yearly' ? '骞翠粯' : order.period === 'monthly' ? '鏈堜粯' : (order.period || '')
    return `${plan}${period ? ' ' + period : ''}`
  }

  function orderStatusLabel(status) {
    if (status === 'paid') return '宸插畬鎴?
    if (status === 'processing') return '澶勭悊涓?
    if (status === 'pending') return '寰呮敮浠?
    if (status === 'expired') return '宸茶繃鏈?
    return status || '-'
  }

  mainContent.innerHTML = `
    <div class="admin-dashboard fade-in">
      <button class="back-btn" id="backHome">鈫?杩斿洖棣栭〉</button>
      <h1 class="admin-title">馃搳 绠＄悊鍚庡彴</h1>

      <div class="admin-board-tabs" role="tablist" aria-label="绠＄悊鍚庡彴鏉垮潡">
        <button class="admin-board-tab active" type="button" data-admin-board="resources">璇剧▼璧勬簮</button>
        <button class="admin-board-tab" type="button" data-admin-board="users">鐢ㄦ埛浼氬憳</button>
        <button class="admin-board-tab" type="button" data-admin-board="referrals">杩斾剑閭€璇?/button>
        <button class="admin-board-tab" type="button" data-admin-board="config">绯荤粺閰嶇疆</button>
      </div>

      <div class="admin-presence-grid" aria-label="鍦ㄧ嚎浜烘暟缁熻">
        <div class="admin-presence-card">
          <div class="admin-presence-label">瀹炴椂鍦ㄧ嚎浜烘暟</div>
          <div class="admin-presence-value">${realtimeOnlineUsers}</div>
          <div class="admin-presence-sub">鏈€杩?${realtimeWindowMinutes} 鍒嗛挓娲昏穬</div>
        </div>
        <div class="admin-presence-card">
          <div class="admin-presence-label">浠婂ぉ鍦ㄧ嚎浜烘暟</div>
          <div class="admin-presence-value">${todayOnlineUsers}</div>
          <div class="admin-presence-sub">鍖椾含鏃堕棿浠婃棩鍘婚噸鐢ㄦ埛</div>
        </div>
        <div class="admin-presence-card">
          <div class="admin-presence-label">鏈懆鍦ㄧ嚎浜烘暟</div>
          <div class="admin-presence-value">${weekOnlineUsers}</div>
          <div class="admin-presence-sub">鍖椾含鏃堕棿鏈懆鍘婚噸鐢ㄦ埛</div>
        </div>
      </div>

      <div class="admin-board admin-board-active" id="adminResourcesBoard">
        ${renderAdminCourseSection()}
      </div>

      <div class="admin-board" id="adminUsersBoard" hidden>

      <div class="admin-stats-grid">
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="all">
          <div class="admin-stat-icon">馃懃</div>
          <div class="admin-stat-value">${stats.totalUsers}</div>
          <div class="admin-stat-label">娉ㄥ唽鐢ㄦ埛鎬绘暟</div>
          <div class="admin-stat-sub">浠婃棩鏂板 ${stats.todayNewUsers}</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="members">
          <div class="admin-stat-icon">猸?/div>
          <div class="admin-stat-value">${plusUsers.length}</div>
          <div class="admin-stat-label">Plus 浼氬憳</div>
          <div class="admin-stat-sub">杞寲鐜?${stats.totalUsers > 0 ? Math.round(plusUsers.length / stats.totalUsers * 100) : 0}%</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="members">
          <div class="admin-stat-icon">馃拵</div>
          <div class="admin-stat-value">${proUsers.length}</div>
          <div class="admin-stat-label">Pro 浼氬憳</div>
          <div class="admin-stat-sub">杞寲鐜?${stats.totalUsers > 0 ? Math.round(proUsers.length / stats.totalUsers * 100) : 0}%</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="orders">
          <div class="admin-stat-icon">馃挼</div>
          <div class="admin-stat-value">$${stats.totalRevenue.toLocaleString()}</div>
          <div class="admin-stat-label">鎬绘敹鍏?/div>
          <div class="admin-stat-sub">${stats.paidOrderCount} 绗旇鍗?/div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">馃摎</div>
          <div class="admin-stat-value">${episodes.length}</div>
          <div class="admin-stat-label">璇剧▼鎬绘暟</div>
          <div class="admin-stat-sub">${episodes.filter(hasEpisodeVideo).length} 鏈熷凡涓婄嚎</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">馃挰</div>
          <div class="admin-stat-value">${stats.totalComments || 0}</div>
          <div class="admin-stat-label">鎬昏瘎璁烘暟</div>
          <div class="admin-stat-sub">${stats.totalReplies || 0} 鏉″洖澶?/div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-icon">馃摑</div>
          <div class="admin-stat-value">${stats.totalPosts || 0}</div>
          <div class="admin-stat-label">绀惧尯甯栧瓙</div>
          <div class="admin-stat-sub">绀惧尯浜掑姩</div>
        </div>
        <div class="admin-stat-card admin-stat-clickable" data-admin-user-tab="learning">
          <div class="admin-stat-icon">馃弳</div>
          <div class="admin-stat-value">${learningRanked.length}</div>
          <div class="admin-stat-label">瀛︿範鎺掕姒?/div>
          <div class="admin-stat-sub">${learningRanked.length > 0 ? '馃 ' + escapeHtml(learningRanked[0].name || '鏈懡鍚?) + ' 路 ' + learningRanked[0].progress.completed + '璇? : '鏆傛棤鏁版嵁'}</div>
        </div>
      </div>

      <div class="admin-board-tabs admin-user-subtabs" id="adminUserSubTabs" role="tablist" aria-label="鐢ㄦ埛浼氬憳瀛愮増鍧?>
        <button class="admin-board-tab active" type="button" data-admin-user-tab="all">鍏ㄩ儴鐢ㄦ埛鍒楄〃</button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="members">浼氬憳鍒楄〃</button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="orders">璁㈠崟鍏呭€?/button>
        <button class="admin-board-tab" type="button" data-admin-user-tab="learning">瀛︿範杩涘害鎺掑悕</button>
      </div>

      <!-- 鐢ㄦ埛鍒楄〃 -->
      <div class="admin-section admin-user-panel" id="adminUserList" data-admin-user-panel="all">
        <div class="admin-section-header">
          <h2>鍏ㄩ儴鐢ㄦ埛鍒楄〃</h2>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="text" id="adminUserSearch" class="admin-plan-input" placeholder="鎼滅储閭鎴栨樀绉?.." style="width:200px;font-size:13px;padding:4px 8px;">
            <span class="admin-section-badge" id="adminUserCount">${stats.totalUsers} 浜?/span>
          </div>
        </div>
        <div class="admin-table-wrapper" id="adminUserTableWrapper">
          <table class="admin-table">
            <thead>
              <tr>
                <th>鐢ㄦ埛</th>
                <th>閭</th>
                <th>娉ㄥ唽鏃堕棿</th>
                <th>浼氬憳</th>
                <th>鍒版湡鏃?/th>
                <th>浠樿垂</th>
                <th>瀛︿範/浜掑姩</th>
                <th>鏈€杩?/th>
                <th>鎿嶄綔</th>
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
                          <div>${escapeHtml(u.name || '鏈懡鍚?)}${u.isAdmin ? ' <span class="admin-badge badge-admin">绠＄悊鍛?/span>' : ''}</div>
                          <div class="admin-uid" title="${escapeHtml(u.uid || '')}">${escapeHtml((u.uid || '').substring(0, 10))}</div>
                        </div>
                      </div>
                    </td>
                    <td class="admin-email" title="${escapeHtml(u.email)}">${escapeHtml(u.email.length > 22 ? u.email.substring(0, 20) + '..' : u.email)}</td>
                    <td style="font-size:12px;white-space:nowrap;">${u.createdAt ? formatDateTime(u.createdAt) : '-'}</td>
                    <td>${planLabel(u.plan, u.planExpiresAt)}</td>
                    <td style="font-size:12px;">${u.planExpiresAt ? formatDateTime(u.planExpiresAt) : '-'}</td>
                    <td>${u.totalPaid > 0 ? '<strong>' + formatMinorUsd(u.totalPaid) + '</strong>' : '-'}</td>
                    <td style="font-size:11px;white-space:nowrap;">
                      ${u.progress?.total > 0 ? `鈻?{u.progress.total} ` : ''}${u.progress?.completed > 0 ? `鉁?{u.progress.completed} ` : ''}${u.progress?.quizPassed > 0 ? `馃幆${u.progress.quizPassed} ` : ''}${u.commentCount > 0 ? `馃挰${u.commentCount} ` : ''}${u.postCount > 0 ? `馃摑${u.postCount} ` : ''}${u.replyCount > 0 ? `鈫?{u.replyCount} ` : ''}${u.commentCount + u.postCount + u.replyCount === 0 && !u.progress?.total ? '-' : ''}
                    </td>
                    <td style="font-size:12px;white-space:nowrap;">${u.lastActivity ? formatDateTime(u.lastActivity) : '-'}</td>
                    <td>
                      <div class="admin-actions">
                        <button class="btn btn-primary btn-xs admin-edit-user" data-user-id="${u.id}" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-plan="${u.plan || 'free'}" data-expires="${u.planExpiresAt || ''}">缂栬緫</button>
                        <button class="btn btn-xs admin-view-orders" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}">璁㈠崟</button>
                      </div>
                    </td>
                  </tr>`
                ).join('')
                : '<tr><td colspan="9" style="text-align:center; color:var(--text-3); padding:32px;">鏆傛棤娉ㄥ唽鐢ㄦ埛</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>

      <!-- 浼氬憳鍒楄〃 -->
      <div class="admin-section admin-user-panel" id="adminMemberList" data-admin-user-panel="members" hidden>
        <div class="admin-section-header">
          <h2>浼氬憳鍒楄〃</h2>
          <span class="admin-section-badge">${memberUsers.length} 浜?/span>
        </div>
        ${memberUsers.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th>鐢ㄦ埛</th><th>閭</th><th>UID</th><th>浼氬憳绛夌骇</th><th>鍒版湡鏃?/th><th>宸蹭粯</th><th>鎿嶄綔</th></tr></thead>
                <tbody>
                  ${memberUsers.map(u => `
                    <tr>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '鏈懡鍚?)}</div></div></div></td>
                      <td class="admin-email" title="${escapeHtml(u.email)}">${escapeHtml(u.email.length > 22 ? u.email.substring(0, 20) + '..' : u.email)}</td>
                      <td class="admin-uid">${escapeHtml(u.uid || '-')}</td>
                      <td>${planLabel(u.plan, u.planExpiresAt)}</td>
                      <td style="font-size:12px;">${u.planExpiresAt ? formatDateTime(u.planExpiresAt) : '-'}</td>
                      <td>${u.totalPaid > 0 ? '<strong>' + formatMinorUsd(u.totalPaid) + '</strong>' : '-'}</td>
                      <td>
                        <div class="admin-actions">
                          <button class="btn btn-primary btn-xs admin-edit-user" data-user-id="${u.id}" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-plan="${u.plan || 'free'}" data-expires="${u.planExpiresAt || ''}">缂栬緫</button>
                          <button class="btn btn-xs admin-view-orders" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}">璁㈠崟</button>
                        </div>
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`
          : '<div class="comments-empty">鏆傛棤浼氬憳</div>'
        }
      </div>

      <!-- 璁㈠崟鍏呭€?-->
      <div class="admin-section admin-user-panel" id="adminPaidList" data-admin-user-panel="orders" hidden>
        <div class="admin-section-header">
          <h2>璁㈠崟鍏呭€?/h2>
          <span class="admin-section-badge">${paidOrderRows.length} 绗?/span>
        </div>
        ${paidOrderRows.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th>鐢ㄦ埛</th><th>UID</th><th>鏂规</th><th>閲戦</th><th>鐘舵€?/th><th>鏀粯/鍒涘缓鏃堕棿</th></tr></thead>
                <tbody>
                  ${paidOrderRows.map(({ user: u, order: o }) => `
                    <tr>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '鏈懡鍚?)}</div></div></div></td>
                      <td class="admin-uid">${escapeHtml((u.uid || '').substring(0, 10))}</td>
                      <td><span class="admin-badge badge-paid">${escapeHtml(orderPlanLabel(o))}</span></td>
                      <td><strong>${formatMinorUsd(o.amountConfirmed || o.amount || 0)}</strong></td>
                      <td><span class="admin-badge ${o.status === 'paid' ? 'badge-paid' : 'badge-free'}">${escapeHtml(orderStatusLabel(o.status))}</span></td>
                      <td style="font-size:12px;white-space:nowrap;">${o.paidAt || o.createdAt ? formatDateTime(o.paidAt || o.createdAt) : '-'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`
          : '<div class="comments-empty">鏆傛棤浠樿垂璁板綍</div>'
        }
      </div>

      <!-- 瀛︿範鎺掕姒?-->
      <div class="admin-section admin-user-panel" id="adminLeaderboard" data-admin-user-panel="learning" hidden>
        <div class="admin-section-header">
          <h2>馃弳 瀛︿範杩涘害鎺掑悕</h2>
          <span class="admin-section-badge">${learningRanked.length} 浜哄畬鎴愯繃璇剧▼</span>
        </div>
        ${learningRanked.length > 0
          ? `<div class="admin-table-wrapper">
              <table class="admin-table">
                <thead><tr><th style="width:50px">鎺掑悕</th><th>鐢ㄦ埛</th><th>UID</th><th>浼氬憳</th><th style="text-align:center">鉁?瀹屾垚</th><th style="text-align:center">馃幆 绛旈</th><th style="text-align:center">鈻?瑙傜湅</th></tr></thead>
                <tbody>
                  ${learningRanked.map((u, i) => {
                    const medal = i === 0 ? '馃' : i === 1 ? '馃' : i === 2 ? '馃' : ''
                    return `
                    <tr${i < 3 ? ' style="background:var(--bg-2);"' : ''}>
                      <td style="text-align:center;font-weight:600;font-size:${i < 3 ? '18px' : '13px'};">${medal || (i + 1)}</td>
                      <td><div class="admin-user-cell"><span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span><div><div>${escapeHtml(u.name || '鏈懡鍚?)}</div></div></div></td>
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
          : '<div class="comments-empty">鏆傛棤瀛︿範璁板綍</div>'
        }
      </div>

      <!-- 璁㈠崟璇︽儏寮圭獥 -->
      <div class="admin-order-modal" id="adminOrderModal" style="display:none">
        <div class="admin-order-modal-content">
          <div class="admin-order-modal-header">
            <h3 id="adminOrderModalTitle">璁㈠崟璇︽儏</h3>
            <button class="admin-order-modal-close" id="adminOrderModalClose">&times;</button>
          </div>
          <div id="adminOrderModalBody"></div>
        </div>
      </div>

      <!-- 瀹¤鏃ュ織 -->
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>馃搵 瀹¤鏃ュ織</h2>
        </div>
        <div class="audit-filters">
          <select id="auditDays" class="form-select">
            <option value="all">鍏ㄩ儴鏃堕棿</option>
            <option value="1">鏈€杩?澶?/option>
            <option value="7">鏈€杩?澶?/option>
            <option value="30">鏈€杩?0澶?/option>
          </select>
          <select id="auditActionType" class="form-select">
            <option value="all">鍏ㄩ儴绫诲瀷</option>
            <option value="login">鐧诲綍</option>
            <option value="register">娉ㄥ唽</option>
            <option value="profile_update">淇敼璧勬枡</option>
            <option value="comment_create">鍙戣〃璇勮</option>
            <option value="post_create">鍙戝笘</option>
            <option value="reply_create">鍥炲</option>
            <option value="admin_change_plan">绠＄悊濂楅</option>
            <option value="trade_create">娣诲姞鎴樼哗</option>
          </select>
          <input type="text" id="auditSearch" class="form-input" placeholder="鎼滅储鐢ㄦ埛閭銆佹樀绉般€佽鎯?..">
          <button class="btn btn-primary" id="loadAuditLogs">鏌ヨ</button>
        </div>
        <div id="auditLogContainer" class="admin-audit-container">
          <p style="color:var(--text-3);padding:12px 0;">鐐瑰嚮銆屾煡璇€嶆煡鐪嬫搷浣滆褰?/p>
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
  setupAdminUserSearch()
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
      container.innerHTML = '<div class="loading-spinner">鍔犺浇涓?..</div>'
      const days = document.getElementById('auditDays')?.value || 'all'
      const action = document.getElementById('auditActionType')?.value || 'all'
      const search = document.getElementById('auditSearch')?.value || ''
      const r = await api.get(`/api/admin-audit?page=${page}&limit=30&days=${days}&action=${action}&search=${encodeURIComponent(search)}`)
      if (!r.logs) {
        container.innerHTML = `<p style="color:var(--text-3);padding:12px 0;">${escapeHtml(r.error || '鍔犺浇澶辫触')}</p>`
        return
      }
      if (r.logs.length === 0) {
        container.innerHTML = '<p style="color:var(--text-3);padding:12px 0;">鏆傛棤鏃ュ織</p>'
        return
      }
      const actionLabels = {
        login: '鐧诲綍', register: '娉ㄥ唽', change_password: '淇敼瀵嗙爜',
        profile_update: '淇敼璧勬枡', comment_create: '鍙戣〃璇勮', comment_delete: '鍒犻櫎璇勮',
        post_create: '鍙戝笘', post_delete: '鍒犻櫎甯栧瓙', reply_create: '鍥炲',
        reply_delete: '鍒犻櫎鍥炲', admin_change_plan: '绠＄悊濂楅',
        admin_delete_comment: '绠＄悊鍛樺垹璇勮', admin_delete_post: '绠＄悊鍛樺垹甯?,
        admin_delete_reply: '绠＄悊鍛樺垹鍥炲', trade_create: '娣诲姞鎴樼哗',
        course_resources_upload: '涓婁紶璇剧▼璧勬枡',
        trade_delete: '鍒犻櫎鎴樼哗', mt5_credentials_access: '鏌ョ湅MT5璐﹀彿',
        smart_close: 'AI 鏅鸿兘骞充粨', smart_close_rule: 'AI 鏅鸿兘骞充粨',
      }
      container.innerHTML = `
        <table class="admin-table" style="font-size:13px;">
          <thead><tr><th>#</th><th>鏃堕棿</th><th>鎿嶄綔鑰?/th><th>IP</th><th>鎿嶄綔</th><th>璇︽儏</th></tr></thead>
          <tbody>${r.logs.map((l, i) => `<tr>
            <td>${(page - 1) * 30 + i + 1}</td>
            <td style="white-space:nowrap;">${l.created_at ? formatDateTime(l.created_at) : '-'}</td>
            <td>${escapeHtml(l.user_nickname || l.user_email || '-')}<br><span style="font-size:11px;color:var(--text-3);">${escapeHtml(l.user_email || '')}</span></td>
            <td style="font-family:monospace;font-size:11px;">${escapeHtml(l.ip || '-')}</td>
            <td>${escapeHtml(actionLabels[l.action] || l.action)}</td>
            <td><button class="btn btn-ghost btn-xs audit-detail" data-id="${l.id}">璇︽儏</button></td>
          </tr>`).join('')}</tbody>
        </table>
        <div style="display:flex;gap:8px;padding:12px 0;justify-content:center;">
          ${page > 1 ? `<button class="btn btn-ghost btn-xs audit-page" data-page="${page - 1}">鈫?涓婁竴椤?/button>` : ''}
          <span style="color:var(--text-3);font-size:13px;">绗?${page}/${r.totalPages} 椤?(鍏?${r.total} 鏉?</span>
          ${page < r.totalPages ? `<button class="btn btn-ghost btn-xs audit-page" data-page="${page + 1}">涓嬩竴椤?鈫?/button>` : ''}
        </div>
      `
      container.querySelectorAll('.audit-page').forEach(btn => {
        btn.addEventListener('click', () => loadAudit(Number(btn.dataset.page)))
      })
      container.querySelectorAll('.audit-detail').forEach(btn => {
        btn.addEventListener('click', () => {
          const log = r.logs.find(l => l.id === Number(btn.dataset.id))
          if (log) {
            alert(`鎿嶄綔: ${actionLabels[log.action] || log.action}\n鐢ㄦ埛: ${log.user_nickname || log.user_email}\nIP: ${log.ip || '-'}\n鏃堕棿: ${formatDateTime(log.created_at)}\n璇︽儏: ${log.detail || '-'}`)
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
        <h2>杩斾剑閭€璇风鐞?/h2>
        <button class="btn btn-ghost btn-xs" id="adminReferralRefresh">鍒锋柊</button>
      </div>
      <div id="adminReferralContent" class="admin-referral-content">
        <div class="loading-spinner">鍔犺浇涓?..</div>
      </div>
    </div>
  `
}

function adminReferralStatusBadge(status) {
  if (status === 'approved') return '<span class="admin-badge badge-paid">宸插鏍?/span>'
  if (status === 'voided') return '<span class="admin-badge badge-expired">宸蹭綔搴?/span>'
  return '<span class="admin-badge badge-free">寰呯‘璁?/span>'
}

async function loadAdminReferrals() {
  const container = document.getElementById('adminReferralContent')
  if (!container) return
  const currentStatus = document.getElementById('adminReferralStatusFilter')?.value || ''
  container.innerHTML = '<div class="loading-spinner">鍔犺浇涓?..</div>'
  try {
    const statusQuery = currentStatus ? `?status=${encodeURIComponent(currentStatus)}` : ''
    const [overview, commissions, rules] = await Promise.all([
      api.get('/api/admin/referrals/overview'),
      api.get(`/api/admin/referrals/commissions${statusQuery}`),
      api.get('/api/admin/referrals/rules'),
    ])
    if (!overview.ok || !commissions.ok || !rules.ok) {
      container.innerHTML = `<div class="comments-empty">${escapeHtml(overview.error || commissions.error || rules.error || '鍔犺浇澶辫触')}</div>`
      return
    }
    const stats = overview.stats || {}
    const rows = commissions.commissions || []
    const ruleRows = rules.rules || []
    container.innerHTML = `
      <div class="admin-stats-grid admin-referral-stats">
        <div class="admin-stat-card"><div class="admin-stat-value">${Number(stats.total_invites || 0)}</div><div class="admin-stat-label">鎬婚個璇锋暟</div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${Number(stats.paid_invites || 0)}</div><div class="admin-stat-label">浠樿垂閭€璇?/div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${formatMinorUsd(stats.pending_credit_cents)}</div><div class="admin-stat-label">寰呯‘璁よ繑浣?/div></div>
        <div class="admin-stat-card"><div class="admin-stat-value">${formatMinorUsd(stats.available_credit_cents)}</div><div class="admin-stat-label">鍙敤杩斾剑</div></div>
      </div>

      <div class="admin-section admin-referral-inner">
        <div class="admin-section-header">
          <h2>杩斾剑璁板綍</h2>
          <select class="admin-plan-select" id="adminReferralStatusFilter">
            <option value="">鍏ㄩ儴鐘舵€?/option>
            <option value="pending" ${currentStatus === 'pending' ? 'selected' : ''}>寰呯‘璁?/option>
            <option value="approved" ${currentStatus === 'approved' ? 'selected' : ''}>宸插鏍?/option>
            <option value="voided" ${currentStatus === 'voided' ? 'selected' : ''}>宸蹭綔搴?/option>
          </select>
        </div>
        ${rows.length ? `
          <div class="admin-table-wrapper">
            <table class="admin-table">
              <thead><tr><th>閭€璇蜂汉</th><th>琚個璇风敤鎴?/th><th>璁㈠崟</th><th>鐜伴噾瀹炰粯</th><th>杩斾剑閲戦</th><th>鐘舵€?/th><th>鍙敤鏃堕棿</th><th>鎿嶄綔</th></tr></thead>
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
                      ${row.status === 'pending' ? `<button class="btn btn-primary btn-xs" data-referral-approve="${escapeHtml(row.id)}" >瀹℃牳閫氳繃</button>` : ''}
                      ${row.status !== 'voided' ? `<button class="btn btn-ghost btn-xs" data-referral-void="${escapeHtml(row.id)}" >浣滃簾</button>` : ''}
                    </div></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>` : '<div class="comments-empty">鏆傛棤杩斾剑璁板綍</div>'}
      </div>

      <div class="admin-section admin-referral-inner">
        <div class="admin-section-header">
          <h2>杩斾剑姣斾緥瑙勫垯</h2>
          <span class="admin-section-badge">涓婇檺 20%</span>
        </div>
        <div class="admin-table-wrapper"><table class="admin-table">
          <thead><tr><th>鏂规</th><th>鍛ㄦ湡</th><th>rate_bps</th><th>鍚敤</th><th>鎿嶄綔</th></tr></thead>
          <tbody>${ruleRows.map(rule => `
            <tr>
              <td>${escapeHtml(rule.plan)}</td>
              <td>${escapeHtml(rule.period)}</td>
              <td><input class="admin-plan-input admin-referral-rate" data-rule-rate="${escapeHtml(rule.plan)}_${escapeHtml(rule.period)}" value="${Number(rule.rate_bps || 0)}" type="number" min="0" max="2000" ></td>
              <td><select class="admin-plan-select admin-referral-enabled" data-rule-enabled="${escapeHtml(rule.plan)}_${escapeHtml(rule.period)}" >
                <option value="1" ${Number(rule.enabled) === 1 ? 'selected' : ''}>鍚敤</option>
                <option value="0" ${Number(rule.enabled) === 0 ? 'selected' : ''}>鍋滅敤</option>
              </select></td>
              <td><button class="btn btn-primary btn-xs admin-referral-rule-save" data-plan="${escapeHtml(rule.plan)}" data-period="${escapeHtml(rule.period)}" >淇濆瓨</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>`

    document.getElementById('adminReferralRefresh')?.addEventListener('click', loadAdminReferrals)
    document.getElementById('adminReferralStatusFilter')?.addEventListener('change', loadAdminReferrals)
    container.querySelectorAll('[data-referral-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const res = await api.patch(`/api/admin/referrals/commissions/${encodeURIComponent(btn.dataset.referralApprove)}`, { action: 'approve' })
        if (!res.ok) alert(res.error || '瀹℃牳澶辫触')
        loadAdminReferrals()
      })
    })
    container.querySelectorAll('[data-referral-void]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reason = prompt('璇疯緭鍏ヤ綔搴熷師鍥?)
        if (!reason) return
        btn.disabled = true
        const res = await api.patch(`/api/admin/referrals/commissions/${encodeURIComponent(btn.dataset.referralVoid)}`, { action: 'void', reason })
        if (!res.ok) alert(res.error || '浣滃簾澶辫触')
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
        const res = await api.put('/api/admin/referrals/rules', { rules: [{ plan, period, rate_bps: rate, enabled }] })
        if (!res.ok) alert(res.error || '淇濆瓨澶辫触')
        loadAdminReferrals()
      })
    })
  } catch (err) {
    console.error('Load admin referrals error:', err)
    container.innerHTML = '<div class="comments-empty">鍔犺浇澶辫触</div>'
  }
}

// ===== System Config Section =====
let adminConfigData = {}
let adminConfigSubTab = 'smtp'

function renderAdminConfigSection() {
  return `
    <div class="admin-section">
      <div class="admin-section-header">
        <h2>绯荤粺閰嶇疆</h2>
        <button class="btn btn-ghost btn-xs" id="adminConfigRefresh">鍒锋柊</button>
      </div>
      <div class="admin-board-tabs admin-config-subtabs" role="tablist" aria-label="绯荤粺閰嶇疆鏉垮潡">
        <button class="admin-board-tab active" type="button" data-config-tab="smtp">鍙戜欢閭</button>
        <button class="admin-board-tab" type="button" data-config-tab="qiniu">涓冪墰浜戝瓨鍌?/button>
        <button class="admin-board-tab" type="button" data-config-tab="toolbox">閲戣瀺宸ュ叿绠?/button>
        <button class="admin-board-tab" type="button" data-config-tab="market_menu">鑲＄エ鐮旂┒鑿滃崟</button>
      </div>
      <div id="adminConfigContent" class="admin-config-content">
        <div class="loading-spinner">鍔犺浇涓?..</div>
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
        <label>SMTP 鏈嶅姟鍣?/label>
        <input type="text" class="admin-plan-input" id="smtpHost" value="${escapeHtml(getVal('host'))}" placeholder="smtp.qq.com">
      </div>
      <div class="admin-config-row">
        <label>绔彛</label>
        <input type="text" class="admin-plan-input" id="smtpPort" value="${escapeHtml(getVal('port'))}" placeholder="587">
      </div>
      <div class="admin-config-row">
        <label>鐢ㄦ埛鍚?/label>
        <input type="text" class="admin-plan-input" id="smtpUser" value="${escapeHtml(getVal('user'))}" placeholder="your@email.com">
      </div>
      <div class="admin-config-row">
        <label>瀵嗙爜</label>
        <input type="password" class="admin-plan-input" id="smtpPass" value="${escapeHtml(getVal('pass'))}" placeholder="鎺堟潈鐮?>
      </div>
      <div class="admin-config-row">
        <label>鍙戜欢浜洪偖绠?/label>
        <input type="text" class="admin-plan-input" id="smtpFrom" value="${escapeHtml(getVal('from'))}" placeholder="noreply@yourdomain.com">
      </div>
      <div class="admin-config-row">
        <label>鍙戜欢浜哄悕绉?/label>
        <input type="text" class="admin-plan-input" id="smtpFromName" value="${escapeHtml(getVal('from_name') || '琛楀摜璇惧爞')}" placeholder="琛楀摜璇惧爞">
      </div>
      <div class="admin-config-row">
        <label>SSL/TLS</label>
        <select class="admin-plan-select" id="smtpSecure">
          <option value="false" ${getVal('secure') === 'false' ? 'selected' : ''}>鍚?(STARTTLS)</option>
          <option value="true" ${getVal('secure') === 'true' ? 'selected' : ''}>鏄?(SSL)</option>
        </select>
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveSmtpConfig">淇濆瓨閰嶇疆</button>
        <button class="btn btn-ghost" id="testSmtpConfig">鍙戦€佹祴璇曢偖浠?/button>
      </div>
      <div id="smtpTestResult" class="admin-config-test-result"></div>
    </div>
  `

  document.getElementById('saveSmtpConfig')?.addEventListener('click', async () => {
    const items = [
      { key: 'host', value: document.getElementById('smtpHost').value, label: 'SMTP 鏈嶅姟鍣?, sort_order: 0 },
      { key: 'port', value: document.getElementById('smtpPort').value, label: '绔彛', sort_order: 1 },
      { key: 'user', value: document.getElementById('smtpUser').value, label: '鐢ㄦ埛鍚?, sort_order: 2 },
      { key: 'pass', value: document.getElementById('smtpPass').value, label: '瀵嗙爜', sort_order: 3 },
      { key: 'from', value: document.getElementById('smtpFrom').value, label: '鍙戜欢浜洪偖绠?, sort_order: 4 },
      { key: 'from_name', value: document.getElementById('smtpFromName').value, label: '鍙戜欢浜哄悕绉?, sort_order: 5 },
      { key: 'secure', value: document.getElementById('smtpSecure').value, label: 'SSL/TLS', sort_order: 6 },
    ]
    const res = await api.put('/api/system-config/smtp', { items })
    if (res.ok) {
      alert('SMTP 閰嶇疆宸蹭繚瀛?)
      loadAdminConfig()
    } else {
      alert(res.error || '淇濆瓨澶辫触')
    }
  })

  document.getElementById('testSmtpConfig')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('smtpTestResult')
    const testEmail = prompt('璇疯緭鍏ユ祴璇曟敹浠堕偖绠憋細')
    if (!testEmail) return
    resultEl.innerHTML = '<span style="color:var(--text-3)">鍙戦€佷腑...</span>'
    const res = await api.post('/api/system-config/smtp/test', { to: testEmail })
    if (res.ok) {
      resultEl.innerHTML = '<span style="color:#10b981">鉁?娴嬭瘯閭欢宸插彂閫侊紝璇锋鏌ユ敹浠剁</span>'
    } else {
      resultEl.innerHTML = `<span style="color:#ef4444">鉁?${escapeHtml(res.error || '鍙戦€佸け璐?)}</span>`
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
        <label>瀛樺偍妗跺悕绉?/label>
        <input type="text" class="admin-plan-input" id="qiniuBucket" value="${escapeHtml(getVal('bucket'))}" placeholder="my-bucket">
      </div>
      <div class="admin-config-row">
        <label>璁块棶鍩熷悕</label>
        <input type="text" class="admin-plan-input" id="qiniuDomain" value="${escapeHtml(getVal('domain'))}" placeholder="https://cdn.example.com">
      </div>
      <div class="admin-config-row">
        <label>鍖哄煙</label>
        <select class="admin-plan-select" id="qiniuRegion">
          <option value="z0" ${getVal('region') === 'z0' ? 'selected' : ''}>鍗庝笢 (z0)</option>
          <option value="cn-east" ${getVal('region') === 'cn-east' ? 'selected' : ''}>鍗庝笢 (cn-east)</option>
          <option value="cn-south" ${getVal('region') === 'cn-south' ? 'selected' : ''}>鍗庡崡 (cn-south)</option>
          <option value="cn-north" ${getVal('region') === 'cn-north' ? 'selected' : ''}>鍗庡寳 (cn-north)</option>
          <option value="us-north" ${getVal('region') === 'us-north' ? 'selected' : ''}>鍖楃編 (us-north)</option>
          <option value="ap-southeast" ${getVal('region') === 'ap-southeast' ? 'selected' : ''}>涓滃崡浜?(ap-southeast)</option>
        </select>
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveQiniuConfig">淇濆瓨閰嶇疆</button>
      </div>
    </div>
  `

  document.getElementById('saveQiniuConfig')?.addEventListener('click', async () => {
    const items = [
      { key: 'access_key', value: document.getElementById('qiniuAK').value, label: 'Access Key', sort_order: 0 },
      { key: 'secret_key', value: document.getElementById('qiniuSK').value, label: 'Secret Key', sort_order: 1 },
      { key: 'bucket', value: document.getElementById('qiniuBucket').value, label: '瀛樺偍妗跺悕绉?, sort_order: 2 },
      { key: 'domain', value: document.getElementById('qiniuDomain').value, label: '璁块棶鍩熷悕', sort_order: 3 },
      { key: 'region', value: document.getElementById('qiniuRegion').value, label: '鍖哄煙', sort_order: 4 },
    ]
    const res = await api.put('/api/system-config/qiniu', { items })
    if (res.ok) {
      alert('涓冪墰浜戦厤缃凡淇濆瓨')
      loadAdminConfig()
    } else {
      alert(res.error || '淇濆瓨澶辫触')
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
        <h3>閲戣瀺宸ュ叿绠遍厤缃?/h3>
        <button class="btn btn-primary btn-sm" id="addToolCategory">+ 娣诲姞鍒嗙被</button>
      </div>
      <div id="toolboxCategories">
        ${categories.map((cat, ci) => renderToolboxCategory(cat, ci)).join('')}
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveToolboxConfig">淇濆瓨鍏ㄩ儴</button>
      </div>
    </div>
  `

  setupToolboxEvents(categories)
}

function renderToolboxCategory(cat, ci) {
  return `
    <div class="admin-toolbox-category" data-cat-index="${ci}">
      <div class="admin-toolbox-cat-header">
        <input type="text" class="admin-plan-input admin-toolbox-cat-name" value="${escapeHtml(cat.category)}" placeholder="鍒嗙被鍚嶇О">
        <button class="btn btn-ghost btn-xs admin-toolbox-cat-delete" data-ci="${ci}">鍒犻櫎鍒嗙被</button>
      </div>
      <div class="admin-toolbox-items">
        ${(cat.items || []).map((item, ii) => renderToolboxItem(item, ci, ii)).join('')}
      </div>
      <button class="btn btn-ghost btn-xs admin-toolbox-add-item" data-ci="${ci}">+ 娣诲姞宸ュ叿</button>
    </div>
  `
}

function renderToolboxItem(item, ci, ii) {
  return `
    <div class="admin-toolbox-item" data-ci="${ci}" data-ii="${ii}">
      <div class="admin-toolbox-item-grid">
        <div class="admin-config-row">
          <label>鍚嶇О</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="name" value="${escapeHtml(item.name || '')}">
        </div>
        <div class="admin-config-row">
          <label>鍥炬爣</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="icon" value="${escapeHtml(item.icon || '')}" placeholder="馃獧">
        </div>
        <div class="admin-config-row">
          <label>閾炬帴</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="url" value="${escapeHtml(item.url || '')}">
        </div>
        <div class="admin-config-row">
          <label>鎻忚堪</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="desc" value="${escapeHtml(item.desc || '')}">
        </div>
        <div class="admin-config-row">
          <label>鏍囩</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="tag" value="${escapeHtml(item.tag || '')}" placeholder="鍙€?>
        </div>
        <div class="admin-config-row">
          <label>鏍囩棰滆壊</label>
          <input type="color" class="admin-plan-input toolbox-field" data-field="tagColor" value="${escapeHtml(item.tagColor || '#2563eb')}" style="height:36px;padding:2px 4px;">
        </div>
        <div class="admin-config-row">
          <label>閭€璇风爜</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="code" value="${escapeHtml(item.code || '')}" placeholder="鍙€?>
        </div>
        <div class="admin-config-row">
          <label>杩斾剑</label>
          <input type="text" class="admin-plan-input toolbox-field" data-field="rebate" value="${escapeHtml(item.rebate || '')}" placeholder="鍙€?>
        </div>
      </div>
      <button class="btn btn-ghost btn-xs admin-toolbox-delete-item" data-ci="${ci}" data-ii="${ii}">鍒犻櫎</button>
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
    categories.push({ category: '鏂板垎绫?, items: [] })
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
    const items = [{ key: 'items', value: JSON.stringify(categories), label: '閲戣瀺宸ュ叿绠?, sort_order: 0 }]
    const res = await api.put('/api/system-config/toolbox', { items })
    if (res.ok) {
      alert('閲戣瀺宸ュ叿绠遍厤缃凡淇濆瓨')
      loadAdminConfig()
    } else {
      alert(res.error || '淇濆瓨澶辫触')
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
        <h3>鑲＄エ甯傚満鐮旂┒鑿滃崟</h3>
        <button class="btn btn-primary btn-sm" id="addMenuItem">+ 娣诲姞鑿滃崟椤?/button>
      </div>
      <div id="marketMenuItems">
        ${menuItems.map((item, i) => renderMarketMenuItem(item, i)).join('')}
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveMarketMenuConfig">淇濆瓨鍏ㄩ儴</button>
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
          <label>鍚嶇О</label>
          <input type="text" class="admin-plan-input menu-field" data-field="name" value="${escapeHtml(item.name || '')}">
        </div>
        <div class="admin-config-row">
          <label>鍥炬爣</label>
          <input type="text" class="admin-plan-input menu-field" data-field="icon" value="${escapeHtml(item.icon || '')}" placeholder="馃搮">
        </div>
        <div class="admin-config-row">
          <label>閾炬帴</label>
          <input type="text" class="admin-plan-input menu-field" data-field="url" value="${escapeHtml(item.url || '')}">
        </div>
      </div>
      <button class="btn btn-ghost btn-xs admin-menu-delete-item" data-i="${i}">鍒犻櫎</button>
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
    const items = [{ key: 'items', value: JSON.stringify(menuItems), label: '鑲＄エ甯傚満鐮旂┒鑿滃崟', sort_order: 0 }]
    const res = await api.put('/api/system-config/market_menu', { items })
    if (res.ok) {
      alert('鑿滃崟閰嶇疆宸蹭繚瀛?)
      loadAdminConfig()
    } else {
      alert(res.error || '淇濆瓨澶辫触')
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
      localStorage.setItem('adminActiveBoard', target)
      // Auto-activate first sub-tab when switching to users board
      if (target === 'users') {
        activateAdminUserTab('all')
      }
    })
  })

  // Restore active board from localStorage
  const savedBoard = localStorage.getItem('adminActiveBoard')
  if (savedBoard && boards[savedBoard]) {
    tabs.forEach(item => item.classList.toggle('active', item.dataset.adminBoard === savedBoard))
    Object.entries(boards).forEach(([key, board]) => {
      if (!board) return
      const active = key === savedBoard
      board.hidden = !active
      board.classList.toggle('admin-board-active', active)
    })
    // Restore sub-tab for users board
    if (savedBoard === 'users') {
      const savedUserTab = localStorage.getItem('adminActiveUserTab') || 'all'
      activateAdminUserTab(savedUserTab)
    }
  }
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
  localStorage.setItem('adminActiveUserTab', target)

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

// Re-fetch and re-render the user table body (used after edit and for search)
let _adminSearchTimer = null
async function refreshAdminUserTable(search = '') {
  try {
    const qs = search ? `?search=${encodeURIComponent(search)}` : ''
    const data = await api.get(`/api/admin-users${qs}`)
    if (!data.ok || !data.users) return
    const tbody = document.querySelector('#adminUserList .admin-table tbody')
    const countEl = document.getElementById('adminUserCount')
    if (!tbody) return
    if (countEl) countEl.textContent = `${data.users.length} 浜篳
    if (data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-3); padding:32px;">鏈壘鍒板尮閰嶇敤鎴?/td></tr>'
      return
    }
    tbody.innerHTML = data.users.map(u => `
      <tr>
        <td>
          <div class="admin-user-cell">
            <span class="admin-user-avatar">${escapeHtml((u.name || 'U')[0].toUpperCase())}</span>
            <div>
              <div>${escapeHtml(u.name || '鏈懡鍚?)}${u.isAdmin ? ' <span class="admin-badge badge-admin">绠＄悊鍛?/span>' : ''}</div>
              <div class="admin-uid" title="${escapeHtml(u.uid || '')}">${escapeHtml((u.uid || '').substring(0, 10))}</div>
            </div>
          </div>
        </td>
        <td class="admin-email" title="${escapeHtml(u.email)}">${escapeHtml(u.email.length > 22 ? u.email.substring(0, 20) + '..' : u.email)}</td>
        <td style="font-size:12px;white-space:nowrap;">${u.createdAt ? formatDateTime(u.createdAt) : '-'}</td>
        <td>${planLabel(u.plan, u.planExpiresAt)}</td>
        <td style="font-size:12px;">${u.planExpiresAt ? formatDateTime(u.planExpiresAt) : '-'}</td>
        <td>${u.totalPaid > 0 ? '<strong>' + formatMinorUsd(u.totalPaid) + '</strong>' : '-'}</td>
        <td style="font-size:11px;white-space:nowrap;">
          ${u.progress?.total > 0 ? `鈻?{u.progress.total} ` : ''}${u.progress?.completed > 0 ? `鉁?{u.progress.completed} ` : ''}${u.progress?.quizPassed > 0 ? `馃幆${u.progress.quizPassed} ` : ''}${u.commentCount > 0 ? `馃挰${u.commentCount} ` : ''}${u.postCount > 0 ? `馃摑${u.postCount} ` : ''}${u.replyCount > 0 ? `鈫?{u.replyCount} ` : ''}${u.commentCount + u.postCount + u.replyCount === 0 && !u.progress?.total ? '-' : ''}
        </td>
        <td style="font-size:12px;white-space:nowrap;">${u.lastActivity ? formatDateTime(u.lastActivity) : '-'}</td>
        <td>
          <div class="admin-actions">
            <button class="btn btn-primary btn-xs admin-edit-user" data-user-id="${u.id}" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-plan="${u.plan || 'free'}" data-expires="${u.planExpiresAt || ''}">缂栬緫</button>
            <button class="btn btn-xs admin-view-orders" data-uid="${escapeHtml(u.uid || '')}" data-name="${escapeHtml(u.name || '')}">璁㈠崟</button>
          </div>
        </td>
      </tr>`).join('')
  } catch (e) {
    console.error('refreshAdminUserTable error:', e)
  }
}

function setupAdminUserSearch() {
  const input = document.getElementById('adminUserSearch')
  if (!input) return
  input.addEventListener('input', () => {
    clearTimeout(_adminSearchTimer)
    _adminSearchTimer = setTimeout(() => refreshAdminUserTable(input.value.trim()), 300)
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
    if (label) label.textContent = '涓婁紶鏂拌棰?
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
      ? `${folderName || '宸查€夋枃浠跺す'} 路 ${folderFiles.length} 涓枃浠禶
      : '閫夋嫨 NotebookLM 鏂囦欢澶?
  }
  if (looseLabel) {
    looseLabel.textContent = looseFiles.length
      ? `琛ュ厖鏂囦欢 路 ${looseFiles.length} 涓猔
      : '琛ュ厖閫夋嫨鍗曚釜鏂囦欢'
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
    String(item.title || '').includes('淇℃伅鍥?) ||
    String(item.image || '').includes('淇℃伅鍥?) ||
    String(item.image || '').toLowerCase().includes('infographic')
  ).length
  const structureCount = items.filter(item => item.structure).length
  const mindmapCount = items.filter(item =>
    item.structure ||
    String(item.title || '').includes('鎬濈淮瀵煎浘') ||
    String(item.image || '').includes('鎬濈淮瀵煎浘') ||
    String(item.image || '').toLowerCase().includes('mindmap')
  ).length
  return { infoCount, mindmapCount, structureCount }
}

function renderAdminResourceSummary(data, fallbackStats = null) {
  const el = document.getElementById('adminResourceSummary')
  if (!el) return
  if (!data?.ok) {
    el.textContent = data?.error || '璧勬枡鐘舵€佸姞杞藉け璐?
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
    <span>棰樼洰 ${Number(data.quizCount || 0)}</span>
    <span>淇℃伅鍥?${infoCount}</span>
    <span>鎬濈淮瀵煎浘 ${mindmapCount}</span>
    <span>缁撴瀯 JSON ${structureCount}</span>
  `
}

async function loadAdminCourseResources(episodeId = getSelectedResourceEpisodeId()) {
  const el = document.getElementById('adminResourceSummary')
  if (!episodeId) {
    if (el) el.textContent = '閫夋嫨璇剧▼鍚庢煡鐪嬭祫鏂欑姸鎬?
    return
  }
  if (el) el.textContent = '璧勬枡鐘舵€佸姞杞戒腑...'
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
    el.innerHTML = '<div class="comments-empty">鏆傛棤璇剧▼锛岀偣鍑烩€滄柊澧炶绋嬧€濆垱寤?/div>'
    return
  }
  const totalPages = Math.ceil(courses.length / ADMIN_COURSE_PAGE_SIZE)
  if (adminCoursePage > totalPages) adminCoursePage = totalPages
  if (adminCoursePage < 1) adminCoursePage = 1
  const start = (adminCoursePage - 1) * ADMIN_COURSE_PAGE_SIZE
  const pageItems = courses.slice(start, start + ADMIN_COURSE_PAGE_SIZE)

  el.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>ID</th><th>璇剧▼</th><th>绫诲瀷</th><th>鍒嗙被</th><th>鍙戝竷鏃堕棿</th><th>鐘舵€?/th><th>鎿嶄綔</th></tr></thead>
      <tbody>
        ${pageItems.map(course => `
          <tr>
            <td class="admin-uid">#${course.id}</td>
            <td>
              <strong>${escapeHtml(course.title)}</strong>
              <div class="admin-uid">${escapeHtml(course.duration || '-')}</div>
            </td>
            <td>${course.contentType === 'article' ? '鏂囩珷' : '瑙嗛'}</td>
            <td>${escapeHtml(getCategoryLabel(course.category) || '-')}</td>
            <td style="font-size:12px;white-space:nowrap;">${escapeHtml(formatDateTime(course.createdAt))}</td>
            <td><span class="admin-badge ${course.status === 'published' ? 'badge-paid' : course.status === 'draft' ? 'badge-free' : 'badge-expired'}">${course.status === 'published' ? '宸插彂甯? : course.status === 'draft' ? '鑽夌' : '宸插綊妗?}</span></td>
            <td>
              <div class="admin-actions">
                <button class="btn btn-primary btn-xs admin-course-edit" data-course-id="${course.id}">缂栬緫</button>
                <button class="btn btn-ghost btn-xs admin-course-archive" data-course-id="${course.id}">鍒犻櫎</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${totalPages > 1 ? `
      <div class="admin-course-pagination">
        <button class="btn btn-ghost btn-xs" ${adminCoursePage <= 1 ? 'disabled' : ''} data-page="${adminCoursePage - 1}">涓婁竴椤?/button>
        <span class="admin-course-page-info">${adminCoursePage} / ${totalPages}</span>
        <button class="btn btn-ghost btn-xs" ${adminCoursePage >= totalPages ? 'disabled' : ''} data-page="${adminCoursePage + 1}">涓嬩竴椤?/button>
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
      if (!confirm('纭畾鍒犻櫎杩欓棬璇剧▼锛熷垹闄ゅ悗涓嶅彲鎭㈠锛?)) return
      const r = await api.del(`/api/admin-course-items?episode=${btn.dataset.courseId}`)
      if (r.ok) {
        await loadAdminCourses()
        await reloadCourseCatalog()
      } else alert(r.error || '鍒犻櫎澶辫触')
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
        <h3>${isEdit ? '缂栬緫璇剧▼' : '鏂板璇剧▼'}</h3>
        <button class="course-modal-close" id="closeCourseModal">鉁?/button>
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
            <label>鏍囬 <span class="required">*</span></label>
            <input class="stream-input" id="courseTitle" value="${isEdit ? escapeHtml(course.title) : ''}" placeholder="渚嬪锛氱63鏈?浜ゆ槗璁″垝" required>
          </div>
          <div class="course-form-row">
            <div class="course-form-group">
              <label>鍒嗙被</label>
              <select class="stream-input" id="courseCategory">
                ${['strategy','indicator','pattern','advanced'].map(v => `<option value="${v}" ${(isEdit ? course.category : 'strategy') === v ? 'selected' : ''}>${CATEGORY_LABELS[v]}</option>`).join('')}
              </select>
            </div>
            <div class="course-form-group">
              <label>绫诲瀷</label>
              <select class="stream-input" id="courseContentType">
                <option value="video" ${(!isEdit || course.contentType === 'video') ? 'selected' : ''}>瑙嗛</option>
                <option value="article" ${(isEdit && course.contentType === 'article') ? 'selected' : ''}>鏂囩珷</option>
              </select>
            </div>
            <div class="course-form-group">
              <label>鏉冮檺</label>
              <select class="stream-input" id="courseAccessLevel">
                ${['free','logged_in','plus_pro','pro_only'].map(v => `<option value="${v}" ${(isEdit ? course.accessLevel : 'plus_pro') === v ? 'selected' : ''}>${{free:'鍏紑鍏嶈垂',logged_in:'鐧诲綍鍙湅',plus_pro:'Plus/Pro',pro_only:'浠匬ro'}[v]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="course-form-group">
            <label>B绔橞V鍙?/label>
            <input class="stream-input" id="courseBilibiliId" value="${isEdit ? escapeHtml(course.bilibiliId || '') : ''}" placeholder="BV1xx411c7mD">
          </div>
          <div class="course-form-group">
            <label>鏂囩珷閾炬帴</label>
            <input class="stream-input" id="courseArticleUrl" value="${isEdit ? escapeHtml(course.articleUrl || '') : ''}" placeholder="https://... 鎴?/articles/xxx.html">
          </div>
          <div class="course-form-group">
            <label>瑙嗛鏂囦欢</label>
            <label class="stream-file-label" id="adminVideoUploadField">
              <span id="streamFileName">鐐瑰嚮閫夋嫨瑙嗛鏂囦欢</span>
              <input type="file" id="streamFileInput" accept="video/*" style="display:none">
            </label>
            <div class="stream-progress-wrap" id="streamProgressWrap" style="display:none">
              <div class="stream-progress-bar">
                <div class="stream-progress-fill" id="streamProgressFill"></div>
              </div>
              <span class="stream-progress-text" id="streamProgressText">鍑嗗涓婁紶...</span>
            </div>
          </div>
          <div class="course-form-group">
            <label>璇剧▼璧勬簮锛堢瓟棰?/ 瀵煎浘 / 淇℃伅鍥撅級</label>
            <div style="display:flex;gap:12px;margin-bottom:8px;">
              <label class="admin-resource-choice"><input type="checkbox" id="attachQuiz" checked><span>绛旈</span></label>
              <label class="admin-resource-choice"><input type="checkbox" id="attachMindmap" checked><span>瀵煎浘</span></label>
              <label class="admin-resource-choice"><input type="checkbox" id="attachInfographic" checked><span>淇℃伅鍥?/span></label>
            </div>
            <label class="stream-file-label">
              <span id="resourceBundleFileName">閫夋嫨 NotebookLM 鏂囦欢澶?/span>
              <input type="file" id="resourceBundleFiles" webkitdirectory directory multiple style="display:none">
            </label>
            <label class="stream-file-label secondary">
              <span id="resourceLooseFileName">琛ュ厖鍗曚釜鏂囦欢</span>
              <input type="file" id="resourceLooseFiles" multiple accept=".json,application/json,image/*" style="display:none">
            </label>
            <div id="adminResourceSummary" class="admin-resource-summary" style="margin-top:8px;">${isEdit ? '鍔犺浇涓?..' : ''}</div>
          </div>
        </div>
      </div>
      <div class="course-modal-footer">
        <button class="btn btn-ghost" id="cancelCourseModal">鍙栨秷</button>
        <button class="btn btn-primary" id="saveResourceAll">淇濆瓨</button>
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
    if (label) label.textContent = streamInput.files?.[0]?.name || '鐐瑰嚮閫夋嫨瑙嗛鏂囦欢'
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
  setStreamProgress('姝ｅ湪涓婁紶瑙嗛...', 5)

  const formData = new FormData()
  formData.append('file', file, file.name || 'video.mp4')
  formData.append('title', title || '')

  const xhr = new XMLHttpRequest()
  const uploadResult = await new Promise((resolve, reject) => {
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) {
        const pct = Math.round(event.loaded / event.total * 100)
        setStreamProgress(`姝ｅ湪涓婁紶瑙嗛 ${pct}%`, pct)
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        try { resolve(JSON.parse(xhr.responseText)) }
        catch { reject(new Error('涓婁紶鍝嶅簲瑙ｆ瀽澶辫触')) }
      } else reject(new Error(`涓婁紶澶辫触: HTTP ${xhr.status}`))
    })
    xhr.addEventListener('error', () => reject(new Error('涓婁紶缃戠粶閿欒')))
    xhr.addEventListener('abort', () => reject(new Error('涓婁紶宸插彇娑?)))
    xhr.open('POST', '/api/video-upload')
    xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('ws_token') || ''))
    xhr.send(formData)
  })

  if (!uploadResult.ok) throw new Error(uploadResult.error || '涓婁紶澶辫触')
  setStreamProgress('涓婁紶瀹屾垚', 100)
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
    throw new Error('璇烽€夋嫨瑕佸鍏ョ殑鍐呭绫诲瀷')
  }
  if ((quizChecked || mindmapChecked || infoChecked) && !files.length) {
    throw new Error('璇烽€夋嫨 NotebookLM 鏂囦欢澶规垨琛ュ厖鏂囦欢')
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
    if (!selectedEpisodeId && !videoFile && !bilibiliId) throw new Error('璇烽€夋嫨宸叉湁瑙嗛銆佷笂浼犳柊瑙嗛銆佹垨濉啓B绔橞V鍙?)
    if (!titleInput?.value.trim()) throw new Error('璇峰～鍐欐爣棰?)

    saveBtn.disabled = true
    saveBtn.textContent = '淇濆瓨涓?..'

    let streamUid = null
    if (videoFile) {
      setAdminInlineResult('adminCourseResult', '姝ｅ湪涓婁紶瑙嗛...')
      streamUid = await uploadStreamVideoForResource(videoFile, titleInput.value.trim())
    }

    setAdminInlineResult('adminCourseResult', '姝ｅ湪淇濆瓨璇剧▼...')
    const courseRes = await api.post('/api/admin-course-items', getAdminCoursePayload())
    if (!courseRes.ok || !courseRes.course) throw new Error(courseRes.error || '淇濆瓨璇剧▼澶辫触')

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
      if (!link.ok) throw new Error(link.error || '鍏宠仈 Stream 瑙嗛澶辫触')
    }

    const { form, count } = collectSelectedResourceFiles(episodeId)
    if (count > 0) {
      setAdminInlineResult('adminCourseResult', '姝ｅ湪涓婁紶璧勬枡...')
      const resourceRes = await api.postForm('/api/admin-course-resources', form)
      if (!resourceRes.ok) throw new Error(resourceRes.error || '涓婁紶璧勬枡澶辫触')
      const skipped = Array.isArray(resourceRes.skipped) ? resourceRes.skipped.length : 0
      setAdminInlineResult('adminCourseResult',
        `淇濆瓨瀹屾垚锛氶鐩?${resourceRes.quizFiles || 0}锛屾枃浠?${resourceRes.assetFiles || 0}${skipped ? `锛岃烦杩?${skipped}` : ''}`
      )
      courseContent.quizzes.delete(episodeId)
      courseContent.mindmaps.delete(episodeId)
      courseContent.structures.clear()
    }

    await loadAdminCourses()
    await reloadCourseCatalog()
    setAdminInlineResult('adminCourseResult', '淇濆瓨瀹屾垚')
    // Close modal after successful save
    const overlay = document.querySelector('.course-modal-overlay')
    if (overlay) {
      overlay.classList.remove('course-modal-visible')
      setTimeout(() => overlay.remove(), 300)
    }
  } catch (err) {
    console.error('[SaveAdminCourse] Error:', err)
    const progressVisible = document.getElementById('streamProgressWrap')?.style.display === 'block'
    if (progressVisible) setStreamProgress(err.message || '淇濆瓨澶辫触', 100, true)
    setAdminInlineResult('adminCourseResult', err.message || '淇濆瓨澶辫触', false)
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false
      saveBtn.textContent = '淇濆瓨'
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
    el.innerHTML = '<div class="comments-empty">鏆傛棤棰樼洰</div>'
    return
  }
  el.innerHTML = questions.map((question, index) => `
    <div class="admin-quiz-item">
      <div>
        <strong>${index + 1}. ${escapeHtml(question.question)}</strong>
        <div class="admin-uid">${escapeHtml((question.options || []).map((opt, i) => `${['A', 'B', 'C', 'D'][i] || i + 1}. ${opt}`).join(' / '))}</div>
      </div>
      <div class="admin-actions">
        <span class="admin-badge ${question.status === 'published' ? 'badge-paid' : 'badge-free'}">${question.status === 'published' ? '宸插彂甯? : question.status}</span>
        <button class="btn btn-primary btn-xs admin-quiz-edit" data-question-id="${question.id}">缂栬緫</button>
        <button class="btn btn-ghost btn-xs admin-quiz-delete" data-question-id="${question.id}">鍒犻櫎</button>
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
      if (!confirm('纭畾鍒犻櫎杩欓亾棰橈紵')) return
      const r = await api.del(`/api/admin-quiz?id=${encodeURIComponent(btn.dataset.questionId)}`)
      if (r.ok) {
        courseContent.quizzes.delete(Number(state.adminQuizEpisodeId))
        await loadAdminQuiz()
        await reloadCourseCatalog()
      }
      else alert(r.error || '鍒犻櫎澶辫触')
    })
  })
}

async function loadAdminQuiz() {
  const episodeId = document.getElementById('adminQuizEpisode')?.value || state.adminQuizEpisodeId
  if (!episodeId) return
  state.adminQuizEpisodeId = Number(episodeId)
  const el = document.getElementById('adminQuizList')
  if (el) el.innerHTML = '<div class="loading-spinner">鍔犺浇棰樼洰...</div>'
  const data = await api.get(`/api/admin-quiz?episode=${episodeId}`)
  if (!data.ok || !Array.isArray(data.questions)) {
    if (el) el.innerHTML = `<div class="comments-empty">${escapeHtml(data.error || '鍔犺浇棰樼洰澶辫触')}</div>`
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
      setAdminInlineResult('adminQuizResult', '棰樼洰宸蹭繚瀛?)
      courseContent.quizzes.delete(Number(episodeId))
      await loadAdminQuiz()
      await reloadCourseCatalog()
    } else {
      setAdminInlineResult('adminQuizResult', r.error || '淇濆瓨棰樼洰澶辫触', false)
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
  uploadBtn.textContent = '涓婁紶涓?..'
  progressWrap.style.display = 'block'
  resultDiv.style.display = 'none'

  try {
    // Step 1: Get direct upload URL from our backend
    progressText.textContent = '鑾峰彇涓婁紶閾炬帴...'
    const createRes = await api.post('/api/stream', { title })
    if (!createRes.ok && !createRes.uploadURL) {
      throw new Error(createRes.error || '鑾峰彇涓婁紶閾炬帴澶辫触')
    }

    const { uploadURL, uid } = createRes

    // Step 2: Upload file via XHR (for progress tracking)
    progressText.textContent = '姝ｅ湪涓婁紶...'
    const uploadResult = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100)
          progressFill.style.width = pct + '%'
          progressText.textContent = `涓婁紶涓?.. ${pct}% (${formatFileSize(e.loaded)} / ${formatFileSize(e.total)})`
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 400) {
          try {
            const resp = JSON.parse(xhr.responseText)
            resolve(resp)
          } catch { resolve() }
        } else {
          reject(new Error(`涓婁紶澶辫触: HTTP ${xhr.status}`))
        }
      })

      xhr.addEventListener('error', () => reject(new Error('缃戠粶閿欒')))
      xhr.addEventListener('abort', () => reject(new Error('涓婁紶琚彇娑?)))

      const formData = new FormData()
      formData.append('file', file)

      xhr.open('POST', uploadURL)
      xhr.send(formData)
    })

    // Step 3: Show success - store upload info for linking
    const uploadedVideo = { uid, duration: uploadResult?.duration || '', localPath: uploadResult?.url || '', cover: uploadResult?.cover || '' }
    progressFill.style.width = '100%'
    progressFill.style.background = 'var(--accent-gradient)'
    progressText.textContent = '涓婁紶瀹屾垚锛佽棰戞鍦ㄥ鐞嗕腑...'

    resultDiv.style.display = 'block'
    const linkableCourses = state.adminCourses.length ? state.adminCourses : episodes
    const epOptions = linkableCourses.map(e => `<option value="${e.id}">${escapeHtml(e.title)}</option>`).join('')
    resultDiv.innerHTML = `
      <div class="stream-result-success">
        <div class="stream-result-title">鉁?涓婁紶鎴愬姛</div>
        <div class="stream-result-row">
          <span>Video ID:</span>
          <code class="stream-uid-code">${uid}</code>
          <button class="btn btn-ghost btn-xs" id="copyStreamUid">澶嶅埗</button>
        </div>
        <div class="stream-result-row" style="margin-top:8px">
          <span>鍏宠仈鍒拌绋嬶細</span>
          <select id="streamLinkEpisode" class="stream-input" style="flex:1;min-width:120px">
            <option value="">-- 閫夋嫨闆嗘暟 --</option>
            ${epOptions}
          </select>
          <button class="btn btn-primary btn-xs" id="streamLinkBtn">鍏宠仈</button>
        </div>
      </div>
    `

    document.getElementById('copyStreamUid')?.addEventListener('click', () => {
      navigator.clipboard.writeText(uid).then(() => {
        document.getElementById('copyStreamUid').textContent = '宸插鍒?'
        setTimeout(() => { document.getElementById('copyStreamUid').textContent = '澶嶅埗' }, 2000)
      })
    })

    document.getElementById('streamLinkBtn')?.addEventListener('click', async () => {
      const epId = document.getElementById('streamLinkEpisode')?.value
      if (!epId) { alert('璇烽€夋嫨闆嗘暟'); return }
      const linkBtn = document.getElementById('streamLinkBtn')
      linkBtn.disabled = true; linkBtn.textContent = '鍏宠仈涓?..'
      const r = await api.post('/api/video-stream', {
        episodeId: Number(epId),
        title,
        localPath: uploadedVideo.localPath,
        duration: uploadedVideo.duration,
        cover: uploadedVideo.cover,
      })
      if (r.ok) {
        linkBtn.textContent = '鉁?宸插叧鑱?
        // Refresh paid video list + access map
        const listRes = await api.get('/api/video-stream')
        if (listRes.episodes) {
          state.paidVideoEpisodes = listRes.episodes.map(e => e.id)
          state.videoAccessMap = {}
          listRes.episodes.forEach(e => { state.videoAccessMap[e.id] = e.access_level || 'plus_pro' })
        }
      } else { alert(r.error || '鍏宠仈澶辫触'); linkBtn.disabled = false; linkBtn.textContent = '鍏宠仈' }
    })

    // Refresh video list after a short delay
    setTimeout(() => loadStreamVideos(), 3000)

  } catch (err) {
    console.error('Stream upload error:', err)
    progressText.textContent = '涓婁紶澶辫触: ' + err.message
    progressFill.style.width = '100%'
    progressFill.style.background = '#ef4444'
  } finally {
    uploadBtn.textContent = '涓婁紶瑙嗛'
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
      listEl.innerHTML = '<div class="comments-empty">鏆傛棤瑙嗛锛屼笂浼犵涓€涓惂</div>'
      return
    }

    // Build reverse map: cfStreamId 鈫?{ episodeId, access_level }
    let streamToEp = {}
    let epToAccess = {}
    try {
      const mapRes = await api.get('/api/video-stream?list=all')
      if (mapRes.mappings) mapRes.mappings.forEach(m => {
        streamToEp[m.cf_stream_id] = m.episode_id
        epToAccess[m.episode_id] = m.access_level || 'plus_pro'
      })
    } catch {}
    const accessLevelOptions = `<option value="free">鍏紑</option><option value="logged_in">鐧诲綍鍙湅</option><option value="plus_pro">Plus/Pro浼氬憳</option><option value="pro_only">浠匬ro</option>`

    const linkableCourses = state.adminCourses.length ? state.adminCourses : episodes
    const epOptions = linkableCourses.map(e => `<option value="${e.id}">${escapeHtml(e.title)}</option>`).join('')

    listEl.innerHTML = videos.map(v => {
      const linkedEp = streamToEp[v.uid]
      const linkedLabel = linkedEp ? '宸插叧鑱? : ''
      return `
      <div class="stream-video-card" data-stream-uid="${v.uid}">
        <div class="stream-video-thumb">
          ${v.thumbnail ? `<img src="${escapeHtml(v.thumbnail)}" alt="${escapeHtml(v.name)}">` : '<div class="stream-thumb-placeholder">馃幀</div>'}
          ${v.readyToStream ? '<span class="stream-status-badge ready">鍙挱鏀?/span>' : `<span class="stream-status-badge processing">${v.status === 'inprogress' ? `澶勭悊涓?${v.pctComplete || ''}` : v.status}</span>`}
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
                 <button class="btn btn-ghost btn-xs stream-unlink-btn" data-unlink-ep="${linkedEp}" style="color:#ef4444">鍙栨秷鍏宠仈</button>`
              : `<select class="stream-link-select" data-link-uid="${v.uid}" style="font-size:12px;padding:2px 4px;border:1px solid #ddd;border-radius:4px">
                  <option value="">鍏宠仈鍒伴泦鏁?/option>
                  ${epOptions}
                </select>
                <button class="btn btn-ghost btn-xs stream-link-save-btn" data-link-uid="${v.uid}">鍏宠仈</button>`}
            <button class="btn btn-ghost btn-xs stream-copy-btn" data-copy-uid="${v.uid}">澶嶅埗ID</button>
            <button class="btn btn-ghost btn-xs stream-delete-btn" data-del-uid="${v.uid}" style="color:#ef4444">鍒犻櫎</button>
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
        if (!epId) { alert('璇烽€夋嫨闆嗘暟'); return }
        btn.disabled = true; btn.textContent = '鍏宠仈涓?..'
        const r = await api.post('/api/video-stream', { episodeId: Number(epId), cfStreamId: uid })
        if (r.ok) { loadStreamVideos() } else { alert(r.error || '鍏宠仈澶辫触'); btn.disabled = false; btn.textContent = '鍏宠仈' }
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
        } else { alert(r.error || '淇敼澶辫触') }
      })
    })

    listEl.querySelectorAll('.stream-unlink-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('纭畾鍙栨秷鍏宠仈锛?)) return
        btn.disabled = true; btn.textContent = '鍙栨秷涓?..'
        const r = await api.del(`/api/video-stream?episode=${btn.dataset.unlinkEp}`)
        if (r.ok) { loadStreamVideos() } else { alert(r.error || '鍙栨秷澶辫触'); btn.disabled = false; btn.textContent = '鍙栨秷鍏宠仈' }
      })
    })

    // Copy and delete handlers
    listEl.querySelectorAll('.stream-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(btn.dataset.copyUid).then(() => {
          btn.textContent = '宸插鍒?'
          setTimeout(() => { btn.textContent = '澶嶅埗ID' }, 2000)
        })
      })
    })

    listEl.querySelectorAll('.stream-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('纭畾鍒犻櫎杩欎釜瑙嗛锛熷垹闄ゅ悗涓嶅彲鎭㈠銆?)) return
        btn.textContent = '鍒犻櫎涓?..'
        btn.disabled = true
        try {
          const res = await api.del(`/api/stream?uid=${btn.dataset.delUid}`)
          if (res.ok || res.success) {
            btn.closest('.stream-video-card')?.remove()
          } else {
            alert(res.error || '鍒犻櫎澶辫触')
            btn.textContent = '鍒犻櫎'
            btn.disabled = false
          }
        } catch (err) {
          alert('鍒犻櫎澶辫触')
          btn.textContent = '鍒犻櫎'
          btn.disabled = false
        }
      })
    })
  } catch (err) {
    console.error('Load stream videos error:', err)
    listEl.innerHTML = '<div class="comments-empty">鍔犺浇瑙嗛鍒楄〃澶辫触</div>'
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
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>

      <div class="membership-header">
        <h1 class="membership-title">閫夋嫨浣犵殑浼氬憳璁″垝</h1>
        <p class="membership-subtitle">瑙ｉ攣琛楀摜鍏ㄩ儴鎶€鏈垎鏋愯绋嬶紝绯荤粺鎺屾彙浜ゆ槗鎶€鏈?/p>
      </div>

      <div id="membershipCreditSummary" class="membership-credit-summary">
        ${state.user ? '<div class="billing-loading">姝ｅ湪璇诲彇杩斾剑閭€璇蜂俊鎭?..</div>' : '<span>鐧诲綍鍚庡彲鏌ョ湅杩斾剑閭€璇蜂俊鎭?/span>'}
      </div>

      <div class="membership-cards">
        <!-- 浣撻獙鐗?-->
        <div class="mem-card ${currentPlan === 'free' ? 'mem-current' : ''}">
          <div class="mem-card-header mem-free">
            <span class="mem-icon">馃啌</span>
            <h3 class="mem-plan-name">浣撻獙鐗?/h3>
            <p class="mem-plan-desc">鍒濇鎰熷彈璇剧▼璐ㄩ噺</p>
          </div>
          <div class="mem-price-section">
            <span class="mem-price">鍏嶈垂</span>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">鉁?/span>宸插叕寮€鐨?9鏈熻绋嬭棰戯紙闄嗙画涓婁紶锛?/li>
            <li class="mem-feat"><span class="mem-check">鉁?/span>琛楀摜閲戣瀺 / 鐢熸椿鎰熸偀璇綍锛堥檰缁洿鏂帮級</li>
            <li class="mem-feat"><span class="mem-check">鉁?/span>瑙傜湅鍘嗗彶璁板綍</li>
            <li class="mem-feat disabled"><span class="mem-x">鉁?/span>鏂拌棰戝嵆鏃惰В閿?/li>
            <li class="mem-feat disabled"><span class="mem-x">鉁?/span>鐭ヨ瘑鍥捐В & 妗嗘灦</li>
            <li class="mem-feat disabled"><span class="mem-x">鉁?/span>璇惧悗娴嬮獙 + 瑙ｆ瀽</li>
            <li class="mem-feat disabled"><span class="mem-x">鉁?/span>涓撳睘琛楀鍐涜韩浠芥爣璇?/li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'free'
              ? '<button class="btn mem-btn mem-btn-current" disabled>褰撳墠鏂规</button>'
              : '<button class="btn mem-btn mem-btn-free">褰撳墠宸叉槸鏇撮珮鏂规</button>'}
          </div>
        </div>

        <!-- Plus -->
        <div class="mem-card ${currentPlan === 'plus' ? 'mem-current' : ''}">
          <div class="mem-card-header mem-plus">
            <span class="mem-icon">猸?/span>
            <h3 class="mem-plan-name">Plus</h3>
            <p class="mem-plan-desc">绯荤粺瀛︿範鎶€鏈垎鏋?/p>
          </div>
          <div class="mem-price-section">
            <div class="mem-price-toggle">
              <button class="price-tab active" data-period="monthly">鏈堜粯</button>
              <button class="price-tab" data-period="yearly">骞翠粯</button>
            </div>
            <div class="mem-price-display">
              <span class="mem-price-original" data-monthly="100" data-yearly="1000">$100</span>
              <span class="mem-price" data-monthly="50" data-yearly="500">$50</span>
              <span class="mem-price-unit" data-monthly="/鏈? data-yearly="/骞?>/ 鏈?/span>
            </div>
            <div class="mem-price-discount">闄愭椂 5 鎶?/div>
            <div class="mem-price-save" style="display:none">骞翠粯绔嬬渷 $100锛屼綆鑷?$50/鏈?/div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">鉁?/span>鏂拌棰戜笂绾垮嵆鏃惰В閿?/li>
            <li class="mem-feat"><span class="mem-check">鉁?/span>楂樻竻鐭ヨ瘑鍥捐В & 妗嗘灦</li>
            <li class="mem-feat"><span class="mem-check">鉁?/span>鍏ㄩ儴璇惧悗娴嬮獙 + 瑙ｆ瀽</li>
            <li class="mem-feat disabled"><span class="mem-x">鉁?/span>AI鍏ㄨ嚜鍔ㄤ氦鏄?/li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? '<button class="btn mem-btn mem-btn-free" disabled>褰撳墠宸叉槸鏇撮珮鏂规</button>'
              : currentPlan === 'plus'
                ? (currentPeriod === 'yearly'
                  ? '<button class="btn mem-btn mem-btn-current" disabled>褰撳墠鏂规</button>'
                  : `<button class="btn mem-btn mem-btn-plus" data-plan="plus" data-force-yearly="1">鏆傚叧闂?/button>`)
                : `<button class="btn mem-btn mem-btn-plus" data-plan="plus">鏆傚叧闂?/button>`}
          </div>
        </div>

        <!-- Pro -->
        <div class="mem-card ${currentPlan === 'pro' ? 'mem-current' : ''}">
          <div class="mem-card-header mem-pro">
            <span class="mem-icon">馃拵</span>
            <h3 class="mem-plan-name">Pro</h3>
            <p class="mem-plan-desc">娣卞害瀛︿範 路 浜ゆ槗杩涢樁</p>
          </div>
          <div class="mem-price-section">
            <div class="mem-price-toggle">
              <button class="price-tab active" data-period="monthly">鏈堜粯</button>
              <button class="price-tab" data-period="yearly">骞翠粯</button>
            </div>
            <div class="mem-price-display">
              <span class="mem-price-original" data-monthly="200" data-yearly="2000">$200</span>
              <span class="mem-price" data-monthly="100" data-yearly="1000">$100</span>
              <span class="mem-price-unit" data-monthly="/鏈? data-yearly="/骞?>/ 鏈?/span>
            </div>
            <div class="mem-price-discount">闄愭椂 5 鎶?/div>
            <div class="mem-price-save" style="display:none">骞翠粯绔嬬渷 $200锛屼綆鑷?$100/鏈?/div>
          </div>
          <ul class="mem-features">
            <li class="mem-feat"><span class="mem-check">鉁?/span>鍖呭惈 Plus 鍏ㄩ儴鏉冮檺</li>
            <li class="mem-feat"><span class="mem-check pro">鉁?/span>AI鍏ㄨ嚜鍔ㄤ氦鏄?/li>
          </ul>
          <div class="mem-action">
            ${currentPlan === 'pro'
              ? (currentPeriod === 'yearly'
                ? '<button class="btn mem-btn mem-btn-current" disabled>褰撳墠鏂规</button>'
                : `<button class="btn mem-btn mem-btn-pro" data-plan="pro" data-force-yearly="1">鏆傚叧闂?/button>`)
              : `<button class="btn mem-btn mem-btn-pro" data-plan="pro">鏆傚叧闂?/button>`}
          </div>
        </div>
      </div>

      <div class="membership-comparison">
        <h3 class="faq-title">鏉冪泭瀵规瘮</h3>
        <table class="comparison-table">
          <thead>
            <tr>
              <th>鍔熻兘</th>
              <th>浣撻獙鐗?/th>
              <th>Plus</th>
              <th>Pro</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>鍏紑璇剧▼瑙嗛</td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>琛楀摜璇綍</td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>瑙傜湅鍘嗗彶</td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>鏂拌棰戝嵆鏃惰В閿?/td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>鐭ヨ瘑鍥捐В & 妗嗘灦</td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>璇惧悗娴嬮獙 + 瑙ｆ瀽</td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>涓撳睘琛楀鍐涙爣璇?/td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>AI鍏ㄨ嚜鍔ㄤ氦鏄?/td><td>鉁?/td><td>鉁?/td><td>鉁?/td></tr>
            <tr><td>鏈堜粯浠锋牸</td><td>鍏嶈垂</td><td>$50/鏈?/td><td>$100/鏈?/td></tr>
          </tbody>
        </table>
      </div>

      <div class="membership-faq">
        <h3 class="faq-title">甯歌闂</h3>
        <div class="faq-list">
          <div class="faq-item">
            <div class="faq-q">鍙互闅忔椂鏇存崲鏂规鍚楋紵</div>
            <div class="faq-a">鍙互銆傚崌绾х珛鍗崇敓鏁堬紝宸环鑷姩琛ラ綈銆?/div>
          </div>
          <div class="faq-item">
            <div class="faq-q">鏀寔鍝簺鏀粯鏂瑰紡锛?/div>
            <div class="faq-a">鏀寔 USDT / USDC 鍔犲瘑璐у竵鏀粯锛岃鐩?Ethereum銆乀ron銆丼olana銆丅SC 绛変富娴侀摼銆?/div>
          </div>
          <div class="faq-item">
            <div class="faq-q">璇剧▼鍐呭浼氭寔缁洿鏂板悧锛?/div>
            <div class="faq-a">鏄殑銆傝鍝ユ瘡鍛ㄤ細鏇存柊浠栧褰撲笅琛屾儏鎬濊矾鐨勮棰戙€?/div>
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
      el.innerHTML = `<span>${escapeHtml(res.error || '杩斾剑閭€璇蜂俊鎭殏鏃舵棤娉曡鍙?)}</span>`
      return
    }
    if (false) {
      if (res.mode === 'disabled') {
        el.style.display = 'none'
        return
      }
      el.classList.add('membership-credit-summary-preview')
      el.innerHTML = `
        <div class="membership-credit-preview-text">
          <strong>閭€璇疯繑浣ｅ姛鑳藉嵆灏嗗紑鏀?/strong>
          <span>褰撳墠浠呭睍绀哄姛鑳借鏄庯紝杩斾剑閭€璇锋殏鏈惎鐢ㄣ€?/span>
        </div>
        <div class="membership-credit-item"><span>寰呯‘璁よ繑浣?/span><strong>$0.00</strong></div>
        <div class="membership-credit-item"><span>鍙敤杩斾剑</span><strong>$0.00</strong></div>
        <div class="membership-credit-item"><span>宸蹭娇鐢ㄨ繑浣?/span><strong>$0.00</strong></div>`
      return
    }
    const stats = res.stats
    el.innerHTML = `
      <div class="membership-credit-item"><span>寰呯‘璁よ繑浣?/span><strong>${formatMinorUsd(stats.pending_credit_cents)}</strong></div>
      <div class="membership-credit-item"><span>鍙敤杩斾剑</span><strong>${formatMinorUsd(stats.available_credit_cents)}</strong></div>
      <div class="membership-credit-item"><span>宸蹭娇鐢ㄨ繑浣?/span><strong>${formatMinorUsd(stats.used_credit_cents)}</strong></div>
      <div class="membership-credit-link">寮€鏀惧悗涓嬪崟鏃惰嚜鍔ㄨ绠楀彲鐢ㄨ繑浣?/div>`
  } catch {
    el.innerHTML = '<span>杩斾剑閭€璇蜂俊鎭殏鏃舵棤娉曡鍙?/span>'
  }
}

// ===== TOS Page =====
function renderTos() {
  mainContent.innerHTML = `
    <div class="tos-page fade-in">
      <button class="back-btn" id="backHome">鈫?杩斿洖</button>
      <div class="tos-card">
        <h1 class="tos-title">鐢ㄦ埛鏈嶅姟鍗忚</h1>
        <p class="tos-update">鏈€鍚庢洿鏂版棩鏈燂細2026骞?鏈?2鏃?/p>

        <div class="tos-content">
          <p>娆㈣繋浣跨敤 wall-street-skill.com锛堜互涓嬬畝绉?鏈綉绔?锛夈€傛湰缃戠珯鐢卞崕灏旇娌℃湁鍚嶅瓧锛?a href="https://x.com/WallStreet0Name" target="_blank">@WallStreet0Name</a>锛屼互涓嬬畝绉?琛楀摜"锛夎繍钀ャ€傚湪娉ㄥ唽銆佽闂垨浣跨敤鏈綉绔欎箣鍓嶏紝璇蜂粩缁嗛槄璇讳互涓嬫潯娆俱€傛敞鍐屽嵆琛ㄧず鎮ㄥ凡闃呰銆佺悊瑙ｅ苟鍚屾剰鍙楁湰鍗忚绾︽潫銆?/p>

          <h2>涓€銆佹湇鍔″唴瀹?/h2>
          <ol>
            <li>鏈綉绔欐彁渚涙妧鏈垎鏋愭暀瀛﹁棰戙€佽鎯呮€濊矾鍒嗕韩銆佺煡璇嗗浘瑙ｃ€佽鍚庢祴楠岀瓑<strong>鏁欒偛绫诲唴瀹?/strong>銆?/li>
            <li>鎵€鏈夊唴瀹瑰潎涓鸿鍝ヤ釜浜哄甯傚満琛屾儏鐨勬€濊€冨拰鎶€鏈暀瀛︽紨绀猴紝<strong>涓嶆瀯鎴愪换浣曞舰寮忕殑鎶曡祫寤鸿銆佷氦鏄撴寚瀵兼垨璧勪骇閰嶇疆鏂规</strong>銆?/li>
            <li>鏈綉绔?strong>涓嶆彁渚涘甫鍗曟湇鍔°€佽窡鍗曚俊鍙枫€佷唬瀹㈢悊璐㈡垨浠讳綍褰㈠紡鐨勬姇璧勯【闂湇鍔?/strong>銆?/li>
          </ol>

          <h2>浜屻€佸厤璐ｅ０鏄?/h2>
          <ol>
            <li><strong>闈炴姇璧勫缓璁?/strong>锛氭湰缃戠珯鍙戝竷鐨勬墍鏈夎棰戙€佹枃瀛椼€佸浘琛ㄣ€佸垎鏋愬強浠讳綍褰㈠紡鐨勫唴瀹癸紝鍧囦负琛楀摜涓汉瀵硅鎯呯殑鎬濊€冨拰鏁欏婕旂ず锛屼粎渚涘涔犲弬鑰冿紝<strong>涓嶆瀯鎴愬浠讳綍閲戣瀺浜у搧鐨勪拱鍗栧缓璁?/strong>銆?/li>
            <li><strong>鎶曡祫椋庨櫓鑷媴</strong>锛氬姞瀵嗚揣甯併€佽吹閲戝睘鍙婂叾浠栭噾铻嶅競鍦轰氦鏄撳叿鏈夐珮搴﹂闄╋紝鍙兘瀵艰嚧鍏ㄩ儴鏈噾鎹熷け銆傜敤鎴峰洜鍙傝€冩湰缃戠珯鍐呭鑰屽仛鍑虹殑浠讳綍鎶曡祫鍐崇瓥锛?strong>椋庨櫓鍜屽悗鏋滅敱鐢ㄦ埛鑷鎵挎媴</strong>锛屼笌鏈綉绔欏強琛楀摜鏃犲叧銆?/li>
            <li><strong>淇℃伅鍑嗙‘鎬?/strong>锛氭垜浠敖鍔涚‘淇濆唴瀹圭殑鍑嗙‘鎬у拰鏃舵晥鎬э紝浣嗕笉瀵瑰唴瀹圭殑瀹屾暣鎬с€佸噯纭€с€佸彲闈犳€ф垨閫傜敤鎬т綔浠讳綍鏄庣ず鎴栨殫绀虹殑淇濊瘉銆傚競鍦虹灛鎭竾鍙橈紝杩囧線鍒嗘瀽涓嶄唬琛ㄦ湭鏉ヨ〃鐜般€?/li>
            <li><strong>绗笁鏂瑰伐鍏?/strong>锛氭湰缃戠珯鍙兘鍖呭惈鎸囧悜绗笁鏂圭綉绔欐垨骞冲彴鐨勯摼鎺ワ紙濡?TradingView銆佷氦鏄撴墍绛夛級锛岃繖浜涢摼鎺ヤ粎涓轰究鍒╃敤鎴疯€屾彁渚涖€傛垜浠笉瀵圭涓夋柟缃戠珯鐨勫唴瀹广€佸畨鍏ㄦ€ф垨鏈嶅姟璐ㄩ噺鎵挎媴浠讳綍璐ｄ换銆?/li>
          </ol>

          <h2>涓夈€佷粯璐规湇鍔′笌閫€娆炬斂绛?/h2>
          <ol>
            <li>鏈綉绔欐彁渚涘厤璐逛綋楠岀増鍙婁粯璐逛細鍛樻湇鍔★紙Plus銆丳ro锛夈€?/li>
            <li><strong>浠樿垂浼氬憳涓€缁忚喘涔帮紝鍗虫椂鐢熸晥锛屼笉鏀寔閫€娆俱€?/strong>璇峰湪璐拱鍓嶅厖鍒嗕簡瑙ｅ悇鏂规鍐呭銆?/li>
            <li>鎴戜滑淇濈暀闅忔椂璋冩暣浼氬憳浠锋牸鍜屾潈鐩婂唴瀹圭殑鏉冨埄锛屽凡璐拱鐨勪細鍛樺湪鏈夋晥鏈熷唴涓嶅彈浠锋牸璋冩暣褰卞搷銆?/li>
            <li>鑻ュ洜鎶€鏈師鍥犲鑷存湇鍔′腑鏂紝鎴戜滑灏嗗湪鍚堢悊鏃堕棿鍐呮仮澶嶆湇鍔★紝浣嗕笉鎵挎媴鍥犳浜х敓鐨勪换浣曟崯澶便€?/li>
          </ol>

          <h2>鍥涖€佺敤鎴疯涓鸿鑼?/h2>
          <ol>
            <li>鐢ㄦ埛搴旀彁渚涚湡瀹炪€佸噯纭殑娉ㄥ唽淇℃伅锛屽苟濡ュ杽淇濈璐﹀彿鍜屽瘑鐮併€?/li>
            <li>鐢ㄦ埛涓嶅緱灏嗘湰缃戠珯鐨勪粯璐瑰唴瀹硅繘琛屽綍鍒躲€佹埅灞忋€佷笅杞姐€佷紶鎾€佽浆鍞垨浠ヤ换浣曟柟寮忓垎浜粰鏈巿鏉冪殑绗笁鏂广€?/li>
            <li>鐢ㄦ埛涓嶅緱鍒╃敤鏈綉绔欏彂甯冭繚娉曘€佷井杈辨€с€侀獨鎵版€ф垨渚垫潈鍐呭銆?/li>
            <li>杩濆弽涓婅堪瑙勫畾鐨勭敤鎴凤紝鎴戜滑鏈夋潈绔嬪嵆缁堟鍏惰处鍙峰苟涓嶄簣閫€娆俱€?/li>
          </ol>

          <h2>浜斻€佺煡璇嗕骇鏉?/h2>
          <ol>
            <li>鏈綉绔欑殑鎵€鏈夊唴瀹癸紝鍖呮嫭浣嗕笉闄愪簬瑙嗛銆佹枃瀛椼€佸浘琛ㄣ€佸浘鐗囥€佺晫闈㈣璁°€佸晢鏍囧強鏍囪瘑锛屽潎鍙楃煡璇嗕骇鏉冩硶寰嬩繚鎶ゃ€?/li>
            <li>鏈粡涔﹂潰璁稿彲锛屼换浣曚釜浜烘垨缁勭粐涓嶅緱澶嶅埗銆佷慨鏀广€佸垎鍙戙€佸睍绀烘垨浠ヤ换浣曟柟寮忎娇鐢ㄦ湰缃戠珯鐨勫唴瀹广€?/li>
          </ol>

          <h2>鍏€侀殣绉佷繚鎶?/h2>
          <ol>
            <li>鎴戜滑閲嶈鐢ㄦ埛闅愮锛屾敹闆嗙殑淇℃伅锛堥偖绠便€佹樀绉般€佸涔犺繘搴︾瓑锛変粎鐢ㄤ簬鎻愪緵鍜屾敼鍠勬湇鍔°€?/li>
            <li>鎴戜滑涓嶄細灏嗙敤鎴蜂釜浜轰俊鎭嚭鍞垨鎻愪緵缁欑涓夋柟锛屾硶寰嬭姹傞櫎澶栥€?/li>
            <li>鐢ㄦ埛鐨勫瘑鐮佺粡鍔犲瘑瀛樺偍锛屾垜浠棤娉曚篃涓嶄細鏌ョ湅鐢ㄦ埛鐨勫師濮嬪瘑鐮併€?/li>
          </ol>

          <h2>涓冦€佽矗浠婚檺鍒?/h2>
          <ol>
            <li><strong>鍦ㄦ硶寰嬪厑璁哥殑鏈€澶ц寖鍥村唴锛屾湰缃戠珯鍙婅鍝ヤ笉瀵圭敤鎴峰洜浣跨敤鎴栨棤娉曚娇鐢ㄦ湰缃戠珯鑰屼骇鐢熺殑浠讳綍鐩存帴銆侀棿鎺ャ€侀檮甯︺€佺壒娈婃垨鎯╃綒鎬ф崯瀹虫壙鎷呰矗浠?/strong>锛屽寘鎷絾涓嶉檺浜庢姇璧勬崯澶便€佹暟鎹涪澶辨垨涓氬姟涓柇銆?/li>
            <li>鏈綉绔欐彁渚涚殑鏈嶅姟鎸?鐜扮姸"鍜?鍙敤鎬?鎻愪緵锛屼笉闄勫甫浠讳綍褰㈠紡鐨勬槑绀烘垨鏆楃ず淇濊瘉銆?/li>
          </ol>

          <h2>鍏€佸崗璁彉鏇?/h2>
          <ol>
            <li>鎴戜滑淇濈暀闅忔椂淇敼鏈崗璁殑鏉冨埄銆備慨鏀瑰悗鐨勫崗璁皢鍦ㄧ綉绔欎笂鍏竷锛岀户缁娇鐢ㄦ湰缃戠珯鍗宠涓烘帴鍙椾慨鏀瑰悗鐨勬潯娆俱€?/li>
            <li>閲嶅ぇ鍙樻洿灏嗛€氳繃缃戠珯閫氱煡鏂瑰紡鍛婄煡鐢ㄦ埛銆?/li>
          </ol>

          <h2>涔濄€佷簤璁В鍐?/h2>
          <ol>
            <li>鏈崗璁殑瑙ｉ噴鍜屾墽琛岄€傜敤鐩稿叧娉曞緥娉曡銆?/li>
            <li>鍥犳湰鍗忚寮曡捣鐨勪换浣曚簤璁紝鍙屾柟搴旈鍏堝弸濂藉崗鍟嗚В鍐炽€傚崗鍟嗕笉鎴愮殑锛屼换浣曚竴鏂瑰潎鏈夋潈鍚戞湁绠¤緰鏉冪殑娉曢櫌鎻愯捣璇夎銆?/li>
          </ol>

          <h2>鍗併€佽仈绯绘柟寮?/h2>
          <p>濡傚鏈崗璁湁浠讳綍鐤戦棶锛岃閫氳繃浠ヤ笅鏂瑰紡鑱旂郴鎴戜滑锛?/p>
          <p>X (Twitter)锛?a href="https://x.com/WallStreet0Name" target="_blank">@WallStreet0Name</a></p>
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
      category: '浜ゆ槗鎵€',
      items: [
        {
          name: 'Binance锛堝竵瀹夛級',
          desc: '鍏ㄧ悆鏈€澶х殑浜ゆ槗鎵€锛屼氦鏄撻噺鍜屾祦鍔ㄦ€у厖娌涳紝棣栭€?,
          icon: '馃獧',
          url: 'https://www.bsmkweb.cc/join?ref=WSBNONAME',
          tag: '棣栭€?,
          tagColor: '#f0b90b',
          code: 'WSBNONAME',
          rebate: '杩斾剑 20%',
        },
        {
          name: 'OKX锛堟鏄擄級',
          desc: '浠呮浜庡竵瀹夌殑浜ゆ槗鎵€锛屽悎绾︽祦鍔ㄦ€уソ锛屾湡鏉冨姛鑳藉畬鍠?,
          icon: '馃數',
          url: 'https://www.promooboost.com/join/CRYPTO618',
          tag: '',
          tagColor: '',
          code: 'CRYPTO618',
          rebate: '杩斾剑 20%',
        },
        {
          name: 'Bybit',
          desc: '閫傚悎浜ゆ槗榛勯噾鐧介摱澶栨眹锛孴radFi 鏉垮潡鎵嬬画璐逛綆',
          icon: '馃煛',
          url: 'https://partner.bybit.com/b/CRYPTO618',
          tag: '',
          tagColor: '',
          code: 'CRYPTO618',
          rebate: '杩斾剑 33%',
          note: '娉ㄥ唽闇€浣跨敤姊瓙锛堝彴婀俱€侀煩鍥姐€佹境澶у埄浜氱瓑鍦板尯IP锛涗笉鑳戒娇鐢ㄩ娓€佹柊鍔犲潯銆佺編鍥姐€佹棩鏈€佹娲茬殑IP锛夈€傜櫥褰曞悗鍥藉唴IP鍙甯镐娇鐢ㄣ€傝璇佹敮鎸佽韩浠借瘉銆侀┚鐓с€佹姢鐓э紝娉ㄥ唽鏃跺厛閫夊眳浣忓湴涓哄彴婀炬垨婢冲ぇ鍒╀簹绛夛紝鎻愪氦璇佷欢鏃堕€夋嫨 China 姝ｅ父鎻愪氦銆?,
        },
        {
          name: 'Bitget',
          desc: '璺熷崟浜ゆ槗骞冲彴锛屼竴閿窡闅忎紭璐ㄤ氦鏄撳憳绛栫暐',
          icon: '馃煝',
          url: 'https://partner.hdmune.cn/bg/v8ju2ccn',
          tag: '',
          tagColor: '',
          code: 'WallStreet',
          rebate: '杩斾剑 40%',
        },
        {
          name: 'BIT 缇庤偂浜ゆ槗鎵€',
          desc: '缇庤偂浜ゆ槗鎵€寮€鎴烽摼鎺ワ紝閫傚悎缇庤偂鐩稿叧浜ゆ槗浣跨敤',
          icon: '馃嚭馃嚫',
          url: 'https://bit.bshareweb.com/newRegister/cn?invite_code=CY3DKV',
          tag: '缇庤偂',
          tagColor: '#2563eb',
          code: 'CY3DKV',
        },
      ],
    },
    {
      category: '鐪嬬洏宸ュ叿',
      items: [
        {
          name: 'TradingView',
          desc: '琛楀摜鑷敤鐨勪笓涓氱湅鐩樿蒋浠讹紝鏀寔鎶€鏈寚鏍囥€佺敾绾垮伐鍏枫€佸鍥捐〃甯冨眬锛屾柊鎵嬪繀澶?,
          icon: '馃搳',
          url: 'https://cn.tradingview.com/?aff_id=158703',
          tag: '琛楀摜鑷敤',
          tagColor: '#f7931a',
        },
      ],
    },
    {
      category: '鏁版嵁宸ュ叿',
      items: [
        {
          name: 'CoinAnk',
          desc: '涓撲笟鍔犲瘑璐у竵鏁版嵁鍒嗘瀽骞冲彴锛岄摼涓婃暟鎹€佽祫閲戞祦鍚戙€佸競鍦烘儏缁垎鏋?,
          icon: '馃搳',
          url: 'https://coinank.com/zh/invite/register?referral=1458068',
          tag: '',
          tagColor: '',
          code: '1458068',
        },
        {
          name: 'CoinGlass',
          desc: '鍚堢害鏁版嵁鐪嬫澘锛岀垎浠撴暟鎹€佽祫閲戣垂鐜囥€佹寔浠撻噺涓€鐩簡鐒?,
          icon: '馃搱',
          url: 'https://www.coinglass.com/?ref_code=YDHYYF',
          tag: '',
          tagColor: '',
        },
        {
          name: 'CoinMarketCap',
          desc: '鍔犲瘑璐у竵甯傚€兼帓鍚嶃€佷环鏍艰拷韪€侀」鐩俊鎭煡璇?,
          icon: '馃捁',
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
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>

      <div class="tools-header">
        <h1 class="tools-title">馃О 閲戣瀺宸ュ叿绠?/h1>
        <p class="tools-subtitle">杩欎簺鏄垜骞虫椂鐪嬬洏銆佷氦鏄撱€佸垎鏋愮敤鍒扮殑宸ュ叿鍜屽钩鍙帮紝鍒嗕韩缁欏ぇ瀹?/p>
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
                ${t.code ? `<div class="tool-code">閭€璇风爜锛?span class="tool-code-val">${t.code}</span></div>` : ''}
                ${t.note ? `<div class="tool-note">${t.note}</div>` : ''}
                <span class="tool-link">娉ㄥ唽/璁块棶 鈫?/span>
              </a>
            `).join('')}
          </div>
        </div>
      `).join('')}

      <div class="tools-disclaimer">
        <p>浠ヤ笂閾炬帴浠呬负涓汉鍒嗕韩锛屼笉鏋勬垚浠讳綍鎶曡祫寤鸿銆傝鑷鍒ゆ柇椋庨櫓銆?/p>
      </div>
    </div>
  `
}

// Settings tab state
let settingsTab = 'profile'

function renderProfile() {
  const currentPlan = getEffectivePlan()
  const planNames = { free: '浣撻獙鐗堬紙鍏嶈垂锛?, plus: '猸?Plus', pro: '馃拵 Pro' }

  mainContent.innerHTML = `
    <div class="settings-page fade-in">
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>
      <div class="settings-layout">
        <nav class="settings-nav">
          <div class="settings-nav-title">璁剧疆鍜岃处鍗?/div>
          <a class="settings-nav-item ${settingsTab === 'profile' ? 'active' : ''}" data-tab="profile">
            <span class="settings-nav-icon">馃懁</span>涓汉璧勬枡
          </a>
          <a class="settings-nav-item ${settingsTab === 'account' ? 'active' : ''}" data-tab="account">
            <span class="settings-nav-icon">馃攼</span>璐﹀彿璁剧疆
          </a>
          <a class="settings-nav-item ${settingsTab === 'notifications' ? 'active' : ''}" data-tab="notifications">
            <span class="settings-nav-icon">馃У</span>璁哄潧閫氱煡
            ${state.notificationUnread ? `<span class="settings-nav-badge">${state.notificationUnread > 99 ? '99+' : state.notificationUnread}</span>` : ''}
          </a>
          <div class="settings-nav-divider"></div>
          <div class="settings-nav-section">璐﹀崟</div>
          <a class="settings-nav-item ${settingsTab === 'subscription' ? 'active' : ''}" data-tab="subscription">
            <span class="settings-nav-icon">馃挸</span>璁㈤槄
          </a>
          <a class="settings-nav-item ${settingsTab === 'credits' ? 'active' : ''}" data-tab="credits">
            <span class="settings-nav-icon">馃師锔?/span>杩斾剑閭€璇?
          </a>
        </nav>

        <div class="settings-content">
          ${settingsTab === 'profile' ? `
            <!-- 涓汉璧勬枡 -->
            <div class="settings-section">
              <h2 class="settings-section-title">涓汉璧勬枡</h2>
              <p class="settings-section-desc">绠＄悊浣犵殑澶村儚鍜屾樀绉?/p>

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
                      鏇存崲澶村儚
                      <input type="file" accept="image/*" id="avatarInput" style="display:none">
                    </label>
                    <p class="settings-hint">鏀寔 JPG銆丳NG锛岃嚜鍔ㄥ帇缂╄嚦 200脳200</p>
                  </div>
                </div>
              </div>

              <div class="settings-card">
                <div class="form-group">
                  <label class="form-label">鏄电О</label>
                  <div class="form-row">
                    <input type="text" class="form-input" id="profileName" value="${state.user.name}">
                    <button class="btn-send-code" id="saveNameBtn">淇濆瓨</button>
                  </div>
                </div>
              </div>

              <div class="settings-card settings-info-card">
                <div class="profile-info-item">
                  <span class="profile-info-label">UID</span>
                  <span class="profile-info-value" style="font-family:monospace;letter-spacing:1px">${state.user.uid || '鈥?}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">褰撳墠鏂规</span>
                  <span class="profile-info-value">${planNames[currentPlan] || '浣撻獙鐗?}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">Telegram 缁戝畾</span>
                  <span class="profile-info-value">${escapeHtml(getTelegramBindingLabel(state.user?.telegramBinding))}</span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">宸插畬鎴愯绋?/span>
                  <span class="profile-info-value">${progress.getCompletedCount()} 璇?/span>
                </div>
                <div class="profile-info-item">
                  <span class="profile-info-label">瀛︿範涓?/span>
                  <span class="profile-info-value">${progress.getInProgressCount()} 璇?/span>
                </div>
              </div>
            </div>
          ` : settingsTab === 'account' ? `
            <!-- 璐﹀彿璁剧疆 -->
            <div class="settings-section">
              <h2 class="settings-section-title">璐﹀彿璁剧疆</h2>
              <p class="settings-section-desc">绠＄悊浣犵殑閭鍜屽瘑鐮?/p>

              <div class="settings-card">
                <div class="form-group">
                  <label class="form-label">鐢靛瓙閭</label>
                  <input type="email" class="form-input" value="${state.user.email}" disabled style="opacity:0.6">
                  <p class="settings-hint">鏆備笉鏀寔鏇存敼閭锛屽闇€鏇存敼璇疯仈绯荤鐞嗗憳</p>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">鏇存敼瀵嗙爜</h3>
                <div class="pwd-change-tabs">
                  <button class="pwd-tab active" data-pwd-mode="old">浣跨敤鍘熷瘑鐮?/button>
                  <button class="pwd-tab" data-pwd-mode="email">浣跨敤閭楠岃瘉</button>
                </div>

                <div id="pwdChangeForm">
                  <div id="pwdOldMode">
                    <div class="form-group">
                      <label class="form-label">鍘熷瘑鐮?/label>
                      <input type="password" class="form-input" id="oldPassword" placeholder="杈撳叆褰撳墠瀵嗙爜">
                    </div>
                  </div>
                  <div id="pwdEmailMode" style="display:none">
                    <div class="form-group">
                      <label class="form-label">閭楠岃瘉</label>
                      <div class="form-row">
                        <input type="text" class="form-input" value="${state.user.email}" disabled style="opacity:0.6;flex:1">
                        <button class="btn-send-code" id="pwdSendCode">鍙戦€侀獙璇佺爜</button>
                      </div>
                    </div>
                    <div class="form-group">
                      <label class="form-label">楠岃瘉鐮?/label>
                      <input type="text" class="form-input" id="pwdVerifyCode" placeholder="杈撳叆6浣嶉獙璇佺爜" maxlength="6">
                    </div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">鏂板瘑鐮?/label>
                    <input type="password" class="form-input" id="newPassword" placeholder="8~32涓瓧绗?>
                  </div>
                  <div class="form-group">
                    <label class="form-label">纭鏂板瘑鐮?/label>
                    <input type="password" class="form-input" id="confirmPassword" placeholder="鍐嶆杈撳叆鏂板瘑鐮?>
                  </div>
                  <button class="btn btn-primary" id="savePasswordBtn" style="width:100%;margin-top:8px">鏇存敼瀵嗙爜</button>
                  <div id="pwdChangeMsg" class="settings-msg" style="display:none"></div>
                </div>
              </div>
            </div>
          ` : settingsTab === 'notifications' ? `
            <div class="settings-section">
              <h2 class="settings-section-title">璁哄潧閫氱煡</h2>
              <p class="settings-section-desc">鏈変汉鍥炲浣犮€佸紩鐢ㄤ綘鏃讹紝浼氬湪杩欓噷鎻愰啋銆?/p>

              <div class="settings-card">
                <div class="forum-notifications-head">
                  <div class="forum-notifications-meta">
                    <span class="forum-notifications-unread">鏈 ${state.notificationUnread || 0}</span>
                    <span class="settings-hint">绯荤粺浼氬湪浣犳墦寮€閫氱煡鍚庤嚜鍔ㄦ爣璁板凡璇?/span>
                  </div>
                  <button class="btn btn-ghost btn-sm" id="forumReadAllBtn">鍏ㄩ儴宸茶</button>
                </div>
                <div id="forumNotificationsList" class="forum-notifications-list">
                  <div class="billing-loading">鍔犺浇涓?..</div>
                </div>
              </div>
            </div>
          ` : settingsTab === 'subscription' ? `
            <!-- 璁㈤槄 -->
            <div class="settings-section">
              <h2 class="settings-section-title">璁㈤槄</h2>
              <p class="settings-section-desc">绠＄悊浣犵殑浼氬憳鏂规</p>

              <div class="settings-card sub-current-card">
                <div class="sub-current-header">
                  <div>
                    <div class="sub-current-plan">${planNames[currentPlan] || '浣撻獙鐗?}</div>
                    <div class="sub-current-desc">${currentPlan === 'free' ? '鍏紑瑙嗛 + 璇綍' : currentPlan === 'plus' ? '鏂拌棰戝嵆鏃惰В閿?+ 鍥捐В + 娴嬮獙' : '鍏ㄩ儴鏉冮檺 + AI淇″彿'}</div>
                    ${state.user?.planExpiresAt ? `<div class="sub-expires">鍒版湡鏃堕棿锛?{formatDateTime(state.user.planExpiresAt)}</div>` : ''}
                  </div>
                  <span class="sub-current-badge sub-badge-${currentPlan}">${currentPlan === 'free' ? '鍏嶈垂' : currentPlan === 'plus' ? 'Plus' : 'Pro'}</span>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">鏇存敼鏂规</h3>
                <div class="sub-plans">
                  <div class="sub-plan-row ${currentPlan === 'free' ? 'sub-plan-active' : ''}" data-plan="free">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">馃啌</span>
                      <div>
                        <div class="sub-plan-name">浣撻獙鐗?/div>
                        <div class="sub-plan-desc">鍏紑瑙嗛 + 璇綍</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">鍏嶈垂</div>
                    ${currentPlan === 'free' ? '<span class="sub-plan-current">褰撳墠</span>' : ''}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'plus' ? 'sub-plan-active' : ''} ${currentPlan === 'pro' ? 'sub-plan-disabled' : ''}" data-plan="plus">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">猸?/span>
                      <div>
                        <div class="sub-plan-name">Plus</div>
                        <div class="sub-plan-desc">鏂拌棰戝嵆鏃惰В閿?+ 鍥捐В + 娴嬮獙</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">$50/鏈?/div>
                    ${currentPlan === 'plus' ? '<span class="sub-plan-current">褰撳墠</span>' : currentPlan === 'pro' ? '' : '<button class="btn btn-sm btn-primary sub-plan-btn" disabled>鏆傚叧闂?/button>'}
                  </div>
                  <div class="sub-plan-row ${currentPlan === 'pro' ? 'sub-plan-active' : ''}" data-plan="pro">
                    <div class="sub-plan-info">
                      <span class="sub-plan-icon">馃拵</span>
                      <div>
                        <div class="sub-plan-name">Pro</div>
                        <div class="sub-plan-desc">鍏ㄩ儴鏉冮檺 + AI淇″彿</div>
                      </div>
                    </div>
                    <div class="sub-plan-price">$100/鏈?/div>
                    ${currentPlan === 'pro' ? '<span class="sub-plan-current">褰撳墠</span>' : '<button class="btn btn-sm btn-primary sub-plan-btn" disabled>鏆傚叧闂?/button>'}
                  </div>
                </div>
              </div>

              <div class="settings-card">
                <h3 class="settings-card-title">璐﹀崟鍘嗗彶</h3>
                <div id="billingHistory" class="billing-history">
                  <div class="billing-loading">鍔犺浇涓?..</div>
                </div>
              </div>

              <a class="settings-link" id="goMembershipPage">鏌ョ湅瀹屾暣鏂规瀵规瘮 鈫?/a>
            </div>
          ` : settingsTab === 'credits' ? `
            <div class="settings-section">
              <h2 class="settings-section-title">杩斾剑閭€璇?/h2>
              <p class="settings-section-desc">閭€璇锋柊鐢ㄦ埛璁㈤槄鍚庣敓鎴愯繑浣ｅ鍔憋紝鍔熻兘姝ｅ紡寮€鏀惧悗鍙敤浜庡悗缁?Plus 鎴?Pro 璁㈤槄銆?/p>
              <div id="subscriptionCreditCenter" class="subscription-credit-center">
                <div class="billing-loading">鍔犺浇涓?..</div>
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
      pwdSendBtn.textContent = '鍙戦€佷腑...'
      try {
        const res = await api.post('/api/send-code', {
          email: state.user.email,
          purpose: 'change_password',
        })
        if (res.ok) {
          showFormMsgProfile('楠岃瘉鐮佸凡鍙戦€?, 'ok')
          let cd = 60
          const timer = setInterval(() => {
            cd--
            pwdSendBtn.textContent = `${cd}s`
            if (cd <= 0) { clearInterval(timer); pwdSendBtn.textContent = '鍙戦€侀獙璇佺爜'; pwdSendBtn.disabled = false }
          }, 1000)
        } else {
          showFormMsgProfile(res.error || '鍙戦€佸け璐?, 'err')
          pwdSendBtn.disabled = false
          pwdSendBtn.textContent = '鍙戦€侀獙璇佺爜'
        }
      } catch {
        showFormMsgProfile('鍙戦€佸け璐?, 'err')
        pwdSendBtn.disabled = false
        pwdSendBtn.textContent = '鍙戦€侀獙璇佺爜'
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
        showPwdMsg(msgDiv, '涓ゆ杈撳叆鐨勫瘑鐮佷笉涓€鑷?, 'err'); return
      }

      const activeMode = mainContent.querySelector('.pwd-tab.active')?.dataset.pwdMode || 'old'
      const body = { newPassword: newPwd }

      if (activeMode === 'old') {
        const oldPwd = document.getElementById('oldPassword')?.value
        if (!oldPwd) { showPwdMsg(msgDiv, '璇疯緭鍏ュ師瀵嗙爜', 'err'); return }
        body.oldPassword = oldPwd
      } else {
        const code = document.getElementById('pwdVerifyCode')?.value
        if (!code || code.length !== 6) { showPwdMsg(msgDiv, '璇疯緭鍏?浣嶉獙璇佺爜', 'err'); return }
        // First verify code to get token
        const vRes = await api.post('/api/verify-code', {
          email: state.user.email,
          code,
          purpose: 'change_password',
        })
        if (!vRes.ok) { showPwdMsg(msgDiv, vRes.error || '楠岃瘉鐮侀敊璇?, 'err'); return }
        body.verifyToken = vRes.token
      }

      savePwdBtn.disabled = true
      savePwdBtn.textContent = '淇敼涓?..'
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
            showAuthModal('login_password', { email, message: '瀵嗙爜淇敼鎴愬姛锛岃閲嶆柊鐧诲綍' })
            return
          }
          showPwdMsg(msgDiv, '瀵嗙爜淇敼鎴愬姛', 'ok')
          const fields = ['oldPassword', 'newPassword', 'confirmPassword', 'pwdVerifyCode']
          fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
        } else {
          showPwdMsg(msgDiv, res.error || '淇敼澶辫触', 'err')
        }
      } catch {
        showPwdMsg(msgDiv, '淇敼澶辫触锛岃绋嶅悗閲嶈瘯', 'err')
      }
      savePwdBtn.disabled = false
      savePwdBtn.textContent = '鏇存敼瀵嗙爜'
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
      forumReadAllBtn.textContent = '澶勭悊涓?..'
      try {
        const res = await api.patch('/api/notifications', { markAll: true })
        if (res.ok) {
          state.notificationUnread = res.unreadCount || 0
          updateAuthUI()
          renderProfile()
        } else {
          alert(res.error || '鎿嶄綔澶辫触')
        }
      } catch {
        alert('鎿嶄綔澶辫触锛岃绋嶅悗閲嶈瘯')
      }
      forumReadAllBtn.disabled = false
      forumReadAllBtn.textContent = '鍏ㄩ儴宸茶'
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
      signalInvBtn.textContent = '鐢熸垚涓?..'
      try {
        const res = await api.post('/api/telegram-entry')
        if (res.success && res.botUrl) {
          window.open(res.botUrl, '_blank', 'noopener')
          if (msgDiv) {
            const bindingHint = state.user?.telegramBinding
              ? '璇峰姟蹇呬娇鐢ㄥ綋鍓嶅凡缁戝畾鐨?Telegram 璐﹀彿鎵撳紑鏈哄櫒浜猴紝鍚﹀垯鏈哄櫒浜轰細鎷掔粷鍙戦摼銆?
              : '鍦ㄦ満鍣ㄤ汉閲岀偣 Start 鍚庯紝瀹冧細缁欎綘鍙戦€佷笓灞炲叆缇ら摼鎺ャ€?
            msgDiv.innerHTML = '鏈哄櫒浜哄叆鍙ｅ凡鐢熸垚锛? + escapeHtml(String(res.expiresInSeconds || 600)) + ' 绉掑唴鏈夋晥锛夛細<a href="' + escapeHtml(res.botUrl) + '" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600;text-decoration:underline;word-break:break-all;">鐐瑰嚮鎵撳紑 Telegram 鏈哄櫒浜?/a><br>' + escapeHtml(bindingHint)
            msgDiv.className = 'signal-msg signal-msg-ok'
            msgDiv.style.display = 'block'
          }
          signalInvBtn.textContent = '宸茬敓鎴?
          setTimeout(() => { signalInvBtn.textContent = getTelegramEntryButtonLabel(state.user); signalInvBtn.disabled = false }, 10000)
        } else {
          if (msgDiv) { msgDiv.textContent = res.error || '鐢熸垚澶辫触'; msgDiv.className = 'signal-msg signal-msg-err'; msgDiv.style.display = 'block' }
          signalInvBtn.disabled = false
          signalInvBtn.textContent = getTelegramEntryButtonLabel(state.user)
        }
      } catch {
        if (msgDiv) { msgDiv.textContent = '鐢熸垚澶辫触锛岃绋嶅悗閲嶈瘯'; msgDiv.className = 'signal-msg signal-msg-err'; msgDiv.style.display = 'block' }
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
      signalRefreshBtn.textContent = '鍒锋柊涓?..'
      try {
        const user = await refreshCurrentUserProfile({ rerender: true, syncTelegram: true })
        const nextMsgDiv = document.getElementById('signalMsg')
        if (user && nextMsgDiv) {
          nextMsgDiv.textContent = `鐘舵€佸凡鍒锋柊锛屽綋鍓嶇粦瀹氾細${getTelegramBindingLabel(user.telegramBinding)}`
          nextMsgDiv.className = 'signal-msg signal-msg-ok'
          nextMsgDiv.style.display = 'block'
        } else if (msgDiv) {
          msgDiv.textContent = '鐘舵€佸凡鍒锋柊'
          msgDiv.className = 'signal-msg signal-msg-ok'
          msgDiv.style.display = 'block'
        }
      } catch {
        if (msgDiv) {
          msgDiv.textContent = '鍒锋柊澶辫触锛岃绋嶅悗閲嶈瘯'
          msgDiv.className = 'signal-msg signal-msg-err'
          msgDiv.style.display = 'block'
        }
      }
      const latestRefreshBtn = document.getElementById('signalRefreshStatus')
      if (latestRefreshBtn) {
        latestRefreshBtn.disabled = false
        latestRefreshBtn.textContent = '鍒锋柊鐘舵€?
      }
    })
  }

}

async function loadBillingHistory(container) {
  try {
    const data = await api.get('/api/orders')

    if (!data.orders || data.orders.length === 0) {
      container.innerHTML = '<div class="billing-empty">鏆傛棤璐﹀崟璁板綍</div>'
      return
    }

    const statusMap = {
      paid: { label: '宸插畬鎴?, cls: 'billing-paid' },
      pending: { label: '寰呮敮浠?, cls: 'billing-pending' },
      processing: { label: '澶勭悊涓?, cls: 'billing-pending' },
      expired: { label: '宸茶繃鏈?, cls: 'billing-expired' },
    }

    container.innerHTML = data.orders.map(o => {
      const s = statusMap[o.status] || { label: o.status, cls: '' }
      const date = o.paidAt || o.createdAt || ''
      const displayDate = formatDateTime(date)
      const paidAmount = o.amountConfirmed || o.amount
      const amountDiff = o.amountConfirmed && o.amountConfirmed !== o.amount
        ? ` <span class="billing-diff">(${formatMinorUsd(o.amount)})</span>` : ''
      const orderIdShort = o.orderId ? o.orderId.substring(0, 8) : ''
      return `
        <div class="billing-row">
          <div class="billing-info">
            <div class="billing-plan">${o.planLabel} ${o.periodLabel}</div>
            <div class="billing-date">${displayDate}${orderIdShort ? ` 路 <span class="billing-oid" title="${o.orderId}">#${orderIdShort}</span>` : ''}</div>
          </div>
          <div class="billing-right">
            <span class="billing-amount">${formatMinorUsd(paidAmount)}${amountDiff}</span>
            <span class="billing-status ${s.cls}">${s.label}</span>
          </div>
        </div>`
    }).join('')
  } catch (err) {
    console.error('Load billing error:', err)
    container.innerHTML = '<div class="billing-empty">鍔犺浇澶辫触</div>'
  }
}


async function loadSubscriptionCreditCenter(container) {
  try {
    const res = await api.get('/api/referrals/me')
    if (!res.ok || !res.stats) {
      container.innerHTML = `<div class="billing-empty">${escapeHtml(res.error || '鍔犺浇澶辫触')}</div>`
      return
    }
    const stats = res.stats
    const recent = Array.isArray(res.recent_commissions) ? res.recent_commissions : []
    const invited = Array.isArray(res.recent_invited_users) ? res.recent_invited_users : []
    if (false) {
      if (res.mode === 'disabled') {
        container.innerHTML = '<div class="billing-empty">閭€璇疯繑浣ｅ姛鑳芥殏鏈紑鏀?/div>'
        return
      }
      container.innerHTML = `
        <div class="subscription-credit-link-card subscription-credit-disabled" data-referral-disabled="1">
          <div>
            <div class="subscription-credit-label">鎴戠殑閭€璇烽摼鎺?/div>
            <div class="subscription-credit-link">姝ｅ紡寮€鏀惧悗鐢熸垚涓撳睘閭€璇烽摼鎺?/div>
          </div>
          <button class="btn btn-primary btn-sm" id="copyReferralLink" disabled>澶嶅埗閾炬帴</button>
        </div>
        <div class="subscription-credit-preview-note">
          <strong>閭€璇疯繑浣ｅ姛鑳藉嵆灏嗗紑鏀?/strong>
          <span>褰撳墠浠呭睍绀哄姛鑳借鏄庯紝鏆傛湭寮€鏀句娇鐢ㄣ€傛寮忓紑鏀惧悗锛屽彲閫氳繃閭€璇峰ソ鍙嬭幏寰楄繑浣ｅ鍔便€?/span>
        </div>
        <div class="subscription-credit-grid">
          <div class="subscription-credit-stat"><span>閭€璇蜂汉鏁?/span><strong>0</strong></div>
          <div class="subscription-credit-stat"><span>浠樿垂閭€璇?/span><strong>0</strong></div>
          <div class="subscription-credit-stat"><span>寰呯‘璁よ繑浣?/span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>鍙敤杩斾剑</span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>澶勭悊涓繑浣?/span><strong>$0.00</strong></div>
          <div class="subscription-credit-stat"><span>宸蹭娇鐢ㄨ繑浣?/span><strong>$0.00</strong></div>
        </div>
        <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">鏈€杩戣繑浣ｈ褰?/h3><div class="billing-empty">鍔熻兘寮€鏀惧悗灞曠ず杩斾剑璁板綍</div></div>
        <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">鏈€杩戦個璇风敤鎴?/h3><div class="billing-empty">鍔熻兘寮€鏀惧悗灞曠ず閭€璇风敤鎴?/div></div>`
      container.querySelector('[data-referral-disabled]')?.addEventListener('click', () => showFormMsgProfile(res.message || '閭€璇疯繑浣ｅ姛鑳芥殏鏈紑鏀?, 'ok'))
      return
    }
    container.innerHTML = `
      <div class="subscription-credit-link-card">
        <div>
          <div class="subscription-credit-label">鎴戠殑閭€璇烽摼鎺?/div>
          <div class="subscription-credit-link" title="${escapeHtml(res.referral_link)}">${escapeHtml(res.referral_link)}</div>
        </div>
        <button class="btn btn-primary btn-sm" id="copyReferralLink">澶嶅埗閾炬帴</button>
      </div>
      <div class="subscription-credit-grid">
        <div class="subscription-credit-stat"><span>閭€璇蜂汉鏁?/span><strong>${Number(stats.invited_count || 0)}</strong></div>
        <div class="subscription-credit-stat"><span>浠樿垂閭€璇?/span><strong>${Number(stats.paid_invited_count || 0)}</strong></div>
        <div class="subscription-credit-stat"><span>寰呯‘璁よ繑浣?/span><strong>${formatMinorUsd(stats.pending_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>鍙敤杩斾剑</span><strong>${formatMinorUsd(stats.available_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>澶勭悊涓繑浣?/span><strong>${formatMinorUsd(stats.reserved_credit_cents)}</strong></div>
        <div class="subscription-credit-stat"><span>宸蹭娇鐢ㄨ繑浣?/span><strong>${formatMinorUsd(stats.used_credit_cents)}</strong></div>
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">鏈€杩戣繑浣ｈ褰?/h3>
        ${recent.length ? `<div class="subscription-credit-list">${recent.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.plan_label || '')}</strong><div class="billing-date">${formatDateTime(item.created_at) || ''} 路 ${escapeHtml(item.invited_user?.email_masked || '宸查個璇风敤鎴?)}</div></div><div class="subscription-credit-row-right"><span>${formatMinorUsd(item.amount_cents)}</span><em>${escapeHtml(item.status_label || item.status || '')}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">鏆傛棤杩斾剑璁板綍</div>'}
      </div>
      <div class="settings-card subscription-credit-inner"><h3 class="settings-card-title">鏈€杩戦個璇风敤鎴?/h3>
        ${invited.length ? `<div class="subscription-credit-list">${invited.map(item => `
          <div class="subscription-credit-row"><div><strong>${escapeHtml(item.email_masked || item.uid || '宸查個璇风敤鎴?)}</strong><div class="billing-date">${formatDateTime(item.attributed_at) || ''}</div></div><div class="subscription-credit-row-right"><span>${item.paid ? '宸茶闃? : '鏈闃?}</span><em>${formatMinorUsd(item.credit_cents)}</em></div></div>`).join('')}</div>` : '<div class="billing-empty">鏆傛棤閭€璇风敤鎴?/div>'}
      </div>`
    container.querySelector('#copyReferralLink')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(res.referral_link); showFormMsgProfile('閭€璇烽摼鎺ュ凡澶嶅埗', 'ok') }
      catch { showFormMsgProfile('澶嶅埗澶辫触锛岃鎵嬪姩澶嶅埗閾炬帴', 'err') }
    })
  } catch (err) {
    console.error('Load subscription credit center error:', err)
    container.innerHTML = '<div class="billing-empty">鍔犺浇澶辫触</div>'
  }
}

function getNotificationText(notification) {
  if (notification.type === 'reply_quote') {
    return {
      title: '鏈変汉寮曠敤浜嗕綘鐨勫洖澶?,
      subtitle: notification.meta?.excerpt || notification.postTitle || '鍘荤湅鐪嬫柊鐨勫紩鐢ㄥ唴瀹?,
    }
  }
  if (notification.type === 'system') {
    return {
      title: notification.title || '绯荤粺閫氱煡',
      subtitle: notification.message || '',
    }
  }
  return {
    title: '浣犵殑甯栧瓙鏈変簡鏂板洖澶?,
    subtitle: notification.meta?.excerpt || notification.postTitle || '鍘荤湅鐪嬫柊鐨勮璁哄唴瀹?,
  }
}

async function loadForumNotifications(container) {
  try {
    const res = await api.get('/api/notifications?limit=20')
    if (!res.ok || !Array.isArray(res.notifications)) {
      container.innerHTML = '<div class="billing-empty">鍔犺浇澶辫触</div>'
      return
    }

    state.notificationUnread = res.unreadCount || 0
    updateAuthUI()

    if (!res.notifications.length) {
      container.innerHTML = '<div class="billing-empty">鏆傛椂杩樻病鏈夎鍧涢€氱煡</div>'
      return
    }

    container.innerHTML = res.notifications.map(notification => {
      const text = getNotificationText(notification)
      return `
        <button class="forum-notification-item ${notification.isRead ? '' : 'unread'}" data-open-forum-notification="${notification.postId || ''}" data-notification-id="${notification.id}">
          <div class="forum-notification-avatar">
            ${notification.actor?.avatar ? `<img src="${escapeHtml(notification.actor.avatar)}" class="avatar-img">` : escapeHtml((notification.actor?.name || '绯?).charAt(0).toUpperCase())}
          </div>
          <div class="forum-notification-content">
            <div class="forum-notification-title">${escapeHtml(text.title)}</div>
            <div class="forum-notification-subtitle">${escapeHtml(notification.actor?.name || '绯荤粺')} 路 ${escapeHtml(text.subtitle)}</div>
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
            if (headEl) headEl.textContent = `鏈 ${state.notificationUnread}`
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
    container.innerHTML = '<div class="billing-empty">鍔犺浇澶辫触</div>'
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
    return '瀵嗙爜闀垮害闇€瑕?8-32 涓瓧绗?
  }
  if (!/[A-Z]/.test(password)) {
    return '瀵嗙爜闇€瑕佸寘鍚嚦灏戜竴涓ぇ鍐欏瓧姣?
  }
  if (!/[0-9]/.test(password)) {
    return '瀵嗙爜闇€瑕佸寘鍚嚦灏戜竴涓暟瀛?
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return '瀵嗙爜闇€瑕佸寘鍚嚦灏戜竴涓壒娈婂瓧绗?
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
    showFormMsgProfile('姝ｅ湪澶勭悊澶村儚...', 'ok')
    const compressed = await compressImage(file, 200, 0.85)
    showFormMsgProfile('姝ｅ湪涓婁紶澶村儚...', 'ok')

    try {
      await api.put('/api/profile', { avatar: compressed })
      state.user.avatar = compressed
      localStorage.setItem('ws_user', JSON.stringify(state.user))
      updateAuthUI()
      renderProfile()
      showFormMsgProfile('澶村儚宸叉洿鏂?, 'ok')
    } catch (err) {
      console.error('Avatar upload error:', err)
      showFormMsgProfile('澶村儚涓婁紶澶辫触锛岃閲嶈瘯', 'err')
    }
  }
})

// ===== Email Verification Helpers =====
const AUTH_MODE_META = {
  login_password: {
    title: '鐧诲綍',
    submitLabel: '鐧诲綍',
    codePurpose: null,
    passwordLabel: '瀵嗙爜',
    passwordPlaceholder: '璇疯緭鍏ュ瘑鐮?,
  },
  login_code: {
    title: '閭楠岃瘉鐮佺櫥褰?,
    submitLabel: '鐧诲綍',
    codePurpose: 'login',
  },
  register: {
    title: '娉ㄥ唽',
    submitLabel: '娉ㄥ唽',
    codePurpose: 'register',
    passwordLabel: '瀵嗙爜',
    passwordPlaceholder: '8-32浣嶏紝鍚ぇ鍐欏瓧姣嶃€佹暟瀛椼€佺壒娈婂瓧绗?,
    showPasswordRules: true,
    showConfirmPassword: true,
    showTos: true,
  },
  reset_password: {
    title: '蹇樿瀵嗙爜',
    submitLabel: '閲嶇疆瀵嗙爜',
    codePurpose: 'reset',
    passwordLabel: '鏂板瘑鐮?,
    passwordPlaceholder: '8-32浣嶏紝鍚ぇ鍐欏瓧姣嶃€佹暟瀛椼€佺壒娈婂瓧绗?,
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
        <a data-auth-mode="login_code">浣跨敤閭楠岃瘉鐮佺櫥褰?/a>
        <a data-auth-mode="reset_password">蹇樿瀵嗙爜</a>
      </div>
    `
  }
  if (mode === 'login_code') {
    return `
      <div class="auth-mode-links">
        <a data-auth-mode="login_password">浣跨敤瀵嗙爜鐧诲綍</a>
        <a data-auth-mode="reset_password">蹇樿瀵嗙爜</a>
      </div>
    `
  }
  if (mode === 'reset_password') {
    return `
      <div class="auth-mode-links">
        <a data-auth-mode="login_password">杩斿洖瀵嗙爜鐧诲綍</a>
        <a data-auth-mode="login_code">浣跨敤楠岃瘉鐮佺櫥褰?/a>
      </div>
    `
  }
  return ''
}

function renderAuthFooter(mode) {
  if (mode === 'register') {
    return '宸叉湁璐﹀彿锛?a data-auth-mode="login_password">绔嬪嵆鐧诲綍</a>'
  }
  return '杩樻病鏈夎处鍙凤紵<a data-auth-mode="register">绔嬪嵆娉ㄥ唽</a>'
}

async function handleSendCode() {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  const emailInput = document.getElementById('authEmail')
  const sendBtn = document.getElementById('sendCodeBtn')
  const codeGroup = document.getElementById('codeGroup')

  if (!emailInput || !emailInput.value || !emailInput.value.includes('@')) {
    showFormMsg('璇峰厛杈撳叆鏈夋晥鐨勯偖绠卞湴鍧€', 'err')
    return
  }

  if (state._codeSending) return
  state._codeSending = true
  sendBtn.textContent = '鍙戦€佷腑...'
  sendBtn.disabled = true

  try {
    const res = await api.post('/api/send-code', {
      email: emailInput.value,
      purpose: meta.codePurpose,
    })

    if (!res.ok) {
      showFormMsg(res.error || '鍙戦€佸け璐ワ紝璇风◢鍚庨噸璇?, 'err')
      sendBtn.textContent = '鍙戦€侀獙璇佺爜'
      sendBtn.disabled = false
      state._codeSending = false
      return
    }

    // Show code input group
    if (codeGroup) codeGroup.style.display = 'block'
    showFormMsg(res.message || '楠岃瘉鐮佸凡鍙戦€佸埌鎮ㄧ殑閭', 'ok')
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
        sendBtn.textContent = '閲嶆柊鍙戦€?
        sendBtn.disabled = false
        state._codeSending = false
      } else {
        sendBtn.textContent = `${state._codeCountdown}s`
      }
    }, 1000)

  } catch (err) {
    showFormMsg('缃戠粶閿欒锛岃妫€鏌ョ綉缁滃悗閲嶈瘯', 'err')
    sendBtn.textContent = '鍙戦€侀獙璇佺爜'
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
      if (codeStatus) { codeStatus.textContent = '鉁?; codeStatus.className = 'code-status code-status-ok' }
      if (codeHint) { codeHint.textContent = '閭楠岃瘉鎴愬姛'; codeHint.className = 'form-hint form-hint-ok' }
    } else {
      state._emailVerified = false
      state._verifyToken = null
      if (codeStatus) { codeStatus.textContent = '鉁?; codeStatus.className = 'code-status code-status-err' }
      if (codeHint) { codeHint.textContent = res.error || '楠岃瘉鐮侀敊璇?; codeHint.className = 'form-hint form-hint-err' }
    }
  } catch (err) {
    console.error('Verify error:', err)
    state._emailVerified = false
    state._verifyToken = null
    if (codeStatus) { codeStatus.textContent = '鉁?; codeStatus.className = 'code-status code-status-err' }
    if (codeHint) { codeHint.textContent = '楠岃瘉澶辫触锛岃閲嶈瘯'; codeHint.className = 'form-hint form-hint-err' }
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
          <label class="form-label">閭€璇风爜</label>
          <input type="text" class="form-input auth-referral-code" value="${escapeHtml(referralCode)}" readonly aria-readonly="true" tabindex="-1">
          <p class="form-hint">璇ラ個璇风爜鏉ヨ嚜閭€璇烽摼鎺ワ紝娉ㄥ唽鍚庣敱鍚庣鑷姩褰掑洜锛屼笉鑳戒慨鏀广€?/p>
        </div>
      ` : ''}
      <div class="form-group">
        <label class="form-label">閭</label>
        ${meta.codePurpose ? `
          <div class="form-row">
            <input type="email" class="form-input" name="email" id="authEmail" required placeholder="璇疯緭鍏ラ偖绠? value="${escapeHtml(prefillEmail)}">
            <button type="button" class="btn-send-code" id="sendCodeBtn">鍙戦€侀獙璇佺爜</button>
          </div>
        ` : `
          <input type="email" class="form-input" name="email" id="authEmail" required placeholder="璇疯緭鍏ラ偖绠? value="${escapeHtml(prefillEmail)}">
        `}
      </div>
      ${mode === 'register' ? `
        <div class="form-group">
          <label class="form-label">鏄电О</label>
          <input type="text" class="form-input" name="nickname" id="authNickname" placeholder="缁欒嚜宸卞彇涓悕瀛楋紙閫夊～锛?>
        </div>
      ` : ''}
      ${meta.codePurpose ? `
        <div class="form-group" id="codeGroup" style="display:none">
          <label class="form-label">楠岃瘉鐮?/label>
          <div class="code-input-wrap">
            <input type="text" class="form-input form-input-code" name="code" placeholder="璇疯緭鍏?浣嶉獙璇佺爜" maxlength="6" inputmode="numeric" id="codeInput" autocomplete="one-time-code">
            <span class="code-status" id="codeStatus"></span>
          </div>
          <p class="form-hint" id="codeHint"></p>
        </div>
      ` : ''}
      ${meta.passwordLabel ? `
        <div class="form-group">
          <label class="form-label">${meta.passwordLabel}</label>
          <input type="password" class="form-input" name="password" ${mode === 'login_password' ? 'required' : ''} placeholder="${meta.passwordPlaceholder}">
          ${meta.showPasswordRules ? '<p class="form-hint pwd-rules" id="pwdRules">闇€鍖呭惈锛氬ぇ鍐欏瓧姣嶃€佹暟瀛椼€佺壒娈婂瓧绗︼紙濡?!@#$%锛?/p>' : ''}
        </div>
      ` : ''}
      ${meta.showConfirmPassword ? `
        <div class="form-group">
          <label class="form-label">纭瀵嗙爜</label>
          <input type="password" class="form-input" name="confirmPassword" required placeholder="璇峰啀娆¤緭鍏ュ瘑鐮?>
        </div>
      ` : ''}
      ${meta.showTos ? `
        <label class="tos-check">
          <input type="checkbox" id="tosAgree">
          <span>鎴戝凡闃呰骞跺悓鎰?<a class="tos-link" id="openTos">銆婄敤鎴锋湇鍔″崗璁€?/a></span>
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

}

// ===== Trade Records View =====
function renderTrades() {
  const adminUser = isAdmin()
  // UI-only flag: server independently verifies before returning any data


  const tradeTimeline = [
    { date: '2025骞?0鏈堝簳', text: '榛勯噾3900鐪嬫定4240锛屽畬缇庛€?, links: ['https://t.co/EQi8J3DsVT'], result: 'win' },
    { date: '2025骞?0鏈堝簳', text: '4240鍋氱┖4280姝㈡崯锛屽悗缁?400-5500涓诲崌娴笍绌恒€?, links: [], result: 'loss' },
    { date: '2026骞?鏈堝簳', text: '鐧介摱99鍒€鏃舵槑纭彂鏂囦笉鑳戒拱鍏ラ粍閲戠櫧閾讹紝鐧介摱2骞村唴瑕佸洖鍒?0銆?, links: ['https://t.co/FhjDzyxqxj'], result: 'win' },
    { date: '2026骞?鏈堝簳', text: '鎵嬫妸鎵?18鍋氱┖鐧介摱锛岀泩鍒?0涓囧垁銆?, links: ['https://t.co/Ufd06Tmol8', 'https://t.co/88zb1axEGn', 'https://t.co/jzMJM35nvp'], result: 'win' },
    { date: '2026骞?鏈?鏃?, text: '杞悜榛勯噾澶氬ご锛岃涓鸿鍙嶅脊鍒癡WAP锛屽埌浣嶅钩澶氥€?, links: ['https://t.co/TwZ8EZK7lD', 'https://t.co/FXmGZxeFcA'], result: 'win' },
    { date: '2026骞?鏈?鏃?, text: '鍒昏垷姹傚墤瀵绘壘鐧介摱78-88锛岄粍閲?100-5300鏈轰細銆?, links: ['https://t.co/Szd8T1is5e', 'https://t.co/QEgqVRSYWQ', 'https://t.co/uQVOStHBkK', 'https://t.co/jpeMotHR3L'], result: 'win' },
    { date: '2026骞?鏈堝垵', text: '閰嶅悎鏈哄櫒浜?0绌哄埌79.9骞崇┖锛屼竴鎶?0涓囧垁鐩堝埄銆?, links: ['https://t.co/XdiBkFUs1H', 'https://t.co/Eeam1LziQG', 'https://t.co/zBug0ki4hk'], result: 'win' },
    { date: '2026骞?鏈堜腑鏃?, text: '榛勯噾鐮翠綅锛岀湅绌?050鍒?791銆備腑闂?619鎶勫簳涓€娆℃鎹熴€?, links: ['https://t.co/FQUfUfj5iq', 'https://t.co/QJV6FztXKZ', 'https://t.co/31S3phsofJ'], result: 'win' },
    { date: '2026骞?鏈?2鏃?, text: '榛勯噾4550鐨勬椂鍊欒涓轰笅璺岀骇鍒斁澶э紝鍒ゆ柇瑕佸幓4180-4250锛屾墜鎶婃墜甯︾潃鍦?150鎶勫簳锛岃涓烘湭鏉ヤ細閲嶅洖4800-5000銆?, links: ['https://t.co/oJzzusqsSv', 'https://t.co/tiobsJUH73', 'https://t.co/w0LVe24WJW', 'https://t.co/rCJ5uqLP0F', 'https://t.co/37cgAAezUm'], result: 'win' },
    { date: '2026骞?鏈?5鏃?, text: '榛勯噾涓婃定鍒?580锛屽崠鍑?200涔扮殑绾搁粍閲戝拰鏉犳潌锛岄檮瑙嗛瑙ｆ瀽+鏈潵閲嶅洖4800-5000灞曟湜銆?, links: ['https://t.co/yCimZeBZfd', 'https://t.co/JZUJLVxHX4'], result: 'win' },
    { date: '-', text: 'TRUMP鐖嗘媺50%锛屾彁鍓嶅垽鏂苟鍙備笌銆?, links: ['https://t.co/0DuoMRA32f', 'https://t.co/9AJNoHF7YD'], result: 'win' },
  ]

  const wins = tradeTimeline.filter(t => t.result === 'win').length
  const losses = tradeTimeline.filter(t => t.result === 'loss').length

  mainContent.innerHTML = `
    <div class="trades-page fade-in">
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>

      <div class="trades-header">
        <h1 class="trades-title">馃搳 琛楀摜鍘嗗彶鎴樼哗</h1>
        <p class="trades-subtitle">浠ヤ笅鍐呭鏁寸悊鑷鍝ュ湪鎺ㄧ壒 X 鍏紑鍙戝竷鐨勪氦鏄撹鐐广€佹搷浣滄€濊矾銆佸疄鐩樿棰戜笌閮ㄥ垎鎴樼哗璁板綍銆?br>杩欎簺鍐呭鍙戝竷鏃堕棿鏃╀簬閮ㄥ垎琛屾儏楠岃瘉鑺傜偣锛岃兘澶熷府鍔╂柊鐢ㄦ埛鏇寸洿瑙傚湴浜嗚В琛楀摜鐨勫垎鏋愭鏋躲€佹墽琛岃兘鍔涘拰浜ゆ槗椋庢牸銆?br>缃戠珯鐨勬剰涔夊緢鏄庣‘锛?br>鎶婂師鏈垎鏁ｅ湪鍏紑骞冲彴涓婄殑瑙嗛鎬濊矾銆佺粡楠屻€佸鐩橈紝绯荤粺鍖栧湴鏁寸悊鍑烘潵锛屾彁渚涚粰鐪熸鏈夐渶瑕佺殑浜恒€?br>浣犱负鏈嶅姟浠樿垂锛屾垜鎻愪緵琛屾儏鎬濊矾锛屼负璁ょ煡鎻愬崌璐熻矗锛屼负浜ゆ槗鎵ц闂鎻愪緵甯姪銆?/p>
      </div>

      <div class="trades-stats">
        <div class="trades-stat-card">
          <div class="trades-stat-num">${tradeTimeline.length}</div>
          <div class="trades-stat-label">鍏紑浜ゆ槗</div>
        </div>
        <div class="trades-stat-card win">
          <div class="trades-stat-num">${wins}</div>
          <div class="trades-stat-label">鐩堝埄</div>
        </div>
        <div class="trades-stat-card loss">
          <div class="trades-stat-num">${losses}</div>
          <div class="trades-stat-label">浜忔崯</div>
        </div>
        <div class="trades-stat-card rate">
          <div class="trades-stat-num">${Math.round(wins / tradeTimeline.length * 100)}%</div>
          <div class="trades-stat-label">鑳滅巼</div>
        </div>
      </div>

      <div class="trades-section">
        <h2 class="trades-section-title">浜ゆ槗鏃堕棿绾?/h2>
        <p class="trades-section-desc">鍘诲勾10鏈堝彂鐜板竵鍦堣蛋鐔婏紝娴佸姩鎬ф瀬宸紝榛勯噾鐧介摱澶勪簬涓诲崌娴粨鏉熺殑绗竴娈垫毚璺岋紝璧勯噾娌¤蛋瀛曡偛鐫€宸ㄥぇ鏈轰細锛屽紑濮嬭浆鍚戣吹閲戝睘銆?/p>
        <div class="trades-timeline">
          ${tradeTimeline.map(t => `
            <div class="timeline-item ${t.result}">
              <div class="timeline-dot"></div>
              <div class="timeline-content">
                <div class="timeline-date">${t.date}</div>
                <div class="timeline-text">${escapeHtml(t.text)}</div>
                ${t.links.length > 0 ? `<div class="timeline-links">${t.links.map((l, i) => `<a href="${escapeHtml(l)}" target="_blank" rel="noopener noreferrer">澶嶇洏閾炬帴${t.links.length > 1 ? i + 1 : ''}</a>`).join(' ')}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="trades-section">
        <h2 class="trades-section-title">MT5 浜ゆ槗鎶ュ憡</h2>
        <p class="trades-section-desc">浠ヤ笅涓?MT5 瀹炵洏浜ゆ槗鎶ュ憡鎴浘锛屽寘鍚畬鏁翠氦鏄撹褰曘€?/p>
        <div class="trades-reports">
          <div class="trades-report-img">
            <img src="/trades/report1.jpeg" alt="MT5浜ゆ槗鎶ュ憡1" loading="lazy">
          </div>
          <div class="trades-report-img">
            <img src="/trades/report2.jpeg" alt="MT5浜ゆ槗鎶ュ憡2" loading="lazy">
          </div>
        </div>
      </div>

      ${adminUser ? `
        <div class="trades-section">
          <h2 class="trades-section-title">绠＄悊锛氭坊鍔犳垬缁╄褰?/h2>
          <div class="trades-admin-form" id="tradesAdminForm" style="display:none">
            <div class="trades-form-grid">
              <input type="date" id="tradeDate" class="trades-input" required>
              <input type="text" id="tradeSymbol" class="trades-input" placeholder="鏍囩殑锛圔TC/GOLD/ETH锛?>
              <select id="tradeDirection" class="trades-input">
                <option value="long">鍋氬 Long</option>
                <option value="short">鍋氱┖ Short</option>
              </select>
              <select id="tradeResult" class="trades-input">
                <option value="win">鐩堝埄</option>
                <option value="loss">浜忔崯</option>
              </select>
              <input type="text" id="tradeEntry" class="trades-input" placeholder="鍏ュ満浠?>
              <input type="text" id="tradeExit" class="trades-input" placeholder="鍑哄満浠?>
              <input type="text" id="tradeProfit" class="trades-input" placeholder="鐩堜簭姣斾緥锛堝 +12.5%锛?>
              <input type="text" id="tradeScreenshot" class="trades-input" placeholder="鎴浘閾炬帴锛堝彲閫夛級">
            </div>
            <input type="text" id="tradeNotes" class="trades-input" placeholder="澶囨敞锛堝彲閫夛級" style="width:100%;margin-top:8px">
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="btn btn-primary" id="submitTrade">娣诲姞</button>
              <button class="btn btn-ghost" id="cancelAddTrade">鍙栨秷</button>
            </div>
          </div>
          <button class="btn btn-primary" id="showAddTrade">+ 娣诲姞鎴樼哗</button>
          <div class="trades-list" id="tradesList" style="margin-top:16px">
            <div class="loading-spinner">鍔犺浇涓?..</div>
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
      btn.disabled = true; btn.textContent = '鎻愪氦涓?..'
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
      if (!data.trade_date || !data.symbol) { alert('璇峰～鍐欐棩鏈熷拰鏍囩殑'); btn.disabled = false; btn.textContent = '娣诲姞'; return }
      const res = await api.post('/api/trades', data)
      if (res.ok) {
        document.getElementById('tradesAdminForm').style.display = 'none'
        document.getElementById('showAddTrade').style.display = 'block'
        loadTradeRecords()
      } else { alert(res.error || '娣诲姞澶辫触') }
      btn.disabled = false; btn.textContent = '娣诲姞'
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
          <div class="trades-stat-label">鎬讳氦鏄?/div>
        </div>
        <div class="trades-stat-card win">
          <div class="trades-stat-num">${wins}</div>
          <div class="trades-stat-label">鐩堝埄</div>
        </div>
        <div class="trades-stat-card loss">
          <div class="trades-stat-num">${losses}</div>
          <div class="trades-stat-label">浜忔崯</div>
        </div>
        <div class="trades-stat-card rate">
          <div class="trades-stat-num">${winRate}%</div>
          <div class="trades-stat-label">鑳滅巼</div>
        </div>
      `
    }

    if (trades.length === 0) {
      listEl.innerHTML = '<div class="comments-empty">鏆傛棤浜ゆ槗璁板綍</div>'
      return
    }

    const adminUser = isAdmin()
    listEl.innerHTML = trades.map(t => `
      <div class="trade-row ${escapeHtml(t.result)}">
        <div class="trade-date">${escapeHtml(t.trade_date)}</div>
        <div class="trade-symbol">${escapeHtml(t.symbol)}</div>
        <div class="trade-direction ${escapeHtml(t.direction)}">${t.direction === 'long' ? '鍋氬' : '鍋氱┖'}</div>
        <div class="trade-prices">
          ${t.entry_price ? `<span class="trade-entry">鍏?${escapeHtml(t.entry_price)}</span>` : ''}
          ${t.exit_price ? `<span class="trade-exit">鍑?${escapeHtml(t.exit_price)}</span>` : ''}
        </div>
        <div class="trade-profit ${escapeHtml(t.result)}">${escapeHtml(t.profit_pct) || '-'}</div>
        <div class="trade-result ${escapeHtml(t.result)}">${t.result === 'win' ? '鉁?鐩堝埄' : '鉂?浜忔崯'}</div>
        ${t.notes ? `<div class="trade-notes">${escapeHtml(t.notes)}</div>` : ''}
        ${t.screenshot_url ? `<a class="trade-screenshot" href="${escapeHtml(t.screenshot_url)}" target="_blank" rel="noopener noreferrer">馃摳 鏌ョ湅鎴浘</a>` : ''}
        ${adminUser ? `<button class="btn btn-ghost btn-xs trade-del-btn" data-trade-id="${t.id}" style="color:#ef4444">鍒犻櫎</button>` : ''}
      </div>
    `).join('')

    // Admin delete handlers
    listEl.querySelectorAll('.trade-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('纭畾鍒犻櫎锛?)) return
        btn.disabled = true
        const r = await api.del(`/api/trades?id=${btn.dataset.tradeId}`)
        if (r.ok) loadTradeRecords()
        else { alert('鍒犻櫎澶辫触'); btn.disabled = false }
      })
    })
  } catch (err) {
    console.error('Load trades error:', err)
    listEl.innerHTML = '<div class="comments-empty">鍔犺浇澶辫触</div>'
  }
}

// ===== Community View =====
const boardMap = {
  ideas: '閲戣瀺鎬濊矾鍒嗕韩',
  review: '鏍囩殑澶嶇洏',
  discussion: '浜ゆ祦浜掔浉甯姪',
}
const forumSortOptions = [
  { key: 'active', label: '鏈€鏂板洖澶? },
  { key: 'newest', label: '鏈€鏂板彂甯? },
  { key: 'hot', label: '鏈€鐑? },
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
  if (diff < 60 * 1000) return '鍒氬垰'
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))} 鍒嗛挓鍓峘
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 3600000))} 灏忔椂鍓峘
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 86400000))} 澶╁墠`
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
  if (user.isAdmin) return `<span class="forum-role-badge admin ${compact ? 'compact' : ''}">绠＄悊鍛?/span>`
  const plan = getEffectivePlan(user)
  if (plan === 'pro') return `<span class="plan-badge pro ${compact ? 'compact' : ''}">Pro</span>`
  if (plan === 'plus') return `<span class="plan-badge plus ${compact ? 'compact' : ''}">Plus</span>`
  return `<span class="forum-role-badge free ${compact ? 'compact' : ''}">鎴愬憳</span>`
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
    <div class="forum-participants" title="鏈€杩戝弬涓庤€?>
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
  if (post.isSticky) badges.push('<span class="forum-label sticky">缃《</span>')
  if (post.isFeatured) badges.push('<span class="forum-label featured">绮惧崕</span>')
  if (post.isLocked || post.threadLocked) badges.push('<span class="forum-label locked">閿佸笘</span>')
  badges.push(`<span class="forum-label board">${escapeHtml(boardMap[post.board] || '绀惧尯')}</span>`)
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
  items.push(`<button class="page-btn page-btn-nav" ${prevPage ? `${dataAttr}="${prevPage}"` : 'disabled'}>涓婁竴椤?/button>`)
  let lastPage = 0
  for (const page of pages) {
    if (lastPage && page - lastPage > 1) items.push('<span class="page-ellipsis">鈥?/span>')
    items.push(`<button class="page-btn ${page === currentPage ? 'active' : ''}" ${dataAttr}="${page}">${page}</button>`)
    lastPage = page
  }
  const nextPage = currentPage < totalPages ? currentPage + 1 : null
  items.push(`<button class="page-btn page-btn-nav" ${nextPage ? `${dataAttr}="${nextPage}"` : 'disabled'}>涓嬩竴椤?/button>`)
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
      <div class="reply-quote-box-meta">寮曠敤 #${state.replyQuote.floorNumber} 路 ${escapeHtml(state.replyQuote.user?.name || '鍖垮悕鐢ㄦ埛')}</div>
      <div class="reply-quote-box-text">${escapeHtml(state.replyQuote.text || '').replace(/\n/g, '<br>')}</div>
    </div>
    <button type="button" class="reply-quote-box-close" id="clearReplyQuote" aria-label="鍙栨秷寮曠敤">脳</button>
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
      <button class="back-btn" id="backHome">鈫?杩斿洖璇剧▼鍒楄〃</button>
      <div class="community-header forum-header">
        <div>
          <div class="forum-header-kicker">浼氬憳鐗堣创鍚?/div>
          <h1 class="community-title">馃挰 浜ゆ槗璁ㄨ鍖?/h1>
          <p class="community-subtitle">鏇撮珮淇℃伅瀵嗗害銆佹洿鍍忔ゼ灞傜殑鍥炲銆佹洿鍍忕ぞ鍖虹殑璁ㄨ姘涘洿銆?/p>
        </div>
        <div class="forum-header-meta">
          <div class="forum-header-stat">
            <span class="forum-header-stat-num">${state.communityTotal || '鈥?}</span>
            <span class="forum-header-stat-label">褰撳墠鏉垮潡甯栧瓙</span>
          </div>
          <div class="forum-header-stat">
            <span class="forum-header-stat-num">${state.communitySort === 'hot' ? '鐑' : state.communitySort === 'newest' ? '鏂板笘' : '娲昏穬'}</span>
            <span class="forum-header-stat-label">褰撳墠鎺掑簭</span>
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
              placeholder="鎼滅储鏍囬鎴栨鏂囨憳瑕?
              value="${escapeHtml(state.communityQuery)}"
              maxlength="40"
            >
            <button class="forum-search-btn" type="submit">鎼滅储</button>
          </form>
        </div>
        <div class="forum-filter-row">
          <button class="forum-tag-filter ${!state.communityTag ? 'active' : ''}" data-tag-filter="">鍏ㄩ儴璇濋</button>
          ${state.communityTags.map(tag => `
            <button class="forum-tag-filter ${state.communityTag === tag.slug ? 'active' : ''}" data-tag-filter="${escapeHtml(tag.slug)}">
              #${escapeHtml(tag.label)} <span>${tag.count || 0}</span>
            </button>
          `).join('')}
        </div>
      </div>
      ${isPaid() ? `
        <div class="community-create forum-create-box">
          <button class="btn btn-primary" id="showCreatePost">鉁忥笍 鍙戝竷鏂板笘</button>
          <div class="forum-create-copy">鏀寔瀵屾枃鏈€佹爣绛惧拰鏈€澶?${MAX_POST_IMAGES} 寮犲浘鐗?/div>
        </div>
        <div class="create-post-form" id="createPostForm" style="display:none">
          <div class="forum-create-head">
            <div>
              <div class="forum-create-title">鏂板缓涓婚</div>
              <div class="forum-create-subtitle">鎶婁綘鐨勪氦鏄撹鐐广€佸鐩樺拰闂鍐欐垚涓€涓洿鍍忚鍧涚殑甯栧瓙</div>
            </div>
            <div class="forum-create-identity">${renderIdentityBadge(state.user)}</div>
          </div>
          <input type="text" class="post-title-input" id="postTitleInput" placeholder="甯栧瓙鏍囬锛屽敖閲忓叿浣撲竴鐐? maxlength="200">
          <input type="text" class="post-title-input post-tags-input" id="postTagsInput" placeholder="鏍囩锛岄€楀彿鍒嗛殧锛屼緥濡傦細榛勯噾, 姣旂壒甯? 鐭嚎" maxlength="60">
          <div class="post-editor-shell">
            <div id="postEditor" class="post-editor"></div>
          </div>
          <div class="post-editor-meta">
            <span class="post-editor-hint">鏀寔鏍囬銆佸紩鐢ㄣ€佸垪琛ㄣ€侀摼鎺ュ拰鍥剧墖锛屾渶澶?${MAX_POST_IMAGES} 寮犲浘</span>
            <span class="post-editor-hint">鍗曞紶鍥剧墖涓嶈秴杩?5MB</span>
          </div>
          <div class="create-post-actions">
            <button class="btn btn-ghost" id="cancelCreatePost">鍙栨秷</button>
            <button class="btn btn-primary" id="submitPost">鍙戝竷</button>
          </div>
        </div>
      ` : ''}
      <div class="community-posts-list" id="communityPostsList">
        <div class="loading-spinner">鍔犺浇涓?..</div>
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
        <div class="forum-empty-icon">馃У</div>
        <div class="forum-empty-title">杩欎釜鏉垮潡鏆傛椂杩樻病鏈夌鍚堟潯浠剁殑甯栧瓙</div>
        <div class="forum-empty-desc">${state.communityQuery || state.communityTag ? '鎹釜鍏抽敭璇嶆垨璇濋璇曡瘯锛屾垨鑰呯洿鎺ュ彂绗竴绡囥€? : '鐜板湪鍙戜竴绡囷紝璁╄璁虹湡姝ｅ姩璧锋潵銆?}</div>
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
            <div class="forum-thread-last-active">鏈€鍚庢椿璺?${formatRelativeTime(post.lastRepliedAt)}</div>
          </div>
          <h3 class="post-card-title forum-thread-title">${escapeHtml(post.title)}</h3>
          <p class="post-card-preview forum-thread-preview">${escapeHtml(post.preview || '')}</p>
          <div class="forum-thread-meta">
            <div class="forum-thread-authorline">
              ${renderForumAvatar(post.user, 'forum-thread-avatar')}
              <div class="forum-thread-authorinfo">
                <div class="forum-thread-authorname">${escapeHtml(post.user.name)} ${renderIdentityBadge(post.user, { compact: true })}</div>
                <div class="forum-thread-authorsub">鍙戣〃浜?${formatDateTime(post.createdAt)}${post.lastReplyUser ? ` 路 鏈€鍚庡洖澶?${escapeHtml(post.lastReplyUser.name)}` : ''}</div>
              </div>
            </div>
            ${renderParticipantAvatars(post.participants || [])}
          </div>
        </div>
        <div class="forum-thread-stats">
          <div class="forum-thread-stat"><span>鍥炲</span><strong>${post.replyCount || 0}</strong></div>
          <div class="forum-thread-stat"><span>娴忚</span><strong>${post.viewCount || 0}</strong></div>
          <div class="forum-thread-stat"><span>鍥剧墖</span><strong>${post.imageCount || 0}</strong></div>
          ${post.canDelete ? `<button class="post-delete-btn forum-delete-btn" data-delete-post="${post.id}" title="鍒犻櫎甯栧瓙">鍒犻櫎</button>` : ''}
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
            ${reply.canDelete ? `<button class="reply-delete-btn" data-delete-reply="${reply.id}" title="鍒犻櫎">鉁?/button>` : ''}
          </div>
        </div>
        ${reply.quote ? `
          <button class="forum-floor-quote" data-quote-reply="${reply.quote.id}">
            <span class="forum-floor-quote-label">寮曠敤 #${reply.quote.floorNumber}</span>
            <span class="forum-floor-quote-text">${escapeHtml(reply.quote.user?.name || '')}锛?{escapeHtml(reply.quote.text || '')}</span>
          </button>
        ` : ''}
        <div class="reply-body ${reply.contentHtml ? 'reply-body-rich post-detail-content-rich' : ''}">
          ${reply.contentHtml || escapeHtml(reply.content || '').replace(/\n/g, '<br>')}
        </div>
        <div class="forum-floor-actions">
          <button class="forum-floor-action" data-open-reply-quote="${reply.id}">寮曠敤</button>
          <button class="forum-floor-action" data-report-reply="${reply.id}">涓炬姤</button>
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
      <button class="back-btn" id="backCommunity">鈫?杩斿洖绀惧尯</button>
      <div class="loading-spinner">鍔犺浇涓?..</div>
    </div>
  `

  try {
    const res = await api.get(`/api/posts?id=${state.currentPost}`)
    const post = res.post
    state.currentPostData = post || null
    if (!post) {
      mainContent.innerHTML = `
        <div class="post-page fade-in">
          <button class="back-btn" id="backCommunity">鈫?杩斿洖绀惧尯</button>
          <div class="community-empty">甯栧瓙涓嶅瓨鍦?/div>
        </div>`
      return
    }

    const locked = post.locked
    const paid = isPaid()
    const richContent = (!locked || paid) && post.contentFormat === 'rich'

    mainContent.innerHTML = `
      <div class="post-page forum-thread-page fade-in">
        <button class="back-btn" id="backCommunity">鈫?杩斿洖绀惧尯</button>
        <div class="post-detail-card forum-thread-detail">
          <div class="forum-thread-detail-top">
            <div class="forum-thread-badges">${renderThreadBadges(post)}</div>
            <div class="forum-thread-detail-tags">${renderForumTags(post.tags || [])}</div>
          </div>
          <div class="post-detail-header forum-thread-detail-header">
            ${renderForumAvatar(post.user, 'forum-thread-detail-avatar')}
            <div class="post-card-meta forum-thread-detail-meta">
              <span class="post-card-author">${escapeHtml(post.user.name)} ${renderIdentityBadge(post.user)}</span>
              <span class="post-card-time">鍙戝竷浜?${formatDateTime(post.createdAt)}${post.lastRepliedAt ? ` 路 鏈€鍚庢椿璺?${formatRelativeTime(post.lastRepliedAt)}` : ''}</span>
            </div>
            <div class="forum-thread-detail-participants">${renderParticipantAvatars(post.participants || [])}</div>
          </div>
          <div class="forum-thread-detail-stats">
            <span class="forum-thread-stat-pill">鍥炲 ${post.replyCount || 0}</span>
            <span class="forum-thread-stat-pill">娴忚 ${post.viewCount || 0}</span>
            <span class="forum-thread-stat-pill">鍥剧墖 ${post.imageCount || 0}</span>
          </div>
          <div class="forum-thread-detail-actions">
            <button class="forum-action-btn" data-post-report="${post.id}">涓炬姤</button>
            ${post.canModerate ? `
              <button class="forum-action-btn admin ${post.isSticky ? 'active' : ''}" data-post-pin="${post.id}" data-next-pin="${post.isSticky ? '0' : '1'}">${post.isSticky ? '鍙栨秷缃《' : '缃《'}</button>
              <button class="forum-action-btn admin ${post.isFeatured ? 'active' : ''}" data-post-feature="${post.id}" data-next-feature="${post.isFeatured ? '0' : '1'}">${post.isFeatured ? '鍙栨秷绮惧崕' : '璁句负绮惧崕'}</button>
              <button class="forum-action-btn admin ${post.threadLocked ? 'active' : ''}" data-post-lock="${post.id}" data-next-lock="${post.threadLocked ? '0' : '1'}">${post.threadLocked ? '瑙ｉ攣涓婚' : '閿佸畾涓婚'}</button>
            ` : ''}
            ${post.canDelete ? `<button class="post-delete-detail-btn" data-delete-post="${post.id}">鍒犻櫎甯栧瓙</button>` : ''}
          </div>
          <h1 class="post-detail-title">${escapeHtml(post.title)}</h1>
          <div class="post-detail-body-wrap">
            ${locked && !paid ? `
              <div class="post-blur-content">${escapeHtml(post.preview || '姝ゅ唴瀹逛粎闄愪粯璐逛細鍛樻煡鐪?..').replace(/\n/g, '<br>')}</div>
              <div class="post-paywall-overlay">
                <div class="post-paywall-box">
                  <div class="post-paywall-icon">馃敀</div>
                  <h3>浠呴檺浠樿垂浼氬憳鏌ョ湅</h3>
                  <p>鍗囩骇浼氬憳瑙ｉ攣鍏ㄩ儴绀惧尯鍐呭</p>
                  <button class="btn btn-primary" id="goUpgradeCommunity">鍗囩骇浼氬憳</button>
                </div>
              </div>
            ` : `
              <div class="post-detail-content ${richContent ? 'post-detail-content-rich' : ''}" id="${richContent ? 'postRichContent' : ''}">${richContent ? (post.contentHtml || '') : escapeHtml(post.content || '').replace(/\n/g, '<br>')}</div>
            `}
          </div>
        </div>
        ${locked && !paid ? `
          <div class="post-replies-section post-replies-locked">
            <h3 class="replies-title">鍥炲</h3>
            <p class="reply-login-hint">${state.user ? '鍗囩骇浠樿垂浼氬憳鍚庡彲鏌ョ湅鍥炲骞跺弬涓庤璁? : '鐧诲綍骞跺崌绾т細鍛樺悗鍙煡鐪嬪洖澶嶄笌鍙備笌璁ㄨ'}</p>
            <div class="reply-locked-actions">
              ${state.user ? '' : '<button class="btn btn-ghost btn-sm" id="commentLoginBtn">鐧诲綍</button>'}
              <button class="btn btn-primary btn-sm" id="goUpgradeCommunityReplies">鍗囩骇浼氬憳</button>
            </div>
          </div>
        ` : `
          <div class="post-replies-section">
            <div class="forum-replies-head">
              <div>
                <h3 class="replies-title">鍏ㄩ儴鍥炲</h3>
                <p class="forum-replies-subtitle">${post.threadLocked ? '褰撳墠涓婚宸查攣甯栵紝鍙兘闃呰鍘嗗彶鍥炲銆? : '鎸夋ゼ灞傞『搴忔煡鐪嬶紝姣忎竴灞傞兘鍍忕湡姝ｈ鍧涢噷閭ｆ牱鍙紩鐢ㄣ€佸彲甯﹀浘銆?}</p>
              </div>
              <div class="forum-replies-summary">${post.replyCount || 0} 妤?/div>
            </div>
            <div id="repliesList" class="replies-list"><div class="replies-loading">鍔犺浇鍥炲涓?..</div></div>
            <div class="community-pagination reply-pagination" id="replyPagination"></div>
            ${paid && !post.threadLocked ? `
              <div class="reply-input-wrap">
                <textarea id="replyInput" class="reply-textarea" placeholder="鍐欎笅浣犵殑鍥炲锛屽彲闄勪笂鍥剧墖..." rows="3"></textarea>
                <div id="replyQuoteBox" class="reply-quote-box" style="display:none"></div>
                <div class="reply-toolbar">
                  <button type="button" class="btn btn-ghost btn-sm" id="replyImageBtn">娣诲姞鍥剧墖</button>
                  <span class="reply-toolbar-hint">鍙坊鍔犲寮犲浘鐗囷紝鍗曞紶涓嶈秴杩?5MB</span>
                  <input type="file" id="replyImageInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
                </div>
                <div id="replyImageList" class="reply-image-list"></div>
                <div class="reply-input-footer">
                  <span class="reply-char-count" id="replyCharCount">0 瀛?路 0 鍥?/span>
                  <button class="btn btn-primary btn-sm" id="submitReplyBtn">鍙戝竷鍥炲</button>
                </div>
              </div>
            ` : `<p class="reply-login-hint">${post.threadLocked ? '甯栧瓙宸查攣瀹氾紝褰撳墠涓嶆帴鍙楁柊鍥炲' : (state.user ? '鍗囩骇浠樿垂浼氬憳鍙備笌鍥炲' : '鐧诲綍鍚庡弬涓庡洖澶?)}</p>`}
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
          listEl.innerHTML = '<p class="replies-empty">鏆傛棤鍥炲锛屾潵鍙戣〃绗竴鏉″洖澶嶅惂</p>'
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
        if (listEl) listEl.innerHTML = '<p class="replies-empty">鍔犺浇鍥炲澶辫触</p>'
      }

      renderReplyDraftImages()
      updateReplyComposerMeta()
      renderReplyQuoteComposer()
    }
  } catch (err) {
    console.error('Load post error:', err)
    mainContent.innerHTML = `
      <div class="post-page fade-in">
        <button class="back-btn" id="backCommunity">鈫?杩斿洖绀惧尯</button>
        <div class="community-empty">鍔犺浇澶辫触锛岃绋嶅悗閲嶈瘯</div>
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
    marketToggle.setAttribute('aria-label', isOpen ? '鍏抽棴鑲＄エ甯傚満鐮旂┒鑿滃崟' : '鎵撳紑鑲＄エ甯傚満鐮旂┒鑿滃崟')
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
  bindProtectedMarketNav('#navAiBubble', '/ai娉℃搏鍛ㄦ姤/')
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
  $('#navAI').addEventListener('click', (e) => {
    e.preventDefault()
    if (!requireLogin()) return
    const token = localStorage.getItem('ws_token')
    const url = `/ai?token=${encodeURIComponent(token)}`
    window.open(url, '_blank')
  })

  $('#loginBtn').addEventListener('click', () => showAuthModal('login_password'))
  $('#registerBtn').addEventListener('click', () => showAuthModal('register'))
  $('#adminBtn').addEventListener('click', () => navigate('admin'))

  // User dropdown menu 鈥?click to toggle, click elsewhere to close
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
    if (dropdownIcon) dropdownIcon.textContent = dark ? '鈽€锔? : '馃寵'
    if (dropdownLabel) dropdownLabel.textContent = dark ? '娴呰壊妯″紡' : '娣辫壊妯″紡'
    if (headerIcon) headerIcon.textContent = dark ? '鈽€锔? : '馃寵'
    if (headerLabel) headerLabel.textContent = dark ? '娴呰壊' : '娣辫壊'
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
    localStorage.removeItem('authToken')
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
      submitBtn.textContent = submitting ? '鎻愪氦涓?..' : getAuthModeMeta(mode).submitLabel
    }

    if (mode === 'register') {
      const tosCheck = document.getElementById('tosAgree')
      if (!tosCheck?.checked) {
        showFormMsg('璇烽槄璇诲苟鍚屾剰銆婄敤鎴锋湇鍔″崗璁€?, 'err')
        return
      }
      if (!state._emailVerified) {
        showFormMsg('璇峰厛瀹屾垚閭楠岃瘉', 'err')
        return
      }
      const pwdError = getPasswordRuleError(data.password)
      if (pwdError) {
        showFormMsg(pwdError, 'err')
        return
      }
      if (data.password !== data.confirmPassword) {
        showFormMsg('涓ゆ杈撳叆鐨勫瘑鐮佷笉涓€鑷?, 'err')
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
          showFormMsg(result.error || '娉ㄥ唽澶辫触锛岃绋嶅悗閲嶈瘯', 'err')
        }
      } catch (err) {
        showFormMsg('鏈嶅姟鍣ㄨ繛鎺ュけ璐ワ紝璇锋鏌ョ綉缁滃悗閲嶈瘯', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_password') {
      if (!data.password) {
        showFormMsg('璇疯緭鍏ュ瘑鐮?, 'err')
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
          showFormMsg(result.error || '鐧诲綍澶辫触锛岄偖绠辨垨瀵嗙爜閿欒', 'err')
        }
      } catch (err) {
        showFormMsg('鏈嶅姟鍣ㄨ繛鎺ュけ璐ワ紝璇锋鏌ョ綉缁滃悗閲嶈瘯', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'login_code') {
      if (!state._emailVerified || !state._verifyToken) {
        showFormMsg('璇峰厛瀹屾垚閭楠岃瘉', 'err')
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
          showFormMsg(result.error || '鐧诲綍澶辫触锛岃绋嶅悗閲嶈瘯', 'err')
        }
      } catch (err) {
        showFormMsg('鏈嶅姟鍣ㄨ繛鎺ュけ璐ワ紝璇锋鏌ョ綉缁滃悗閲嶈瘯', 'err')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (mode === 'reset_password') {
      if (!state._emailVerified || !state._verifyToken) {
        showFormMsg('璇峰厛瀹屾垚閭楠岃瘉', 'err')
        return
      }

      const pwdError = getPasswordRuleError(data.password)
      if (pwdError) {
        showFormMsg(pwdError, 'err')
        return
      }
      if (data.password !== data.confirmPassword) {
        showFormMsg('涓ゆ杈撳叆鐨勫瘑鐮佷笉涓€鑷?, 'err')
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
            message: result.message || '瀵嗙爜宸叉洿鏂帮紝璇烽噸鏂扮櫥褰?,
          })
        } else {
          showFormMsg(result.error || '閲嶇疆澶辫触锛岃绋嶅悗閲嶈瘯', 'err')
        }
      } catch (err) {
        showFormMsg('鏈嶅姟鍣ㄨ繛鎺ュけ璐ワ紝璇锋鏌ョ綉缁滃悗閲嶈瘯', 'err')
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

    // 绠＄悊鍚庡彴锛氱偣鍑荤粺璁″崱鐗囪烦杞埌瀵瑰簲鍖哄煙
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

    // 绠＄悊鍚庡彴锛氭墦寮€缂栬緫鐢ㄦ埛寮圭獥
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
      modalTitle.textContent = `缂栬緫鐢ㄦ埛 - ${userName} (${userUid})`
      const defaultExpiry = new Date(Date.now() + 365 * 86400000 + 8 * 3600_000).toISOString().split('T')[0]
      modalBody.innerHTML = `
        <div class="admin-plan-form" style="display:flex;flex-direction:column;gap:14px;">
          <div class="admin-plan-field">
            <label>UID锛?/label>
            <span style="font-family:monospace;">${escapeHtml(userUid)}</span>
          </div>
          <div class="admin-plan-field">
            <label for="editUserEmail">閭锛?/label>
            <input type="email" id="editUserEmail" class="admin-plan-input" value="${escapeHtml(userEmail)}">
          </div>
          <div class="admin-plan-field">
            <label for="editUserNickname">鏄电О锛?/label>
            <input type="text" id="editUserNickname" class="admin-plan-input" value="${escapeHtml(userName)}">
          </div>
          <div class="admin-plan-field">
            <label for="editUserPassword">鏂板瘑鐮侊紙鐣欑┖涓嶄慨鏀癸級锛?/label>
            <input type="password" id="editUserPassword" class="admin-plan-input" placeholder="鐣欑┖鍒欎笉淇敼">
          </div>
          <div class="admin-plan-field">
            <label for="editUserPlan">濂楅锛?/label>
            <select id="editUserPlan" class="admin-plan-select">
              <option value="free" ${currentPlan === 'free' ? 'selected' : ''}>鍏嶈垂 (Free)</option>
              <option value="plus" ${currentPlan === 'plus' ? 'selected' : ''}>Plus 浼氬憳</option>
              <option value="pro" ${currentPlan === 'pro' ? 'selected' : ''}>Pro 浼氬憳</option>
            </select>
          </div>
          <div class="admin-plan-field" id="editUserExpiresField">
            <label for="editUserExpires">鍒版湡鏃ユ湡锛?/label>
            <input type="date" id="editUserExpires" class="admin-plan-input" value="${currentExpires || defaultExpiry}">
            <div class="admin-plan-shortcuts">
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="30">+1涓湀</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="90">+3涓湀</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="180">+鍗婂勾</button>
              <button class="btn btn-xs admin-expires-shortcut" data-target="editUserExpires" data-days="365">+1骞?/button>
            </div>
          </div>
          <div class="admin-plan-actions">
            <button class="btn btn-primary" id="adminEditUserSaveBtn" data-user-id="${userId}">淇濆瓨</button>
            <button class="btn btn-ghost" id="adminEditUserCancelBtn">鍙栨秷</button>
          </div>
          <div style="border-top:1px solid var(--border-1);padding-top:12px;margin-top:4px;">
            <button class="btn btn-xs" id="adminEditUserDeleteBtn" data-user-id="${userId}" data-name="${escapeHtml(userName)}" style="color:#ef4444;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);">鍒犻櫎鐢ㄦ埛</button>
            <span id="adminDeleteConfirm" style="display:none;margin-left:8px;font-size:12px;">纭鍒犻櫎锛熸鎿嶄綔涓嶅彲鎭㈠锛?
              <button class="btn btn-xs" id="adminDeleteConfirmYes" style="color:#fff;background:#ef4444;margin-left:4px;">纭鍒犻櫎</button>
              <button class="btn btn-xs btn-ghost" id="adminDeleteConfirmNo">鍙栨秷</button>
            </span>
          </div>
          <div id="adminEditUserResult" style="display:none"></div>
        </div>
      `
      modal.style.display = 'flex'

      document.getElementById('adminEditUserCancelBtn')?.addEventListener('click', () => modal.style.display = 'none')
      document.getElementById('adminEditUserSaveBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('adminEditUserSaveBtn')
        btn.disabled = true; btn.textContent = '淇濆瓨涓?..'
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
          if (password) {
            if (password.length < 6) {
              resultEl.style.display = 'block'
              resultEl.innerHTML = '<div class="stream-result-success error">瀵嗙爜鑷冲皯闇€瑕?浣?/div>'
              btn.disabled = false; btn.textContent = '淇濆瓨'
              return
            }
            payload.password = password
          }
          payload.plan = plan
          if (plan !== 'free') payload.expiresAt = expiresAt
          const r = await api.put('/api/admin-users', payload)
          if (r.ok) {
            resultEl.style.display = 'block'
            resultEl.innerHTML = '<div class="stream-result-success">淇濆瓨鎴愬姛</div>'
            setTimeout(() => { modal.style.display = 'none'; refreshAdminUserTable() }, 800)
          } else {
            resultEl.style.display = 'block'
            resultEl.innerHTML = `<div class="stream-result-success error">${escapeHtml(r.error || '淇濆瓨澶辫触')}</div>`
          }
        } catch (e) {
          resultEl.style.display = 'block'
          resultEl.innerHTML = `<div class="stream-result-success error">璇锋眰澶辫触</div>`
        }
        btn.disabled = false; btn.textContent = '淇濆瓨'
      })

      // Expiry shortcuts
      modal.querySelectorAll('.admin-expires-shortcut').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetId = btn.dataset.target || 'adminExpiresInput'
          const input = document.getElementById(targetId)
          if (input) {
            const d = new Date(Date.now() + Number(btn.dataset.days) * 86400000)
            input.value = new Date(d.getTime() + 8 * 3600_000).toISOString().split('T')[0]
          }
        })
      })

      // Delete user
      const deleteBtn = document.getElementById('adminEditUserDeleteBtn')
      const deleteConfirm = document.getElementById('adminDeleteConfirm')
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => { deleteBtn.style.display = 'none'; deleteConfirm.style.display = 'inline' })
      }
      const deleteNo = document.getElementById('adminDeleteConfirmNo')
      if (deleteNo) {
        deleteNo.addEventListener('click', () => { deleteBtn.style.display = 'inline-block'; deleteConfirm.style.display = 'none' })
      }
      const deleteYes = document.getElementById('adminDeleteConfirmYes')
      if (deleteYes) {
        deleteYes.addEventListener('click', async () => {
          deleteYes.disabled = true; deleteYes.textContent = '鍒犻櫎涓?..'
          try {
            const r = await api.del(`/api/admin-users/${userId}`)
            if (r.ok) {
              modal.style.display = 'none'
              refreshAdminUserTable()
            } else {
              alert(r.error || '鍒犻櫎澶辫触')
            }
          } catch { alert('鍒犻櫎澶辫触') }
        })
      }
      return
    }

    // 绠＄悊鍚庡彴锛氭墦寮€濂楅绠＄悊寮圭獥
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
      modalTitle.textContent = `绠＄悊濂楅 - ${userName} (ID: ${userId})`
      // Default expiry: 1 year from now
      const defaultExpiry = new Date(Date.now() + 365 * 86400000 + 8 * 3600_000).toISOString().split('T')[0]
      modalBody.innerHTML = `
        <div class="admin-plan-form">
          <div class="admin-plan-field">
            <label>褰撳墠鐘舵€侊細</label>
            <span>${currentPlan === 'free' ? '鍏嶈垂鐢ㄦ埛' : currentPlan.toUpperCase() + ' 浼氬憳'}${currentExpires ? '锛屽埌鏈熸棩 ' + currentExpires : ''}</span>
          </div>
          <div class="admin-plan-field">
            <label for="adminPlanSelect">璁剧疆濂楅锛?/label>
            <select id="adminPlanSelect" class="admin-plan-select">
              <option value="free" ${currentPlan === 'free' ? 'selected' : ''}>鍏嶈垂 (Free)</option>
              <option value="plus" ${currentPlan === 'plus' ? 'selected' : ''}>Plus 浼氬憳</option>
              <option value="pro" ${currentPlan === 'pro' ? 'selected' : ''}>Pro 浼氬憳</option>
            </select>
          </div>
          <div class="admin-plan-field" id="adminExpiresField">
            <label for="adminExpiresInput">鍒版湡鏃ユ湡锛?/label>
            <input type="date" id="adminExpiresInput" class="admin-plan-input" value="${currentExpires || defaultExpiry}">
            <div class="admin-plan-shortcuts">
              <button class="btn btn-xs admin-expires-shortcut" data-days="30">+1涓湀</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="90">+3涓湀</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="180">+鍗婂勾</button>
              <button class="btn btn-xs admin-expires-shortcut" data-days="365">+1骞?/button>
            </div>
          </div>
          <div class="admin-plan-actions">
            <button class="btn btn-primary" id="adminPlanSaveBtn" data-user-id="${userId}">淇濆瓨</button>
            <button class="btn btn-ghost" id="adminPlanCancelBtn">鍙栨秷</button>
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

    // 绠＄悊鍚庡彴锛氬埌鏈熸棩鏈熷揩鎹锋寜閽?
    const expiresShortcut = target.closest('.admin-expires-shortcut')
    if (expiresShortcut) {
      const days = Number(expiresShortcut.dataset.days)
      const input = document.getElementById('adminExpiresInput')
      if (input) {
        const d = new Date(Date.now() + days * 86400000)
        input.value = new Date(d.getTime() + 8 * 3600_000).toISOString().split('T')[0]
      }
      return
    }

    // 绠＄悊鍚庡彴锛氫繚瀛樺椁?
    if (target.id === 'adminPlanSaveBtn') {
      const userId = Number(target.dataset.userId)
      const plan = document.getElementById('adminPlanSelect')?.value
      const expiresAt = document.getElementById('adminExpiresInput')?.value
      if (!plan) return
      target.disabled = true
      target.textContent = '淇濆瓨涓?..'
      api.post('/api/admin-users', { userId, plan, expiresAt: plan === 'free' ? null : expiresAt }).then(r => {
        if (r.ok) {
          document.getElementById('adminOrderModal').style.display = 'none'
          renderAdmin()
        } else {
          alert('鎿嶄綔澶辫触: ' + (r.error || '鏈煡閿欒'))
          target.disabled = false
          target.textContent = '淇濆瓨'
        }
      })
      return
    }

    // 绠＄悊鍚庡彴锛氬彇娑堝脊绐?
    if (target.id === 'adminPlanCancelBtn') {
      document.getElementById('adminOrderModal').style.display = 'none'
      return
    }

    // 绠＄悊鍚庡彴锛氭煡鐪嬬敤鎴疯鍗?
    const viewOrdersBtn = target.closest('.admin-view-orders')
    if (viewOrdersBtn) {
      const uid = viewOrdersBtn.dataset.uid
      const name = viewOrdersBtn.dataset.name
      const modal = document.getElementById('adminOrderModal')
      const modalBody = document.getElementById('adminOrderModalBody')
      const modalTitle = document.getElementById('adminOrderModalTitle')
      if (!modal || !uid) return
      modalTitle.textContent = `${name} 鐨勮鍗曡褰昤
      modalBody.innerHTML = '<div class="loading-spinner">鍔犺浇涓?..</div>'
      modal.style.display = 'flex'
      api.get(`/api/orders?uid=${uid}`).then(r => {
        if (!r.ok || !r.orders) {
          modalBody.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:20px;">${escapeHtml(r.error || '鑾峰彇澶辫触')}</p>`
          return
        }
        if (r.orders.length === 0) {
          modalBody.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:20px;">鏆傛棤璁㈠崟</p>'
          return
        }
        modalBody.innerHTML = `
          <table class="admin-table" style="margin:0;">
            <thead><tr><th>璁㈠崟鍙?/th><th>鏂规</th><th>閲戦</th><th>瀹炰粯</th><th>鐘舵€?/th><th>鏃堕棿</th></tr></thead>
            <tbody>
              ${r.orders.map(o => `<tr>
                <td style="font-size:12px;">${escapeHtml(o.orderId || '-')}</td>
                <td>${escapeHtml(o.planLabel)} ${escapeHtml(o.periodLabel)}</td>
                <td>${formatMinorUsd(o.amount)}</td>
                <td>${o.amountConfirmed ? formatMinorUsd(o.amountConfirmed) : '-'}</td>
                <td><span class="admin-badge ${o.status === 'paid' ? 'badge-paid' : 'badge-free'}">${escapeHtml(o.statusLabel)}</span></td>
                <td>${formatDateTime(o.paidAt || o.createdAt) || '-'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        `
      })
      return
    }

    // 鍏抽棴璁㈠崟寮圭獥
    if (target.id === 'adminOrderModalClose' || target.classList.contains('admin-order-modal')) {
      const modal = document.getElementById('adminOrderModal')
      if (modal) modal.style.display = 'none'
      return
    }
    if (target.id === 'goUpgrade' || target.id === 'goUpgrade2' || target.id === 'goUpgradeCommunity' || target.id === 'goUpgradeCommunityReplies') { navigate('membership'); return }
    if (target.id === 'goUpgradeVideo') { if (!state.user) { showAuthModal('login_password') } else { navigate('membership') }; return }

    // Membership: subscribe button 鈥?currently disabled
    if (target.closest('.mem-btn-plus, .mem-btn-pro')) {
      alert('鏀粯鍔熻兘鏆傚叧闂紝璇疯仈绯荤鐞嗗憳寮€閫氥€?)
      return
    }// Membership price toggle (鏈堜粯/骞翠粯)
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
      if (unitEl) unitEl.textContent = '/ ' + (period === 'monthly' ? '鏈? : '骞?)
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
      if (!confirm('纭畾瑕佸垹闄よ繖绡囧笘瀛愬悧锛熷垹闄ゅ悗涓嶅彲鎭㈠銆?)) return
      try {
        const res = await api.del(`/api/posts?id=${postId}`)
        if (res.ok || res.success) {
          if (state.currentView === 'post') {
            navigate('community')
          } else {
            renderCommunity()
          }
        } else {
          alert(res.error || '鍒犻櫎澶辫触')
        }
      } catch (err) {
        console.error('Delete post error:', err)
        alert('鍒犻櫎澶辫触锛岃妫€鏌ョ綉缁?)
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
      btn.textContent = '鍙戝竷涓?..'
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
          alert(res.error || '鍙戝竷澶辫触')
          btn.disabled = false
          btn.textContent = '鍙戝竷鍥炲'
        }
      } catch (err) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        console.error('Submit reply error:', err)
        alert(err?.message || '鍙戝竷澶辫触锛岃妫€鏌ョ綉缁?)
        btn.disabled = false
        btn.textContent = '鍙戝竷鍥炲'
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
      if (!confirm('纭畾瑕佸垹闄よ繖鏉″洖澶嶅悧锛?)) return
      const replyId = deleteReplyBtn.dataset.deleteReply
      try {
        const res = await api.del(`/api/post-replies?id=${replyId}`)
        if (res.success) {
          renderPost()
        } else {
          alert(res.error || '鍒犻櫎澶辫触')
        }
      } catch (err) {
        console.error('Delete reply error:', err)
        alert('鍒犻櫎澶辫触锛岃妫€鏌ョ綉缁?)
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
      const reason = prompt('璇疯緭鍏ヤ妇鎶ュ師鍥狅紝渚嬪锛氬箍鍛娿€佽颈楠傘€佷汉韬敾鍑汇€佸埛灞?)
      if (!reason) return
      const detail = prompt('琛ュ厖璇存槑锛堥€夊～锛?) || ''
      const res = await api.post('/api/post-reports', { replyId: reportReplyBtn.dataset.reportReply, reason, detail })
      alert(res.ok ? (res.message || '涓炬姤宸叉彁浜?) : (res.error || '涓炬姤澶辫触'))
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
      if (!title || !plainText) { alert('鏍囬鍜屽唴瀹逛笉鑳戒负绌?); return }
      if ((editor?.root && getPostImageCount(editor.root) > MAX_POST_IMAGES)) {
        alert(`鏈€澶氫笂浼?${MAX_POST_IMAGES} 寮犲浘鐗嘸)
        return
      }
      const btn = target
      btn.disabled = true
      btn.textContent = '鍙戝竷涓?..'
      const uploadedAssetIds = []
      try {
        const editorRoot = editor?.root?.cloneNode(true)
        if (!editorRoot) {
          throw new Error('缂栬緫鍣ㄥ垵濮嬪寲澶辫触')
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
          alert(res.error || '鍙戝笘澶辫触')
          btn.disabled = false
          btn.textContent = '鍙戝竷'
        }
      } catch (error) {
        await cleanupTemporaryPostImages(uploadedAssetIds)
        alert(error?.message || '鍙戝笘澶辫触锛岃妫€鏌ョ綉缁?)
        btn.disabled = false
        btn.textContent = '鍙戝竷'
      }
      return
    }

    const postReportBtn = target.closest('[data-post-report]')
    if (postReportBtn) {
      if (!requireLogin()) return
      const reason = prompt('璇疯緭鍏ヤ妇鎶ュ師鍥狅紝渚嬪锛氬箍鍛娿€佽颈楠傘€佷汉韬敾鍑汇€佸埛灞?)
      if (!reason) return
      const detail = prompt('琛ュ厖璇存槑锛堥€夊～锛?) || ''
      const res = await api.post('/api/post-reports', { postId: postReportBtn.dataset.postReport, reason, detail })
      alert(res.ok ? (res.message || '涓炬姤宸叉彁浜?) : (res.error || '涓炬姤澶辫触'))
      return
    }

    const postPinBtn = target.closest('[data-post-pin]')
    if (postPinBtn) {
      const res = await api.patch('/api/posts/pin', {
        postId: postPinBtn.dataset.postPin,
        sticky: postPinBtn.dataset.nextPin === '1',
      })
      if (!res.ok) {
        alert(res.error || '鎿嶄綔澶辫触')
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
        alert(res.error || '鎿嶄綔澶辫触')
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
        alert(res.error || '鎿嶄綔澶辫触')
        return
      }
      renderPost()
      return
    }

    const richImage = target.closest('.post-rich-image, .reply-rich-image')
    if (richImage && richImage.getAttribute('src')) {
      showPostImageLightbox(richImage.getAttribute('src'), richImage.getAttribute('alt') || '甯栧瓙鍥剧墖')
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
          showFormMsgProfile('鐢ㄦ埛鍚嶅凡鏇存柊', 'ok')
        } catch (err) {
          console.error('Name update error:', err)
          showFormMsgProfile('鏇存柊澶辫触锛岃妫€鏌ョ綉缁?, 'err')
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
      // 甯﹁В閲?鎻愮ず鐨勯鐩仠鐣欏湪褰撳墠棰橈紝璁╃敤鎴疯瀹屽悗鎵嬪姩缁х画銆?
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

  // ===== 鍥炲埌椤堕儴 娴姩鎸夐挳锛堟墍鏈夐〉闈㈤€氱敤锛屾粦鍔ㄨ秴杩?400px 鏄剧ず锛?====
  if (!document.getElementById('backToTopBtn')) {
    const btn = document.createElement('button')
    btn.id = 'backToTopBtn'
    btn.className = 'back-to-top-btn'
    btn.setAttribute('aria-label', '鍥炲埌椤堕儴')
    btn.innerHTML = '鈫?
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
