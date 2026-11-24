// Local-credentials session source: read the Quick desktop app's stored OAuth
// session straight out of Windows Credential Manager — no agent.exe, no
// outpost, no desktop process needed while the access token is fresh.
//
// The app persists `{refresh_token, access_token, client_id, client_secret,
// issuer_url, tenant_url, access_token_expiry, …}` as generic credentials
// (`quickwork-<provider>-<profile>`, chunked + UTF-16 when large). The stored
// `aoa…` access token is a valid WS bearer while `access_token_expiry` is in
// the future (verified live); past that we refresh via the OIDC token
// endpoint and write the rotated tokens back so the desktop app keeps working.
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readQuickCredentials, writeQuickCredential } from './wincred.mjs'
import { createDirectBackend, defaultStoreDir, isDeviceId } from './oauth.mjs'

const REGION_RE = /(us|eu|ap|sa|ca|me|af|il)-(east|west|north|south|central|northeast|southeast|southwest|northwest)-\d/

export function regionFromTenant(tenantUrl) {
  const m = String(tenantUrl || '').match(REGION_RE)
  return m ? m[0] : 'us-east-1'
}

function profilesJsonPath() {
  return path.join(os.homedir(), '.quickwork', 'profiles.json')
}

/** Normalize a raw credman blob into the session record refreshSession expects. */
export function sessionFromBlob(blob, target) {
  const tenant = String(blob.tenant_url || '').replace(/\/+$/, '')
  const now = Math.floor(Date.now() / 1000)
  return {
    provider: 'social',
    stage: 'prod',
    tenant_url: tenant,
    ws_host: tenant ? new URL(tenant).host : '',
    jwt: blob.access_token || '',
    actor_arn: '',
    aws_account_id: blob.aws_account_id || '',
    account_name: blob.account_name || '',
    email: blob.email || '',
    display_name: blob.display_name || '',
    region: regionFromTenant(tenant),
    usable_until: Math.floor(Number(blob.access_token_expiry) || 0),
    obtained_at: now,
    tokens: {
      access_token: blob.access_token || '',
      refresh_token: blob.refresh_token || '',
      id_token: '',
      expires_in: 0,
    },
    client: {
      client_id: blob.client_id || '',
      client_secret: blob.client_secret || '',
      issuer_url: blob.issuer_url || '',
      idc_region: '',
    },
    _credTarget: target,
    _raw: { ...blob },
  }
}

/** Merge refreshed tokens back into the app's blob shape for CredWrite. */
export function mergeForCredWrite(sess) {
  const raw = sess?._raw || {}
  return {
    ...raw,
    refresh_token: sess?.tokens?.refresh_token || raw.refresh_token,
    access_token: sess?.tokens?.access_token || raw.access_token,
    access_token_expiry: sess?.usable_until || raw.access_token_expiry,
  }
}

/** Write the merged session back to the app's credential target. */
export async function persistCredManSession(sess) {
  return writeQuickCredential(sess._credTarget, mergeForCredWrite(sess))
}

/**
 * Load the active profile's session from Credential Manager.
 * Prefers the profile marked `last_active` in ~/.quickwork/profiles.json.
 * Returns null when the app was never signed in / not on Windows.
 */
export async function loadCredManSession() {
  const creds = await readQuickCredentials()
  if (!creds.length) return null
  let active = ''
  try {
    active = JSON.parse(readFileSync(profilesJsonPath(), 'utf8'))?.last_active || ''
  } catch {}
  const pick = (active && creds.find((c) => c.target.includes(active))) || creds[0]
  return sessionFromBlob(pick.data, pick.target)
}

/**
 * The desktop's own device id for the profile behind a credential target
 * (`quickwork-<provider>-<profile>`): ~/.quickwork/<data_path>/device_id.
 * Read-only — this never writes into the Quick app's directories.
 */
export function profileDeviceId(target, { home = os.homedir() } = {}) {
  const root = path.join(home, '.quickwork')
  let entries = []
  try {
    entries = JSON.parse(readFileSync(path.join(root, 'profiles.json'), 'utf8'))?.entries || []
  } catch {
    return ''
  }
  const hit = entries
    .filter((e) => e?.id && String(target || '').includes(e.id))
    .sort((a, b) => b.id.length - a.id.length)[0]
  if (!hit) return ''
  try {
    const id = readFileSync(path.join(root, hit.data_path || path.join('profiles', hit.id), 'device_id'), 'utf8').trim()
    return isDeviceId(id) ? id : ''
  } catch {
    return ''
  }
}

/**
 * Device-id resolver for Credential Manager accounts: the desktop profile's
 * own device_id when it can be found, else an id generated once per
 * credential target and kept in the plugin's own store dir.
 */
export function credManDeviceId({ dir = defaultStoreDir(), home } = {}) {
  const file = path.join(dir, 'credman-devices.json')
  return (s) => {
    const target = s?._credTarget || ''
    const own = profileDeviceId(target, { home })
    if (own) return own
    const k = createHash('sha256').update(target).digest('hex').slice(0, 16)
    let db = {}
    try { db = JSON.parse(readFileSync(file, 'utf8')) || {} } catch {}
    if (isDeviceId(db[k])) return db[k]
    db[k] = randomUUID()
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2) + '\n')
    renameSync(`${file}.tmp`, file)
    return db[k]
  }
}

/** Outpost-shaped backend backed by Credential Manager (+OIDC refresh). */
export function createCredManBackend({ fetchImpl = fetch, log = () => {}, deviceId } = {}) {
  return createDirectBackend({
    load: () => loadCredManSession(),
    persist: (s) => persistCredManSession(s),
    deviceId,
    fetchImpl,
    log,
  })
}
