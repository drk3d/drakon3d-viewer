import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const LICENSE_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_SECRET = 'test-account-secret';
const SHARE_ID = 'A'.repeat(24);

function createEnvironment(onQuotaRequest) {
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
  };
}

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
