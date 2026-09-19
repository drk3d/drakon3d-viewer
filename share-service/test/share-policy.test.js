import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SHARE_TTL_DAYS,
  readShareConfiguration,
  resolveLicenseSharePolicy,
} from '../src/share-policy.js';

const COMMERCIAL_V1_POLICY_ID = 'de789532-945b-4de9-a0a3-2babfeea63c5';

test('public sharing defaults match the released license allowances', () => {
  const configuration = readShareConfiguration({});

  assert.deepEqual(configuration.limits.trial, {
    active: 5,
    total: 5,
    label: 'Trial',
  });
  assert.deepEqual(configuration.limits.lab, {
    active: 20,
    total: null,
    label: 'Lab',
  });
  assert.equal(configuration.limits.educational.active, 10);
  assert.equal(configuration.limits.commercial.active, 10);
  assert.equal(configuration.limits.commercialPro.active, 30);
  assert.equal(MAX_SHARE_TTL_DAYS, 15);
});

test('deployment limit overrides retain the same trial and lab allowances', () => {
  const configuration = readShareConfiguration({
    DRAKON_SHARE_LIMITS_JSON: JSON.stringify({
      trial: { active: 5, total: 5 },
      lab: { active: 20 },
    }),
  });

  assert.equal(configuration.limits.trial.active, 5);
  assert.equal(configuration.limits.trial.total, 5);
  assert.equal(configuration.limits.lab.active, 20);
});

test('Commercial 1.0 licenses are eligible for the commercial sharing allowance', () => {
  const policy = resolveLicenseSharePolicy({
    relationships: { policy: { data: { id: COMMERCIAL_V1_POLICY_ID } } },
    attributes: { metadata: {} },
  }, readShareConfiguration({}));

  assert.deepEqual(policy, {
    key: 'commercial',
    active: 10,
    total: null,
    label: 'Commercial',
  });
});
