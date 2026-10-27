import { extractDesignTokens, hasDesignSystem } from '../../vendor/editor.js'
import { toFileName } from './html.js'

/**
 * The gap between screens on the canvas, like the editor agent places them
 * (AIConfig.layout.screenGap).
 */
export const SCREEN_GAP = 64

/**
 * Turns the screens HTML2QUX made into a fragment that can be added to the
 * app (POST /rest/ai/apps/:appID/screens.json), the way the editor adds the
 * result of its own agent (AIController.addAiResult):
 *
 *  - new ids from the lastUUID of the app (Screen._createScreenAndWidgets)
 *  - the screens in a row right of the screens there are
 *  - data-link elements become links to their screen
 *  - the images of the call replace the URLs the importer saw
 *  - the widgets are linked to the design tokens of the app, and when the
 *    app has no design system, the values used often become one
 *    (DesignTokenExtractor, as in AIController._linkAiDesignTokens)
 *
 * @param {object} model the app as it is now
 * @param {Array<{name: string, app: object, links?: Array<{qid, to}>}>} parsed one per screen
 * @param {{images?: Map<string, {url: string, w: number, h: number}>}} options
 * @returns {{fragment: object, screens: Array<{id, name, widgets, warnings}>, warnings: string[]}}
 */
export function buildFragment (model, parsed, options = {}) {
  const images = options.images || new Map()
  let lastUUID = Number(model.lastUUID) || 10000
  const getUUID = () => lastUUID++ + '_' + Math.round(Math.random() * 100000)

  const fragment = { screens: {}, widgets: {}, groups: {}, lines: {}, designtokens: {} }
  const report = []
  const warnings = []
  const pendingLinks = []

  const takenNames = new Set(Object.values(model.screens || {}).map(s => s.name))
  const hasStart = Object.values(model.screens || {}).some(s => s.props && s.props.start)
  let z = maxZ(model.widgets) + 1
  const origin = getStartPosition(model)
  let x = origin.x

  parsed.forEach(({ name, app, links = [] }, index) => {
    const source = Object.values(app.screens || {})[0]
    if (!source) {
      throw new Error(`The importer made no screen of "${name}"`)
    }
    const screenWarnings = getImportWarnings(app, source)
    const dx = x - source.x
    const dy = origin.y - source.y

    const widgetIds = {}
    Object.keys(app.widgets || {}).forEach(oldId => {
      const widget = app.widgets[oldId]
      const id = 'w' + getUUID()
      widgetIds[oldId] = id
      widget.id = id
      widget.x += dx
      widget.y += dy
      widget.z = z++
      setImage(widget, images, screenWarnings)
      fragment.widgets[id] = widget
    })

    const screenId = 's' + getUUID()
    const screen = Object.assign({}, source, {
      id: screenId,
      name: uniqueName(name, takenNames),
      x: source.x + dx,
      y: source.y + dy,
      children: (source.children || []).filter(id => widgetIds[id]).map(id => widgetIds[id])
    })
    screen.props = Object.assign({}, screen.props, { start: !hasStart && index === 0 })
    fragment.screens[screenId] = screen
    x += screen.w + SCREEN_GAP

    addGroups(app.groups || {}, widgetIds, fragment.groups, getUUID)

    links.forEach(link => {
      const widget = Object.values(fragment.widgets).find(w => w._sourceId === link.qid && screen.children.includes(w.id))
      if (widget) {
        pendingLinks.push({ from: widget.id, to: link.to, screen: screen.name })
      } else {
        screenWarnings.push(`The element with data-link="${link.to}" became no element of its own, so it links nowhere`)
      }
    })

    report.push({ id: screenId, name: screen.name, requested: name, widgets: screen.children.length, warnings: screenWarnings })
  })

  pendingLinks.forEach(link => {
    const to = findScreen(link.to, report, model)
    if (!to) {
      warnings.push(`"${link.screen}" links to "${link.to}", which is no screen of the app or of this call`)
      return
    }
    const id = 'l' + getUUID()
    fragment.lines[id] = { id, from: link.from, to, points: [], event: 'click' }
  })

  linkDesignTokens(model, fragment)
  ;[fragment.screens, fragment.widgets, fragment.groups].forEach(removePrivateKeys)
  fragment.lastUUID = lastUUID
  return { fragment, screens: report, warnings }
}

/**
 * The widgets link to the tokens of the app, like the editor links the
 * result of its agent: on a copy of the app, then the new tokens and the
 * linked widgets are taken back.
 */
