import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as Handoff from './handoff/DesignHandoff.js'
import { AuthError, ApiError } from './QuxClient.js'

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
- Images: get_screen_handoff lists them with a download URL when there is one; get_image shows an image.`

const appParam = z.string().describe('The app: its id or its name, from list_apps')
const screenParam = z.string().describe('The screen: its id or its name, from get_app_overview')

/**
 * The MCP server with the tools for one user. client is a QuxClient with
 * the token of the user; imageUrl(path) gives a download link for an
 * uploaded image (the HTTP server signs one).
 */
export function createMcpServer ({ client, imageUrl: signImageUrl }) {
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
