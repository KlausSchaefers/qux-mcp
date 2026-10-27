import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { prepareHTML, toFileName } from '../src/create/html.js'
import { toDesignTokens } from '../src/create/tokens.js'
import { buildFragment, SCREEN_GAP } from '../src/create/ScreenImport.js'
import { createScreens } from '../src/create/createScreens.js'
import { Renderer, HOST, FILES_PREFIX } from '../src/create/Renderer.js'
import { ApiError } from '../src/QuxClient.js'

/**
 * create_app and create_screens: the HTML of an agent becomes screens of an
 * app (src/create). The importer itself (HTML2QUX) runs in Chromium, the
 * last tests need Playwright's Chromium and are skipped without it.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const loginHTML = fs.readFileSync(path.join(here, 'fixtures/login.html'), 'utf8')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/*
 * The HTML
 */

test('prepareHTML() removes scripts and shuts off the page', () => {
  const { html } = prepareHTML('<html><head><script src="x.js"></script><script>alert(1)</script></head><body>Hi</body></html>')
  assert.ok(!html.includes('<script'))
  assert.match(html, /Content-Security-Policy" content="script-src 'none'/)
  assert.ok(html.includes(`<base href="${HOST}${FILES_PREFIX}">`))
})

test('prepareHTML() wraps a fragment into a document', () => {
  const { html } = prepareHTML('<div>Hi</div>')
  assert.match(html, /^<!doctype html><html><head><meta/)
  assert.ok(html.includes('<body><div>Hi</div></body>'))
})

test('prepareHTML() marks the data-link elements', () => {
  const { html, links } = prepareHTML('<body><a class="b" data-link="Home">Go</a><div data-qid="own" data-link=\'Sign &amp; up\'>x</div><span data-link="">y</span></body>')
  assert.deepEqual(links, [{ qid: 'qux-link-1', to: 'Home' }, { qid: 'own', to: 'Sign & up' }])
  assert.ok(html.includes('<a class="b" data-link="Home" data-qid="qux-link-1">'))
})

test('toFileName() gives the name of an image of the call', () => {
  assert.equal(toFileName(`${HOST}${FILES_PREFIX}img%20one.png?x=1`), 'img one.png')
  assert.equal(toFileName('https://example.com/a.png'), null)
  assert.equal(toFileName(undefined), null)
})

/*
 * The tokens
 */

test('toDesignTokens() takes the tokens as get_design_tokens gives them', () => {
  const { tokens, errors } = toDesignTokens([
    { name: 'Primary', type: 'color', role: 'primary', value: '#2563eb' },
    { name: 'Body', type: 'text', role: 'body', value: { fontFamily: 'Inter', fontSize: '16px', fontWeight: 400, lineHeight: '24px' } },
    { name: 'Medium', type: 'radius', value: '8px' },
    { name: 'Card', type: 'boxShadow', value: '0 2px 8px rgba(0, 0, 0, 0.15), 0 1px 2px #000' },
    { name: 'Primary', type: 'color', role: 'nonsense', value: '#000' },
    { name: 'Broken', type: 'gradient', value: 'x' },
    { name: 'No size', type: 'text', value: { fontFamily: 'Inter' } },
    { type: 'color', value: '#fff' }
  ])
  const list = Object.values(tokens)
  assert.equal(list.length, 5)
  assert.deepEqual(list.map(t => t.id), ['dtPrimary', 'dtBody', 'dtMedium', 'dtCard', 'dtPrimary_2'])
  assert.equal(tokens.dtPrimary.role, 'primary')
  assert.equal(tokens.dtPrimary_2.role, undefined)
  assert.deepEqual(tokens.dtBody.value, { fontSize: 16, fontFamily: 'Inter', textAlign: 'left', verticalAlign: 'top', letterSpacing: 0, lineHeight: 1.5, fontWeight: 400 })
  assert.equal(tokens.dtBody.isComplex, true)
  assert.equal(tokens.dtMedium.value, 8)
  assert.deepEqual(tokens.dtCard.value, { h: 0, v: 2, b: 8, s: 0, c: 'rgba(0, 0, 0, 0.15)' })
  assert.equal(errors.length, 3)
})

