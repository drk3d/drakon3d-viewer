const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const SHARE_TTL_HOURS = 14 * 24;
const SHARE_ID_BYTES = 18;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return preflight(origin, env);
    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/v1/shares' && request.method === 'POST') {
      return createShare(request, env, origin);
    }

    const match = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{24})$/);
    if (match && request.method === 'GET') {
      return getShare(match[1], env, origin, ctx);
    }

    return json({ error: 'Not found.' }, 404, cors(origin, env));
  },
};

async function createShare(request, env, origin) {
  if (!isAuthorized(request, env)) {
    return json({ error: 'Upload authorization failed.' }, 401, cors(origin, env));
  }

  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '', 10);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return json({ error: 'A valid Content-Length header is required.' }, 411, cors(origin, env));
  }
  if (contentLength > MAX_MODEL_BYTES) {
    return json({ error: 'The model exceeds the 100 MB sharing limit.' }, 413, cors(origin, env));
  }
  if (!request.body) {
    return json({ error: 'No model was supplied.' }, 400, cors(origin, env));
  }

  const filename = safeFilename(request.headers.get('X-Drakon-Filename'));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHARE_TTL_HOURS * 60 * 60 * 1000);
  const id = randomId();

  await env.SHARES.put(`shares/${id}.3dm`, request.body, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      contentDisposition: `inline; filename="${filename}"`,
    },
    customMetadata: {
      expiresAt: expiresAt.toISOString(),
      filename,
    },
  });

  return json({
    id,
    url: shareUrl(request, env, id),
    expiresAt: expiresAt.toISOString(),
  }, 201, cors(origin, env));
}

function shareUrl(request, env, id) {
  const viewerUrl = new URL(requiredViewerOrigin(env));
  viewerUrl.searchParams.set('share', id);
  // The API endpoint is public but account-specific. Carrying it in the link
  // lets the static GitHub Pages viewer open shares without embedding a
  // Cloudflare account identifier in its source.
  viewerUrl.searchParams.set('api', new URL(request.url).origin);
  return viewerUrl.toString();
}

async function getShare(id, env, origin, ctx) {
  const key = `shares/${id}.3dm`;
  const object = await env.SHARES.get(key);
  if (!object) return json({ error: 'This share link is unavailable.' }, 404, cors(origin, env));

  const expiresAt = Date.parse(object.customMetadata?.expiresAt || '');
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    ctx.waitUntil(env.SHARES.delete(key));
    return json({ error: 'This share link has expired.' }, 410, cors(origin, env));
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

function preflight(origin, env) {
  if (!isViewerOrigin(origin, env)) return new Response(null, { status: 403 });
  const headers = cors(origin, env);
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
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

function isAuthorized(request, env) {
  const expected = env.DRAKON_SHARE_UPLOAD_TOKEN;
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(expected && match && constantTimeEquals(match[1], expected));
}

function constantTimeEquals(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function safeFilename(value) {
  let decoded = 'design.3dm';
  try {
    if (value) decoded = decodeURIComponent(value);
  } catch {
    // Use the safe fallback below when a malformed header is received.
  }
  const cleaned = decoded
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith('.3dm') ? cleaned : `${cleaned || 'design'}.3dm`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(data, status = 200, headers = undefined) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}
