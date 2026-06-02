export const api = {
  _token() { return localStorage.getItem('ws_token') },

  _headers(json = true) {
    const h = {}
    if (json) h['Content-Type'] = 'application/json'
    const t = this._token()
    if (t) h.Authorization = `Bearer ${t}`
    return h
  },

  async get(url) {
    const res = await fetch(url, { headers: this._headers(false) })
    try {
      const data = await res.json()
      return { ok: res.ok, ...data, httpStatus: res.status }
    } catch {
      return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}` }
    }
  },

  async post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) })
    return { ok: res.ok, ...(await res.json()) }
  },

  async put(url, body) {
    const res = await fetch(url, { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) })
    return { ok: res.ok, ...(await res.json()) }
  },

  async del(url) {
    const res = await fetch(url, { method: 'DELETE', headers: this._headers(false) })
    return { ok: res.ok, ...(await res.json()) }
  },

  async patch(url, body) {
    const res = await fetch(url, { method: 'PATCH', headers: this._headers(), body: JSON.stringify(body) })
    return { ok: res.ok, ...(await res.json()) }
  },

  async postForm(url, formData) {
    const res = await fetch(url, { method: 'POST', headers: this._headers(false), body: formData })
    return { ok: res.ok, ...(await res.json()) }
  },

  async fetchJson(url) {
    const res = await fetch(url, {
      headers: { ...this._headers(false), Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },

  async fetchBlobUrl(url) {
    const res = await fetch(url, { headers: this._headers(false) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return URL.createObjectURL(await res.blob())
  },
}
