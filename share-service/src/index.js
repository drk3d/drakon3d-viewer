import {
  MAX_SHARE_TTL_DAYS,
  readShareConfiguration,
  relationshipId,
  resolveLicenseSharePolicy,
} from './share-policy.js';
import { ShareQuotaCoordinator } from './share-quota-coordinator.js';

const SHARE_ID_BYTES = 18;
const PREPARE_TOKEN_BYTES = 24;
const PREPARE_TOKEN_TTL_MS = 15 * 60 * 1000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_HASH_VERSION = '2';
const PASSWORD_ITERATIONS = 600000;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 128;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

export { ShareQuotaCoordinator };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return preflight(origin, env);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/v1/share-status' && request.method === 'GET') return getShareStatus(request, env, origin);
    if (url.pathname === '/v1/account/shares' && request.method === 'GET') return getAccountShares(request, env);
    const accountShareMatch = url.pathname.match(/^\/v1\/account\/shares\/([A-Za-z0-9_-]{24})$/);
    if (accountShareMatch && request.method === 'DELETE') return deleteAccountShare(accountShareMatch[1], request, env);
    if (accountShareMatch && request.method === 'PATCH') return updateAccountShareExpiry(accountShareMatch[1], request, env);
    if (url.pathname === '/v1/shares' && request.method === 'POST') return createShare(request, env, origin);

    const match = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{24})$/);
    if (match && request.method === 'GET') return getShare(match[1], request, env, origin, ctx);

    const modelMatch = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{24})\/model$/);
    if (modelMatch && request.method === 'POST') return finalizeShare(modelMatch[1], request, env, origin);

    const thumbnailMatch = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{24})\/thumbnail$/);
    if (thumbnailMatch && request.method === 'POST') return createThumbnail(thumbnailMatch[1], request, env, origin);
    if (thumbnailMatch && request.method === 'GET') return getThumbnail(thumbnailMatch[1], env, ctx);

    const landingMatch = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{24})$/);
    if (landingMatch && request.method === 'GET') return getShareLandingPage(landingMatch[1], request, env, ctx);
    const socialShareMatch = url.pathname.match(/^\/share\/([A-Za-z0-9_-]{24})$/);
    if (socialShareMatch && request.method === 'GET') return getSocialSharePage(socialShareMatch[1], request, env, ctx);
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

  const lifetime = readShareLifetime(request, configuration.defaultTtlDays);
  if (lifetime.error) return json({ error: lifetime.error }, 400, cors(origin, env));

  const filename = safeFilename(request.headers.get('X-Drakon-Filename'), '3dm');
  const expiresAt = new Date(Date.now() + lifetime.days * 24 * 60 * 60 * 1000);
  const id = randomId();
  const prepareToken = randomToken(PREPARE_TOKEN_BYTES);
  const prepareTokenHash = await sha256Hex(prepareToken);
  const prepareExpiresAt = new Date(Date.now() + PREPARE_TOKEN_TTL_MS).toISOString();
  const licenseKey = await sha256Hex(authorization.license.id);
  const reservation = await quotaRequest(env, {
    action: 'reserve',
    shareId: id,
    licenseKey,
    size: contentLength,
    expiresAt: expiresAt.getTime(),
    maxLiveBytes: configuration.maxLiveBytes,
    policy: authorization.policy,
    filename,
  });
  if (!reservation.ok) {
    return json({ error: reservation.error, code: reservation.code }, reservation.status || 503, cors(origin, env));
  }

  let passwordMetadata;
  try {
    passwordMetadata = password.value ? await passwordProtectionMetadata(password.value, env) : {};
  } catch {
    return json({ error: 'Password-protected shares are temporarily unavailable. Please try again shortly.' }, 503, cors(origin, env));
  }
  let stored = false;
  let confirmed = null;
  try {
    const storedObject = await env.SHARES.put(`shares/${id}.3dm`, request.body, {
      httpMetadata: {
        contentType: 'application/octet-stream',
        contentDisposition: `inline; filename="${filename}"`,
      },
      customMetadata: {
        expiresAt: expiresAt.toISOString(),
        filename,
        format: '3dm',
        ownerLicenseKey: licenseKey,
        prepareTokenHash,
        prepareExpiresAt,
        ...passwordMetadata,
      },
    });
    if (!storedObject || storedObject.size <= 0) {
      // Do not leave a link—or even a quota reservation—for an empty body,
      // including a malformed request that lied about Content-Length.
      await env.SHARES.delete(`shares/${id}.3dm`);
      await quotaRequest(env, { action: 'cancel', shareId: id });
      return json({ error: 'An empty model cannot be shared.' }, 400, cors(origin, env));
    }
    stored = true;

    confirmed = await quotaRequest(env, { action: 'confirm', shareId: id });
    if (!confirmed.ok) throw new Error('The share service could not confirm the uploaded model.');
  } catch (error) {
    // A failed cleanup is still safe: the Durable Object removes an abandoned
    // reservation and R2 object automatically within fifteen minutes.
    try { await quotaRequest(env, { action: 'cancel', shareId: id }); } catch { /* alarm will retry */ }
    if (stored) console.error('Drakon Share upload confirmation failed', error);
    return json({ error: 'The shared model could not be stored. Please try again.' }, 503, cors(origin, env));
  }

  return json({
    id,
    url: shareUrl(env, id),
    prepareUrl: sharePrepareUrl(env, id, prepareToken),
    expiresAt: expiresAt.toISOString(),
    activeLinks: confirmed.activeCount,
    activeLinkLimit: authorization.policy.active,
    exportCount: authorization.policy.total == null ? null : confirmed.totalExports,
    exportLimit: authorization.policy.total,
  }, 201, cors(origin, env));
}

