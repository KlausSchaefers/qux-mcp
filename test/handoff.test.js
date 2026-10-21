import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  findScreen, getScreens, getFlows, getTokens, getTokenList, getRules, getScreenHTML, getComponents,
  getScreenHandoff, getDesignSystemSummary, getImages
} from '../src/handoff/DesignHandoff.js'
import { AgentHTML } from '../src/handoff/AgentHTML.js'
import { designSystemCSS, getTokenReferences } from '../src/handoff/tokens.js'
import { QUX2HTML } from '../vendor/editor.js'

/**
 * The design of an app for agents (src/handoff) on top of the editor code
 * (vendor/editor.js): the handoff, the tokens and what AgentHTML adds to
 * the HTML of the editor.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const demo = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/agent_demo_1.json'), 'utf8'))

function getModel () {
  const model = JSON.parse(JSON.stringify(demo))
  // the tokens of the demo stay, its widgets link to them
  Object.values(model.designtokens).forEach(t => { t.suggested = { source: 'ai' } })
  Object.assign(model.designtokens, {
    dtPrimary: { id: 'dtPrimary', name: 'Primary', type: 'color', role: 'primary', value: '#2563eb' },
    dtText: { id: 'dtText', name: 'Text', type: 'color', value: '#111827' },
    dtBody: { id: 'dtBody', name: 'Body', type: 'text', role: 'body', value: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, lineHeight: 1.5 } },
    dtRadius: { id: 'dtRadius', name: 'Medium', type: 'radius', value: 8 },
    dtAI: { id: 'dtAI', name: 'Success', type: 'color', value: '#16a34a', suggested: { source: 'ai' } }
  })
  return model
}

/*
 * The handoff
 */

test('findScreen() by id and by name', () => {
  const model = getModel()
  const first = Object.values(model.screens)[0]
  assert.equal(findScreen(model, first.id), first)
  assert.equal(findScreen(model, first.name.toUpperCase()), first)
  assert.equal(findScreen(model, 'no such screen'), null)
})

test('getScreens() lists the screens with the start screen', () => {
  const model = getModel()
  const screens = getScreens(model)
  assert.equal(screens.length, Object.keys(model.screens).length)
  assert.ok(screens.some(s => s.isStart))
  assert.ok(screens[0].elements > 0)
})

test('getFlows() follows logic nodes to the screens', () => {
  // the demo: button "Box 5" > A/B test "AB" (LogicOr, off the screens) > Checkin 1 or Checkin 2
  const flows = getFlows(getModel())
  assert.equal(flows.length, 2)
  flows.forEach(flow => {
    assert.equal(flow.from.screen, 'Start 1')
    assert.equal(flow.from.element, 'Box 5')
    assert.deepEqual(flow.via, [{ id: 'w10692_243', name: 'AB', type: 'LogicOr' }])
    assert.equal(flow.event, 'click')
  })
  assert.deepEqual(flows.map(f => f.to.screen).sort(), ['Checkin 1', 'Checkin 2'])
})

test('getFlows() links to screens and elements directly', () => {
  const model = {
    screens: {
      s1: { id: 's1', name: 'Home', children: ['w1'] },
      s2: { id: 's2', name: 'Detail', children: ['w2'] }
    },
    widgets: { w1: { id: 'w1', name: 'Open', type: 'Button' }, w2: { id: 'w2', name: 'Title', type: 'Label' } },
    lines: {
      l1: { id: 'l1', from: 'w1', to: 's2', event: 'click' },
      l2: { id: 'l2', from: 's2', to: 'w2' },
      l3: { id: 'l3', from: 'w1', to: 'gone' }
    }
  }
  const flows = getFlows(model)
  assert.equal(flows[0].from.screen, 'Home')
  assert.equal(flows[0].from.element, 'Open')
  assert.equal(flows[0].to.screen, 'Detail')
  assert.deepEqual(flows[0].via, [])
  assert.equal(flows[1].from.elementId, null)
  assert.equal(flows[1].to.element, 'Title')
  assert.equal(flows[1].event, 'click')
  assert.deepEqual(flows[2].to, { screenId: 'gone', screen: null })
})