/*
 * The fragment
 */

/**
 * What HTML2QUX gives for a screen: one screen, absolute widgets, private
 * keys of the importer.
 */
function importedApp (n = 1) {
  return {
    screens: {
      s10005_1: { id: 's10005_1', name: 'Screen', x: 0, y: 0, w: 375, h: 812, min: { w: 375, h: 812 }, props: {}, style: { background: '#ffffff' }, children: ['w10001_1', 'w10002_1', 'w10003_1', 'w10004_1'] }
    },
    widgets: {
      w10001_1: { id: 'w10001_1', type: 'Label', x: 24, y: 24, w: 300, h: 30, z: 1, _tag: 'H1', props: { label: `Title ${n}` }, style: { color: '#111827' } },
      w10002_1: { id: 'w10002_1', type: 'Button', x: 24, y: 80, w: 300, h: 48, z: 2, _sourceId: 'qux-link-1', props: { label: 'Next' }, style: { background: '#2563eb', color: '#ffffff' } },
      w10003_1: { id: 'w10003_1', type: 'Image', x: 24, y: 140, w: 48, h: 48, z: 3, props: {}, style: { externalImageURL: `${HOST}${FILES_PREFIX}logo.png` } },
      w10004_1: { id: 'w10004_1', type: 'Image', x: 24, y: 200, w: 48, h: 48, z: 4, props: {}, style: { externalImageURL: 'https://example.com/photo.jpg' } }
    },
    groups: {
      g1: { id: 'g1', name: 'Header', children: ['w10001_1', 'w10002_1'], groups: [] },
      g2: { id: 'g2', name: 'Empty', children: [], groups: [] }
    },
    importInfo: { scrollWidth: 375, width: 375, overflowingElements: [] }
  }
}

function existingApp () {
  return {
    lastUUID: 20000,
    screens: {
      sHome: { id: 'sHome', name: 'Home', x: 100, y: 50, w: 375, h: 812, props: { start: true }, children: ['wOld'] }
    },
    widgets: { wOld: { id: 'wOld', type: 'Label', x: 110, y: 60, w: 10, h: 10, z: 7, style: { color: '#2563eb' } } },
    designtokens: { dtPrimary: { id: 'dtPrimary', name: 'Primary', type: 'color', role: 'primary', value: '#2563eb' } }
  }
}

test('buildFragment() gives new ids and places the screens right of the others', () => {
  const model = existingApp()
  const { fragment, screens, warnings } = buildFragment(model, [
    { name: 'Login', app: importedApp(1), links: [{ qid: 'qux-link-1', to: 'home' }] },
    { name: 'Home', app: importedApp(2), links: [{ qid: 'qux-link-1', to: 'Login' }] }
  ], { images: new Map([['logo.png', { url: 'app1/abc.png', w: 96, h: 96 }]]) })

  assert.deepEqual(warnings, [])
  assert.equal(screens.length, 2)
  const [login, home] = screens.map(s => fragment.screens[s.id])
  assert.equal(login.name, 'Login')
  // the app has a "Home" already
  assert.equal(home.name, 'Home 2')
  assert.equal(login.x, 100 + 375 + SCREEN_GAP * 2)
  assert.equal(home.x, login.x + 375 + SCREEN_GAP)
  assert.equal(login.y, 50)
  // the app has a start screen
  assert.equal(login.props.start, false)

  // every id is new, from lastUUID on
  Object.keys(fragment.widgets).forEach(id => assert.match(id, /^w2\d{4}_\d+$/))
  assert.ok(fragment.lastUUID > 20000)
  const title = fragment.widgets[login.children[0]]
  assert.equal(title.props.label, 'Title 1')
  assert.equal(title.x, login.x + 24)
  assert.equal(title.y, 50 + 24)
  // above the widgets there are
  assert.ok(title.z > 7)

  // the empty group is dropped, the other one has the new ids
  const groups = Object.values(fragment.groups)
  assert.equal(groups.length, 2)
  groups.forEach(g => g.children.forEach(id => assert.ok(fragment.widgets[id])))

  // links between the screens of the call: "home" is the Home of the call, not the one of the app
  const lines = Object.values(fragment.lines)
  assert.equal(lines.length, 2)
  assert.equal(lines.find(l => login.children.includes(l.from)).to, home.id)
  assert.equal(lines.find(l => home.children.includes(l.from)).to, login.id)

  // the image of the call is the uploaded one, the one on the web stays
  const [logo, photo] = login.children.slice(2).map(id => fragment.widgets[id])
  assert.deepEqual(logo.style.backgroundImage, { url: 'app1/abc.png', w: 96, h: 96 })
  assert.equal(logo.style.externalImageURL, undefined)
  assert.equal(photo.style.externalImageURL, 'https://example.com/photo.jpg')

  // nothing of the importer is left
  Object.values(fragment.widgets).forEach(w => assert.ok(!Object.keys(w).some(k => k.startsWith('_'))))
})

