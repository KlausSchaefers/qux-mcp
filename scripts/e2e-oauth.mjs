/**
 * End to end check of the agent login, as an MCP client like Claude Code
 * does it, with the OAuth client of the MCP SDK:
 *
 *   401 > resource metadata > authorization server metadata > client
 *   registration > authorize (PKCE) > the user approves > code > token >
 *   tools, then refresh and logout.
 *
 * The user approves through the API of the consent page with the JWT of a
 * login, so no browser is needed. It creates a user and an app.
 * Use it only against a local or test backend, never production.
 *
 *   QUX_API=http://localhost:8099 MCP_URL=http://localhost:8090/mcp node scripts/e2e-oauth.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

const API = process.env.QUX_API || 'http://localhost:8099'
const MCP_URL = process.env.MCP_URL || 'http://localhost:8090/mcp'
const REDIRECT = 'http://127.0.0.1:53999/callback'

if (/quant-ux\.com/.test(API)) {
  console.error('Refusing to run against production')
  process.exit(1)
}

function check (cond, msg) {
  if (!cond) {
    console.error('FAIL', msg)
    process.exit(1)
  }
  console.log('ok  ', msg)
}

async function api (method, path, body, jwt) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

/**
 * What an MCP client keeps: its registration, the PKCE verifier, the tokens.
 */
class MemoryProvider {
  constructor () {
    this.store = {}
  }

  get redirectUrl () { return REDIRECT }
  get clientMetadata () {
    return {
      client_name: 'E2E Agent',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  clientInformation () { return this.store.client }
  saveClientInformation (info) { this.store.client = info }
  tokens () { return this.store.tokens }
  saveTokens (tokens) { this.store.tokens = tokens }
  redirectToAuthorization (url) { this.store.authorizationUrl = url }
  saveCodeVerifier (v) { this.store.verifier = v }
  codeVerifier () { return this.store.verifier }
}

async function main () {
  // a user with an app
  const email = `e2e_${Date.now()}@example.com`
  check((await api('POST', '/rest/user', { email, password: '123456789', name: 'E2E', lastname: 'Tester', tos: true })).status === 200, 'user created')
  const login = await api('POST', '/rest/login', { email, password: '123456789' })
  const jwt = login.json.token
  check(!!jwt, 'user logged in')
  const app = await api('POST', '/rest/apps', {
    name: 'E2E Shop',
    screenSize: { w: 375, h: 812 },
    screens: { s1: { id: 's1', name: 'Home', x: 0, y: 0, w: 375, h: 812, children: ['w1'], style: { background: '#ffffff' } } },
    widgets: { w1: { id: 'w1', name: 'Buy', type: 'Button', x: 20, y: 700, w: 335, h: 48, z: 1, props: { label: 'Buy now' }, style: { background: '#2563eb', color: '#ffffff', fontSize: 16 } } },
    designtokens: { dt1: { id: 'dt1', name: 'Primary', type: 'color', role: 'primary', value: '#2563eb' } }
  }, jwt)
  check(!!app.json._id, 'app created')
  await new Promise(resolve => setTimeout(resolve, 300))

  // 1) the client connects without a token: 401 > discovery > registration > authorize url
  const provider = new MemoryProvider()
  let transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
  let client = new Client({ name: 'e2e', version: '1.0.0' })
  try {
    await client.connect(transport)
    check(false, 'connect without login must fail')
  } catch (err) {
    check(err instanceof UnauthorizedError, 'connect without login asks for authorization')
  }
  check(provider.store.client && provider.store.client.client_id.startsWith('qux_client_'), 'client registered itself (RFC 7591)')
  const authorizationUrl = provider.store.authorizationUrl
  check(authorizationUrl && authorizationUrl.searchParams.get('code_challenge_method') === 'S256', 'authorize url with PKCE S256')
  check(authorizationUrl.searchParams.get('resource') === MCP_URL, 'authorize url names the MCP server as resource (RFC 8707)')

  // 2) the browser opens the authorize url: redirect to the consent page
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  check(authorize.status === 302 && location.includes('/#/agent/authorize.html?request='), 'authorize redirects to the consent page')
  const requestID = location.split('request=')[1]

  // 3) the user approves on the consent page
  const consent = await api('GET', `/oauth/requests/${requestID}.json`, null, jwt)
  check(consent.json.client.name === 'E2E Agent', 'consent page shows the agent')
  const approved = await api('POST', `/oauth/requests/${requestID}/approve`, { appIDs: null }, jwt)
  const callback = new URL(approved.json.redirect)
  check(callback.origin + callback.pathname === REDIRECT, 'the browser goes back to the agent')
  check(callback.searchParams.get('state') === authorizationUrl.searchParams.get('state'), 'state comes back')

  // 4) the client exchanges the code and connects
  await transport.finishAuth(callback.searchParams.get('code'))
  check(provider.store.tokens.access_token.startsWith('qux_at_'), 'token issued')
  transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
  client = new Client({ name: 'e2e', version: '1.0.0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  check(tools.length === 7 && tools.some(t => t.name === 'get_image'), 'tools listed')

  const apps = await client.callTool({ name: 'list_apps', arguments: {} })
  check(apps.content[0].text.includes('E2E Shop'), 'list_apps sees the app of the user')
  const tokens = await client.callTool({ name: 'get_design_tokens', arguments: { app: 'E2E Shop' } })
  check(tokens.content[0].text.includes('--color-primary: #2563eb'), 'get_design_tokens gives the CSS')
  const handoff = await client.callTool({ name: 'get_screen_handoff', arguments: { app: 'E2E Shop', screen: 'home' } })
  check(handoff.content[0].text.includes('data-qid="w1"') && handoff.content[0].text.includes('Buy now'), 'get_screen_handoff gives the HTML')
  await client.close()

  // 5) the user disconnects the agent in "My account": the token stops working
  const list = await api('GET', '/rest/agent-tokens.json', null, jwt)
  check(list.json.length === 1 && list.json[0].name === 'E2E Agent', 'the agent is listed in My account')
  await api('DELETE', `/rest/agent-tokens/${list.json[0].id}.json`, null, jwt)
  const me = await fetch(`${API}/rest/ai/v2/me.json`, { headers: { Authorization: `Bearer ${provider.store.tokens.access_token}` } })
  check(me.status === 401, 'disconnected agent is rejected')

  console.log('\nAll checks passed')
}

main().catch(err => {
  console.error('FAIL', err)
  process.exit(1)
})