test('getTokens() as css and json, without the AI suggestions', () => {
  const model = getModel()
  const css = getTokens(model, 'css')
  assert.ok(css.includes('--color-primary: #2563eb;'))
  assert.ok(css.includes('--radius-medium: 8px;'))
  assert.ok(css.includes('.text-body'))
  assert.ok(!css.includes('#16a34a'))

  const json = getTokenList(model)
  assert.ok(json.find(t => t.id === 'dtPrimary').usage.includes('primary buttons'))
  assert.equal(json.find(t => t.id === 'dtAI'), undefined)
  assert.deepEqual(getTokens(model, 'json'), json)

  const summary = getDesignSystemSummary(model)
  assert.equal(summary.hasDesignSystem, true)
  assert.equal(summary.tokens, 4)
})

test('getTokens() is empty without a design system', () => {
  const model = getModel()
  model.designtokens = {}
  assert.equal(getTokens(model, 'css'), '')
  assert.equal(getRules(model), '')
  assert.deepEqual(getTokens(model, 'json'), [])
})

test('getRules() are the rules of the editor agent with the names of the HTML', () => {
  const model = getModel()
  // the role is taken twice, so the HTML names these tokens after their name
  model.designtokens.dtPrimary2 = { id: 'dtPrimary2', name: 'Brand Dark', type: 'color', role: 'primary', value: '#1e40af' }
  const rules = getRules(model)
  assert.ok(rules.includes('## Design system'))
  assert.ok(rules.includes(designSystemCSS(model)))
  assert.ok(rules.includes('--color-brand-dark: #1e40af;'))
})

test('getScreenHTML() renders a document with widget ids', () => {
  const model = getModel()
  const screen = Object.values(model.screens)[0]
  const html = getScreenHTML(model, screen.name)
  assert.ok(html.includes('<!doctype html>'))
  assert.ok(html.includes('data-qid='))
  assert.equal(getScreenHTML(model, 'nope'), null)
})