test('buildFragment() links to the design system and never makes a token beside it', () => {
  const { fragment } = buildFragment(existingApp(), [{ name: 'Login', app: importedApp(), links: [{ qid: 'qux-link-1', to: 'home' }] }])
  const button = Object.values(fragment.widgets).find(w => w.type === 'Button')
  assert.deepEqual(button.designtokens, { style: { background: 'dtPrimary' } })
  assert.deepEqual(fragment.designtokens, {})
  // a link to a screen of the app
  assert.equal(Object.values(fragment.lines)[0].to, 'sHome')
})

test('buildFragment() makes a design system for an app without one', () => {
  const model = { lastUUID: 10000, screens: {}, widgets: {}, designtokens: {} }
  const { fragment } = buildFragment(model, [
    { name: 'A', app: importedApp(1) },
    { name: 'B', app: importedApp(2) },
    { name: 'C', app: importedApp(3) }
  ])
  const tokens = Object.values(fragment.designtokens)
  assert.ok(tokens.some(t => t.type === 'color' && t.value === '#2563eb'))
  const screens = Object.values(fragment.screens)
  assert.equal(screens[0].x, 0)
  // the first screen of an empty app is the start screen
  assert.deepEqual(screens.map(s => s.props.start), [true, false, false])
})

test('buildFragment() warns about what did not work', () => {
  const app = importedApp()
  app.importInfo = { scrollWidth: 500, width: 375, overflowingElements: [{}, {}] }
  const { screens, warnings } = buildFragment(existingApp(), [{ name: 'Login', app, links: [{ qid: 'qux-link-1', to: 'Nowhere' }, { qid: 'gone', to: 'Home' }] }])
  assert.match(screens[0].warnings[0], /500px wide.*2 elements stick out/)
  assert.match(screens[0].warnings[1], /"logo.png" is not in images/)
  assert.match(screens[0].warnings[2], /data-link="Home" became no element/)
  assert.match(warnings[0], /links to "Nowhere"/)
})

/*
 * createScreens with a fake backend and importer
 */

function fakeClient (model) {
  const calls = { uploads: [], fragments: [] }
  return {
    calls,
    resolveApp: async ref => ({ id: model.id, name: model.name }),
    getApp: async () => JSON.parse(JSON.stringify(model)),
    uploadImage: async (appId, image) => {
      calls.uploads.push(image)
      return { url: `${appId}/${image.name}`, width: 2, height: 2 }
    },
    addScreens: async (appId, fragment) => {
      calls.fragments.push(fragment)
      return { appID: appId }
    }
  }
}

