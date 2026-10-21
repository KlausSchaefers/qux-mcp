/**
 * The Quant-UX API for agents (/rest/ai/v2, see AIRest in the backend),
 * called with the token of the request (the MCP client renews it itself).
 */
export class AuthError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AuthError'
  }
}

export class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// a full app can be big, so it is kept a few seconds for the next tool call
const APP_CACHE_MS = 30 * 1000

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export class QuxClient {

  /**
   * @param {{ apiUrl: string, getToken: () => Promise<string> }} options
   */
  constructor ({ apiUrl, getToken }) {
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.getToken = getToken
    this.appCache = new Map()
  }

  me () {
    return this.get('/rest/ai/v2/me.json')
  }

  listApps () {
    return this.get('/rest/ai/v2/apps.json')
  }

  listScreens (appId) {
    return this.get(`/rest/ai/v2/apps/${encodeURIComponent(appId)}/screens.json`)
  }

  getDesignTokens (appId) {
    return this.get(`/rest/ai/v2/apps/${encodeURIComponent(appId)}/designtokens.json`)
  }

  async getApp (appId) {
    const cached = this.appCache.get(appId)
    if (cached && Date.now() - cached.at < APP_CACHE_MS) {
      return cached.app
    }
    const app = await this.get(`/rest/ai/v2/apps/${encodeURIComponent(appId)}.json`)
    if (!app.id) {
      app.id = app._id || appId
    }
    this.appCache.set(appId, { app, at: Date.now() })
    return app
  }

  /**
   * An uploaded image of an app, by its path in the model ("<appID>/<file>").
   * @returns {{data: Buffer, mimeType: string}}
   */
  async getImage (path) {
    // "<appID>/<file>" as ImageREST stores it, never a way out of the image folder
    const match = /^([\w-]+)\/([^/\\?#]+)$/.exec(String(path))
    if (!match || match[2].includes('..')) {
      throw new ApiError(400, `Not an image of Quant-UX: ${path}`)
    }
    const res = await this.fetchWithAuth(`/rest/images/${match[1]}/${encodeURIComponent(match[2])}`, 'image/*')
    if (!res.ok) {
      throw new ApiError(res.status, `Could not load the image ${path} (${res.status})`)
    }
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length > MAX_IMAGE_BYTES) {
      throw new ApiError(413, `The image ${path} is bigger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    }
    return { data, mimeType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] }
  }

  async fetchWithAuth (path, accept) {
    const token = await this.getToken()
    let res
    try {
      res = await fetch(this.apiUrl + path, { headers: { Authorization: `Bearer ${token}`, Accept: accept } })
    } catch (err) {
      throw new ApiError(0, `Quant-UX is not reachable at ${this.apiUrl}: ${err.message}`)
    }
    if (res.status === 401) {
      throw new AuthError('The Quant-UX login expired or was revoked. Reconnect the Quant-UX MCP server to log in again.')
    }
    return res
  }

  /**
   * An app by id or by name (case insensitive), so the agent can say
   * "the Banking app".
   */
  async resolveApp (ref) {
    const apps = await this.listApps()
    const needle = String(ref || '').trim().toLowerCase()
    const app = apps.find(a => a.id === ref) ||
      apps.find(a => String(a.name || '').trim().toLowerCase() === needle) ||
      apps.find(a => String(a.name || '').toLowerCase().includes(needle))
    if (!app) {
      const names = apps.slice(0, 20).map(a => `"${a.name}" (${a.id})`).join(', ')
      throw new ApiError(404, `No app "${ref}". The apps are: ${names || 'none'}`)
    }
    return app
  }

  async get (path) {
    const res = await this.fetchWithAuth(path, 'application/json')
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (e) {
      json = null
    }
    if (!res.ok) {
      const description = json && (json.error_description || json.error)
      throw new ApiError(res.status, description || `Quant-UX answered ${res.status} for ${path}`)
    }
    return json
  }
}