async function finalizeShare(id, request, env, origin) {
  const configuration = readShareConfiguration(env);
  const model = await env.SHARES.head(`shares/${id}.3dm`);
  if (!model || isExpired(model)) {
    return json({ error: 'This share link is unavailable.' }, 404, cors(origin, env));
  }

  const prepareToken = request.headers.get('X-Drakon-Prepare-Token');
  if (!await isValidPrepareToken(prepareToken, model.customMetadata)) {
    return json({ error: 'The share preparation link is invalid or has expired.' }, 403, cors(origin, env));
  }

  // Retrying a completed preparation is harmless, but it must not replace an
  // already-compact share a second time.
  if (model.customMetadata?.format === 'rhv') {
    return json({ ok: true, optimized: true, size: model.size }, 200, cors(origin, env));
  }

  const contentType = request.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim();
  if (contentType !== 'application/vnd.drakon.rhv' || !request.body) {
    return json({ error: 'A valid RHV model is required.' }, 400, cors(origin, env));
  }

  const filename = safeFilename(request.headers.get('X-Drakon-Filename'), 'rhv');
  const modelKey = `shares/${id}.3dm`;
  const temporaryKey = `shares/${id}.${crypto.randomUUID()}.rhv.tmp`;
  try {
    // Browsers cannot set Content-Length themselves, and HTTP/2 is allowed to
    // omit it. Stream the upload to a private temporary R2 object first, then
    // use R2's authoritative stored size before replacing the public model.
    const temporaryObject = await env.SHARES.put(temporaryKey, request.body, {
      httpMetadata: {
        contentType: 'application/vnd.drakon.rhv',
        contentDisposition: `inline; filename="${filename}"`,
      },
      customMetadata: {
        ...model.customMetadata,
        filename,
        format: 'rhv',
        optimizedAt: new Date().toISOString(),
      },
    });
    if (!temporaryObject || temporaryObject.size <= 0) throw new Error('The compact model was empty.');
    if (temporaryObject.size > configuration.maxModelBytes) {
      return json({ error: 'The compact model exceeds the sharing limit.' }, 413, cors(origin, env));
    }

    // The optimisation must never consume more capacity than the original
    // upload. If this particular model compresses better as 3DM, keep it.
    if (temporaryObject.size >= model.size) {
      return json({ ok: true, optimized: false, size: model.size, format: '3dm' }, 200, cors(origin, env));
    }

    const compactObject = await env.SHARES.get(temporaryKey);
    if (!compactObject?.body) throw new Error('The compact model could not be read back.');
    const storedObject = await env.SHARES.put(modelKey, compactObject.body, {
      httpMetadata: {
        contentType: 'application/vnd.drakon.rhv',
        contentDisposition: `inline; filename="${filename}"`,
      },
      customMetadata: {
        ...model.customMetadata,
        filename,
        format: 'rhv',
        optimizedAt: new Date().toISOString(),
      },
    });
    if (!storedObject || storedObject.size <= 0) throw new Error('The compact model was empty.');

    // A failed accounting update only over-counts capacity, which is safe.
    // The public model has already been replaced atomically in R2 and remains
    // available, so do not make a successful share look broken to the user.
    try {
      const resized = await quotaRequest(env, {
        action: 'resize',
        shareId: id,
        size: storedObject.size,
        maxLiveBytes: configuration.maxLiveBytes,
      });
      if (!resized.ok) console.error('Drakon Share compact-size accounting was not updated', resized.error);
    } catch (error) {
      console.error('Drakon Share compact-size accounting was not updated', error);
    }

    return json({
      ok: true,
      optimized: true,
      size: storedObject.size,
      originalSize: model.size,
      format: 'rhv',
    }, 200, cors(origin, env));
  } catch (error) {
    console.error('Drakon Share RHV finalization failed', error);
    return json({ error: 'The compact model could not be stored.' }, 503, cors(origin, env));
  } finally {
    // The temporary object is never public and should not count against live
    // sharing capacity. A cleanup failure does not endanger the active share.
    try { await env.SHARES.delete(temporaryKey); }
    catch (error) { console.error('Drakon Share RHV temporary cleanup failed', error); }
  }
}

