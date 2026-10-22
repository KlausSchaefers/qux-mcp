import { getDesignSystemTokens, getRole, toCSS, toBackgroundCSS, isTransparentColor } from '../../vendor/editor.js'

/**
 * How the design system is written as CSS: a custom property per color,
 * gradient, radius, spacing and shadow token, and a class per text style.
 * The one place for the names, so the CSS of the tokens (designSystemCSS)
 * and the HTML of a screen (AgentHTML) always use the same ones.
 *
 * A token is named after its role when no other token of its type has the
 * same role (--color-primary), else after its name (--color-brand-blue).
 * Spacing is named after its value (--space-16). Two tokens that would get
 * the same name with different values get a number (--color-text-2).
 *
 * @returns {Object<string, {variable?: string, className?: string, css: string, keys?: string[]}>}
 *   by token id: the custom property and its value, or the class of a text
 *   style, its declarations and the style keys it sets
 */
export function getTokenReferences (model) {
  const tokens = getDesignSystemTokens(model)
  const roleCount = {}
  tokens.forEach(token => {
    const key = token.type + ':' + getRole(token)
    roleCount[key] = (roleCount[key] || 0) + 1
  })
  const slug = (token) => {
    const role = getRole(token)
    const base = role && roleCount[token.type + ':' + role] === 1 ? role : (token.name || token.id)
    return String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'token'
  }

  const taken = {}
  const claim = (name, css) => {
    let unique = name
    for (let n = 2; taken[unique] !== undefined && taken[unique] !== css; n++) {
      unique = `${name}-${n}`
    }
    taken[unique] = css
    return unique
  }

  const refs = {}
  tokens.forEach(token => {
    const value = token.value
    if (value === undefined || value === null) {
      return
    }
    if (token.type === 'color' && typeof value === 'string' && !isTransparentColor(value)) {
      refs[token.id] = { variable: claim(`--color-${slug(token)}`, value), css: value }
    } else if (token.type === 'color' && typeof value === 'object' && value.colors) {
      const css = toBackgroundCSS(value)
      if (css) {
        refs[token.id] = { variable: claim(`--gradient-${slug(token)}`, css), css }
      }
    } else if (token.type === 'radius' && Number(value) > 0) {
      const css = px(Number(value))
      refs[token.id] = { variable: claim(`--radius-${slug(token)}`, css), css }
    } else if (token.type === 'spacing' && Number(value) > 0) {
      const css = px(Number(value))
      refs[token.id] = { variable: claim(`--space-${Number(value)}`, css), css }
    } else if (token.type === 'boxShadow' && typeof value === 'object') {
      const css = `${px(value.h || 0)} ${px(value.v || 0)} ${px(value.b || 0)} ${px(value.s || 0)} ${value.c || ''}${value.i ? ' inset' : ''}`.trim()
      refs[token.id] = { variable: claim(`--shadow-${slug(token)}`, css), css }
    } else if (token.type === 'text') {
      const css = toCSS(token)
      if (css) {
        // the style keys the class sets, an element using it leaves them out
        refs[token.id] = { className: claim(`text-${slug(token)}`, css), css, keys: Object.keys(value) }
      }
    }
  })
  return refs
}

const VARIABLE_ORDER = ['--color-', '--gradient-', '--radius-', '--space-', '--shadow-']

/**
 * The design system as CSS: the custom properties in :root and a class per
 * text style, named by getTokenReferences(). Empty without a design system.
 */
export function designSystemCSS (model) {
  const refs = Object.values(getTokenReferences(model))
  const vars = []
  const seen = new Set()
  const rank = (name) => VARIABLE_ORDER.findIndex(prefix => name.startsWith(prefix))
  refs.filter(ref => ref.variable)
    .sort((a, b) => {
      const byKind = rank(a.variable) - rank(b.variable)
      if (byKind !== 0) {
        return byKind
      }
      // the spacing scale from small to big
      return a.variable.startsWith('--space-') ? parseFloat(a.css) - parseFloat(b.css) : 0
    })
    .forEach(ref => {
      if (!seen.has(ref.variable)) {
        seen.add(ref.variable)
        vars.push(`  ${ref.variable}: ${ref.css};`)
      }
    })
  const classes = refs.filter(ref => ref.className).map(ref => `.${ref.className} { ${ref.css}; }`)
  if (vars.length === 0 && classes.length === 0) {
    return ''
  }
  return (vars.length ? ':root {\n' + vars.join('\n') + '\n}\n' : '') + classes.join('\n')
}

function px (value) {
  const n = Number(value)
  return isNaN(n) ? String(value) : n + 'px'
}
