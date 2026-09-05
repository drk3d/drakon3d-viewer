// A single Durable Object serializes quota changes. Upload bytes stay in R2;
// this object stores only small accounting records, which keeps the public
// sharing service inexpensive and makes its policy limits race-safe.

const GLOBAL_KEY = 'state:global';
const LICENSE_PREFIX = 'license:';
const SHARE_PREFIX = 'share:';
const RESERVATION_TTL_MS = 15 * 60 * 1000;

export class ShareQuotaCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') return quotaJson({ error: 'Not found.' }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return quotaJson({ error: 'Invalid quota request.' }, 400);
    }

    const action = body?.action;
    try {
      if (action === 'reserve') {
        await this.cleanupExpired(Date.now());
        return quotaJson(await this.reserve(body));
      }
      if (action === 'status') {
        await this.cleanupExpired(Date.now());
        return quotaJson(await this.status(body));
      }
      if (action === 'confirm') return quotaJson(await this.confirm(body));
      if (action === 'reservePreview') return quotaJson(await this.reservePreview(body));
      if (action === 'releasePreview') return quotaJson(await this.releasePreview(body));
      if (action === 'cancel' || action === 'release') return quotaJson(await this.release(body));
      if (action === 'cleanup') {
        await this.cleanupExpired(Date.now());
        return quotaJson({ ok: true });
      }
    } catch (error) {
      console.error('Drakon Share quota coordinator failed', error);
      return quotaJson({ ok: false, status: 503, error: 'Drakon Share is temporarily unavailable.' }, 503);
    }

    return quotaJson({ error: 'Invalid quota action.' }, 400);
  }

  async alarm() {
    await this.cleanupExpired(Date.now());
  }

  async reserve(body) {
    const request = validateReservation(body);
    if (!request) return { ok: false, status: 400, error: 'Invalid share quota request.' };

    const result = await this.ctx.storage.transaction(async transaction => {
      const shareStorageKey = shareKey(request.shareId);
      if (await transaction.get(shareStorageKey)) {
        return { ok: false, status: 409, error: 'Please retry creating the share link.' };
      }

      const global = (await transaction.get(GLOBAL_KEY)) || emptyGlobalState();
      const licenseStorageKey = licenseKey(request.licenseKey);
      const license = (await transaction.get(licenseStorageKey)) || emptyLicenseState();

      if (global.activeBytes + global.pendingBytes + request.size > request.maxLiveBytes) {
        return {
          ok: false,
          status: 503,
          code: 'SERVICE_CAPACITY_REACHED',
          error: 'Drakon Share is temporarily at capacity. Please try again later.',
        };
      }

      if (license.activeCount + license.pendingCount >= request.policy.active) {
        return {
          ok: false,
          status: 429,
          code: 'ACTIVE_LINK_LIMIT_REACHED',
          error: `${request.policy.label} licenses can have ${request.policy.active} active Drakon Share links at a time.`,
          activeLimit: request.policy.active,
          activeCount: license.activeCount,
        };
      }

      if (request.policy.total != null && license.totalExports + license.pendingTrialExports >= request.policy.total) {
        return {
          ok: false,
          status: 429,
          code: 'TRIAL_EXPORT_LIMIT_REACHED',
          error: `Your trial includes ${request.policy.total} Drakon Share exports.`,
          exportLimit: request.policy.total,
          exportCount: license.totalExports,
        };
      }

      const now = Date.now();
      const reservationUntil = Math.min(request.expiresAt, now + RESERVATION_TTL_MS);
      const share = {
        shareId: request.shareId,
        licenseKey: request.licenseKey,
        size: request.size,
        expiresAt: request.expiresAt,
        reservationUntil,
        state: 'reserved',
      };

      license.pendingCount += 1;
      if (request.policy.total != null) license.pendingTrialExports += 1;
      global.pendingCount += 1;
      global.pendingBytes += request.size;

      await transaction.put(shareStorageKey, share);
      await transaction.put(licenseStorageKey, license);
      await transaction.put(GLOBAL_KEY, global);
      return { ok: true };
    });

    if (result.ok) await this.scheduleNextAlarm();
    return result;
  }

  async confirm(body) {
    const shareId = boundedId(body?.shareId);
    if (!shareId) return { ok: false, status: 400, error: 'Invalid share confirmation.' };

    const result = await this.ctx.storage.transaction(async transaction => {
      const key = shareKey(shareId);
      const share = await transaction.get(key);
      if (!share || share.state !== 'reserved') {
        return { ok: false, status: 409, error: 'The share reservation is no longer available.' };
      }
      if (share.reservationUntil <= Date.now()) {
        return { ok: false, status: 409, error: 'The share reservation expired. Please try again.' };
      }

      const global = (await transaction.get(GLOBAL_KEY)) || emptyGlobalState();
      const storageKey = licenseKey(share.licenseKey);
      const license = (await transaction.get(storageKey)) || emptyLicenseState();

      share.state = 'active';
      delete share.reservationUntil;
      global.pendingCount = decrement(global.pendingCount);
      global.pendingBytes = decrement(global.pendingBytes, share.size);
      global.activeCount += 1;
      global.activeBytes += share.size;
      license.pendingCount = decrement(license.pendingCount);
      license.activeCount += 1;
      if (license.pendingTrialExports > 0) {
        license.pendingTrialExports -= 1;
        license.totalExports += 1;
      }

      await transaction.put(key, share);
      await transaction.put(storageKey, license);
      await transaction.put(GLOBAL_KEY, global);
      return { ok: true, activeCount: license.activeCount, totalExports: license.totalExports };
    });

    if (result.ok) await this.scheduleNextAlarm();
    return result;
  }

  async status(body) {
    const licenseKeyValue = typeof body?.licenseKey === 'string' && /^[a-f0-9]{64}$/.test(body.licenseKey)
      ? body.licenseKey
      : null;
    if (!licenseKeyValue) return { ok: false, status: 400, error: 'Invalid share status request.' };

    const license = (await this.ctx.storage.get(licenseKey(licenseKeyValue))) || emptyLicenseState();
    return { ok: true, activeCount: license.activeCount, totalExports: license.totalExports };
  }

  async reservePreview(body) {
    const shareId = boundedId(body?.shareId);
    const size = safeInteger(body?.size, 1, 4 * 1024 * 1024);
    const maxLiveBytes = safeInteger(body?.maxLiveBytes, 1, 100 * 1024 * 1024 * 1024);
    if (!shareId || !size || !maxLiveBytes) return { ok: false, status: 400, error: 'Invalid preview reservation.' };

    return this.ctx.storage.transaction(async transaction => {
      const key = shareKey(shareId);
      const share = await transaction.get(key);
      if (!share || share.state !== 'active') return { ok: false, status: 404, error: 'This share link is unavailable.' };
      if (share.previewSize) return { ok: false, status: 409, error: 'A preview image already exists for this share.' };

      const global = (await transaction.get(GLOBAL_KEY)) || emptyGlobalState();
      if (global.activeBytes + global.pendingBytes + size > maxLiveBytes) {
        return { ok: false, status: 503, error: 'Drakon Share is temporarily at capacity. Please try again later.' };
      }

      share.previewSize = size;
      global.activeBytes += size;
      await transaction.put(key, share);
      await transaction.put(GLOBAL_KEY, global);
      return { ok: true };
    });
  }

  async releasePreview(body) {
    const shareId = boundedId(body?.shareId);
    if (!shareId) return { ok: false, status: 400, error: 'Invalid preview reference.' };

    return this.ctx.storage.transaction(async transaction => {
      const key = shareKey(shareId);
      const share = await transaction.get(key);
      if (!share?.previewSize) return { ok: true };

      const global = (await transaction.get(GLOBAL_KEY)) || emptyGlobalState();
      global.activeBytes = decrement(global.activeBytes, share.previewSize);
      delete share.previewSize;
      await transaction.put(key, share);
      await transaction.put(GLOBAL_KEY, global);
      return { ok: true };
    });
  }

  async release(body) {
    const shareId = boundedId(body?.shareId);
    if (!shareId) return { ok: false, status: 400, error: 'Invalid share reference.' };

    const share = await this.ctx.storage.get(shareKey(shareId));
    if (!share) return { ok: true };

    // Delete the R2 object before freeing its capacity. If R2 is temporarily
    // unavailable, the Durable Object alarm retries instead of allowing the
    // live storage total to drift upward unnoticed.
    await Promise.all([
      this.env.SHARES.delete(`shares/${shareId}.3dm`),
      this.env.SHARES.delete(`shares/${shareId}.png`),
    ]);
    await this.removeShares([share]);
    return { ok: true };
  }

  async cleanupExpired(now) {
    const records = await this.ctx.storage.list({ prefix: SHARE_PREFIX, limit: 10000 });
    const due = [];
    for (const share of records.values()) {
      if (share.state === 'active' && share.expiresAt <= now) due.push(share);
      else if (share.state === 'reserved' && share.reservationUntil <= now) due.push(share);
    }

    if (due.length > 0) {
      // R2 delete is idempotent: this also removes a model whose upload
      // completed but whose client lost connection before confirmation.
      await Promise.all(due.flatMap(share => [
        this.env.SHARES.delete(`shares/${share.shareId}.3dm`),
        this.env.SHARES.delete(`shares/${share.shareId}.png`),
      ]));
      await this.removeShares(due);
    }
    await this.scheduleNextAlarm();
  }

  async removeShares(shares) {
    if (!shares.length) return;
    await this.ctx.storage.transaction(async transaction => {
      const global = (await transaction.get(GLOBAL_KEY)) || emptyGlobalState();
      const licenses = new Map();

      for (const candidate of shares) {
        const key = shareKey(candidate.shareId);
        const share = await transaction.get(key);
        if (!share) continue;

        const storageKey = licenseKey(share.licenseKey);
        let license = licenses.get(storageKey);
        if (!license) {
          license = (await transaction.get(storageKey)) || emptyLicenseState();
          licenses.set(storageKey, license);
        }

        if (share.state === 'active') {
          global.activeCount = decrement(global.activeCount);
          global.activeBytes = decrement(global.activeBytes, share.size + (share.previewSize || 0));
          license.activeCount = decrement(license.activeCount);
        } else {
          global.pendingCount = decrement(global.pendingCount);
          global.pendingBytes = decrement(global.pendingBytes, share.size);
          license.pendingCount = decrement(license.pendingCount);
          // A cancelled reservation is not an export. The trial counter only
          // increases when R2 storage has been confirmed successfully.
          license.pendingTrialExports = decrement(license.pendingTrialExports);
        }
        await transaction.delete(key);
      }

      for (const [key, license] of licenses) await transaction.put(key, license);
      await transaction.put(GLOBAL_KEY, global);
    });
  }

  async scheduleNextAlarm() {
    const records = await this.ctx.storage.list({ prefix: SHARE_PREFIX, limit: 10000 });
    let next = null;
    for (const share of records.values()) {
      const candidate = share.state === 'active' ? share.expiresAt : share.reservationUntil;
      if (Number.isSafeInteger(candidate) && (next == null || candidate < next)) next = candidate;
    }

    if (next == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current == null || next !== current) await this.ctx.storage.setAlarm(next);
  }
}