async function getShareStatus(request, env, origin) {
  const configuration = readShareConfiguration(env);
  const authorization = await validateUploadLicense(request, configuration);
  if (!authorization.ok) {
    return json({ error: authorization.error, code: authorization.code }, authorization.status, cors(origin, env));
  }

  const licenseKey = await sha256Hex(authorization.license.id);
  const usage = await quotaRequest(env, { action: 'status', licenseKey });
  if (!usage.ok) {
    return json({ error: usage.error }, usage.status || 503, cors(origin, env));
  }

  return json({
    plan: authorization.policy.label,
    activeLinks: usage.activeCount,
    activeLinkLimit: authorization.policy.active,
    exportCount: authorization.policy.total == null ? null : usage.totalExports,
    exportLimit: authorization.policy.total,
  }, 200, cors(origin, env));
}

// This endpoint is intentionally server-to-server. The Wix account page
// proves member ownership of a Keygen licence before calling it, then uses the
// shared deployment secret below. It never exposes a Keygen user token or a
// licence identifier to the browser.
async function getAccountShares(request, env) {
  if (!await isAccountApiRequest(request, env)) {
    return json({ error: 'Account access is not authorized.' }, 401);
  }

  const licenseId = readSafeHeader(request, 'X-Drakon-License-Id', 200);
  if (!licenseId) return json({ error: 'A valid Drakon license is required.' }, 400);

  const licenseKey = await sha256Hex(licenseId);
  const result = await quotaRequest(env, { action: 'list', licenseKey });
  if (!result.ok) return json({ error: result.error }, result.status || 503);

  const publicOrigin = optionalShareOrigin(env) || requiredViewerOrigin(env);
  const shares = result.shares.map(share => ({
    id: share.shareId,
    url: shareUrl(env, share.shareId),
    thumbnailUrl: share.hasPreview
      ? new URL(`/v1/shares/${share.shareId}/thumbnail`, publicOrigin).toString()
      : null,
    filename: share.filename || 'Shared model',
    expiresAt: new Date(share.expiresAt).toISOString(),
    hasPreview: share.hasPreview === true,
  }));

  return json({ shares }, 200);
}

// Like the account list endpoint, this is server-to-server only. The Wix
// backend verifies the site member's license ownership before reaching here.
// The Durable Object verifies the supplied license again before deleting R2
// objects, so an account request can never remove another license's share.
async function deleteAccountShare(shareId, request, env) {
  if (!await isAccountApiRequest(request, env)) {
    return json({ error: 'Account access is not authorized.' }, 401);
  }

  const licenseId = readSafeHeader(request, 'X-Drakon-License-Id', 200);
  if (!licenseId) return json({ error: 'A valid Drakon license is required.' }, 400);

  const licenseKey = await sha256Hex(licenseId);
  const result = await quotaRequest(env, { action: 'delete', shareId, licenseKey });
  if (!result.ok) return json({ error: result.error || 'This share link is unavailable.' }, result.status || 503);
  return json({ ok: true }, 200);
}

