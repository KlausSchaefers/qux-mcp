/**
 * The code of the Quant-UX editor this server uses, as it is in the app:
 * the converter of a design to HTML and the design system. scripts/vendor.mjs
 * bundles it into vendor/editor.js. What only agents need is in src/handoff.
 */
export { default as QUX2HTML } from 'ai/QUX2HTML'
export { describeDesignSystem, designSystemCSS as editorDesignSystemCSS } from 'ai/TokenMapper'
export {
  getDesignSystemTokens, getSuggestedTokens, hasDesignSystem, getRole, toCSS, toBackgroundCSS,
  isTransparentColor, ROLE_USAGE, TOKEN_TYPES
} from 'core/designtoken/DesignSystem'
export { getElementGroups } from 'core/designtoken/DesignSystemElements'
