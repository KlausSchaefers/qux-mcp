import crypto from 'crypto'

/**
 * Download links for the images of an app, like a presigned S3 URL: an
 * agent cannot send an Authorization header when it downloads an image of
 * the HTML, so the link carries what the server needs to fetch it, the
 * token of the user and the path, encrypted (AES-256-GCM) and valid for an
 * hour. The token never shows in the link.
 *
 * The key comes from QUX_ASSET_SECRET; without it every start makes a new
 * one, so the links of a server die with it.
 */
export const ASSET_TTL_MS = 60 * 60 * 1000

export function createAssetSigner (secret) {
  const key = crypto.createHash('sha256').update(secret || crypto.randomBytes(32)).digest()

  function sign (payload, ttl = ASSET_TTL_MS) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const plain = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttl }), 'utf8')
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }

  /**
   * The payload of a link, null when it was changed or expired.
   */
  function open (id) {
    try {
      const raw = Buffer.from(String(id), 'base64url')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
      const payload = JSON.parse(plain.toString('utf8'))
      return payload.exp > Date.now() ? payload : null
    } catch (e) {
      return null
    }
  }

  return { sign, open }
}