test('getScreenHTML() writes tokens, icons and states for agents', () => {
  // the demo as it is: its widgets link to its own tokens
  const model = JSON.parse(JSON.stringify(demo))
  const start = Object.values(model.screens)[0]
  const html = getScreenHTML(model, start.id)
  assert.ok(html.includes('var(--color-buttongreen)'))
  assert.ok(html.includes('/* design tokens */'))
  assert.ok(html.includes('<i class="mdi mdi-menu '))
  const checkin = Object.values(model.screens).find(s => s.name === 'Checkin 1')
  assert.match(getScreenHTML(model, checkin.id), /\.st\d+:focus \{/)
})

test('getImages() lists the pictures with their link', () => {
  const model = getModel()
  const start = Object.values(model.screens)[0]
  model.widgets.img = { id: 'img', name: 'Photo', type: 'Image', x: 0, y: 0, w: 100, h: 50, style: { backgroundImage: { url: 'app/p.png' } } }
  model.widgets.ext = { id: 'ext', name: 'Logo', type: 'Image', x: 0, y: 0, w: 10, h: 10, style: { backgroundImage: { url: 'https://cdn.example.com/logo.png' } } }
  start.children.push('img', 'ext')
  const images = getImages(model, start.id, path => `https://dl.example.com/${path}`)
  assert.deepEqual(images, [
    { elementId: 'img', element: 'Photo', path: 'app/p.png', url: 'https://dl.example.com/app/p.png', w: 100, h: 50 },
    { elementId: 'ext', element: 'Logo', path: null, url: 'https://cdn.example.com/logo.png', w: 10, h: 10 }
  ])
  assert.equal(getImages(model, start.id)[0].url, null)
  const handoff = getScreenHandoff(model, start.id, { imageUrl: path => `https://dl.example.com/${path}` })
  assert.ok(handoff.html.includes('src="https://dl.example.com/app/p.png"'))
  assert.equal(handoff.images.length, 2)
})

test('getComponents() and getScreenHandoff()', () => {
  const model = getModel()
  const components = getComponents(model)
  assert.ok(components.length > 0)
  assert.equal(components[0].variants[0].states[0].state, 'style')

  const screen = Object.values(model.screens)[0]
  const handoff = getScreenHandoff(model, screen.id)
  assert.equal(handoff.screen.name, screen.name)
  assert.ok(handoff.tokensCSS.includes('--color-primary'))
  assert.ok(handoff.html.includes('<!doctype html>'))
  assert.ok(handoff.flows.every(f => f.from.screenId === screen.id))
  const onScreen = new Set(screen.children)
  handoff.components.forEach(group => group.variants.forEach(v => {
    assert.ok(v.elementIds.every(id => onScreen.has(id)))
  }))
})

/*
 * AgentHTML: the HTML of the editor plus icons, tokens, states and images
 */

let z = 1
beforeEach(() => { z = 1 })

function widget (id, type, x, y, w, h, extra = {}) {
  return Object.assign({
    id, name: id, type, x, y, w, h, z: z++,
    props: {},
    has: {},
    style: { fontSize: 14, color: '#000000' }
  }, extra)
}

function makeModel (widgets, designtokens = {}) {
  const byId = {}
  widgets.forEach(w => { byId[w.id] = w })
  return {
    id: 'app',
    screenSize: { w: 400, h: 800 },
    screens: { s1: { id: 's1', name: 'S', x: 0, y: 0, w: 400, h: 800, min: { w: 400, h: 800 }, children: widgets.map(w => w.id), props: {}, has: {}, style: { background: '#ffffff' } } },
    widgets: byId,
    groups: {},
    lines: {},
    templates: {},
    designtokens
  }
}

function render (model, options) {
  return new AgentHTML(options).toHTML(model, 's1')
}

// the CSS of the class rules of the element with this data-qid
function cssOf (html, id) {
  const classes = tagOf(html, id).match(/class="([^"]*)"/)[1].split(' ')
  return classes.map(c => {
    const rule = html.match(new RegExp(`\\.${c} \\{([^}]*)\\}`))
    return rule ? rule[1] : ''
  }).join('')
}

function tagOf (html, id) {
  return html.match(new RegExp(`<[^>]*data-qid="${id}"[^>]*>`))[0]
}

const TOKENS = {
  dtPrimary: { id: 'dtPrimary', name: 'Primary', type: 'color', role: 'primary', value: '#2563eb' },
  dtHero: { id: 'dtHero', name: 'Hero', type: 'color', value: { colors: [{ c: '#086cbd', p: 0 }, { c: '#02b5f3', p: 100 }], gradient: true, direction: '45' } },
  dtHeading: { id: 'dtHeading', name: 'Heading', type: 'text', role: 'heading', value: { fontSize: 28, fontWeight: 700, fontFamily: 'Inter' } },
  dtRadius: { id: 'dtRadius', name: 'Medium', type: 'radius', value: 8 },
  dtSpace: { id: 'dtSpace', name: 'S', type: 'spacing', value: 16 },
  dtShadow: { id: 'dtShadow', name: 'Card', type: 'boxShadow', value: { h: 0, v: 2, b: 8, s: 0, c: 'rgba(0,0,0,0.2)' } },
  dtAI: { id: 'dtAI', name: 'Suggested', type: 'color', value: '#16a34a', suggested: { source: 'ai' } }
}