// Account members can change a share's calendar expiry without involving the
// Rhino plug-in. The request is still server-to-server only and must own the
// share's licence. R2 retains the authoritative expiry used by the Viewer,
// while the Durable Object retains the matching cleanup schedule.
async function updateAccountShareExpiry(shareId, request, env) {
  if (!await isAccountApiRequest(request, env)) {
    return json({ error: 'Account access is not authorized.' }, 401);
  }

  const licenseId = readSafeHeader(request, 'X-Drakon-License-Id', 200);
  if (!licenseId) return json({ error: 'A valid Drakon license is required.' }, 400);

  const expiry = await readAccountExpiry(request);
  if (expiry.error) return json({ error: expiry.error }, 400);

  const licenseKey = await sha256Hex(licenseId);
  const modelKey = `shares/${shareId}.3dm`;
  const model = await env.SHARES.get(modelKey);
  // Check R2 ownership too, before consuming the model stream to update its
  // metadata. The Durable Object repeats this check before it changes quota
  // state, so neither store trusts the other on its own.
  if (!model?.body || isExpired(model) || model.customMetadata?.ownerLicenseKey !== licenseKey) {
    return json({ error: 'This share link is unavailable.' }, 404);
  }

  const update = await quotaRequest(env, {
    action: 'updateExpiry',
    shareId,
    licenseKey,
    expiresAt: expiry.expiresAt,
  });
  if (!update.ok) return json({ error: update.error || 'This share link is unavailable.' }, update.status || 503);

  try {
    const stored = await env.SHARES.put(modelKey, model.body, {
      httpMetadata: preservedHttpMetadata(model.httpMetadata),
      customMetadata: {
        ...model.customMetadata,
        expiresAt: expiry.iso,
      },
    });
    if (!stored || stored.size <= 0) throw new Error('The shared model could not be updated.');
  } catch (error) {
    // Revert the schedule if the authoritative R2 metadata was not changed.
    // A failed rollback is safe: it can only cause the model to be removed
    // earlier, never expose it beyond its previous expiration.
    try {
      await quotaRequest(env, {
        action: 'updateExpiry',
        shareId,
        licenseKey,
        expiresAt: update.previousExpiresAt,
      });
    } catch (rollbackError) {
      console.error('Drakon Share expiry rollback failed', rollbackError);
    }
    console.error('Drakon Share expiry update failed', error);
    return json({ error: 'The share expiry could not be updated. Please try again.' }, 503);
  }

  return json({ ok: true, expiresAt: expiry.iso }, 200);
}

function shareUrl(env, id) {
  const shareOrigin = optionalShareOrigin(env);
  if (shareOrigin) return new URL(`/s/${id}`, shareOrigin).toString();

  const viewerUrl = new URL(requiredViewerOrigin(env));
  viewerUrl.searchParams.set('share', id);
  return viewerUrl.toString();
}

function sharePrepareUrl(env, id, token) {
  const viewerUrl = new URL(requiredViewerOrigin(env));
  viewerUrl.searchParams.set('share', id);
  // Fragments are not sent in HTTP requests or referrer headers. The viewer
  // exchanges this short-lived token for the initial model and its one-time
  // compact RHV replacement.
  viewerUrl.hash = `prepare=${token}`;
  return viewerUrl.toString();
}

function readShareLifetime(request, defaultDays) {
  const requested = request.headers.get('X-Drakon-Expires-In-Days');
  if (requested == null || requested.trim() === '') return { days: defaultDays };

  // This is enforced on the Worker, not merely in the Rhino command, so a
  // modified plug-in cannot create a longer-lived public share.
  if (!/^\d{1,2}$/.test(requested.trim())) {
    return { error: `Share expiry must be a whole number between 1 and ${MAX_SHARE_TTL_DAYS} days.` };
  }
  const days = Number.parseInt(requested, 10);
  if (days < 1 || days > MAX_SHARE_TTL_DAYS) {
    return { error: `Share expiry must be between 1 and ${MAX_SHARE_TTL_DAYS} days.` };
  }
  return { days };
}

