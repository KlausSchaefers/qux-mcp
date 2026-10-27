import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendor = path.join(here, '../../vendor')

/**
 * The origin of the page HTML2QUX runs in. It never goes on the network:
 * every request of the page is answered by route() below, so a screen can
 * neither reach the internal network of the server nor the internet.
 */
export const HOST = 'http://qux-import.invalid'

/**
 * The images of a screen, served at HOST/files/<name>, so "logo.png" in the
 * HTML of the agent loads and HTML2QUX gets its size.
 */
export const FILES_PREFIX = '/files/'

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/fonts/fonts.css">
<script src="/importer.js"></script>
</head>
<body><div id="root"></div></body>
</html>`

const MIME = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Turns HTML into a Quant-UX screen with the importer of the editor
 * (HTML2QUX, vendor/importer.js), which lays the HTML out in a browser:
 * one headless Chromium for the server, a fresh page per screen, at most
 * maxPages at the same time.
 *
 * The HTML comes from agents, so the page is shut off: no network, and no
 * scripts in the HTML (see prepareHTML).
 */
export class Renderer {

  constructor ({ maxPages = 2, timeout = 30000, launch } = {}) {
    this.maxPages = maxPages
    this.timeout = timeout
    this.launchBrowser = launch || defaultLaunch
    this.running = 0
    this.queue = []
  }

  /**
   * @param {string} html the screen
   * @param {number} width
   * @param {number} height
   * @param {{lastUUID?: number, customFonts?: Array, files?: Map<string, {data: Buffer, mimeType: string}>}} options
   * @returns {Promise<object>} the app HTML2QUX made: screens, widgets, groups, importInfo
   */
  async parse (html, width, height, options = {}) {
    await this.acquire()
    let context = null
    try {
      const browser = await this.getBrowser()
      context = await browser.newContext({
        viewport: { width: Math.max(width, 320), height: Math.max(height, 320) },
        javaScriptEnabled: true,
        serviceWorkers: 'block'
      })
      await context.route('**/*', route => this.serve(route, options.files))
      const page = await context.newPage()
      page.setDefaultTimeout(this.timeout)
      await page.goto(HOST + '/', { waitUntil: 'load' })
      return await page.evaluate(async ({ html, width, height, lastUUID, customFonts }) => {
        // the importer logs a lot, the server log is not the place for it
        console.log = () => {}
        console.debug = () => {}
        const importer = new window.QuxImporter.HTML2QUX(document.getElementById('root'), lastUUID)
        const app = await importer.run(html, width, height, { customFonts })
        return JSON.parse(JSON.stringify(app))
      }, { html, width, height, lastUUID: options.lastUUID || 10000, customFonts: options.customFonts })
    } finally {
      if (context) {
        await context.close().catch(() => {})
      }
      this.release()
    }
  }

  serve (route, files) {
    const url = new URL(route.request().url())
    if (url.origin !== HOST) {
      return route.abort('blockedbyclient')
    }
    if (url.pathname === '/') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
    }
    if (url.pathname === '/importer.js') {
      return route.fulfill({ status: 200, contentType: MIME['.js'], body: readVendor('importer.js') })
    }
    if (url.pathname.startsWith('/fonts/')) {
      const name = path.basename(decodeURIComponent(url.pathname))
      const file = path.join(vendor, 'fonts', name)
      if (fs.existsSync(file)) {
        return route.fulfill({ status: 200, contentType: MIME[path.extname(name)] || 'application/octet-stream', body: fs.readFileSync(file) })
      }
    }
    if (url.pathname.startsWith(FILES_PREFIX) && files) {
      const file = files.get(decodeURIComponent(url.pathname.substring(FILES_PREFIX.length)))
      if (file) {
        return route.fulfill({ status: 200, contentType: file.mimeType, body: file.data })
      }
    }
    return route.fulfill({ status: 404, body: '' })
  }

  async getBrowser () {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await this.launchBrowser()
    }
    return this.browser
  }

  acquire () {
    if (this.running < this.maxPages) {
      this.running++
      return Promise.resolve()
    }
    return new Promise(resolve => this.queue.push(resolve))
  }

  release () {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.running--
    }
  }

  async close () {
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }
}

let importerCode = null

function readVendor (name) {
  if (!importerCode) {
    importerCode = fs.readFileSync(path.join(vendor, name), 'utf8')
  }
  return importerCode
}

/**
 * Chromium of Playwright, or the one of QUX_CHROMIUM_PATH (e.g. the one
 * of the Docker image).
 */
async function defaultLaunch () {
  const { chromium } = await import('playwright')
  return chromium.launch({
    headless: true,
    executablePath: process.env.QUX_CHROMIUM_PATH || undefined,
    args: process.env.QUX_CHROMIUM_NO_SANDBOX === 'true' ? ['--no-sandbox'] : []
  })
}