function tokenModel () {
  return makeModel([
    widget('title', 'Label', 20, 20, 300, 40, {
      props: { label: 'Welcome' },
      style: { fontSize: 28, fontWeight: 700, fontFamily: 'Inter', color: '#2563eb' },
      designtokens: { style: { fontSize: 'dtHeading', fontWeight: 'dtHeading', fontFamily: 'dtHeading', color: 'dtPrimary' } }
    }),
    widget('btn', 'Button', 20, 100, 200, 48, {
      props: { label: 'Go' },
      style: {
        fontSize: 16, color: '#ffffff', textAlign: 'center',
        background: '#2563eb',
        borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
        paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
        boxShadow: { h: 0, v: 2, b: 8, s: 0, c: 'rgba(0,0,0,0.2)' }
      },
      designtokens: {
        style: {
          background: 'dtPrimary',
          borderTopLeftRadius: 'dtRadius', borderTopRightRadius: 'dtRadius', borderBottomLeftRadius: 'dtRadius', borderBottomRightRadius: 'dtRadius',
          paddingTop: 'dtSpace', paddingBottom: 'dtSpace', paddingLeft: 'dtSpace', paddingRight: 'dtSpace',
          boxShadow: 'dtShadow'
        }
      }
    }),
    widget('hero', 'Box', 20, 200, 300, 100, {
      style: { background: TOKENS.dtHero.value },
      designtokens: { style: { background: 'dtHero' } }
    }),
    widget('ai', 'Box', 20, 320, 100, 40, {
      style: { background: '#16a34a' },
      designtokens: { style: { background: 'dtAI' } }
    })
  ], JSON.parse(JSON.stringify(TOKENS)))
}

test('AgentHTML without options is the HTML of the editor', () => {
  const model = tokenModel()
  model.widgets.icon = widget('icon', 'Icon', 300, 20, 24, 24, { style: { icon: 'mdi mdi-menu', color: '#333333' } })
  model.screens.s1.children.push('icon')
  // the ids of generated rows count up over all renders
  const withoutRowIds = html => html.replace(/data-qid="r\d+"/g, 'data-qid="r"')
  const html = render(JSON.parse(JSON.stringify(model)))
  assert.equal(withoutRowIds(html), withoutRowIds(new QUX2HTML().toHTML(JSON.parse(JSON.stringify(model)), 's1')))
  assert.ok(!html.includes('var(--'))
  assert.ok(!html.includes('materialdesignicons'))
  assert.ok(!html.includes('<i '))
  assert.ok(cssOf(html, 'btn').includes('background-color:#2563eb;'))
  assert.ok(cssOf(html, 'title').includes('font-size:28px;'))
})

test('tokens: linked values as the custom properties of the design system', () => {
  const html = render(tokenModel(), { tokens: true })
  const btn = cssOf(html, 'btn')
  assert.ok(btn.includes('background-color:var(--color-primary);'))
  assert.ok(btn.includes('border-radius:var(--radius-medium);'))
  assert.ok(btn.includes('padding:var(--space-16);'))
  assert.ok(btn.includes('box-shadow:var(--shadow-card);'))
  assert.ok(cssOf(html, 'hero').includes('background-image:var(--gradient-hero);'))
  // not in the design system: the value
  assert.ok(cssOf(html, 'ai').includes('background-color:#16a34a;'))
})

