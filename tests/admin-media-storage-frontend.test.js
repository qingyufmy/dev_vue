import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app=readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const css=readFileSync(new URL('../public/admin/styles.css', import.meta.url), 'utf8')
const main=readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')

describe('media storage admin settings contract', () => {
  it('keeps storage settings in the existing system settings workbench', () => {
    expect(app).toContain("media_storage:{label:'文件与媒体存储'")
    expect(app).toContain("qiniu:{label:'七牛连接'")
    expect(app).toContain("qiniu_connection_test_status")
    expect(app).toContain("当前生效：")
    expect(app).toContain("/api/system-config/media_storage/test")
    expect(app).toContain('function mediaStorageOperationsHtml()')
    expect(app).toContain('待删除')
    expect(css).toContain('.media-storage-operations')
    expect(app).toContain("切换到七牛连接会丢失当前页面中尚未保存的内容")
    expect(app).toContain("state.view === 'system-settings' && state.systemConfigDirty")
    expect(app).toContain("离开系统设置会丢失当前页面中尚未保存的内容")
  })

  it('protects unsaved edits and does not render cloud credentials or signed URLs', () => {
    expect(app).toContain("state.systemConfigDirty")
    expect(app).toContain("event.returnValue = '系统设置有未保存的修改。'")
    expect(app).toContain('凭证、临时对象上传、读取和删除')
    expect(app).not.toContain('signed_url')
    expect(css).toContain('.storage-provider-control')
    expect(css).toContain('.media-storage-test-state')
  })

  it('recomputes inherit results from the current form controls', () => {
    expect(app).toContain('function storageProviderItemsForRoot(root=document)')
    expect(app).toContain("root.querySelectorAll?.('[data-storage-provider]')")
    expect(app).toContain('const items=storageProviderItemsForRoot(root)')
    expect(app).toContain("if(category==='media_storage'&&control.dataset.storageProvider)refreshStorageEffectiveProviders(root)")
  })

  it('preflights the effective provider and splits qiniu visual uploads before multipart', () => {
    expect(app).toContain('uploadCourseResourcesForProvider')
    expect(app).toContain("const serverFiles=imageProvider==='qiniu'?files.filter(file=>!imageFiles.includes(file)):files")
    expect(app).toContain('const namedMindmap=/mindmap|structure|导图|思维/i.test(file.name)')
    expect(app).not.toContain('uploadCourseAttachmentsWithDirectFallback')
    expect(app).not.toContain('image/svg+xml')
    expect(app).toContain('storageUploadProviderLabel(imageProvider)')
    expect(app).toContain("root.querySelector('#courseAssetUpload').onsubmit=async event=>")
  })

  it('uses an XHR upload progress event and keeps confirmation as a separate phase', () => {
    expect(app).toContain('xhr.upload.onprogress')
    expect(app).toContain("onPhase?.('")
    expect(app).toContain('uploadQiniuAdminResourceFile')
    expect(app).toContain("upload_phase:'confirmed'")
  })

  it('uses the managed resumable video flow without legacy submit interception', () => {
    expect(app).toContain("script.src='/vendor/qiniu-js-3.4.4.min.js'")
    expect(app).toContain('chunkSize:8,forceDirect:false')
    expect(app).toContain('info?.total?.percent??info?.percent')
    expect(app).toContain("reject(new Error('视频上传已取消'))")
    expect(app).toContain("api('/api/video-upload-session'")
    expect(app).toContain("api('/api/video-upload-confirm'")
    expect(app).toContain('function bindManagedVideoUpload(root)')
    expect(app).toContain('accept=".mp4,video/mp4"')
    expect(app).not.toContain("document.addEventListener('submit',event=>")
    expect(app).not.toContain('new MutationObserver(')
    expect(app).not.toContain("api('/api/video-stream',{method:'POST'")
  })

  it('prefers explicit managed playback and refreshes an expired URL at most once', () => {
    expect(main).toContain("r.videoSource === 'local_mp4' || r.videoSource === 'qiniu_mp4'")
    expect(main).toContain('function initLocalPlayer(videoUrl, options = {})')
    expect(main).toContain('let refreshAttempted = false')
    expect(main).toContain('if (refreshAttempted) {')
    expect(main).toContain('video.currentTime = Math.min(currentTime')
    expect(main).toContain('if (wasPlaying) video.play()')
  })
})
