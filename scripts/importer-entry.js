/**
 * The importer of the Quant-UX editor, as it is in the app: HTML2QUX turns
 * HTML into screens and widgets by laying it out in an iframe, so it needs a
 * browser. scripts/vendor.mjs bundles it into vendor/importer.js, which
 * src/create/Renderer.js loads into headless Chromium as window.QuxImporter.
 */
export { default as HTML2QUX } from 'ai/HTML2QUX'
