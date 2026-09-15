import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const LICENSE_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_SECRET = 'test-account-secret';
const SHARE_ID = 'A'.repeat(24);

function createEnvironment(onQuotaRequest) {
  const objects = new Map();
  return {
    DRAKON_SHARE_ACCOUNT_API_SECRET: ACCOUNT_SECRET,
    SHARE_PUBLIC_ORIGIN: 'https://share.drakon3d.com',
    VIEWER_ORIGIN: 'https://viewer.drakon3d.com',
    SHARE_QUOTAS: {
      idFromName() { return 'quota'; },
      get() {
        return {
          async fetch(_url, init) {
            const request = JSON.parse(init.body);
            const response = onQuotaRequest(request);
            return Response.json(response || {
              ok: true,
              shares: [{
                shareId: SHARE_ID,
                filename: 'Solitaire.3dm',
                expiresAt: Date.UTC(2026, 8, 18),
                hasPreview: true,
              }],
            });
          },
        };
      },
    },
    SHARES: {
      async get(key) { return objects.get(key) || null; },
      async head(key) { return objects.get(key) || null; },
      async put(key, body, options) {
        const stored = {
          body,
          size: typeof body === 'string' ? body.length : 1,
          customMetadata: options.customMetadata,
          httpMetadata: options.httpMetadata,
        };
        objects.set(key, stored);
        return stored;
      },
      objects,
    },
  };
}

test('the social share page provides browser and direct share choices for an active link', async () => {
  const environment = createEnvironment(() => ({ ok: true }));
  environment.SHARES.objects.set(`shares/${SHARE_ID}.3dm`, {
    size: 11,
    customMetadata: {
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      filename: 'Solitaire.3dm',
    },
  });

  const response = await worker.fetch(new Request(`https://worker.example/share/${SHARE_ID}`), environment, { waitUntil() {} });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Share with an app/);
  assert.match(html, /WhatsApp/);
  assert.match(html, /mailto:/);
  assert.match(html, new RegExp(`/s/${SHARE_ID}`));
});

test('the account endpoint returns only the authenticated license share records', async () => {
  let quotaRequest = null;
  const response = await worker.fetch(new Request('https://worker.example/v1/account/shares', {
    headers: {
      'X-Drakon-Account-Secret': ACCOUNT_SECRET,
      'X-Drakon-License-Id': LICENSE_ID,
    },
  }), createEnvironment(request => { quotaRequest = request; }), { waitUntil() {} });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(quotaRequest.action, 'list');
  assert.match(quotaRequest.licenseKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(body.shares, [{
    id: SHARE_ID,
    url: `https://share.drakon3d.com/s/${SHARE_ID}`,
    thumbnailUrl: `https://share.drakon3d.com/v1/shares/${SHARE_ID}/thumbnail`,
    filename: 'Solitaire.3dm',
    expiresAt: '2026-09-18T00:00:00.000Z',
    hasPreview: true,
  }]);
});

test('the account endpoint rejects requests without the server-to-server secret', async () => {
  let quotaCalled = false;
  const response = await worker.fetch(new Request('https://worker.example/v1/account/shares', {
    headers: { 'X-Drakon-License-Id': LICENSE_ID },
  }), createEnvironment(() => { quotaCalled = true; }), { waitUntil() {} });

  assert.equal(response.status, 401);
  assert.equal(quotaCalled, false);
});

test('the account endpoint deletes only through the authenticated licence', async () => {
  let quotaRequest = null;
  const response = await worker.fetch(new Request(`https://worker.example/v1/account/shares/${SHARE_ID}`, {
    method: 'DELETE',
    headers: {
      'X-Drakon-Account-Secret': ACCOUNT_SECRET,
      'X-Drakon-License-Id': LICENSE_ID,
    },
  }), createEnvironment(request => {
    quotaRequest = request;
    return { ok: true };
  }), { waitUntil() {} });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(quotaRequest.action, 'delete');
  assert.equal(quotaRequest.shareId, SHARE_ID);
  assert.match(quotaRequest.licenseKey, /^[a-f0-9]{64}$/);
});

test('the account endpoint updates an owned share expiry and its R2 metadata', async () => {
  const requests = [];
  const environment = createEnvironment(request => {
    requests.push(request);
    return request.action === 'updateExpiry'
      ? { ok: true, previousExpiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000, expiresAt: request.expiresAt }
      : { ok: true };
  });
  const licenseKey = await sha256(LICENSE_ID);
  const modelKey = `shares/${SHARE_ID}.3dm`;
  environment.SHARES.objects.set(modelKey, {
    body: 'model-bytes',
    size: 11,
    httpMetadata: { contentType: 'application/octet-stream', contentDisposition: 'inline; filename="Solitaire.3dm"' },
    customMetadata: {
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      ownerLicenseKey: licenseKey,
      filename: 'Solitaire.3dm',
    },
  });

  const requestedDate = utcDateString(2);
  const response = await worker.fetch(new Request(`https://worker.example/v1/account/shares/${SHARE_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Drakon-Account-Secret': ACCOUNT_SECRET,
      'X-Drakon-License-Id': LICENSE_ID,
    },
    body: JSON.stringify({ expiresOn: requestedDate }),
  }), environment, { waitUntil() {} });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.expiresAt, `${requestedDate}T23:59:59.999Z`);
  assert.equal(requests.filter(request => request.action === 'updateExpiry').length, 1);
  assert.equal(environment.SHARES.objects.get(modelKey).customMetadata.expiresAt, body.expiresAt);
  assert.equal(environment.SHARES.objects.get(modelKey).customMetadata.ownerLicenseKey, licenseKey);
});

test('the account expiry endpoint rejects a date outside the calendar limit', async () => {
  let quotaCalled = false;
  const environment = createEnvironment(() => { quotaCalled = true; return { ok: true }; });
  const response = await worker.fetch(new Request(`https://worker.example/v1/account/shares/${SHARE_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Drakon-Account-Secret': ACCOUNT_SECRET,
      'X-Drakon-License-Id': LICENSE_ID,
    },
    body: JSON.stringify({ expiresOn: utcDateString(16) }),
  }), environment, { waitUntil() {} });

  assert.equal(response.status, 400);
  assert.equal(quotaCalled, false);
});

async function sha256(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function utcDateString(daysAhead) {
  const date = new Date();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysAhead));
  return target.toISOString().slice(0, 10);
}
