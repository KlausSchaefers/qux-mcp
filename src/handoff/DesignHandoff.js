/**
 * The design of an app as a coding agent needs it, from the app model alone
 * (no DOM, no canvas): the screens and how they link, the design tokens as
 * CSS or JSON, the HTML of a screen and its components. It builds on the
 * code of the editor (vendor/editor.js), so the agent sees what the editor
 * agent works with.
 */
import {
  describeDesignSystem, editorDesignSystemCSS, getDesignSystemTokens, getSuggestedTokens, hasDesignSystem,
  getRole, toCSS, ROLE_USAGE, TOKEN_TYPES, getElementGroups
} from '../../vendor/editor.js'
import { AgentHTML } from './AgentHTML.js'
import { designSystemCSS } from './tokens.js'

/**
 * A screen by id or by name (case insensitive), null when there is none.
 */
export function findScreen (model, ref) {
  if (!model || !model.screens || ref === undefined || ref === null) {
    return null
  }
  if (model.screens[ref]) {
    return model.screens[ref]
  }
  const name = String(ref).trim().toLowerCase()
  return Object.values(model.screens).find(s => String(s.name || '').trim().toLowerCase() === name) || null
}

export function getScreens (model) {
  if (!model || !model.screens) {
    return []
  }
  return Object.values(model.screens).map(s => ({
    id: s.id,
    name: s.name,
    w: s.w,
    h: s.h,
    isStart: !!(s.props && s.props.start) || s.id === model.startScreen,
    elements: (s.children || []).length,
    masterScreens: s.parents || []
  }))
}

// a link may pass logic nodes (A/B test, rules...), each one a hop
const MAX_HOPS = 5

/**
 * The links between screens: which element leads to which screen on which
 * event. A link to a logic node off the screens (an A/B test, a rule) is
 * followed to the screens it leads to, the nodes on the way are in "via".
 * screenNames can name screens that are not in the model (a screen model
 * of the API only has its own screen).
 */
export function getFlows (model, screenNames = {}) {
  if (!model || !model.lines) {
    return []
  }
  const screens = model.screens || {}
  const widgets = model.widgets || {}
  const screenOfWidget = {}
  Object.values(screens).forEach(s => {
    (s.children || []).forEach(id => { screenOfWidget[id] = s.id })
  })
  const nameOf = (id) => screens[id] ? screens[id].name : (screenNames[id] || null)
  const isOnScreen = (id) => !!screens[id] || !!screenOfWidget[id]
  const isLogicNode = (id) => !!widgets[id] && !screenOfWidget[id]

  const outgoing = {}
  Object.values(model.lines)
    .filter(line => line && line.from && line.to)
    .forEach(line => {
      (outgoing[line.from] = outgoing[line.from] || []).push(line)
    })

  const node = (id) => ({ id, name: widgets[id].name, type: widgets[id].type })

  /**
     * Where a target ends: a screen, an element on a screen, or the
     * screens behind a logic node.
     */
  const resolve = (id, via, seen) => {
    if (isLogicNode(id) && via.length < MAX_HOPS && !seen.has(id)) {
      seen.add(id)
      const next = (outgoing[id] || []).flatMap(line => resolve(line.to, via.concat([node(id)]), seen))
      if (next.length > 0) {
        return next
      }
    }
    if (widgets[id] && screenOfWidget[id]) {
      const screenId = screenOfWidget[id]
      return [{ to: { screenId, screen: nameOf(screenId), elementId: id, element: widgets[id].name }, via }]
    }
    return [{ to: { screenId: id, screen: nameOf(id) }, via }]
  }

  const flows = []
  Object.values(model.lines)
    .filter(line => line && line.from && line.to && isOnScreen(line.from))
    .forEach(line => {
      const widget = widgets[line.from] || null
      const fromScreen = screens[line.from] ? line.from : screenOfWidget[line.from]
      const from = {
        screenId: fromScreen,
        screen: nameOf(fromScreen),
        elementId: widget ? widget.id : null,
        element: widget ? widget.name : null,
        elementType: widget ? widget.type : null
      }
      resolve(line.to, [], new Set()).forEach(target => {
        flows.push({ from, to: target.to, via: target.via, event: line.event || 'click' })
      })
    })
  return flows
}

/**
 * The curated tokens (not the AI suggestions) with their role, how to use
 * them and their CSS.
 */
export function getTokenList (model) {
  return getDesignSystemTokens(model).map(token => {
    const role = getRole(token)
    return {
      id: token.id,
      name: token.name,
      type: token.type,
      role: role || null,
      usage: role && ROLE_USAGE[role] ? ROLE_USAGE[role] : null,
      css: toCSS(token) || null,
      value: token.value
    }
  })
}

