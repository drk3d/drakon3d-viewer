import assert from 'node:assert/strict';
import test from 'node:test';

import { ShareQuotaCoordinator } from '../src/share-quota-coordinator.js';

const LICENSE_KEY = 'a'.repeat(64);
const OTHER_LICENSE_KEY = 'b'.repeat(64);
const SHARE_ID = 'A'.repeat(24);

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }

  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix, limit }) {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit));
  }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}

async function call(coordinator, body) {
  const response = await coordinator.fetch(new Request('https://quota.internal/', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  return response.json();
}

test('the quota coordinator lists only active links for the requested license', async () => {
  const storage = new MemoryStorage();
  const deletedKeys = [];
  const coordinator = new ShareQuotaCoordinator({ storage }, {
    SHARES: { async delete(key) { deletedKeys.push(key); } },
  });
  const expiresAt = Date.now() + 60_000;

  const reserved = await call(coordinator, {
    action: 'reserve',
    shareId: SHARE_ID,
    licenseKey: LICENSE_KEY,
    filename: 'Engagement ring.3dm',
    size: 128,
    expiresAt,
    maxLiveBytes: 1024,
    policy: { active: 10, total: null, label: 'Commercial' },
  });
  assert.equal(reserved.ok, true);
  assert.equal((await call(coordinator, { action: 'confirm', shareId: SHARE_ID })).ok, true);
  assert.equal((await call(coordinator, {
    action: 'reservePreview', shareId: SHARE_ID, size: 64, maxLiveBytes: 1024,
  })).ok, true);

  const result = await call(coordinator, { action: 'list', licenseKey: LICENSE_KEY });
  assert.deepEqual(result, {
    ok: true,
    shares: [{
      shareId: SHARE_ID,
      filename: 'Engagement ring.3dm',
      expiresAt,
      hasPreview: true,
    }],
  });

  assert.deepEqual(await call(coordinator, { action: 'list', licenseKey: OTHER_LICENSE_KEY }), {
    ok: true,
    shares: [],
  });

  assert.deepEqual(await call(coordinator, {
    action: 'delete', shareId: SHARE_ID, licenseKey: OTHER_LICENSE_KEY,
  }), {
    ok: false,
    status: 404,
    error: 'This share link is unavailable.',
  });

  assert.deepEqual(await call(coordinator, {
    action: 'delete', shareId: SHARE_ID, licenseKey: LICENSE_KEY,
  }), { ok: true });
  assert.deepEqual(deletedKeys, [`shares/${SHARE_ID}.3dm`, `shares/${SHARE_ID}.png`]);
  assert.deepEqual(await call(coordinator, { action: 'list', licenseKey: LICENSE_KEY }), {
    ok: true,
    shares: [],
  });
});
