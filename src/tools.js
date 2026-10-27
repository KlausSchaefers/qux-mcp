import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as Handoff from './handoff/DesignHandoff.js'
import { AuthError, ApiError } from './QuxClient.js'
import { createScreens, MAX_SCREENS } from './create/createScreens.js'
import { toDesignTokens } from './create/tokens.js'

export const SERVER_NAME = 'quant-ux'

export const SERVER_VERSION = '0.1.0'

// the HTML of a big screen can be huge, an agent can ask for parts of it
const MAX_TEXT = 150000

const INSTRUCTIONS = `Quant-UX is a design tool. This server gives you the designs of the user: apps, screens, design tokens and components.
To implement a design in code:
1. list_apps to find the app.
2. get_app_overview for its screens and how they link.
3. get_design_tokens once, and map the tokens into the codebase (CSS variables, Tailwind theme...).
4. get_screen_handoff for each screen you build: rules, tokens, HTML, components, images and links in one call.
How to read the HTML:
- It reproduces the canvas pixel by pixel (fixed px sizes, grids sized to the design). Use it as the visual reference, not as the code: build the layout responsive with the components and conventions of the codebase.
- Values of the design system are written as var(--color-...), var(--space-...), var(--radius-...), var(--shadow-...), var(--gradient-...) and text style classes (.text-heading). Keep these references instead of the raw values.
- Icons are <i class="mdi mdi-NAME">, Material Design Icons 5.9 by name. Use that icon set, or the same icon of the icon set of the codebase.
- State rules: :hover, :focus, :active, and .is-error for an invalid field.
- Every element has data-qid="<element id>"; mention these ids when you talk about an element.
- Images: get_screen_handoff lists them with a download URL when there is one; get_image shows an image.

To recreate the UI of a codebase in Quant-UX (needs the user to allow "Create apps and add screens"):
1. Find the screens: the routes, pages and views of the codebase, and the device size it is built for.
2. Find the design tokens: the theme (Tailwind config, CSS variables, theme files) with colors, text styles, radius, spacing and shadows.
3. create_app with the name, the screen size and the tokens. Or add to an app of list_apps.
4. create_screens, up to ${MAX_SCREENS} screens per call: one self-contained HTML document per screen that looks like the screen does in the running app with realistic content.
   - Inline CSS in a <style>, no JavaScript, no external CSS. Flatten the components to plain HTML; resolve conditionals to the default state.
   - The body is the screen at the width of the app; the height grows with the content.
   - Use the token values (CSS variables are fine), elements that use the same value are linked to the same token.
   - Icons as inline <svg>. Images: an https URL, or a file of the codebase passed in images and used by its name (<img src="logo.png">).
   - data-link="<screen name>" on an element makes it open that screen in the prototype.
5. Check the result with get_screen_handoff and fix big differences with another create_screens call.`

const appParam = z.string().describe('The app: its id or its name, from list_apps')

const tokenParam = z.object({
  name: z.string().describe('e.g. "Primary", "Heading", "Medium"'),
  type: z.enum(['color', 'text', 'radius', 'spacing', 'boxShadow']),
  role: z.string().optional().describe('color: primary, secondary, accent, background, surface, text, muted, border, success, warning, error. text: display, heading, subheading, body, label, caption'),
  value: z.any().describe('color: "#2563eb". text: {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing}. radius and spacing: a number in px. boxShadow: "0 2px 8px rgba(0,0,0,.15)"')
})
const screenParam = z.string().describe('The screen: its id or its name, from get_app_overview')

/**
 * The MCP server with the tools for one user. client is a QuxClient with
 * the token of the user; imageUrl(path) gives a download link for an
 * uploaded image (the HTTP server signs one).
 */
