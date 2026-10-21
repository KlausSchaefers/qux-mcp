import { QUX2HTML } from '../../vendor/editor.js'
import { getTokenReferences, designSystemCSS } from './tokens.js'

/**
 * The icon font of the canvas (src/style/css/material17 of the app,
 * Material Design Icons 5.9.55), so the class names of the icons match.
 */
const MDI_STYLESHEET = 'https://cdn.jsdelivr.net/npm/@mdi/font@5.9.55/css/materialdesignicons.min.css'

/**
 * The states of a widget (widget.hover, widget.focus...) and their selector.
 * An error is a class, the code sets it when a field is invalid.
 */
const STATE_SELECTORS = [
  ['hover', ':hover'],
  ['focus', ':focus'],
  ['active', ':active'],
  ['error', '.is-error']
]

const FONT_KEYS = ['color', 'textAlign', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'textDecoration']
const BORDER_WIDTH_KEYS = ['borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth']
const PADDING_KEYS = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']
const CSS_PROPS = {
  color: 'color',
  textAlign: 'text-align',
  fontFamily: 'font-family',
  fontSize: 'font-size',
  fontStyle: 'font-style',
  fontWeight: 'font-weight',
  letterSpacing: 'letter-spacing',
  lineHeight: 'line-height',
  textDecoration: 'text-decoration',
  borderTopColor: 'border-top-color',
  borderBottomColor: 'border-bottom-color',
  borderLeftColor: 'border-left-color',
  borderRightColor: 'border-right-color',
  borderTopWidth: 'border-top-width',
  borderBottomWidth: 'border-bottom-width',
  borderLeftWidth: 'border-left-width',
  borderRightWidth: 'border-right-width',
  borderTopLeftRadius: 'border-top-left-radius',
  borderTopRightRadius: 'border-top-right-radius',
  borderBottomLeftRadius: 'border-bottom-left-radius',
  borderBottomRightRadius: 'border-bottom-right-radius',
  paddingTop: 'padding-top',
  paddingBottom: 'padding-bottom',
  paddingLeft: 'padding-left',
  paddingRight: 'padding-right',
  opacity: 'opacity'
}

/**
 * The HTML of the editor (QUX2HTML) with what a coding agent needs on top.
 * Each option is off by default:
 *
 *  - icons:    an Icon widget as <i class="mdi mdi-..."> and the icon font,
 *              instead of an empty box
 *  - tokens:   values linked to a design token as var(--color-primary), text
 *              styles as their class (text-heading), with the :root of the
 *              tokens, see tokens.js
 *  - states:   the hover, focus, active and error styles of a widget as
 *              :hover, :focus, :active and .is-error rules
 *  - imageUrl: (url, node) => string, a URL for an image the model only has
 *              as a server path, e.g. a signed download link
 *
 * It hooks into the render steps of QUX2HTML, so the layout stays the one
 * of the editor. test/handoff.test.js checks it against the bundled editor.
 */
export class AgentHTML extends QUX2HTML {
  constructor (options = {}) {
    super()
    this.options = Object.assign({}, options)
  }

  toHTML (model, ...args) {
    this.stateToClassName = new Map()
    this.usesIcons = false
    this.tokenRefs = this.options.tokens ? getTokenReferences(model) : null
    this.tokenCSS = this.options.tokens ? designSystemCSS(model) : ''
    return super.toHTML(model, ...args)
  }

  wrapDocument (scrn, bodyHTML, nodeCSS) {
    let html = super.wrapDocument(scrn, bodyHTML, nodeCSS)
    if (this.tokenCSS) {
      // before the rules of the elements, which use the tokens
      const at = html.lastIndexOf('<style>')
      html = `${html.slice(0, at)}<style>\n/* design tokens */\n${this.tokenCSS}\n</style>\n${html.slice(at)}`
    }
    if (this.usesIcons) {
      html = html.replace('<style>', `<link rel="stylesheet" href="${MDI_STYLESHEET}">\n<style>`)
    }
    return html
  }

  renderContainer (node, parent, isRoot) {
    this.styleNode = node
    return super.renderContainer(node, parent, isRoot)
  }

  renderLeaf (node, parent) {
    if (this.options.icons && this.isIcon(node)) {
      return this.renderIcon(node, parent)
    }
    this.styleNode = node
    return super.renderLeaf(node, parent)
  }