function linkDesignTokens (model, fragment) {
  const merged = {
    screens: Object.assign({}, model.screens, fragment.screens),
    widgets: Object.assign({}, model.widgets, fragment.widgets),
    designtokens: Object.assign({}, model.designtokens)
  }
  const ids = Object.keys(fragment.widgets).concat(Object.keys(fragment.screens))
  extractDesignTokens(merged, {
    ids,
    minCount: 2,
    snap: true,
    create: !hasDesignSystem(model)
  })
  Object.keys(merged.designtokens).forEach(id => {
    if (!model.designtokens || !model.designtokens[id]) {
      fragment.designtokens[id] = merged.designtokens[id]
    }
  })
}

/**
 * Only groups with members are kept, with the new ids (see
 * Screen._createScreenAndWidgets).
 */
function addGroups (groups, widgetIds, result, getUUID) {
  const groupIds = {}
  Object.keys(groups).forEach(oldId => {
    groupIds[oldId] = 'g' + getUUID()
  })
  const grouped = new Set()
  Object.keys(groups).forEach(oldId => {
    const group = groups[oldId]
    const children = (group.children || []).filter(id => widgetIds[id] && !grouped.has(widgetIds[id])).map(id => widgetIds[id])
    children.forEach(id => grouped.add(id))
    const subGroups = (group.groups || []).filter(id => groupIds[id]).map(id => groupIds[id])
    if (children.length === 0 && subGroups.length === 0) {
      return
    }
    const id = groupIds[oldId]
    result[id] = Object.assign({}, group, { id, children, groups: subGroups })
  })
  // a sub group that was dropped is no member
  Object.values(result).forEach(group => {
    group.groups = group.groups.filter(id => result[id])
  })
}

/**
 * An image of the call becomes an image of the app (uploaded before). An
 * image on the web stays a link, the canvas shows it from there.
 */
function setImage (widget, images, warnings) {
  const style = widget.style
  if (!style || !style.externalImageURL) {
    return
  }
  const name = toFileName(style.externalImageURL)
  if (name === null) {
    return
  }
  delete style.externalImageURL
  const image = images.get(name)
  if (image) {
    style.backgroundImage = { url: image.url, w: image.w, h: image.h }
  } else if (name) {
    warnings.push(`The image "${name}" is not in images, the element is an empty image`)
  }
}

function getImportWarnings (app, screen) {
  const warnings = []
  const info = app.importInfo || {}
  if (info.scrollWidth > info.width) {
    const elements = (info.overflowingElements || []).length
    warnings.push(`The content is ${info.scrollWidth}px wide, wider than the screen (${info.width}px)${elements ? `: ${elements} elements stick out` : ''}. Make the layout fit the width.`)
  }
  if (info.textOverflows && info.textOverflows.length) {
    warnings.push(`${info.textOverflows.length} texts do not fit their box on the canvas`)
  }
  if (!screen.children || screen.children.length === 0) {
    warnings.push('The screen has no elements')
  }
  return warnings
}

/**
 * Right of the screens there are, aligned with the top one, or 0,0 in an
 * empty app.
 */
function getStartPosition (model) {
  const screens = Object.values(model.screens || {})
  if (screens.length === 0) {
    return { x: 0, y: 0 }
  }
  return {
    x: Math.max(...screens.map(s => (s.x || 0) + (s.w || 0))) + SCREEN_GAP * 2,
    y: Math.min(...screens.map(s => s.y || 0))
  }
}

function findScreen (ref, created, model) {
  const needle = String(ref).trim().toLowerCase()
  const own = created.find(s => s.name.toLowerCase() === needle || s.requested.toLowerCase() === needle || s.id === ref)
  if (own) {
    return own.id
  }
  const existing = Object.values(model.screens || {}).find(s => s.id === ref || String(s.name || '').toLowerCase() === needle)
  return existing ? existing.id : null
}

function uniqueName (name, taken) {
  const base = String(name || 'Screen').trim().substring(0, 80) || 'Screen'
  let result = base
  let i = 2
  while (taken.has(result)) {
    result = `${base} ${i++}`
  }
  taken.add(result)
  return result
}

function maxZ (widgets) {
  return Object.values(widgets || {}).reduce((max, w) => Math.max(max, Number(w.z) || 0), 0)
}

/**
 * What the importer keeps for itself (_tag, _className, _sourceId...) is
 * not part of the model.
 */
function removePrivateKeys (items) {
  Object.values(items).forEach(item => {
    Object.keys(item).forEach(key => {
      if (key.startsWith('_')) {
        delete item[key]
      }
    })
  })
}
