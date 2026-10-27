import { TOKEN_TYPES, COLOR_ROLES, TEXT_ROLES } from '../../vendor/editor.js'

const MAX_TOKENS = 200

/**
 * The design tokens an agent found in a codebase, as the model of an app
 * stores them (see DesignSystem.createToken in the app). The input is what
 * get_design_tokens format=json gives: {name, type, role?, value}.
 *
 *  - color:     "#2563eb", "rgb(...)"
 *  - text:      {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing}
 *  - radius:    8 or "8px"
 *  - spacing:   16 or "16px"
 *  - boxShadow: "0 2px 8px rgba(0,0,0,.15)" or {h, v, b, s, c}
 *
 * @returns {{tokens: object, errors: string[]}} tokens by id
 */
export function toDesignTokens (list) {
  const tokens = {}
  const errors = []
  const now = Date.now()
  const ids = new Set()
  ;(Array.isArray(list) ? list : []).slice(0, MAX_TOKENS).forEach((input, i) => {
    const label = input && input.name ? `"${input.name}"` : `#${i + 1}`
    if (!input || typeof input.name !== 'string' || !input.name.trim()) {
      errors.push(`Token ${label} has no name`)
      return
    }
    if (!TOKEN_TYPES.includes(input.type)) {
      errors.push(`Token ${label} has the type "${input.type}", use one of ${TOKEN_TYPES.join(', ')}`)
      return
    }
    const value = toValue(input.type, input.value)
    if (value === null) {
      errors.push(`Token ${label} has no valid ${input.type} value: ${JSON.stringify(input.value)}`)
      return
    }
    const id = uniqueId(input.name, ids)
    const token = {
      id,
      name: input.name.trim().substring(0, 60),
      type: input.type,
      isComplex: input.type === 'text',
      modified: now,
      value
    }
    const roles = input.type === 'color' ? COLOR_ROLES : input.type === 'text' ? TEXT_ROLES : []
    if (input.role && roles.includes(input.role)) {
      token.role = input.role
    }
    tokens[id] = token
  })
  if (Array.isArray(list) && list.length > MAX_TOKENS) {
    errors.push(`Only the first ${MAX_TOKENS} tokens were taken`)
  }
  return { tokens, errors }
}

function toValue (type, value) {
  if (type === 'color') {
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  if (type === 'radius' || type === 'spacing') {
    const n = toNumber(value)
    return n !== null && n >= 0 ? n : null
  }
  if (type === 'boxShadow') {
    return toShadow(value)
  }
  if (type === 'text') {
    return toTextStyle(value)
  }
  return null
}

function toTextStyle (value) {
  if (!value || typeof value !== 'object') {
    return null
  }
  const fontSize = toNumber(value.fontSize)
  if (fontSize === null || fontSize <= 0) {
    return null
  }
  const style = {
    fontSize,
    fontFamily: typeof value.fontFamily === 'string' && value.fontFamily.trim() ? value.fontFamily.trim() : 'Inter, sans-serif',
    textAlign: 'left',
    verticalAlign: 'top',
    letterSpacing: toNumber(value.letterSpacing) || 0,
    lineHeight: toLineHeight(value.lineHeight, fontSize)
  }
  const weight = toNumber(value.fontWeight)
  if (weight !== null) {
    style.fontWeight = weight
  }
  return style
}

/**
 * A ratio, as the canvas stores it: 1.5, "1.5", "24px" at 16px font size.
 */
function toLineHeight (value, fontSize) {
  if (typeof value === 'string' && value.trim().endsWith('px')) {
    const px = toNumber(value)
    return px ? Math.round(px / fontSize * 100) / 100 : 1.4
  }
  const n = toNumber(value)
  return n && n > 0 ? n : 1.4
}

function toShadow (value) {
  if (value && typeof value === 'object') {
    const shadow = {
      h: toNumber(value.h) || 0,
      v: toNumber(value.v) || 0,
      b: toNumber(value.b) || 0,
      s: toNumber(value.s) || 0,
      c: typeof value.c === 'string' ? value.c : 'rgba(0, 0, 0, 0.25)'
    }
    if (value.i) {
      shadow.i = true
    }
    return shadow
  }
  if (typeof value !== 'string') {
    return null
  }
  // the first shadow of a list: [inset] h v [blur [spread]] color
  const first = value.split(/,(?![^(]*\))/)[0].trim()
  const inset = /\binset\b/.test(first)
  const color = (first.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}\b)/) || [])[1] || 'rgba(0, 0, 0, 0.25)'
  const lengths = first.replace(color, '').replace(/\binset\b/, '').trim().split(/\s+/).filter(Boolean).map(toNumber)
  if (lengths.length < 2 || lengths.some(n => n === null)) {
    return null
  }
  const shadow = { h: lengths[0], v: lengths[1], b: lengths[2] || 0, s: lengths[3] || 0, c: color }
  if (inset) {
    shadow.i = true
  }
  return shadow
}

function toNumber (value) {
  if (typeof value === 'number' && isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const n = parseFloat(value)
    return isFinite(n) ? n : null
  }
  return null
}

function uniqueId (name, ids) {
  const base = 'dt' + (name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 40) || 'token')
  let id = base
  let i = 2
  while (ids.has(id)) {
    id = `${base}_${i++}`
  }
  ids.add(id)
  return id
}