  /**
   * An absolute URL as QUX2HTML writes it. A server path (an uploaded
   * image) or a data: URL only with imageUrl.
   */
  renderImage (node, ownGroups, posStyle) {
    const bg = node.style && node.style.backgroundImage
    const url = bg && bg.url
    if (url && url.indexOf('http') !== 0 && this.options.imageUrl) {
      const src = url.indexOf('data:') === 0 ? url : this.options.imageUrl(url, node)
      if (src) {
        this.assignClasses(node, [...ownGroups, 'object-fit:cover;'], posStyle)
        return `<img src="${this.escapeAttr(src)}" class="${this.getClassAttr(node)}"${this.getDataAttr(node)} alt="">`
      }
    }
    return super.renderImage(node, ownGroups, posStyle)
  }

  isIcon (node) {
    const icon = node.style && node.style.icon
    return typeof icon === 'string' && /(^|\s)mdi-[a-z0-9-]+/.test(icon) && !this.getLabel(node)
  }

  /**
   * An Icon widget in the icon font of the canvas, as big as the canvas
   * draws it: the height without the borders, times the iconSizeFactor.
   */
  renderIcon (node, parent) {
    const style = Object.assign({}, node.style)
    delete style.fontSize
    delete style.lineHeight
    this.styleNode = node
    const ownGroups = this.getStyleGroups(style, false)
    ownGroups.push(`display:flex;align-items:center;justify-content:center;font-size:${this.getIconSize(node)}px;line-height:1;`)
    const posStyle = `${this.getPositionStyle(node, parent)}${this.getSizeStyle(node, parent)}`
    this.assignClasses(node, ownGroups, posStyle)
    this.usesIcons = true
    return `<i class="${this.getIconClasses(node.style.icon)} ${this.getClassAttr(node)}"${this.getDataAttr(node)} aria-hidden="true"></i>`
  }

  getIconClasses (icon) {
    // only the icon classes, never anything else of the value into the attribute
    const classes = Array.from(new Set(String(icon).match(/\bmdi(-[a-z0-9]+)*\b/g) || []))
    if (!classes.includes('mdi')) {
      classes.unshift('mdi')
    }
    return classes.join(' ')
  }

  getIconSize (node) {
    const style = node.style || {}
    let size = this.toNumber(node.h, 24) - this.toNumber(style.borderTopWidth, 0) - this.toNumber(style.borderBottomWidth, 0)
    if (style.iconSizeFactor) {
      size = size * this.toNumber(style.iconSizeFactor, 1)
    }
    return Math.max(1, Math.round(size))
  }

  /**
   * The class of a text style token comes first, then the classes of
   * QUX2HTML, then the ones of the states.
   */
  assignClasses (node, ownGroups, posStyle) {
    super.assignClasses(node, ownGroups, posStyle)
    node._cssClass = (node._tokenClasses || []).concat(node._cssClass)
    if (this.options.states) {
      this.addStateClasses(node)
    }
    return node._cssClass
  }

  /**
   * A class per state look, shared by the elements with the same one:
   * .st1:hover { background-color:#ebf5ff; }. Only the properties the state
   * changes, the rest stays as in the normal state.
   */
  addStateClasses (node) {
    STATE_SELECTORS.forEach(([state, selector]) => {
      const delta = node[state]
      if (!delta || typeof delta !== 'object' || Object.keys(delta).length === 0) {
        return
      }
      const cssText = this.getStateCSS(node, state, delta)
      if (!cssText) {
        return
      }
      const key = `${selector}|${cssText}`
      let className = this.stateToClassName.get(key)
      if (!className) {
        className = this.getClassName('st')
        this.stateToClassName.set(key, className)
        this.cssRules.push(`.${className}${selector} { ${cssText} }`)
      }
      node._cssClass.push(className)
    })
  }

  getStateCSS (node, state, delta) {
    this.activeTokens = this.getNodeTokens(node, state)
    try {
      let css = ''
      Object.keys(delta).forEach(key => {
        const value = delta[key]
        if (value === undefined || value === null || value === '') {
          return
        }
        if (key === 'background' || key === 'backgroundColor') {
          css += this.getBackgroundCSS({ [key]: value })
        } else if (key === 'boxShadow') {
          css += typeof value === 'object' ? this.getShadowCSS({ boxShadow: value }) : ''
        } else if (CSS_PROPS[key]) {
          css += `${CSS_PROPS[key]}:${this.formatValue(key, value)};`
        }
      })
      // a border that appears in the state needs a style to be drawn
      if (BORDER_WIDTH_KEYS.some(k => this.toNumber(delta[k], 0) > 0)) {
        css += 'border-style:solid;'
      }
      return css
    } finally {
      this.activeTokens = null
    }
  }

