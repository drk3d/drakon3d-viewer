import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const ACCOUNT_ID = 'f301b769-0700-43e5-bce6-a4af9e55d29b';
const PRODUCT_ID = '859745b0-e758-44b7-9380-5c275f315884';
const POLICY_ID = 'f9158572-603b-47d5-a843-e29913671919';
const LICENSE_ID = '11111111-1111-1111-1111-111111111111';
const MACHINE_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

function licenseValidation(valid, code) {
  return {
    meta: { valid, code },
    data: {
      type: 'licenses',
      id: LICENSE_ID,
      attributes: { suspended: false, metadata: { pro: true } },
      relationships: {
        product: { data: { type: 'products', id: PRODUCT_ID } },
        policy: { data: { type: 'policies', id: POLICY_ID } },
        owner: { data: { type: 'users', id: USER_ID } },
      },
    },
  };
}

test('an overdue active Drakon session checks in its license and then returns its allowance', async () => {
  const originalFetch = globalThis.fetch;
  const keygenCalls = [];
  let validationCount = 0;

  globalThis.fetch = async (url, init) => {
    keygenCalls.push({ url: String(url), method: init?.method });
    if (String(url).endsWith('/actions/check-in')) {
      return Response.json({ data: { id: LICENSE_ID, type: 'licenses' } });
    }
    validationCount += 1;
    return Response.json(validationCount === 1
      ? licenseValidation(false, 'OVERDUE')
      : licenseValidation(true, 'VALID'));
  };

  const env = {
    KEYGEN_ACCOUNT_ID: ACCOUNT_ID,
    KEYGEN_PRODUCT_ID: PRODUCT_ID,
    SHARE_QUOTAS: {
      idFromName() { return 'quota'; },
      get() {
        return {
          async fetch() {
            return Response.json({ ok: true, activeCount: 9, totalExports: 0 });
          },
        };
      },
    },
  };

  try {
    const response = await worker.fetch(new Request('https://worker.example/v1/share-status', {
      headers: {
        Authorization: 'Bearer signed-in-user-token',
        'X-Drakon-License-Id': LICENSE_ID,
        'X-Drakon-Machine-Id': MACHINE_ID,
        'X-Drakon-Machine-Fingerprint': 'current-computer',
      },
    }), env, { waitUntil() {} });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.activeLinks, 9);
    assert.equal(result.activeLinkLimit, 30);
    assert.deepEqual(keygenCalls.map(call => call.method), ['POST', 'POST', 'POST']);
    assert.match(keygenCalls[1].url, new RegExp(`/licenses/${LICENSE_ID}/actions/check-in$`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
