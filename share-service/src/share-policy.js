// Share-policy configuration is intentionally isolated from transport and
// storage. Changing the commercial allowance later is a configuration change,
// not a plug-in release or a storage migration.

export const DEFAULT_KEYGEN_ACCOUNT_ID = 'f301b769-0700-43e5-bce6-a4af9e55d29b';
export const DEFAULT_KEYGEN_PRODUCT_ID = '859745b0-e758-44b7-9380-5c275f315884';

// These IDs mirror the production Drakon licensing policies. The legacy
// Commercial 1.0 policy is deliberately absent: it is not valid in current
// Drakon releases and must not gain public sharing access.
const POLICY_IDS = Object.freeze({
  trial: '4fece003-a155-4dfa-8f79-9c74919d5763',
  educational: '016f151a-9be8-44fe-a01e-2d0c6a7d6ba2',
  lab: '3787f0f4-32b4-4d85-a82c-85a409e0f192',
  commercial: 'f9158572-603b-47d5-a843-e29913671919',
});

const DEFAULT_LIMITS = Object.freeze({
  trial: { active: 3, total: 3, label: 'Trial' },
  educational: { active: 10, total: null, label: 'Educational' },
  lab: { active: 10, total: null, label: 'Lab' },
  commercial: { active: 10, total: null, label: 'Commercial' },
  commercialPro: { active: 30, total: null, label: 'Commercial Pro' },
});

export const DEFAULT_MAX_MODEL_BYTES = 100 * 1024 * 1024;
export const DEFAULT_SHARE_TTL_HOURS = 14 * 24;
// The 8 GiB guard leaves practical headroom under the R2 free-tier storage
// allowance and is a service-wide protection in addition to each licence cap.
export const DEFAULT_MAX_LIVE_BYTES = 8 * 1024 * 1024 * 1024;

export function readShareConfiguration(env) {
  const overrides = parseJsonObject(env.DRAKON_SHARE_LIMITS_JSON);
  const limits = {
    trial: readLimit(overrides.trial, DEFAULT_LIMITS.trial, true),
    educational: readLimit(overrides.educational, DEFAULT_LIMITS.educational),
    lab: readLimit(overrides.lab, DEFAULT_LIMITS.lab),
    commercial: readLimit(overrides.commercial, DEFAULT_LIMITS.commercial),
    commercialPro: readLimit(overrides.commercialPro, DEFAULT_LIMITS.commercialPro),
  };

  return {
    keygenAccountId: textOrDefault(env.KEYGEN_ACCOUNT_ID, DEFAULT_KEYGEN_ACCOUNT_ID),
    keygenProductId: textOrDefault(env.KEYGEN_PRODUCT_ID, DEFAULT_KEYGEN_PRODUCT_ID),
    maxModelBytes: readInteger(
      env.DRAKON_SHARE_MAX_MODEL_BYTES,
      DEFAULT_MAX_MODEL_BYTES,
      1 * 1024 * 1024,
      DEFAULT_MAX_MODEL_BYTES,
    ),
    ttlHours: readInteger(env.DRAKON_SHARE_TTL_HOURS, DEFAULT_SHARE_TTL_HOURS, 1, 31 * 24),
    maxLiveBytes: readInteger(
      env.DRAKON_SHARE_MAX_LIVE_BYTES,
      DEFAULT_MAX_LIVE_BYTES,
      1 * 1024 * 1024,
      100 * 1024 * 1024 * 1024,
    ),
    limits,
  };
}

export function resolveLicenseSharePolicy(license, configuration) {
  const policyId = relationshipId(license, 'policy');
  let key;
  if (policyId === POLICY_IDS.trial) key = 'trial';
  else if (policyId === POLICY_IDS.educational) key = 'educational';
  else if (policyId === POLICY_IDS.lab) key = 'lab';
  else if (policyId === POLICY_IDS.commercial) {
    key = truthyMetadata(license?.attributes?.metadata?.pro) ? 'commercialPro' : 'commercial';
  }
  if (!key) return null;

  return { key, ...configuration.limits[key] };
}

export function relationshipId(resource, relationship) {
  const id = resource?.relationships?.[relationship]?.data?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readLimit(value, defaults, includeTotal = false) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const active = readInteger(object.active, defaults.active, 1, 10000);
  const total = includeTotal
    ? readInteger(object.total, defaults.total, 1, 10000)
    : null;
  return { active, total, label: defaults.label };
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A bad optional override must not silently make the public service open.
    // Defaults are conservative and remain in force.
    return {};
  }
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function textOrDefault(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function truthyMetadata(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}
