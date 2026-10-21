import http from 'http'
import crypto from 'crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './tools.js'
import { QuxClient } from './QuxClient.js'
import { createAssetSigner } from './assets.js'

const ASSET_PREFIX = '/mcp/assets/'

/**
 * The remote MCP server (Streamable HTTP), an OAuth resource server.
 *
 * An MCP client without a token gets a 401 that points to the metadata of
 * this resource (RFC 9728), which names the backend as the authorization
 * server. The client registers, opens the login page of quant-ux and comes
 * back with a token (see OAuthREST in the backend). No setup by the user.
 *
 * Config (env):
 *   QUX_PUBLIC_URL  the URL agents reach this server at, e.g. https://mcp.quant-ux.com.
 *                   The MCP endpoint is QUX_PUBLIC_URL/mcp.
 *   QUX_ISSUER      the authorization server: quant-ux, which proxies /oauth to the
 *                   backend, e.g. https://app.quant-ux.com. Default QUX_PUBLIC_URL
 *   QUX_API_URL     where this server reaches the backend, default QUX_ISSUER
 *   PORT            default 8090
 */
const TOKEN_CACHE_MS = 60 * 1000

const MAX_BODY = 1024 * 1024

/**
 * The one scope of agent tokens, which are read only (the client takes the
 * scope of the 401, else the scopes_supported).
 */
const SCOPES = ['apps:read']

export function startHttpServer (env = process.env) {
  const port = Number(env.PORT || 8090)
  const publicUrl = trim(env.QUX_PUBLIC_URL || `http://localhost:${port}`)
  const issuer = trim(env.QUX_ISSUER || publicUrl)
  const apiUrl = trim(env.QUX_API_URL || issuer)
  const resource = `${publicUrl}/mcp`
  const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`

  const tokens = new Map()
  const assets = createAssetSigner(env.QUX_ASSET_SECRET)

  /**
   * An image of the app as a link the agent can download without a
   * header, see assets.js.
   */
  async function sendAsset (id, res) {
    const payload = assets.open(id)
    if (!payload) {
      json(res, 404, { error: 'not_found', error_description: 'The link expired, ask the tool again' })
      return
    }
    const client = new QuxClient({ apiUrl, getToken: async () => payload.t })
    const { data, mimeType } = await client.getImage(payload.p)
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(data)
  }

  /**
   * The user of the token, asked from the backend and kept for a minute.
   * A token issued for another resource (RFC 8707) is not accepted, a
   * personal access token has none and works everywhere.
   */
  async function authenticate (token) {
    const key = crypto.createHash('sha256').update(token).digest('hex')
    const cached = tokens.get(key)
    if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) {
      return cached.me
    }
    const res = await fetch(`${apiUrl}/rest/ai/me.json`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    if (res.status !== 200) {
      tokens.delete(key)
      return null
    }
    const me = await res.json()
    const audience = me.token && me.token.resource
    if (audience && trim(audience) !== resource) {
      return null
    }
    tokens.set(key, { me, at: Date.now() })
    if (tokens.size > 10000) {
      tokens.clear()
    }
    return me
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'OPTIONS') {
        cors(res)
        res.writeHead(204).end()
        return
      }

      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource')) {
        cors(res)
        json(res, 200, {
          resource,
          authorization_servers: [issuer],
          scopes_supported: SCOPES,
          bearer_methods_supported: ['header'],
          resource_name: 'Quant-UX',
          resource_documentation: `${issuer}/#/help.html`
        })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith(ASSET_PREFIX)) {
        await sendAsset(url.pathname.substring(ASSET_PREFIX.length), res)
        return
      }

      if (url.pathname === '/health') {
        json(res, 200, { status: 'ok', name: SERVER_NAME, version: SERVER_VERSION })
        return
      }

      if (url.pathname !== '/mcp') {
        json(res, 404, { error: 'not_found' })
        return
      }

      cors(res)
      const token = getBearer(req)
      const me = token ? await authenticate(token) : null
      if (!me) {
        const scope = SCOPES.join(' ')
        const challenge = token
          ? `Bearer error="invalid_token", error_description="The token is invalid, expired or not for this server", resource_metadata="${metadataUrl}", scope="${scope}"`
          : `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`
        res.setHeader('WWW-Authenticate', challenge)
        json(res, 401, { error: token ? 'invalid_token' : 'unauthorized', error_description: 'Log in to Quant-UX' })
        return
      }

      /*
       * Stateless: a server and a transport per request, the token of the
       * request is the only state.
       */
      const client = new QuxClient({ apiUrl, getToken: async () => token })
      const imageUrl = path => `${publicUrl}${ASSET_PREFIX}${assets.sign({ t: token, p: path })}`
      const mcp = createMcpServer({ client, imageUrl })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        mcp.close()
      })
      await mcp.connect(transport)
      const body = req.method === 'POST' ? await readJson(req) : undefined
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('quant-ux-mcp > request failed', err)
      if (!res.headersSent) {
        json(res, err.status || 500, { jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null })
      }
    }
  })

  server.listen(port, () => {
    console.error(`quant-ux-mcp > listening on :${port}, resource ${resource}, issuer ${issuer}, api ${apiUrl}`)
  })
  return server
}

function getBearer (req) {
  const header = req.headers.authorization || ''
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        const err = new Error('Request too large')
        err.status = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : undefined)
      } catch (e) {
        const err = new Error('Invalid JSON')
        err.status = 400
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function cors (res) {
  // browser based clients (e.g. the MCP inspector) read the 401 challenge
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version')
}

function json (res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function trim (url) {
  return String(url).replace(/\/+$/, '')
}