test('tokens: a text style is its class, without what the class sets', () => {
  const html = render(tokenModel(), { tokens: true })
  assert.match(tagOf(html, 'title'), /class="text-heading /)
  // the own classes of the element, without the one of the token
  const title = cssOf(html.replace(/class="text-heading /, 'class="'), 'title')
  assert.ok(!title.includes('font-size'))
  assert.ok(!title.includes('font-weight'))
  assert.ok(title.includes('color:var(--color-primary);'))
})

test('tokens: in the document with the same names', () => {
  const model = tokenModel()
  const html = render(model, { tokens: true })
  assert.ok(html.includes('/* design tokens */'))
  assert.ok(html.includes(designSystemCSS(model)))
  assert.ok(designSystemCSS(model).includes('--gradient-hero: linear-gradient('))
  assert.ok(designSystemCSS(model).includes('--shadow-card: 0px 2px 8px 0px rgba(0,0,0,0.2)'))
  assert.ok(designSystemCSS(model).includes('.text-heading { '))
})

test('getTokenReferences() names after the role, or the name when the role is taken twice', () => {
  const refs = getTokenReferences({
    designtokens: {
      a: { id: 'a', name: 'Ink', type: 'color', role: 'text', value: '#111111' },
      b: { id: 'b', name: 'Ink Light', type: 'color', role: 'text', value: '#555555' },
      c: { id: 'c', name: 'Brand', type: 'color', role: 'primary', value: '#2563eb' },
      d: { id: 'd', name: 'Space A', type: 'spacing', value: 8 },
      e: { id: 'e', name: 'Space B', type: 'spacing', value: 8 }
    }
  })
  assert.equal(refs.a.variable, '--color-ink')
  assert.equal(refs.b.variable, '--color-ink-light')
  assert.equal(refs.c.variable, '--color-primary')
  // the same value shares the name
  assert.equal(refs.d.variable, '--space-8')
  assert.equal(refs.e.variable, '--space-8')
})

test('getTokenReferences() numbers two tokens that would get the same name', () => {
  const refs = getTokenReferences({
    designtokens: {
      a: { id: 'a', name: 'Card', type: 'radius', value: 8 },
      b: { id: 'b', name: 'card', type: 'radius', value: 12 }
    }
  })
  assert.equal(refs.a.variable, '--radius-card')
  assert.equal(refs.b.variable, '--radius-card-2')
})

test('icons: an Icon in the icon font of the canvas', () => {
  const model = makeModel([
    widget('icon', 'Icon', 20, 20, 32, 32, { style: { icon: 'mdi mdi-menu', color: '#333333', borderTopWidth: 2, borderBottomWidth: 2 } })
  ])
  const html = render(model, { icons: true })
  assert.match(tagOf(html, 'icon'), /^<i class="mdi mdi-menu /)
  assert.ok(tagOf(html, 'icon').includes('aria-hidden="true"'))
  assert.ok(cssOf(html, 'icon').includes('font-size:28px;'))
  assert.ok(cssOf(html, 'icon').includes('color:#333333;'))
  assert.ok(html.includes('@mdi/font@5.9.55/css/materialdesignicons.min.css'))
})

test('icons: only icon classes', () => {
  const model = makeModel([
    widget('icon', 'Icon', 20, 20, 24, 24, { style: { icon: 'mdi-home" onclick="x', iconSizeFactor: 0.5 } })
  ])
  const html = render(model, { icons: true })
  assert.match(tagOf(html, 'icon'), /^<i class="mdi mdi-home /)
  assert.ok(!html.includes('onclick'))
  assert.ok(cssOf(html, 'icon').includes('font-size:12px;'))
})

test('states: as rules, shared by the same look', () => {
  const state = { background: '#ebf5ff', borderTopWidth: 1, borderBottomWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderTopColor: '#2563eb' }
  const model = makeModel([
    widget('a', 'TextBox', 20, 20, 200, 40, { props: { label: 'Name' }, focus: state, error: { borderTopColor: '#cc0000' } }),
    widget('b', 'TextBox', 20, 80, 200, 40, { props: { label: 'Mail' }, focus: state })
  ])
  const html = render(model, { states: true })
  const focusRule = html.match(/\.(st\d+):focus \{([^}]*)\}/)
  assert.ok(focusRule[2].includes('background-color:#ebf5ff;'))
  assert.ok(focusRule[2].includes('border-style:solid;'))
  assert.ok(tagOf(html, 'a').includes(focusRule[1]))
  assert.ok(tagOf(html, 'b').includes(focusRule[1]))
  assert.match(html, /\.st\d+\.is-error \{ border-top-color:#cc0000; \}/)
  assert.ok(!render(model).includes(':focus'))
})

test('images: imageUrl for a server path', () => {
  const model = makeModel([
    widget('img', 'Image', 20, 20, 200, 100, { style: { backgroundImage: { url: 'app/photo.png', w: 200, h: 100 } } })
  ])
  assert.ok(!tagOf(render(model), 'img').includes('src='))
  const html = render(model, { imageUrl: url => `https://assets.example.com/${url}` })
  assert.ok(tagOf(html, 'img').includes('src="https://assets.example.com/app/photo.png"'))
})