export function createMcpServer ({ client, imageUrl: signImageUrl, renderer }) {
  // one link per image, the same in the HTML and in the list of images
  const imageUrls = new Map()
  const imageUrl = signImageUrl ? (path) => {
    if (!imageUrls.has(path)) {
      imageUrls.set(path, signImageUrl(path))
    }
    return imageUrls.get(path)
  } : null
  const htmlOptions = imageUrl ? { imageUrl: path => imageUrl(path) } : {}

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  )

  const tool = (name, config, handler) => {
    server.registerTool(name, {
      ...config,
      annotations: { readOnlyHint: true, openWorldHint: false, ...(config.annotations || {}) }
    }, async (args) => {
      try {
        return await handler(args)
      } catch (err) {
        return toError(err)
      }
    })
  }

  tool('list_apps', {
    title: 'List apps',
    description: 'Lists the Quant-UX apps (designs) the user can access, newest first. Start here to find the app the user means.'
  }, async () => {
    const apps = await client.listApps()
    const lines = apps.map(a => `- ${a.name} (id: ${a.id}) · ${a.screenCount} screens · ${a.type || 'app'} · ${a.permission} · updated ${date(a.lastUpdate)}`)
    return result(apps.length ? `${apps.length} apps:\n${lines.join('\n')}` : 'The user has no apps yet.')
  })

  tool('get_app_overview', {
    title: 'App overview',
    description: 'The screens of an app (size, start screen), the links between them (which element opens which screen) and a summary of its design system. Use it to plan which screens and routes to build.',
    inputSchema: { app: appParam }
  }, async ({ app }) => {
    const model = await loadApp(client, app)
    const screens = Handoff.getScreens(model)
    const flows = Handoff.getFlows(model)
    const ds = Handoff.getDesignSystemSummary(model)
    const text = [
      `# ${model.name}`,
      `Type: ${model.type || 'app'}, screen size ${size(model.screenSize)}`,
      '',
      `## Screens (${screens.length})`,
      ...screens.map(s => `- ${s.name} (id: ${s.id}) ${s.w}x${s.h}${s.isStart ? ' · start screen' : ''} · ${s.elements} elements`),
      '',
      `## Links (${flows.length})`,
      ...flows.map(f => `- ${f.from.screen} › ${f.from.element || 'screen'} --${f.event}--> ${target(f)}`),
      '',
      '## Design system',
      ds.hasDesignSystem
        ? `${ds.tokens} tokens: ${Object.entries(ds.byType).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ')}. Get them with get_design_tokens.`
        : 'The app has no design system yet. Take the values from the HTML of the screens.'
    ].join('\n')
    return result(text)
  })

  tool('get_design_tokens', {
    title: 'Design tokens',
    description: 'The design tokens of an app (colors with their role, text styles, radius, spacing, shadows). format=css gives CSS variables and text classes to paste, json gives the tokens with role, usage and value to map into a theme (e.g. Tailwind).',
    inputSchema: {
      app: appParam,
      format: z.enum(['css', 'json']).default('css').describe('css (default) or json')
    }
  }, async ({ app, format = 'css' }) => {
    const model = await loadApp(client, app)
    const tokens = Handoff.getTokens(model, format)
    if (format === 'json') {
      return result(JSON.stringify(tokens, null, 2))
    }
    if (!tokens) {
      return result(`The app "${model.name}" has no design system. Take the values from the HTML of the screens.`)
    }
    return result(tokens)
  })

  tool('get_image', {
    title: 'Image',
    description: 'Shows an image of a screen: the picture of an element (data-qid) or an image path from get_screen_handoff. Use it to see what an image shows, or when there is no download URL.',
    inputSchema: {
      app: appParam,
      image: z.string().describe('The element id (data-qid) of the image, or its path')
    }
  }, async ({ app, image }) => {
    const model = await loadApp(client, app)
    const widget = model.widgets && model.widgets[image]
    const path = widget && widget.style && widget.style.backgroundImage ? widget.style.backgroundImage.url : image
    if (/^https?:/.test(path)) {
      return result(`The image is not stored in Quant-UX, it is at ${path}`)
    }
    const { data, mimeType } = await client.getImage(path)
    const content = [{ type: 'image', data: data.toString('base64'), mimeType }]
    const url = imageUrl ? imageUrl(path) : null
    if (url) {
      content.push({ type: 'text', text: `Download (valid 1 hour): ${url}` })
    }
    return { content }
  })

  tool('get_screen_handoff', {
    title: 'Screen handoff',
    description: 'Everything to implement one screen in one call: the design system rules, the tokens as CSS, the components on the screen with their states, its images, where its elements link to, and the HTML. Use this for each screen you build.',
    inputSchema: { app: appParam, screen: screenParam }
  }, async ({ app, screen }) => {
    const model = await loadApp(client, app)
    const found = findScreenOrThrow(model, screen)
    const handoff = Handoff.getScreenHandoff(model, found.id, htmlOptions)
    const text = [
      `# ${handoff.screen.name} (${handoff.screen.w}x${handoff.screen.h}) of ${handoff.app.name}`,
      '',
      handoff.rules || 'The app has no design system. Use the values of the HTML.',
      '',
      '## Links of this screen',
      handoff.flows.length
        ? handoff.flows.map(f => `- ${f.from.element || 'the screen'}${f.from.elementId ? ` (data-qid="${f.from.elementId}")` : ''} --${f.event}--> ${target(f)}`).join('\n')
        : 'None.',
      '',
      '## Components on this screen',
      '```json',
      JSON.stringify(handoff.components, null, 2),
      '```',
      '',
      '## Images on this screen',
      handoff.images.length
        ? handoff.images.map(i => `- ${i.element} (data-qid="${i.elementId}") ${i.w}x${i.h}: ${i.url ? i.url : `get_image with image "${i.elementId}"`}`).join('\n')
        : 'None.',
      '',
      '## HTML (visual reference, see the instructions)',
      '```html',
      handoff.html,
      '```'
    ].join('\n')
    return result(clip(text))
  })

  const writeTool = (name, config, handler) => tool(name, {
    ...config,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler)

  writeTool('create_app', {
    title: 'Create app',
    description: 'Creates a new, empty app (design) for the user, with the screen size and optionally the design tokens of the codebase. Then add the screens with create_screens.',
    inputSchema: {
      name: z.string().min(1).max(100).describe('The name of the app, e.g. the name of the product'),
      width: z.number().int().min(100).max(5000).describe('The screen width in px: 375 for a phone, 768 for a tablet, 1440 for a desktop web app'),
      height: z.number().int().min(100).max(5000).describe('The screen height in px (the viewport), e.g. 812 for a phone, 900 for a desktop'),
      description: z.string().max(1000).optional(),
      tokens: z.array(tokenParam).max(200).optional().describe('The design tokens of the codebase. The widgets of the screens are linked to the tokens with their value.')
    }
  }, async ({ name, width, height, description, tokens }) => {
    const { tokens: designtokens, errors } = toDesignTokens(tokens)
    const app = await client.createApp({ name, description, screenSize: { w: width, h: height }, designtokens })
    const lines = [
      `Created the app "${app.name}" (id: ${app.id}), ${app.type} ${width}x${height}, with ${Object.keys(designtokens).length} design tokens.`,
      'Add the screens with create_screens.'
    ]
    if (errors.length) {
      lines.push('', 'Tokens that were left out:', ...errors.map(e => `- ${e}`))
    }
    return result(lines.join('\n'))
  })

  writeTool('create_screens', {
    title: 'Create screens',
    description: `Adds screens to an app, made of one HTML document each. Quant-UX turns the HTML into editable elements (texts, buttons, inputs, images, groups with auto layout) with the importer of the editor, links them to the design tokens of the app and adds the links of data-link elements. Up to ${MAX_SCREENS} screens per call. See the instructions of the server for the HTML.`,
    inputSchema: {
      app: appParam,
      screens: z.array(z.object({
        name: z.string().min(1).max(80).describe('The name of the screen, e.g. "Login"'),
        html: z.string().min(1).describe('A self-contained HTML document: inline <style>, no scripts, icons as inline <svg>'),
        height: z.number().int().min(100).max(20000).optional().describe('The viewport height, default the one of the app. The screen grows with its content.')
      })).min(1).max(MAX_SCREENS),
      images: z.array(z.object({
        name: z.string().describe('The name the HTML uses, e.g. "logo.png" in <img src="logo.png">'),
        data: z.string().describe('The file, base64'),
        mimeType: z.string().optional().describe('image/png, image/jpeg, image/gif, image/webp or image/svg+xml')
      })).max(50).optional().describe('Image files of the codebase the screens show')
    }
  }, async ({ app, screens, images }) => {
    if (!renderer) {
      throw new ApiError(503, 'This server cannot create screens, it has no browser to import the HTML')
    }
    const res = await createScreens({ client, renderer, app, screens, images })
    const lines = [
      `Added ${res.screens.length} screens to "${res.app.name}" (id: ${res.app.id}):`,
      ...res.screens.map(s => `- ${s.name} (id: ${s.id}): ${s.widgets} elements${s.warnings.length ? '\n' + s.warnings.map(w => `  ! ${w}`).join('\n') : ''}`)
    ]
    if (res.tokens.length) {
      lines.push('', `New design tokens: ${res.tokens.map(t => `${t.name} (${t.type})`).join(', ')}`)
    }
    if (res.images) {
      lines.push('', `Uploaded ${res.images} images.`)
    }
    if (res.warnings.length) {
      lines.push('', 'Warnings:', ...res.warnings.map(w => `- ${w}`))
    }
    lines.push('', 'The user sees the screens after reloading the app in Quant-UX. Check a screen with get_screen_handoff.')
    return result(lines.join('\n'))
  })

  return server
}

