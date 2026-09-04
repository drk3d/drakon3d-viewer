import { readShareConfiguration, relationshipId, resolveLicenseSharePolicy } from './share-policy.js';
import { ShareQuotaCoordinator } from './share-quota-coordinator.js';

const SHARE_ID_BYTES = 18;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_ITERATIONS = 600000;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 128;

export { ShareQuotaCoordinator };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return preflight(origin, env);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/v1/shares' && request.method === 'POST') return createShare(request, env, origin);

    const match = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{24})$/);
    if (match && request.method === 'GET') return getShare(match[1], request, env, origin, ctx);
    return json({ error: 'Not found.' }, 404, cors(origin, env));
  },
};

async function createShare(request, env, origin) {
  const configuration = readShareConfiguration(env);
  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '', 10);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return json({ error: 'A valid Content-Length header is required.' }, 411, cors(origin, env));
  }
  if (contentLength > configuration.maxModelBytes) {
    const megabytes = Math.floor(configuration.maxModelBytes / (1024 * 1024));
    return json({ error: `The model exceeds the ${megabytes} MB sharing limit.` }, 413, cors(origin, env));
  }
  if (!request.body) return json({ error: 'No model was supplied.' }, 400, cors(origin, env));

  // This checks the user's current Keygen session, license, and activated
  // computer for every upload. No reusable Drakon upload secret ships with a
  // public plug-in installation.
  const authorization = await validateUploadLicense(request, configuration);
  if (!authorization.ok) {
    return json({ error: authorization.error, code: authorization.code }, authorization.status, cors(origin, env));
  }

  const password = readPassword(request);
  if (password.error) return json({ error: password.error }, 400, cors(origin, env));

  const filename = safeFilename(request.headers.get('X-Drakon-Filename'));
  const expiresAt = new Date(Date.now() + configuration.ttlHours * 60 * 60 * 1000);
  const id = randomId();
  const licenseKey = await sha256Hex(authorization.license.id);
  const reservation = await quotaRequest(env, {
    action: 'reserve',
    shareId: id,
    licenseKey,
    size: contentLength,
    expiresAt: expiresAt.getTime(),
    maxLiveBytes: configuration.maxLiveBytes,
    policy: authorization.policy,
  });
  if (!reservation.ok) {
    return json({ error: reservation.error, code: reservation.code }, reservation.status || 503, cors(origin, env));
  }

  const passwordMetadata = password.value ? await passwordProtectionMetadata(password.value) : {};
  let stored = false;
  try {
    await env.SHARES.put(`shares/${id}.3dm`, request.body, {
      httpMetadata: {
        contentType: 'application/octet-stream',
        contentDisposition: `inline; filename="${filename}"`,
      },
      customMetadata: { expiresAt: expiresAt.toISOString(), filename, ...passwordMetadata },
    });
    stored = true;

    const confirmed = await quotaRequest(env, { action: 'confirm', shareId: id });
    if (!confirmed.ok) throw new Error('The share service could not confirm the uploaded model.');
  } catch (error) {
    // A failed cleanup is still safe: the Durable Object removes an abandoned
    // reservation and R2 object automatically within fifteen minutes.
    try { await quotaRequest(env, { action: 'cancel', shareId: id }); } catch { /* alarm will retry */ }
    if (stored) console.error('Drakon Share upload confirmation failed', error);
    return json({ error: 'The shared model could not be stored. Please try again.' }, 503, cors(origin, env));
  }

  return json({ id, url: shareUrl(env, id), expiresAt: expiresAt.toISOString() }, 201, cors(origin, env));
}

function shareUrl(env, id) {
  const viewerUrl = new URL(requiredViewerOrigin(env));
  viewerUrl.searchParams.set('share', id);
  return viewerUrl.toString();
}