test('createScreens() uploads the images the screens show and adds them in one request', async () => {
  const client = fakeClient(Object.assign(existingApp(), { id: 'app1', name: 'Shop', screenSize: { w: 375, h: 812 } }))
  const renderer = {
    parse: async (html, w, h, options) => {
      assert.equal(w, 375)
      assert.ok(options.files.has('logo.png'))
      if (html.includes('broken')) {
        throw new Error('HTML2QUX.run() > timeout')
      }
      return importedApp()
    }
  }
  const res = await createScreens({
    client,
    renderer,
    app: 'Shop',
    screens: [{ name: 'Login', html: '<div data-link="Home">Go</div>' }, { name: 'Broken', html: '<div>broken</div>' }],
    images: [
      { name: 'logo', data: PNG.toString('base64'), mimeType: 'image/png' },
      { name: 'logo.png', data: 'data:image/png;base64,' + PNG.toString('base64') },
      { name: 'unused.png', data: PNG.toString('base64') }
    ]
  })
  assert.equal(res.screens.length, 1)
  assert.match(res.warnings[0], /"Broken" could not be imported: HTML2QUX.run\(\) > timeout/)
  // only the image the screen shows, with its extension
  assert.deepEqual(client.calls.uploads.map(u => u.name), ['logo.png'])
  assert.ok(client.calls.uploads[0].data.equals(PNG))
  assert.equal(client.calls.fragments.length, 1)
  const logo = Object.values(client.calls.fragments[0].widgets).find(w => w.style.backgroundImage)
  assert.equal(logo.style.backgroundImage.url, 'app1/logo.png')
})

test('createScreens() checks the input before it does anything', async () => {
  const client = fakeClient(existingApp())
  const renderer = { parse: async () => assert.fail('no parse') }
  await assert.rejects(createScreens({ client, renderer, app: 'x', screens: [] }), ApiError)
  await assert.rejects(createScreens({ client, renderer, app: 'x', screens: Array(11).fill({ name: 'a', html: 'b' }) }), /At most 10 screens/)
  await assert.rejects(createScreens({ client, renderer, app: 'x', screens: [{ name: 'a', html: 'b' }], images: [{ name: 'a.exe', data: 'AAAA' }] }), /use PNG/)
})

/*
 * The importer of the editor in Chromium
 */

const renderer = new Renderer()
let hasChromium = true
try {
  await renderer.getBrowser()
} catch (e) {
  hasChromium = false
}
after(() => renderer.close())

test('Renderer.parse() imports a screen with the importer of the editor', { skip: !hasChromium && 'no Chromium (npx playwright install chromium)' }, async () => {
  const { html, links } = prepareHTML(loginHTML)
  const app = await renderer.parse(html, 375, 812, { files: new Map([['logo.png', { data: PNG, mimeType: 'image/png' }]]) })
  const widgets = Object.values(app.widgets)
  const labels = widgets.map(w => w.props && w.props.label).filter(Boolean)
  // the script of the HTML did not run
  assert.ok(labels.includes('Welcome back'))
  assert.ok(labels.includes('Log in'))
  assert.ok(widgets.some(w => w.type === 'TextBox'))
  assert.ok(widgets.some(w => w.type === 'Password'))
  const logo = widgets.find(w => w.type === 'Image')
  assert.equal(toFileName(logo.style.externalImageURL), 'logo.png')
  assert.equal(logo.w, 48)
  assert.ok(widgets.some(w => w._sourceId === links[0].qid))
  assert.equal(app.importInfo.scrollWidth, 375)
})

test('Renderer.parse() reaches no network', { skip: !hasChromium && 'no Chromium' }, async () => {
  const requests = []
  const server = (await import('http')).createServer((req, res) => {
    requests.push(req.url)
    res.end('x')
  })
  await new Promise(resolve => server.listen(0, resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const { html } = prepareHTML(`<body><img src="${url}/img.png" style="width:10px;height:10px"><div style="background:url(${url}/bg.png)">x</div><link rel="stylesheet" href="${url}/x.css"></body>`)
    await renderer.parse(html, 375, 812, {})
    assert.deepEqual(requests, [])
  } finally {
    server.close()
  }
})