async function readAccountExpiry(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: 'Choose a valid expiry date.' };
  }

  const expiresOn = typeof body?.expiresOn === 'string' ? body.expiresOn : '';
  const match = expiresOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { error: 'Choose a valid expiry date.' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dateStart = Date.UTC(year, month - 1, day);
  const date = new Date(dateStart);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { error: 'Choose a valid expiry date.' };
  }

  // Keep online changes within the same 1-15 calendar-day rule as new shares
  // created by DkShare. The date is stored at the end of the selected UTC day
  // so a member never loses the selected date due to a time-zone conversion.
  const now = new Date();
  const firstAllowed = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const lastAllowed = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + MAX_SHARE_TTL_DAYS);
  if (dateStart < firstAllowed || dateStart > lastAllowed) {
    return { error: `Share expiry must be between 1 and ${MAX_SHARE_TTL_DAYS} days from today.` };
  }

  const expiresAt = dateStart + (24 * 60 * 60 * 1000) - 1;
  return { expiresAt, iso: new Date(expiresAt).toISOString() };
}

function preservedHttpMetadata(metadata) {
  const result = {};
  for (const key of ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl']) {
    if (typeof metadata?.[key] === 'string' && metadata[key]) result[key] = metadata[key];
  }
  if (metadata?.cacheExpiry instanceof Date) result.cacheExpiry = metadata.cacheExpiry;
  return result;
}

async function createThumbnail(id, request, env, origin) {
  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '', 10);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_PREVIEW_BYTES) {
    return json({ error: 'The preview image is invalid.' }, 400, cors(origin, env));
  }
  if (request.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'image/png' || !request.body) {
    return json({ error: 'The preview image must be a PNG.' }, 400, cors(origin, env));
  }

  const configuration = readShareConfiguration(env);
  const authorization = await validateUploadLicense(request, configuration);
  if (!authorization.ok) return json({ error: authorization.error, code: authorization.code }, authorization.status, cors(origin, env));

  const model = await env.SHARES.head(`shares/${id}.3dm`);
  if (!model || isExpired(model)) return json({ error: 'This share link is unavailable.' }, 404, cors(origin, env));
  const licenseKey = await sha256Hex(authorization.license.id);
  if (model.customMetadata?.ownerLicenseKey !== licenseKey) {
    return json({ error: 'Only the owner can add a preview image.' }, 403, cors(origin, env));
  }

  const reservation = await quotaRequest(env, {
    action: 'reservePreview',
    shareId: id,
    size: contentLength,
    maxLiveBytes: configuration.maxLiveBytes,
  });
  if (!reservation.ok) return json({ error: reservation.error }, reservation.status || 503, cors(origin, env));

  try {
    const storedPreview = await env.SHARES.put(`shares/${id}.png`, request.body, {
      httpMetadata: { contentType: 'image/png', contentDisposition: 'inline' },
      customMetadata: { expiresAt: model.customMetadata.expiresAt },
    });
    if (!storedPreview || storedPreview.size <= 0) throw new Error('Preview image was empty.');
    return json({ ok: true }, 201, cors(origin, env));
  } catch {
    await quotaRequest(env, { action: 'releasePreview', shareId: id });
    return json({ error: 'The preview image could not be stored.' }, 503, cors(origin, env));
  }
}

async function getThumbnail(id, env, ctx) {
  const model = await env.SHARES.head(`shares/${id}.3dm`);
  if (!model || isExpired(model)) {
    if (model && isExpired(model)) ctx.waitUntil(releaseShareQuota(env, id));
    return json({ error: 'This share link is unavailable.' }, 404);
  }

  const preview = await env.SHARES.get(`shares/${id}.png`);
  if (!preview) return json({ error: 'This share has no preview image.' }, 404);
  const headers = new Headers();
  preview.writeHttpMetadata(headers);
  headers.set('Content-Type', 'image/png');
  headers.set('Cache-Control', 'public, max-age=600');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(preview.body, { headers });
}