async function loadApp (client, ref) {
  const app = await client.resolveApp(ref)
  return client.getApp(app.id)
}

function findScreenOrThrow (model, ref) {
  const screen = Handoff.findScreen(model, ref)
  if (!screen) {
    const names = Handoff.getScreens(model).map(s => `"${s.name}"`).join(', ')
    throw new ApiError(404, `No screen "${ref}" in "${model.name}". The screens are: ${names}`)
  }
  return screen
}

function result (text) {
  return { content: [{ type: 'text', text }] }
}

function toError (err) {
  let text = err.message
  if (!(err instanceof ApiError) && !(err instanceof AuthError)) {
    console.error('quant-ux-mcp > tool failed', err)
    text = `Something went wrong: ${err.message}`
  }
  return { isError: true, content: [{ type: 'text', text }] }
}

function clip (text) {
  if (!text || text.length <= MAX_TEXT) {
    return text
  }
  return text.substring(0, MAX_TEXT) + `\n\n[cut after ${MAX_TEXT} characters, the screen is very big]`
}

/**
 * "Checkin 1", or "Checkin 1 › Form" for an element, with the logic nodes on
 * the way, e.g. 'Checkin 1 (via LogicOr "AB")'.
 */
function target (flow) {
  let text = flow.to.screen || flow.to.screenId
  if (flow.to.element) {
    text += ` › ${flow.to.element}`
  }
  if (flow.via && flow.via.length) {
    text += ` (via ${flow.via.map(n => `${n.type} "${n.name}"`).join(', ')})`
  }
  return text
}

function size (s) {
  return s ? `${s.w}x${s.h}` : 'unknown'
}

function date (ms) {
  return ms ? new Date(ms).toISOString().substring(0, 10) : '-'
}