  /**
   * QUX2HTML calls this with the style of the node it renders (see
   * renderContainer() and renderLeaf()), the tokens of that node apply.
   */
  getStyleGroups (style, isContainer) {
    const node = this.styleNode
    this.styleNode = null
    if (node) {
      node._tokenClasses = []
    }
    this.activeTokens = this.getNodeTokens(node, 'style')
    try {
      return super.getStyleGroups(this.withoutTextStyle(style, node), isContainer)
    } finally {
      this.activeTokens = null
    }
  }

  /**
   * The design tokens a node links its style keys to, in a state, as
   * {color: {variable: '--color-primary', css}, fontSize: {className...}}.
   * Only with the tokens option, and only tokens of the design system.
   */
  getNodeTokens (node, state) {
    if (!this.tokenRefs || !node || !node.designtokens || !node.designtokens[state]) {
      return null
    }
    const result = {}
    Object.entries(node.designtokens[state]).forEach(([key, tokenID]) => {
      if (this.tokenRefs[tokenID]) {
        result[key] = this.tokenRefs[tokenID]
      }
    })
    return Object.keys(result).length > 0 ? result : null
  }

  /**
   * A node with a text style token gets its class (text-heading) and leaves
   * out the keys the class sets.
   */
  withoutTextStyle (style, node) {
    if (!style || !this.activeTokens || !node) {
      return style
    }
    const text = FONT_KEYS.map(key => this.activeTokens[key]).find(ref => ref && ref.className)
    if (!text) {
      return style
    }
    node._tokenClasses.push(text.className)
    const result = Object.assign({}, style)
    FONT_KEYS.forEach(key => {
      if (this.activeTokens[key] === text && text.keys.includes(key)) {
        delete result[key]
      }
    })
    return result
  }

  /*
   * With tokens, the sides of a border, radius or padding are compared as
   * written, so four sides of one token become one var().
   */

  getUniformGroup (style, keys, shorthandProp) {
    if (!this.activeTokens) {
      return super.getUniformGroup(style, keys, shorthandProp)
    }
    const values = keys.map(key => style[key])
    if (values.every(v => v === undefined || v === null || v === '')) {
      return ''
    }
    const formatted = keys.map((key, i) => this.formatValue(key, values[i]))
    if (formatted.every(v => v === formatted[0])) {
      return `${shorthandProp}:${formatted[0]};`
    }
    return this.getStyleByKeys(style, keys)
  }

  getUniformSkipZero (style, keys, shorthandProp) {
    if (!this.activeTokens) {
      return super.getUniformSkipZero(style, keys, shorthandProp)
    }
    const values = keys.map(key => style[key])
    if (values.every(v => !v)) {
      return ''
    }
    const formatted = keys.map((key, i) => this.formatValue(key, values[i]))
    if (values.every(v => v) && formatted.every(v => v === formatted[0])) {
      return `${shorthandProp}:${formatted[0]};`
    }
    let css = ''
    keys.forEach((key, i) => {
      if (values[i]) {
        css += `${CSS_PROPS[key]}:${this.formatValue(key, values[i])};`
      }
    })
    return css
  }

  getPaddingCSS (style) {
    if (!this.activeTokens) {
      return super.getPaddingCSS(style)
    }
    const values = PADDING_KEYS.map(key => style[key])
    if (values.every(v => !v)) {
      return ''
    }
    const formatted = PADDING_KEYS.map((key, i) => values[i] ? this.formatValue(key, values[i]) : '0px')
    if (formatted.every(v => v === formatted[0])) {
      return `padding:${formatted[0]};`
    }
    const [top, bottom, left, right] = formatted
    return `padding:${top} ${right} ${bottom} ${left};`
  }

  getShadowCSS (style) {
    const ref = this.activeTokens && this.activeTokens.boxShadow
    if (style.boxShadow && ref && ref.variable) {
      return `box-shadow:var(${ref.variable});`
    }
    return super.getShadowCSS(style)
  }

  formatValue (key, value) {
    // linked to a token of the design system: its custom property
    const ref = this.activeTokens && this.activeTokens[key]
    if (ref && ref.variable) {
      return `var(${ref.variable})`
    }
    return super.formatValue(key, value)
  }

  getBackgroundCSS (style) {
    const ref = this.activeTokens && this.activeTokens.background
    if (!style.background || !ref || !ref.variable) {
      return super.getBackgroundCSS(style)
    }
    let css = ''
    if (typeof style.background === 'object' && style.background.colors) {
      css += `background-image:var(${ref.variable});`
    } else if (this.hasVisibleBackground(style.background)) {
      css += `background-color:var(${ref.variable});`
    }
    if (style.backgroundColor && this.hasVisibleBackground(style.backgroundColor)) {
      css += `background-color:${this.toHexColor(style.backgroundColor)};`
    }
    return css
  }
}