function validateReservation(body) {
  const shareId = boundedId(body?.shareId);
  const licenseKeyValue = typeof body?.licenseKey === 'string' && /^[a-f0-9]{64}$/.test(body.licenseKey)
    ? body.licenseKey
    : null;
  const size = safeInteger(body?.size, 1, 100 * 1024 * 1024);
  const expiresAt = safeInteger(body?.expiresAt, Date.now() + 1000, Date.now() + 32 * 24 * 60 * 60 * 1000);
  const maxLiveBytes = safeInteger(body?.maxLiveBytes, 1, 100 * 1024 * 1024 * 1024);
  const active = safeInteger(body?.policy?.active, 1, 10000);
  const total = body?.policy?.total == null ? null : safeInteger(body.policy.total, 1, 10000);
  const label = typeof body?.policy?.label === 'string' && body.policy.label.length <= 80
    ? body.policy.label
    : null;
  if (!shareId || !licenseKeyValue || !size || !expiresAt || !maxLiveBytes || !active || (body?.policy?.total != null && !total) || !label) {
    return null;
  }
  return {
    shareId,
    licenseKey: licenseKeyValue,
    size,
    expiresAt,
    maxLiveBytes,
    policy: { active, total, label },
  };
}

function emptyGlobalState() {
  return { activeCount: 0, activeBytes: 0, pendingCount: 0, pendingBytes: 0 };
}

function emptyLicenseState() {
  return { activeCount: 0, pendingCount: 0, totalExports: 0, pendingTrialExports: 0 };
}

function shareKey(id) {
  return `${SHARE_PREFIX}${id}`;
}

function licenseKey(value) {
  return `${LICENSE_PREFIX}${value}`;
}

function boundedId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{24}$/.test(value) ? value : null;
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function decrement(value, amount = 1) {
  return Math.max(0, (Number.isSafeInteger(value) ? value : 0) - amount);
}

function quotaJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