export function getDesignSystemSummary (model) {
  const tokens = getDesignSystemTokens(model)
  const counts = {}
  TOKEN_TYPES.forEach(type => {
    counts[type] = tokens.filter(t => t.type === type).length
  })
  return {
    hasDesignSystem: hasDesignSystem(model),
    tokens: tokens.length,
    suggested: getSuggestedTokens(model).length,
    byType: counts
  }
}

/**
 * The tokens as CSS (variables and text classes) or JSON. The CSS is ''
 * without a design system.
 */
export function getTokens (model, format = 'css') {
  return format === 'json' ? getTokenList(model) : designSystemCSS(model)
}

/**
 * The rules of the design system as the editor agent follows them, with the
 * CSS of the agents: the names of the HTML.
 */
export function getRules (model) {
  const rules = describeDesignSystem(model)
  const editorCSS = editorDesignSystemCSS(model)
  return editorCSS ? rules.replace(editorCSS, designSystemCSS(model)) : rules
}

/**
 * What the HTML for a coding agent carries on top of the HTML of the editor
 * agent, see AgentHTML: icons by their name, the design tokens as var(--...)
 * and classes, and the hover, focus, active and error states.
 */
export const AGENT_HTML_OPTIONS = { icons: true, tokens: true, states: true }

/**
 * A screen as one self contained HTML document. Every element has
 * data-qid="<widget id>", so the agent can refer back to it.
 *
 * @param {{imageUrl?: function(string, object): string}} options a URL for
 *   the uploaded images, which the model only has as a server path
 */
export function getScreenHTML (model, screenRef, options = {}) {
  const screen = findScreen(model, screenRef)
  if (!screen) {
    return null
  }
  return new AgentHTML(Object.assign({}, AGENT_HTML_OPTIONS, options)).toHTML(model, screen.id)
}

/**
 * The images on a screen (Image widgets and backgrounds with a picture):
 * the element, the path in the model and, with imageUrl, where to get it.
 */
export function getImages (model, screenRef, imageUrl = null) {
  const screen = findScreen(model, screenRef)
  if (!screen || !model.widgets) {
    return []
  }
  return (screen.children || [])
    .map(id => model.widgets[id])
    .filter(w => w && w.style && w.style.backgroundImage && w.style.backgroundImage.url)
    .map(w => {
      const path = w.style.backgroundImage.url
      const isAbsolute = /^(https?:|data:)/.test(path)
      return {
        elementId: w.id,
        element: w.name,
        path: isAbsolute ? null : path,
        url: isAbsolute ? path : (imageUrl ? imageUrl(path, w) : null),
        w: w.w,
        h: w.h
      }
    })
}

/**
 * The components of the app: the kinds of elements (buttons, inputs...)
 * with their variants as they are used on the canvas, their tokens and
 * the style of each state (default, hover, focus, error). With
 * onlyElementIds, only the variants used by these elements.
 */
export function getComponents (model, onlyElementIds = null) {
  const tokens = model && model.designtokens ? model.designtokens : {}
  const isUsed = variant => !onlyElementIds || variant.widgetIds.some(id => onlyElementIds.has(id))
  return getElementGroups(model).map(group => ({
    kind: group.kind.label,
    variants: group.variants.filter(isUsed).map(variant => ({
      id: variant.id,
      label: variant.label,
      type: variant.type,
      uses: variant.count,
      elementIds: onlyElementIds
        ? variant.widgetIds.filter(id => onlyElementIds.has(id))
        : variant.widgetIds.slice(0, 5),
      tokens: (variant.tokenIds || [])
        .map(id => tokens[id])
        .filter(Boolean)
        .map(t => ({ name: t.name, type: t.type, css: toCSS(t) || null })),
      states: variant.states.map(state => ({
        state: state.id,
        label: state.label,
        style: state.box ? state.box.style : null
      }))
    }))
  }))
}

/**
 * Everything to implement one screen in one go: the rules and tokens of the
 * design system, the HTML, the components on the screen, its images and
 * where its elements lead to.
 *
 * @param {{screenNames?: object, imageUrl?: function}} options
 */
export function getScreenHandoff (model, screenRef, options = {}) {
  const screen = findScreen(model, screenRef)
  if (!screen) {
    return null
  }
  const components = getComponents(model, new Set(screen.children || []))
    .filter(group => group.variants.length > 0)
  const htmlOptions = options.imageUrl ? { imageUrl: options.imageUrl } : {}

  return {
    app: { id: model.id, name: model.name, type: model.type, screenSize: model.screenSize },
    screen: { id: screen.id, name: screen.name, w: screen.w, h: screen.h },
    designSystem: getDesignSystemSummary(model),
    rules: getRules(model),
    tokensCSS: designSystemCSS(model),
    html: getScreenHTML(model, screen.id, htmlOptions),
    components,
    images: getImages(model, screen.id, options.imageUrl),
    flows: getFlows(model, options.screenNames || {}).filter(f => f.from.screenId === screen.id)
  }
}

