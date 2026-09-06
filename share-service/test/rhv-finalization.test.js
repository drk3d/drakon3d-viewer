import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const SHARE_ID = 'A'.repeat(24);
const PREPARE_TOKEN = 'B'.repeat(32);
const VIEWER_ORIGIN = 'https://viewer.drakon3d.com';

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function makeEnvironment(originalSize = 128) {
  const state = {
    puts: [],
    quotaRequests: [],
    object: {
      size: originalSize,
      customMetadata: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        filename: 'design.3dm',
        format: '3dm',
        passwordHash: 'protected',
        prepareTokenHash: await sha256Hex(PREPARE_TOKEN),
        prepareExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      writeHttpMetadata() {},
    },
  };

  const env = {
    VIEWER_ORIGIN,
    SHARES: {
      async head() { return state.object; },
      async get() {
        return {
          ...state.object,
          body: new Uint8Array(state.object.size),
        };
      },
      async put(key, body, options) {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        state.puts.push({ key, bytes, options });
        state.object = {
          size: bytes.length,
          customMetadata: options.customMetadata,
          writeHttpMetadata() {},
        };
        return { size: bytes.length };
      },
    },
    SHARE_QUOTAS: {
      idFromName() { return 'quota'; },
      get() {
        return {
          async fetch(_url, init) {
            state.quotaRequests.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ ok: true }));
          },
        };
      },
    },
  };
  return { env, state };
}

function request(path, { token = PREPARE_TOKEN, size = 64 } = {}) {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: {
      Origin: VIEWER_ORIGIN,
      'Content-Type': 'application/vnd.drakon.rhv',
      'Content-Length': String(size),
      'X-Drakon-Prepare-Token': token,
      'X-Drakon-Filename': 'ring.rhv',
    },
    body: new Uint8Array(size),
    duplex: 'half',
  });
}

test('a valid creator token atomically replaces a larger 3DM with RHV', async () => {
  const { env, state } = await makeEnvironment();
  const response = await worker.fetch(
    request(`/v1/shares/${SHARE_ID}/model`),
    env,
    { waitUntil() {} },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.optimized, true);
  assert.equal(state.puts.length, 1);
  assert.equal(state.puts[0].key, `shares/${SHARE_ID}.3dm`);
  assert.equal(state.object.customMetadata.format, 'rhv');
  assert.equal(state.object.customMetadata.filename, 'ring.rhv');
  assert.deepEqual(state.quotaRequests, [{
    action: 'resize',
    shareId: SHARE_ID,
    size: 64,
    maxLiveBytes: 8 * 1024 * 1024 * 1024,
  }]);
});

test('a compact file that is not smaller leaves the original 3DM untouched', async () => {
  const { env, state } = await makeEnvironment(64);
  const response = await worker.fetch(
    request(`/v1/shares/${SHARE_ID}/model`, { size: 64 }),
    env,
    { waitUntil() {} },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.optimized, false);
  assert.equal(state.puts.length, 0);
  assert.equal(state.object.customMetadata.format, '3dm');
});

test('an invalid preparation token cannot read or replace a password-protected share', async () => {
  const { env, state } = await makeEnvironment();
  const invalidToken = 'C'.repeat(32);
  const replaceResponse = await worker.fetch(
    request(`/v1/shares/${SHARE_ID}/model`, { token: invalidToken }),
    env,
    { waitUntil() {} },
  );
  assert.equal(replaceResponse.status, 403);
  assert.equal(state.puts.length, 0);

  const readResponse = await worker.fetch(new Request(
    `https://worker.example/v1/shares/${SHARE_ID}`,
    { headers: { Origin: VIEWER_ORIGIN, 'X-Drakon-Prepare-Token': invalidToken } },
  ), env, { waitUntil() {} });
  assert.equal(readResponse.status, 403);
});