async function getShareLandingPage(id, request, env, ctx) {
  const model = await env.SHARES.head(`shares/${id}.3dm`);
  if (!model || isExpired(model)) {
    if (model && isExpired(model)) ctx.waitUntil(releaseShareQuota(env, id));
    return Response.redirect(requiredViewerOrigin(env), 302);
  }

  const viewerUrl = new URL(requiredViewerOrigin(env));
  viewerUrl.searchParams.set('share', id);
  // Embed controls are declared on the existing public share URL. Preserve
  // only the known presentation flags when that URL redirects into Viewer.
  const landingUrl = new URL(request.url);
  if (landingUrl.searchParams.get('embed') === '1') {
    viewerUrl.searchParams.set('embed', '1');
    if (landingUrl.searchParams.get('file') === '0') viewerUrl.searchParams.set('file', '0');
    if (landingUrl.searchParams.get('viewport') === 'full') viewerUrl.searchParams.set('viewport', 'full');
  }
  // The landing page can be served through the branded reverse proxy even
  // while the storage Worker continues to run on workers.dev.  Keep the
  // preview URL on that public host so social-card crawlers receive an image
  // from the same share address they requested.
  const publicOrigin = optionalShareOrigin(env) || new URL(request.url).origin;
  const previewUrl = new URL(`/v1/shares/${id}/thumbnail`, publicOrigin).toString();
  const title = 'Drakon3D Viewer';
  return new Response(shareLandingHtml(title, previewUrl, viewerUrl.toString()), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function getSocialSharePage(id, request, env, ctx) {
  const model = await env.SHARES.head(`shares/${id}.3dm`);
  if (!model || isExpired(model)) {
    if (model && isExpired(model)) ctx.waitUntil(releaseShareQuota(env, id));
    return new Response('This shared model is unavailable.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const publicOrigin = optionalShareOrigin(env) || new URL(request.url).origin;
  const shareUrl = new URL(`/s/${id}`, publicOrigin).toString();
  const title = model.customMetadata?.filename || 'Shared Drakon3D model';
  return new Response(socialShareHtml(title, shareUrl), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function getShare(id, request, env, origin, ctx) {
  const object = await env.SHARES.get(`shares/${id}.3dm`);
  if (!object) return json({ error: 'This share link is unavailable.' }, 404, cors(origin, env));

  if (isExpired(object)) {
    ctx.waitUntil(releaseShareQuota(env, id));
    return json({ error: 'This share link has expired.' }, 410, cors(origin, env));
  }

  const suppliedPrepareToken = request.headers.get('X-Drakon-Prepare-Token');
  const preparedByOwner = suppliedPrepareToken
    ? await isValidPrepareToken(suppliedPrepareToken, object.customMetadata)
    : false;
  if (suppliedPrepareToken && !preparedByOwner) {
    return json({ error: 'The share preparation link is invalid or has expired.' }, 403, cors(origin, env));
  }

  if (object.customMetadata?.passwordHash && !preparedByOwner) {
    const password = readPassword(request);
    if (password.error || !password.value || !await isCorrectPassword(password.value, object.customMetadata, env)) {
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
  let validation = await keygenValidateWithRequiredScopes(endpoint, headers, scope);

  // OVERDUE is a license check-in status, not a machine-heartbeat status.
  // The plug-in has already supplied its signed-in user's token and exact
  // license ID. Check in that same license, then validate it again. This keeps
  // public sharing tied to the existing active Drakon session without asking
  // the user to perform a second login or weakening expiry/suspension checks.
  if (validation.response?.ok && keygenCode(validation.result) === 'OVERDUE') {
    const checkInEndpoint = `https://api.keygen.sh/v1/accounts/${encodeURIComponent(configuration.keygenAccountId)}/licenses/${encodeURIComponent(licenseId)}/actions/check-in`;
    const checkIn = await keygenCheckIn(checkInEndpoint, headers);
    if (checkIn.response?.ok) {
      validation = await keygenValidateWithRequiredScopes(endpoint, headers, scope);
    }
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

async function keygenValidateWithRequiredScopes(endpoint, headers, scope) {
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

  return validation;
}

async function keygenCheckIn(endpoint, headers) {
  try {
    const response = await fetch(endpoint, { method: 'POST', headers });
    let result = null;
    try { result = await response.json(); } catch { /* response status is sufficient */ }
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
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Drakon-Share-Password, X-Drakon-Prepare-Token, X-Drakon-Filename');
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

function optionalShareOrigin(env) {
  const value = env.SHARE_PUBLIC_ORIGIN;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isExpired(object) {
  const expiresAt = Date.parse(object?.customMetadata?.expiresAt || '');
  return !Number.isFinite(expiresAt) || Date.now() >= expiresAt;
}

function safeHtmlTitle(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function shareLandingHtml(title, previewUrl, viewerUrl) {
  const escapedViewerUrl = safeHtmlTitle(viewerUrl);
  const escapedPreviewUrl = safeHtmlTitle(previewUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="Open this Drakon 3D design in your browser."><meta property="og:image" content="${escapedPreviewUrl}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:image" content="${escapedPreviewUrl}"><meta http-equiv="refresh" content="0;url=${escapedViewerUrl}"><script>location.replace(${JSON.stringify(viewerUrl)})</script></head><body><p>Opening Drakon 3D Viewer… <a href="${escapedViewerUrl}">Continue</a></p></body></html>`;
}

function socialShareHtml(title, shareUrl) {
  const message = `View this Drakon3D model: ${shareUrl}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const emailUrl = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(message)}`;
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
  const escapedTitle = safeHtmlTitle(title);
  const escapedShareUrl = safeHtmlTitle(shareUrl);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share ${escapedTitle}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#fff;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}.card{width:min(100%,440px);padding:28px;border:1px solid #353535;border-radius:16px;background:#1c1c1c;box-shadow:0 16px 48px #0007}h1{font-size:24px;margin:0 0 8px;overflow-wrap:anywhere}p{color:#c4c4c4;margin:0 0 22px}.actions{display:grid;gap:10px}.actions[hidden],.embed-panel[hidden]{display:none!important}.action{display:block;width:100%;padding:13px 16px;border:0;border-radius:9px;background:#fff;color:#111;text-align:center;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}.secondary{background:#2c2c2c;color:#fff}.url{margin-top:18px;color:#aaa;font-size:12px;overflow-wrap:anywhere}.embed-panel{display:grid;gap:13px}.embed-panel h2{font-size:19px;margin:0}.embed-option{display:flex;justify-content:space-between;gap:16px;align-items:center;color:#ddd;font-size:14px}.embed-option input{width:17px;height:17px;accent-color:#fff}.embed-code{width:100%;min-height:150px;resize:vertical;border:1px solid #454545;border-radius:9px;background:#111;color:#eee;padding:10px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.embed-help{margin:0;color:#aaa;font-size:12px}</style>
</head><body><main class="card"><h1>Share model</h1><p>${escapedTitle}</p><div class="actions" id="share-actions"><button class="action" id="native-share" type="button">Share with an app</button><a class="action secondary" href="${safeHtmlTitle(whatsappUrl)}" target="_blank" rel="noopener">WhatsApp</a><a class="action secondary" href="${safeHtmlTitle(emailUrl)}">Email</a><a class="action secondary" href="${safeHtmlTitle(facebookUrl)}" target="_blank" rel="noopener">Facebook</a><button class="action secondary" id="embed-link" type="button">Embed</button><button class="action secondary" id="copy-link" type="button">Copy link</button></div><section class="embed-panel" id="embed-panel" hidden><h2>Embed model</h2><label class="embed-option">Hide File menu <input id="embed-hide-file" type="checkbox" checked></label><label class="embed-option">Keep 3D viewport full size <input id="embed-full-viewport" type="checkbox" checked></label><textarea id="embed-code" class="embed-code" readonly spellcheck="false" aria-label="Embed code"></textarea><p class="embed-help">This uses the same share link and preserves its password, expiry and permissions.</p><button class="action" id="copy-embed" type="button">Copy embed code</button><button class="action secondary" id="close-embed" type="button">Back</button></section><div class="url">${escapedShareUrl}</div></main><script>
const shareUrl=${JSON.stringify(shareUrl)};const shareData={title:'Drakon3D model',text:'View this Drakon3D model.',url:shareUrl};
const copyButton=document.querySelector('#copy-link');
async function copyLink(){try{await navigator.clipboard.writeText(shareUrl);copyButton.textContent='Link copied';setTimeout(()=>copyButton.textContent='Copy link',1800)}catch{copyButton.textContent='Copy unavailable'}}
copyButton.addEventListener('click',copyLink);
document.querySelector('#native-share').addEventListener('click',async()=>{if(typeof navigator.share==='function'){try{await navigator.share(shareData);return}catch(error){if(error&&error.name==='AbortError')return}}await copyLink()});
const shareActions=document.querySelector('#share-actions'),embedPanel=document.querySelector('#embed-panel'),embedCode=document.querySelector('#embed-code'),hideFile=document.querySelector('#embed-hide-file'),fullViewport=document.querySelector('#embed-full-viewport'),copyEmbed=document.querySelector('#copy-embed');
function updateEmbedCode(){const url=new URL(shareUrl);url.searchParams.set('embed','1');if(hideFile.checked)url.searchParams.set('file','0');else url.searchParams.delete('file');if(fullViewport.checked)url.searchParams.set('viewport','full');else url.searchParams.delete('viewport');const height=fullViewport.checked?'100vh; min-height:700px':'700px';embedCode.value='<iframe\\n  src="'+url.toString()+'"\\n  style="width:100%; height:'+height+'; border:0; display:block;"\\n  allow="fullscreen"\\n  allowfullscreen>\\n</iframe>'}
document.querySelector('#embed-link').addEventListener('click',()=>{updateEmbedCode();shareActions.hidden=true;embedPanel.hidden=false;embedCode.focus()});
document.querySelector('#close-embed').addEventListener('click',()=>{embedPanel.hidden=true;shareActions.hidden=false});
hideFile.addEventListener('change',updateEmbedCode);fullViewport.addEventListener('change',updateEmbedCode);
copyEmbed.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(embedCode.value);copyEmbed.textContent='Embed code copied';setTimeout(()=>copyEmbed.textContent='Copy embed code',1800)}catch{copyEmbed.textContent='Copy unavailable'}});
</script></body></html>`;
}

function readBearerToken(authorization) {
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+([^\s]{1,8192})$/i) : null;
  return match ? match[1] : null;
}

async function isAccountApiRequest(request, env) {
  const configuredSecret = typeof env.DRAKON_SHARE_ACCOUNT_API_SECRET === 'string'
    ? env.DRAKON_SHARE_ACCOUNT_API_SECRET.trim()
    : '';
  const suppliedSecret = readSafeHeader(request, 'X-Drakon-Account-Secret', 8192);
  if (!configuredSecret || !suppliedSecret) return false;
  return constantTimeStringEqual(
    await sha256Hex(suppliedSecret),
    await sha256Hex(configuredSecret),
  );
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

function safeFilename(value, extension = '3dm') {
  let decoded = `design.${extension}`;
  try {
    if (value) decoded = decodeURIComponent(value);
  } catch {
    // Use the safe fallback below when a malformed header is received.
  }
  const cleaned = decoded.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  const baseName = cleaned.replace(/\.(?:3dm|rhv)$/i, '').trim();
  return `${baseName || 'design'}.${extension}`;
}

function randomId() {
  return randomToken(SHARE_ID_BYTES);
}

function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function isValidPrepareToken(token, metadata) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const expiresAt = Date.parse(metadata?.prepareExpiresAt || '');
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = metadata?.prepareTokenHash;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return constantTimeStringEqual(await sha256Hex(token), expected);
}

function constantTimeStringEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
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

async function passwordProtectionMetadata(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePepperedPasswordHash(password, salt, env);
  return {
    passwordSalt: toBase64Url(salt),
    passwordHash: toBase64Url(hash),
    passwordHashVersion: PASSWORD_HASH_VERSION,
  };
}

async function isCorrectPassword(password, metadata, env) {
  // Shares created before this update retain their PBKDF2 verification data.
  // New shares use a server-secret HMAC so password protection stays within
  // the CPU allowance of the Cloudflare Worker plan.
  if (metadata.passwordHashVersion === PASSWORD_HASH_VERSION) {
    try {
      const expected = fromBase64Url(metadata.passwordHash);
      const salt = fromBase64Url(metadata.passwordSalt);
      return constantTimeBytesEqual(await derivePepperedPasswordHash(password, salt, env), expected);
    } catch {
      return false;
    }
  }

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

async function derivePepperedPasswordHash(password, salt, env) {
  const pepper = env.DRAKON_SHARE_PASSWORD_PEPPER;
  if (typeof pepper !== 'string' || pepper.length < 32) throw new Error('Password pepper is unavailable.');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const passwordBytes = new TextEncoder().encode(password);
  const payload = new Uint8Array(1 + salt.length + passwordBytes.length);
  payload[0] = 2;
  payload.set(salt, 1);
  payload.set(passwordBytes, 1 + salt.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
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
