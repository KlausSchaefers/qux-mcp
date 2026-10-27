import path from 'path'
import { ApiError } from '../QuxClient.js'
import { prepareHTML, toFileName } from './html.js'
import { buildFragment } from './ScreenImport.js'

export const MAX_SCREENS = 10

const MAX_HTML = 500 * 1024

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

/**
 * Adds screens made of HTML to an app: each screen is laid out by the
 * importer of the editor (Renderer), the images it uses are uploaded, and
 * all screens are added in one request (ScreenImport, AIRest.addScreens).
 * A screen the importer cannot parse is reported, the others are added.
 *
 * @param {{client: QuxClient, renderer: Renderer, app: string,
 *   screens: Array<{name: string, html: string, height?: number}>,
 *   images?: Array<{name: string, data: string, mimeType?: string}>}} options
 */
export async function createScreens ({ client, renderer, app: appRef, screens, images = [] }) {
  if (!screens || screens.length === 0) {
    throw new ApiError(400, 'No screens, add at least one with a name and its html')
  }
  if (screens.length > MAX_SCREENS) {
    throw new ApiError(400, `At most ${MAX_SCREENS} screens per call, send the others in another call`)
  }
  screens.forEach(s => {
    if (!s.html || s.html.length > MAX_HTML) {
      throw new ApiError(400, `The HTML of "${s.name}" is empty or bigger than ${MAX_HTML / 1024} KB`)
    }
  })
  const files = toFiles(images)

  const ref = await client.resolveApp(appRef)
  const model = await client.getApp(ref.id)
  const size = model.screenSize || { w: 375, h: 667 }

  const results = await Promise.allSettled(screens.map(async screen => {
    const { html, links } = prepareHTML(screen.html)
    const app = await renderer.parse(html, size.w, screen.height || size.h, {
      files,
      customFonts: model.fonts,
      lastUUID: Number(model.lastUUID) || 10000
    })
    return { name: screen.name, app, links }
  }))
  const parsed = []
  const failed = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      parsed.push(r.value)
    } else {
      failed.push(`"${screens[i].name}" could not be imported: ${r.reason && r.reason.message}`)
    }
  })
  if (parsed.length === 0) {
    throw new ApiError(400, failed.join('\n'))
  }

  const uploaded = await uploadUsedImages(client, model.id, parsed, files)
  const { fragment, screens: created, warnings } = buildFragment(model, parsed, { images: uploaded })
  await client.addScreens(model.id, fragment)
  return {
    app: model,
    screens: created,
    warnings: failed.concat(warnings),
    tokens: Object.values(fragment.designtokens),
    images: uploaded.size
  }
}

/**
 * The images of the call by name, decoded.
 */
function toFiles (images) {
  const files = new Map()
  ;(images || []).forEach(image => {
    if (!image || !image.name || !image.data) {
      throw new ApiError(400, 'An image needs a name and its data (base64)')
    }
    const data = Buffer.from(String(image.data).replace(/^data:[^,]*,/, ''), 'base64')
    const mimeType = image.mimeType || guessType(image.name)
    if (!IMAGE_TYPES[mimeType]) {
      throw new ApiError(400, `The image ${image.name} is ${mimeType || 'of an unknown type'}, use PNG, JPEG, GIF, WEBP or SVG`)
    }
    files.set(image.name, { data, mimeType })
  })
  return files
}

/**
 * Only the images a screen shows are uploaded, once each.
 */
async function uploadUsedImages (client, appId, parsed, files) {
  const used = new Set()
  parsed.forEach(({ app }) => {
    Object.values(app.widgets || {}).forEach(w => {
      const name = w.style ? toFileName(w.style.externalImageURL) : null
      if (name && files.has(name)) {
        used.add(name)
      }
    })
  })
  const uploaded = new Map()
  for (const name of used) {
    const file = files.get(name)
    const upload = await client.uploadImage(appId, { name: withExtension(name, file.mimeType), data: file.data, mimeType: file.mimeType })
    uploaded.set(name, { url: upload.url, w: upload.width, h: upload.height })
  }
  return uploaded
}

function guessType (name) {
  const ext = path.extname(String(name)).toLowerCase()
  return Object.keys(IMAGE_TYPES).find(type => IMAGE_TYPES[type] === ext || (ext === '.jpeg' && type === 'image/jpeg'))
}

/**
 * The backend takes an image by the extension of its name.
 */
function withExtension (name, mimeType) {
  const base = path.basename(String(name))
  return guessType(base) === mimeType ? base : base + IMAGE_TYPES[mimeType]
}
