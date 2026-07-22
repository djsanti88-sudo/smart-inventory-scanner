// e2e/teach/personas.test.mjs
//
// Unit tests for the PURE parts of personas.mjs only (makeEmail, makePassword,
// classifyDeploymentMode, PERSONAS shape). Browser-driven flows
// (probeDeployment, signUpPersona, newPersonaContext) require a live
// Playwright browser + deployed app and are exercised by the E2E harness,
// not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONAS,
  makeEmail,
  makePassword,
  classifyDeploymentMode,
} from './personas.mjs';

test('makeEmail: format is teachbot+<runId>-<personaKey>@scanbin-teachbot.test', () => {
  const email = makeEmail('run123', 'tire');
  assert.equal(email, 'teachbot+run123-tire@scanbin-teachbot.test');
  assert.match(email, /^teachbot\+[^@]+@scanbin-teachbot\.test$/);
});

test('makeEmail: deterministic for the same (runId, personaKey)', () => {
  const a = makeEmail('run123', 'tire');
  const b = makeEmail('run123', 'tire');
  assert.equal(a, b);
});

test('makeEmail: unique across personaKeys for the same runId', () => {
  const emails = PERSONAS.map((p) => makeEmail('run123', p.key));
  assert.equal(new Set(emails).size, emails.length);
});

test('makeEmail: unique across runIds for the same personaKey', () => {
  const a = makeEmail('run-A', 'tire');
  const b = makeEmail('run-B', 'tire');
  assert.notEqual(a, b);
});

test('makePassword: returns a non-empty string of decent length', () => {
  const pw = makePassword();
  assert.equal(typeof pw, 'string');
  assert.ok(pw.length >= 12, `expected password length >= 12, got ${pw.length}`);
});

test('makePassword: differs across calls', () => {
  const a = makePassword();
  const b = makePassword();
  assert.notEqual(a, b);
});

test('classifyDeploymentMode: login form present -> live_auth', () => {
  assert.equal(
    classifyDeploymentMode({
      hasLoginForm: true,
      hasBusinessGate: false,
      scannerVisibleWithoutLogin: false,
    }),
    'live_auth'
  );
});

test('classifyDeploymentMode: business gate present -> live_auth', () => {
  assert.equal(
    classifyDeploymentMode({
      hasLoginForm: false,
      hasBusinessGate: true,
      scannerVisibleWithoutLogin: false,
    }),
    'live_auth'
  );
});

test('classifyDeploymentMode: both login form and business gate -> live_auth', () => {
  assert.equal(
    classifyDeploymentMode({
      hasLoginForm: true,
      hasBusinessGate: true,
      scannerVisibleWithoutLogin: true,
    }),
    'live_auth'
  );
});

test('classifyDeploymentMode: only scanner visible without login -> demo_open', () => {
  assert.equal(
    classifyDeploymentMode({
      hasLoginForm: false,
      hasBusinessGate: false,
      scannerVisibleWithoutLogin: true,
    }),
    'demo_open'
  );
});

test('classifyDeploymentMode: all false -> live_auth (assume auth by default)', () => {
  assert.equal(
    classifyDeploymentMode({
      hasLoginForm: false,
      hasBusinessGate: false,
      scannerVisibleWithoutLogin: false,
    }),
    'live_auth'
  );
});

test('classifyDeploymentMode: handles missing/undefined fields gracefully', () => {
  assert.equal(classifyDeploymentMode({}), 'live_auth');
  assert.equal(classifyDeploymentMode(undefined), 'live_auth');
});

test('PERSONAS: exactly 3 personas', () => {
  assert.equal(PERSONAS.length, 3);
});

test('PERSONAS: exactly one mobile persona', () => {
  const mobile = PERSONAS.filter((p) => p.viewport === 'mobile');
  assert.equal(mobile.length, 1);
  assert.equal(mobile[0].key, 'supp');
});

test('PERSONAS: keys are unique', () => {
  const keys = PERSONAS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('PERSONAS: each persona has label, businessName, viewport, and code banks', () => {
  for (const persona of PERSONAS) {
    assert.equal(typeof persona.key, 'string');
    assert.equal(typeof persona.label, 'string');
    assert.equal(typeof persona.businessName, 'string');
    assert.ok(['desktop', 'mobile'].includes(persona.viewport));
    assert.ok(persona.codes, `persona ${persona.key} missing codes`);
    assert.ok(Array.isArray(persona.codes.known) && persona.codes.known.length > 0);
    assert.ok(Array.isArray(persona.codes.unknown) && persona.codes.unknown.length > 0);
    assert.ok(Array.isArray(persona.codes.vendor) && persona.codes.vendor.length > 0);
  }
});

test('PERSONAS: expected persona keys present (tire, cstore, supp)', () => {
  const keys = PERSONAS.map((p) => p.key).sort();
  assert.deepEqual(keys, ['cstore', 'supp', 'tire']);
});
