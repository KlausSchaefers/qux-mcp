import { HOST, FILES_PREFIX } from './Renderer.js'

/**
 * The HTML of an agent as the importer gets it:
 *
 *  - no scripts: a Content-Security-Policy, and the <script> tags removed.
 *    HTML2QUX only reads the layout, a script could only change its result.
 *  - relative URLs (src="logo.png") point to the images of the call, see
 *    Renderer FILES_PREFIX.
 *  - an element with data-link="<screen name>" opens that screen. It gets a
 *    data-qid, which HTML2QUX keeps as _sourceId, so the widget can be
 *    found after the import (see ScreenImport).
 *
 * @returns {{html: string, links: Array<{qid: string, to: string}>}}
 */
export function prepareHTML (html) {
  const links = []
  let count = 0
  let result = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')

  result = result.replace(/<([a-zA-Z][\w-]*)(\s[^<>]*?)?\sdata-link\s*=\s*("([^"]*)"|'([^']*)')([^<>]*)>/g,
    (tag, name, before = '', quoted, double, single, after) => {
      const to = decodeEntities(double !== undefined ? double : single).trim()
      if (!to) {
        return tag
      }
      const attrs = before + after
      const qid = /\sdata-qid\s*=\s*["']([^"']+)["']/.exec(attrs)
      if (qid) {
        links.push({ qid: qid[1].trim(), to })
        return tag
      }
      const id = `qux-link-${++count}`
      links.push({ qid: id, to })
      return `<${name}${before} data-link=${quoted} data-qid="${id}"${after}>`
    })

  const head = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'"><base href="${HOST}${FILES_PREFIX}">`
  if (/<head\b[^>]*>/i.test(result)) {
    result = result.replace(/<head\b[^>]*>/i, m => m + head)
  } else if (/<html\b[^>]*>/i.test(result)) {
    result = result.replace(/<html\b[^>]*>/i, m => `${m}<head>${head}</head>`)
  } else {
    result = `<!doctype html><html><head>${head}</head><body>${result}</body></html>`
  }
  return { html: result, links }
}

/**
 * The name of an image of the call, from the URL the importer saw.
 */
export function toFileName (url) {
  const prefix = HOST + FILES_PREFIX
  if (typeof url !== 'string' || !url.startsWith(prefix)) {
    return null
  }
  try {
    return decodeURIComponent(url.substring(prefix.length).split(/[?#]/)[0])
  } catch (e) {
    return null
  }
}

function decodeEntities (text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
