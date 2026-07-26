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
  computeSplitLayout,
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

// computeSplitLayout: pure 2-up left/right split-screen window positioning.
// Owner requirement: at most 2 windows visible concurrently, one occupying
// the LEFT half of the screen, one the RIGHT half (each ~half width, full
// height). No live browser or real screen size is used here - just math.

test('computeSplitLayout: index 0 occupies the left half starting at x=0,y=0', () => {
  const layout = computeSplitLayout(1920, 1080, 0);
  assert.equal(layout.x, 0);
  assert.equal(layout.y, 0);
  assert.equal(layout.width, 960);
  assert.equal(layout.height, 1080);
});

test('computeSplitLayout: index 1 occupies the right half starting at x=width/2', () => {
  const layout = computeSplitLayout(1920, 1080, 1);
  assert.equal(layout.x, 960);
  assert.equal(layout.y, 0);
  assert.equal(layout.width, 960);
  assert.equal(layout.height, 1080);
});

test('computeSplitLayout: left and right halves never overlap and together span the full width', () => {
  const left = computeSplitLayout(1920, 1080, 0);
  const right = computeSplitLayout(1920, 1080, 1);
  assert.equal(left.x + left.width, right.x);
  assert.equal(left.width + right.width, 1920);
});

test('computeSplitLayout: both halves use the full screen height', () => {
  const left = computeSplitLayout(1600, 900, 0);
  const right = computeSplitLayout(1600, 900, 1);
  assert.equal(left.height, 900);
  assert.equal(right.height, 900);
});

test('computeSplitLayout: odd screen width still produces two non-overlapping halves covering the width', () => {
  const left = computeSplitLayout(1921, 1080, 0);
  const right = computeSplitLayout(1921, 1080, 1);
  assert.equal(left.x, 0);
  assert.equal(left.x + left.width, right.x);
  assert.equal(right.x + right.width, 1921);
});

test('computeSplitLayout: index beyond 0/1 wraps modulo 2 (never more than 2 slots)', () => {
  const layoutFor2 = computeSplitLayout(1920, 1080, 2);
  const layoutFor0 = computeSplitLayout(1920, 1080, 0);
  assert.deepEqual(layoutFor2, layoutFor0);
});

test('computeSplitLayout: returns integer pixel values', () => {
  const left = computeSplitLayout(1921, 1080, 0);
  const right = computeSplitLayout(1921, 1080, 1);
  for (const v of [left.x, left.y, left.width, left.height, right.x, right.y, right.width, right.height]) {
    assert.ok(Number.isInteger(v), `expected integer, got ${v}`);
  }
});
