import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpServer } from '../src/http.js'

/**
 * The HTTP MCP server against a fake backend: the 401 challenge, the
 * resource metadata, the audience check and the tools.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const demo = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/agent_demo_1.json'), 'utf8'))
// an uploaded image on the start screen
const START = Object.values(demo.screens)[0]
demo.widgets.wImg = { id: 'wImg', name: 'Photo', type: 'Image', x: 10, y: 600, w: 120, h: 80, z: 99, props: {}, has: {}, style: { backgroundImage: { url: 'a1/photo123.png', w: 120, h: 80 } } }
START.children.push('wImg')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4bf0000000049454e44ae426082', 'hex')
const PUBLIC_URL = 'http://mcp.test'
const TOKENS = {
  'qux_at_good': { email: 'klaus@example.com', token: { resource: `${PUBLIC_URL}/mcp` } },
  'qux_pat_good': { email: 'klaus@example.com', token: { resource: null } },
  'qux_at_other': { email: 'klaus@example.com', token: { resource: 'https://other.example.com/mcp' } }
}

let api, mcp, mcpUrl

before(async () => {
  api = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    const me = TOKENS[token]
    if (!me) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid_token"}')
      return
    }
    const send = body => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/rest/ai/v2/me.json') {
      send(me)
    } else if (req.url === '/rest/ai/v2/apps.json') {
      send([{ id: 'a1', name: 'Demo Banking', screenCount: Object.keys(demo.screens).length, type: 'smartphone', permission: 'owner', lastUpdate: 1 }])
    } else if (req.url === '/rest/ai/v2/apps/a1.json') {
      send({ ...demo, id: 'a1', name: 'Demo Banking' })
    } else if (req.url === '/rest/images/a1/photo123.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}')
    }
  })
  await new Promise(resolve => api.listen(0, resolve))

  mcp = startHttpServer({
    PORT: '0',
    QUX_PUBLIC_URL: PUBLIC_URL,
    QUX_API_URL: `http://127.0.0.1:${api.address().port}`
  })
  await new Promise(resolve => mcp.on('listening', resolve))
  mcpUrl = `http://127.0.0.1:${mcp.address().port}`
})

after(() => {
  mcp.close()
  api.close()
})

async function connect (token) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  return client
}

test('publishes the resource metadata with the authorization server', async () => {
  const res = await fetch(`${mcpUrl}/.well-known/oauth-protected-resource/mcp`)
  assert.equal(res.status, 200)
  const metadata = await res.json()
  assert.equal(metadata.resource, `${PUBLIC_URL}/mcp`)
  assert.deepEqual(metadata.authorization_servers, [PUBLIC_URL])
  assert.deepEqual(metadata.scopes_supported, ['apps:read'])
})

test('answers 401 with the metadata without a token or with a wrong one', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

  const none = await fetch(`${mcpUrl}/mcp`, { method: 'POST', headers, body })
  assert.equal(none.status, 401)
  // read only: the client asks for apps:read, not for everything it can find
  assert.equal(none.headers.get('www-authenticate'), `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="apps:read"`)

  const wrong = await fetch(`${mcpUrl}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer qux_at_nope' }, body })
  assert.equal(wrong.status, 401)
  assert.match(wrong.headers.get('www-authenticate'), /error="invalid_token"/)

  // issued for another MCP server (RFC 8707)
  const other = await fetch(`${mcpUrl}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer qux_at_other' }, body })
  assert.equal(other.status, 401)
})

test('lists the read only tools', async () => {
  const client = await connect('qux_at_good')
  const { tools } = await client.listTools()
  const names = tools.map(t => t.name).sort()
  assert.deepEqual(names, ['get_app_overview', 'get_components', 'get_design_tokens', 'get_image', 'get_screen_handoff', 'get_screen_html', 'list_apps'])
  assert.ok(tools.every(t => t.annotations.readOnlyHint === true))
  await client.close()
})

test('the tools read the app by name', async () => {
  const client = await connect('qux_pat_good')

  const apps = await client.callTool({ name: 'list_apps', arguments: {} })
  assert.match(apps.content[0].text, /Demo Banking \(id: a1\)/)

  const overview = await client.callTool({ name: 'get_app_overview', arguments: { app: 'demo banking' } })
  assert.equal(overview.isError, undefined)
  assert.match(overview.content[0].text, /## Screens/)
  assert.ok(overview.structuredContent.flows.length > 0)

  const screen = Object.values(demo.screens)[0]
  const handoff = await client.callTool({ name: 'get_screen_handoff', arguments: { app: 'a1', screen: screen.name } })
  assert.match(handoff.content[0].text, /```html\n<!doctype html>/)
  assert.match(handoff.content[0].text, /data-qid=/)

  const tokens = await client.callTool({ name: 'get_design_tokens', arguments: { app: 'a1', format: 'json' } })
  assert.ok(Array.isArray(tokens.structuredContent.tokens))

  const missing = await client.callTool({ name: 'get_screen_html', arguments: { app: 'a1', screen: 'Nope' } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /The screens are:/)

  const noApp = await client.callTool({ name: 'get_components', arguments: { app: 'Unknown' } })
  assert.equal(noApp.isError, true)
  assert.match(noApp.content[0].text, /No app "Unknown"/)

  await client.close()
})

test('the HTML for agents has tokens, icons and image links', async (t) => {
  const client = await connect('qux_pat_good')
  t.after(() => client.close())
  const handoff = await client.callTool({ name: 'get_screen_handoff', arguments: { app: 'a1', screen: START.name } })
  const text = handoff.content[0].text

  // the button "Box 5" is linked to the color tokens of the demo
  assert.match(text, /var\(--color-buttongreen\)/)
  assert.match(text, /\/\* design tokens \*\//)
  assert.match(text, /<i class="mdi mdi-menu /)
  assert.match(text, /materialdesignicons\.min\.css/)

  // the image as a signed link of this server
  const image = handoff.structuredContent.images.find(i => i.elementId === 'wImg')
  assert.ok(image.url.startsWith(`${PUBLIC_URL}/mcp/assets/`))
  assert.match(text, new RegExp(`src="${image.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))

  const local = image.url.replace(PUBLIC_URL, mcpUrl)
  const res = await fetch(local)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG)

  // a changed link is no link
  const tampered = local.slice(0, -2) + (local.endsWith('AA') ? 'BB' : 'AA')
  assert.equal((await fetch(tampered)).status, 404)

  const shown = await client.callTool({ name: 'get_image', arguments: { app: 'a1', image: 'wImg' } })
  assert.equal(shown.content[0].type, 'image')
  assert.equal(shown.content[0].mimeType, 'image/png')
  assert.equal(Buffer.from(shown.content[0].data, 'base64').length, PNG.length)

  const outside = await client.callTool({ name: 'get_image', arguments: { app: 'a1', image: '../../etc/passwd' } })
  assert.equal(outside.isError, true)
})
