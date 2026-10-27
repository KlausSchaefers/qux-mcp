/**
 * The Quant-UX API for agents (/rest/ai, see AIRest in the backend),
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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export class QuxClient {

  /**
   * @param {{ apiUrl: string, getToken: () => Promise<string> }} options
   */
  constructor ({ apiUrl, getToken }) {
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.getToken = getToken
  }

  me () {
    return this.get('/rest/ai/me.json')
  }

  listApps () {
    return this.get('/rest/ai/apps.json')
  }

  async getApp (appId) {
    const app = await this.get(`/rest/ai/apps/${encodeURIComponent(appId)}.json`)
    if (!app.id) {
      app.id = app._id || appId
    }
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

  /**
   * A new app of the user (needs apps:write).
   * @param {{name: string, description?: string, type?: string, screenSize: {w, h}, designtokens?: object}} app
   */
  createApp (app) {
    return this.post('/rest/ai/apps.json', app)
  }

  /**
   * Adds screens to an app (needs apps:write), see ScreenImport.buildFragment.
   */
  addScreens (appId, fragment) {
    return this.post(`/rest/ai/apps/${encodeURIComponent(appId)}/screens.json`, fragment)
  }

  /**
   * Uploads an image to an app (needs apps:write), like the editor does.
   * @returns {{url: string, width: number, height: number}} url is "<appID>/<file>"
   */
  async uploadImage (appId, { name, data, mimeType }) {
    if (data.length > MAX_IMAGE_BYTES) {
      throw new ApiError(413, `The image ${name} is bigger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    }
    const form = new FormData()
    form.append('file', new Blob([data], { type: mimeType }), name)
    const res = await this.fetchWithAuth(`/rest/images/${encodeURIComponent(appId)}`, 'application/json', { method: 'POST', body: form })
    const json = await readJson(res, `/rest/images/${appId}`)
    const upload = json && json.uploads && json.uploads[0]
    if (!upload || !upload.url) {
      throw new ApiError(400, `Quant-UX did not take the image ${name}, is it a PNG, JPEG, GIF, WEBP or SVG?`)
    }
    return upload
  }

  async fetchWithAuth (path, accept, init = {}) {
    const token = await this.getToken()
    let res
    try {
      res = await fetch(this.apiUrl + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: accept } })
    } catch (err) {
      throw new ApiError(0, `Quant-UX is not reachable at ${this.apiUrl}: ${err.message}`)
    }
    if (res.status === 401) {
      throw new AuthError('The Quant-UX login expired or was revoked. Reconnect the Quant-UX MCP server to log in again.')
    }
    if (res.status === 403 && /insufficient_scope/.test(res.headers.get('www-authenticate') || '')) {
      throw new AuthError('This login can only read. To create apps and screens, reconnect the Quant-UX MCP server (in Claude Code: /mcp, quant-ux, re-authenticate) and allow "Create apps and add screens".')
    }
    return res
  }

  async post (path, body) {
    const res = await this.fetchWithAuth(path, 'application/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return readJson(res, path)
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
    return readJson(res, path)
  }
}

async function readJson (res, path) {
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
