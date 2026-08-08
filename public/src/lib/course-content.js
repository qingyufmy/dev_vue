export function createCourseContent(api) {
  return {
    quizzes: new Map(),
    knowledge: new Map(),
    mindmaps: new Map(),
    attachments: new Map(),
    structures: new Map(),
    objectUrls: new Map(),

    async loadManifest() {
      return { version: 1, episodes: {} }
    },

    isManifestReady() {
      return true
    },

    getEntry() {
      return null
    },

    async getEntryAsync() {
      return null
    },

    getCachedQuiz(episodeId) {
      return this.quizzes.get(Number(episodeId)) || null
    },

    async loadQuiz(episodeId) {
      const id = Number(episodeId)
      if (this.quizzes.has(id)) return this.quizzes.get(id)

      try {
        const apiData = await api.get(`/api/course-items/${id}/quiz`)
        if (apiData.ok && Array.isArray(apiData.questions)) {
          this.quizzes.set(id, apiData.questions)
          return apiData.questions
        }
        if (apiData.httpStatus === 401 || apiData.httpStatus === 403) {
          this.quizzes.set(id, [])
          return []
        }
      } catch (err) {
        console.error('Course quiz API load error:', err)
      }

      this.quizzes.set(id, [])
      return []
    },

    getCachedKnowledge(episodeId) {
      return this.knowledge.get(Number(episodeId)) || null
    },

    async loadKnowledge(episodeId) {
      const id = Number(episodeId)
      if (this.knowledge.has(id)) return this.knowledge.get(id)

      try {
        const apiData = await api.get(`/api/course-items/${id}/resources`)
        if (apiData.ok && Array.isArray(apiData.knowledgePoints)) {
          this.knowledge.set(id, apiData.knowledgePoints)
          return apiData.knowledgePoints
        }
      } catch (err) {
        console.error('Course knowledge API load error:', err)
      }

      this.knowledge.set(id, [])
      return []
    },

    getCachedMindmaps(episodeId) {
      return this.mindmaps.get(Number(episodeId)) || null
    },

    async loadMindmaps(episodeId) {
      const id = Number(episodeId)
      if (this.mindmaps.has(id)) return this.mindmaps.get(id)

      try {
        const apiData = await api.get(`/api/course-items/${id}/resources`)
        if (apiData.ok && Array.isArray(apiData.mindmapItems)) {
          const items = await Promise.all(apiData.mindmapItems.map(item => this.resolveMindmapItem(item)))
          this.mindmaps.set(id, items)
          return items
        }
        if (apiData.httpStatus === 401 || apiData.httpStatus === 403) {
          this.mindmaps.set(id, [])
          return []
        }
      } catch (err) {
        console.error('Course resources API load error:', err)
      }

      this.mindmaps.set(id, [])
      return []
    },

    getCachedAttachments(episodeId) {
      return this.attachments.get(Number(episodeId)) || null
    },

    async loadAttachments(episodeId) {
      const id = Number(episodeId)
      if (this.attachments.has(id)) return this.attachments.get(id)
      try {
        const apiData = await api.get(`/api/course-items/${id}/attachments`)
        if (apiData.ok && Array.isArray(apiData.attachments)) {
          this.attachments.set(id, apiData.attachments)
          return apiData.attachments
        }
        if ([401, 403, 404].includes(apiData.httpStatus)) {
          this.attachments.set(id, [])
          return []
        }
      } catch (err) {
        console.error('Course attachments API load error:', err)
      }
      this.attachments.set(id, [])
      return []
    },

    async resolveMindmapItem(item) {
      const resolved = { ...item }
      if (resolved.image) resolved.image = await this.resolveMediaUrl(resolved.image)
      if (resolved.pdf) resolved.pdf = await this.resolveMediaUrl(resolved.pdf)
      return resolved
    },

    async resolveMediaUrl(url) {
      if (!url || !String(url).startsWith('/api/')) return url
      if (this.objectUrls.has(url)) return this.objectUrls.get(url)
      const objectUrl = await api.fetchBlobUrl(url)
      this.objectUrls.set(url, objectUrl)
      return objectUrl
    },

    async loadStructure(path) {
      if (!path) return null
      if (this.structures.has(path)) return this.structures.get(path)
      const data = await api.fetchJson(path)
      this.structures.set(path, data)
      return data
    },
  }
}