async function getShare(id, request, env, origin, ctx) {
  const object = await env.SHARES.get(`shares/${id}.3dm`);
  if (!object) return json({ error: 'This share link is unavailable.' }, 404, cors(origin, env));

  const expiresAt = Date.parse(object.customMetadata?.expiresAt || '');
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    ctx.waitUntil(releaseShareQuota(env, id));
    return json({ error: 'This share link has expired.' }, 410, cors(origin, env));
  }

  if (object.customMetadata?.passwordHash) {
    const password = readPassword(request);
    if (password.error || !password.value || !await isCorrectPassword(password.value, object.customMetadata)) {
      return json({ error: 'This share link is password protected.' }, 401, cors(origin, env));
    }
  }

  const headers = new Headers(cors(origin, env));
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Drakon-Filename', object.customMetadata?.filename || 'design.3dm');
  headers.set('Access-Control-Expose-Headers', 'X-Drakon-Filename');
  return new Response(object.body, { headers });
}

async function validateUploadLicense(request, configuration) {
  const userToken = readBearerToken(request.headers.get('Authorization'));
  const licenseId = readSafeHeader(request, 'X-Drakon-License-Id', 200);
  const machineId = readSafeHeader(request, 'X-Drakon-Machine-Id', 200);
  const fingerprint = readSafeHeader(request, 'X-Drakon-Machine-Fingerprint', 1024);
  if (!userToken || !licenseId || !machineId || !fingerprint) {
    return { ok: false, status: 401, code: 'LICENSE_LOGIN_REQUIRED', error: 'Sign in to Drakon with an active online license, then try again.' };
  }

  const endpoint = `https://api.keygen.sh/v1/accounts/${encodeURIComponent(configuration.keygenAccountId)}/licenses/${encodeURIComponent(licenseId)}/actions/validate`;
  const headers = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${userToken}`,
  };
  const scope = { product: configuration.keygenProductId, fingerprint, machine: machineId };
  let validation = await keygenValidate(endpoint, headers, scope);

  // Some valid Drakon policies additionally require explicit policy or user
  // scope. Those values come only from Keygen's response for this license.
  for (let attempt = 0; attempt < 2 && validation.response?.ok && validation.result?.meta?.valid !== true; attempt += 1) {
    const code = keygenCode(validation.result);
    const license = validation.result?.data;
    let changed = false;
    if (code === 'POLICY_SCOPE_REQUIRED' && !scope.policy) {
      const policyId = relationshipId(license, 'policy');
      if (policyId) { scope.policy = policyId; changed = true; }
    } else if (code === 'USER_SCOPE_REQUIRED' && !scope.user) {
      const userId = relationshipId(license, 'owner') || relationshipId(license, 'user');
      if (userId) { scope.user = userId; changed = true; }
    }
    if (!changed) break;
    validation = await keygenValidate(endpoint, headers, scope);
  }

  if (!validation.response) {
    return { ok: false, status: 503, code: 'LICENSE_SERVICE_UNAVAILABLE', error: 'The Drakon license service is temporarily unavailable. Please try again.' };
  }
  if (!validation.response.ok) {
    const retryable = validation.response.status === 429 || validation.response.status >= 500;
    return {
      ok: false,
      status: retryable ? 503 : 403,
      code: retryable ? 'LICENSE_SERVICE_UNAVAILABLE' : 'LICENSE_NOT_VALID',
      error: retryable ? 'The Drakon license service is temporarily unavailable. Please try again.' : licenseFailureMessage(keygenCode(validation.result)),
    };
  }
  if (validation.result?.meta?.valid !== true) {
    return { ok: false, status: 403, code: keygenCode(validation.result) || 'LICENSE_NOT_VALID', error: licenseFailureMessage(keygenCode(validation.result)) };
  }

  const license = validation.result?.data;
  if (!license?.id || license.id !== licenseId || relationshipId(license, 'product') !== configuration.keygenProductId) {
    return { ok: false, status: 403, code: 'LICENSE_NOT_VALID', error: 'The active license is not valid for Drakon Share.' };
  }
  if (license.attributes?.suspended === true) {
    return { ok: false, status: 403, code: 'LICENSE_INACTIVE', error: 'The active Drakon license is not available for sharing.' };
  }

  const policy = resolveLicenseSharePolicy(license, configuration);
  if (!policy) {
    return { ok: false, status: 403, code: 'LICENSE_POLICY_NOT_SUPPORTED', error: 'This Drakon license is not enabled for public sharing.' };
  }
  return { ok: true, license, policy };
}

async function keygenValidate(endpoint, headers, scope) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ meta: { scope } }),
    });
    let result = null;
    try { result = await response.json(); } catch { /* handled as invalid below */ }
    return { response, result };
  } catch {
    return { response: null, result: null };
  }
}

async function quotaRequest(env, data) {
  const id = env.SHARE_QUOTAS.idFromName('drakon3d-share-global');
  const response = await env.SHARE_QUOTAS.get(id).fetch('https://quota.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  let result = null;
  try { result = await response.json(); } catch { /* handled below */ }
  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, status: 503, error: 'Drakon Share is temporarily unavailable.' };
  }
  return result;
}

async function releaseShareQuota(env, id) {
  try { await quotaRequest(env, { action: 'release', shareId: id }); } catch { /* R2 lifecycle is a cleanup backstop */ }
}

function preflight(origin, env) {
  if (!isViewerOrigin(origin, env)) return new Response(null, { status: 403 });
  const headers = cors(origin, env);
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Drakon-Share-Password');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function cors(origin, env) {
  const headers = new Headers({ Vary: 'Origin' });
  if (isViewerOrigin(origin, env)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function isViewerOrigin(origin, env) {
  return origin === requiredViewerOrigin(env);
}

function requiredViewerOrigin(env) {
  const origin = env.VIEWER_ORIGIN || 'https://viewer.drakon3d.com';
  return origin.replace(/\/$/, '');
}

function readBearerToken(authorization) {
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+([^\s]{1,8192})$/i) : null;
  return match ? match[1] : null;
}

function readSafeHeader(request, name, maxLength) {
  const value = request.headers.get(name);
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

function keygenCode(result) {
  const code = result?.meta?.code ?? result?.meta?.constant ?? result?.errors?.[0]?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code : '';
}

function licenseFailureMessage(code) {
  if (code === 'EXPIRED') return 'The active Drakon license has expired.';
  if (code === 'SUSPENDED' || code === 'BANNED') return 'The active Drakon license is not available for sharing.';
  if (['NO_MACHINE', 'NO_MACHINES', 'MACHINE_SCOPE_REQUIRED', 'MACHINE_SCOPE_MISMATCH', 'FINGERPRINT_SCOPE_REQUIRED', 'FINGERPRINT_SCOPE_MISMATCH', 'HEARTBEAT_DEAD', 'HEARTBEAT_NOT_STARTED'].includes(code)) {
    return 'The active Drakon license is not activated on this computer.';
  }
  if (code === 'OVERDUE') return 'The Drakon license needs to reconnect before creating a share link.';
  return 'The Drakon license could not be validated for sharing.';
}

async function sha256Hex(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeFilename(value) {
  let decoded = 'design.3dm';
  try {
    if (value) decoded = decodeURIComponent(value);
  } catch {
    // Use the safe fallback below when a malformed header is received.
  }
  const cleaned = decoded.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned.toLowerCase().endsWith('.3dm') ? cleaned : `${cleaned || 'design'}.3dm`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readPassword(request) {
  const encoded = request.headers.get('X-Drakon-Share-Password');
  if (!encoded) return { value: null };
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) return { error: 'The share password is invalid.' };
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.length < MIN_PASSWORD_BYTES || bytes.length > MAX_PASSWORD_BYTES) {
      return { error: `Share passwords must be between ${MIN_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} bytes.` };
    }
    return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { error: 'The share password is invalid.' };
  }
}

async function passwordProtectionMetadata(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
  return { passwordSalt: toBase64Url(salt), passwordHash: toBase64Url(hash), passwordIterations: String(PASSWORD_ITERATIONS) };
}

async function isCorrectPassword(password, metadata) {
  const iterations = Number.parseInt(metadata.passwordIterations || '', 10);
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  try {
    const expected = fromBase64Url(metadata.passwordHash);
    const salt = fromBase64Url(metadata.passwordSalt);
    return constantTimeBytesEqual(await derivePasswordHash(password, salt, iterations), expected);
  } catch {
    return false;
  }
}

async function derivePasswordHash(password, salt, iterations) {
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passwordKey, PASSWORD_HASH_BYTES * 8);
  return new Uint8Array(bits);
}

function constantTimeBytesEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function json(data, status = 200, headers = undefined) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}
