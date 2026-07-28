// e2e/teach/argparse.test.mjs
//
// Unit tests for teach.mjs's pure argv parser (parseArgs) and the CLI
// entry-point safety behavior around --help and unrecognized flags.
//
// SAFETY CONTEXT: running `node e2e/teach/teach.mjs --help` (or any typo'd
// flag) must NEVER fall through to a default full live run - that launches
// 3 headed browsers and creates 3 real Firebase accounts against production.
// --help and unknown flags must both short-circuit before any browser or
// account-creation code path runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, USAGE } from './teach.mjs';

test('parseArgs: --help sets help=true and does not set unknownFlag', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: -h sets help=true (short form)', () => {
  const args = parseArgs(['-h']);
  assert.equal(args.help, true);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: an unrecognized flag sets unknownFlag to that flag and help stays false', () => {
  const args = parseArgs(['--bogus-flag']);
  assert.equal(args.unknownFlag, '--bogus-flag');
  assert.equal(args.help, false);
});

test('parseArgs: an unrecognized flag is detected even after recognized flags', () => {
  const args = parseArgs(['--self-check', '--nonsense']);
  assert.equal(args.unknownFlag, '--nonsense');
  assert.equal(args.selfCheck, true);
});

test('parseArgs: stops scanning at the first unrecognized flag (does not also flag consumed values)', () => {
  // --target consumes its following value; a URL-looking value must never be
  // treated as an unknown flag itself, since it doesn't start with "-".
  const args = parseArgs(['--target', 'https://example.com', '--typo']);
  assert.equal(args.target, 'https://example.com');
  assert.equal(args.unknownFlag, '--typo');
});

test('parseArgs: recognized flags still work exactly as before (no help/unknownFlag set)', () => {
  const args = parseArgs(['--self-check']);
  assert.equal(args.selfCheck, true);
  assert.equal(args.help, false);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: --loop still implies --one-window when no unknown flag present', () => {
  const args = parseArgs(['--loop']);
  assert.equal(args.loop, true);
  assert.equal(args.oneWindow, true);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: --persona <key> still parses its value', () => {
  const args = parseArgs(['--persona', 'cstore']);
  assert.equal(args.persona, 'cstore');
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: no args at all -> help=false, unknownFlag=null (default full live run path)', () => {
  const args = parseArgs([]);
  assert.equal(args.help, false);
  assert.equal(args.unknownFlag, null);
});

test('USAGE: mentions all real flags and the TEACH_ env budget vars', () => {
  assert.match(USAGE, /--self-check/);
  assert.match(USAGE, /--loop/);
  assert.match(USAGE, /--one-window/);
  assert.match(USAGE, /--persona/);
  assert.match(USAGE, /TEACH_/);
});

test('USAGE: documents --lesson <id|level>[,<id|level>...]', () => {
  assert.match(USAGE, /--lesson/);
  assert.match(USAGE, /<id\|level>/);
});

test('parseArgs: no --lesson -> lessons is an empty array (unchanged default behavior)', () => {
  const args = parseArgs([]);
  assert.deepEqual(args.lessons, []);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: --lesson 7 parses to ["7"]', () => {
  const args = parseArgs(['--lesson', '7']);
  assert.deepEqual(args.lessons, ['7']);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: --lesson 2,7 parses a comma list to ["2", "7"]', () => {
  const args = parseArgs(['--lesson', '2,7']);
  assert.deepEqual(args.lessons, ['2', '7']);
});

test('parseArgs: --lesson live-decode-ladder-trace parses the slug form', () => {
  const args = parseArgs(['--lesson', 'live-decode-ladder-trace']);
  assert.deepEqual(args.lessons, ['live-decode-ladder-trace']);
});

test('parseArgs: repeated --lesson flags accumulate', () => {
  const args = parseArgs(['--lesson', '2', '--lesson', '7']);
  assert.deepEqual(args.lessons, ['2', '7']);
});

test('parseArgs: repeated --lesson combined with comma lists accumulate all values', () => {
  const args = parseArgs(['--lesson', '1,2', '--lesson', '7']);
  assert.deepEqual(args.lessons, ['1', '2', '7']);
});

test('parseArgs: --lesson works alongside --one-window and --persona (does not disturb other flags)', () => {
  const args = parseArgs(['--one-window', '--persona', 'tire', '--lesson', '7']);
  assert.equal(args.oneWindow, true);
  assert.equal(args.persona, 'tire');
  assert.deepEqual(args.lessons, ['7']);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: --lesson with a trailing unknown flag still reports the unknown flag', () => {
  const args = parseArgs(['--lesson', '7', '--typo']);
  assert.deepEqual(args.lessons, ['7']);
  assert.equal(args.unknownFlag, '--typo');
});

// --reuse-account: explicit flag to force account-reuse (login instead of
// fresh signup) ON. parseArgs itself stays pure/env-free - it only records
// whether the flag was passed; main() combines this with
// TEACH_BOT_ACCOUNT_PASSWORD presence to decide the actual reuse mode (see
// personas.mjs chooseAuthFlow / resolveIdentity, unit-tested there).

test('parseArgs: --reuse-account sets reuseAccount=true', () => {
  const args = parseArgs(['--reuse-account']);
  assert.equal(args.reuseAccount, true);
  assert.equal(args.unknownFlag, null);
});

test('parseArgs: default (no flag) -> reuseAccount=false', () => {
  const args = parseArgs([]);
  assert.equal(args.reuseAccount, false);
});

test('parseArgs: --reuse-account works alongside --one-window --persona --lesson', () => {
  const args = parseArgs(['--one-window', '--persona', 'tire', '--lesson', '7', '--reuse-account']);
  assert.equal(args.reuseAccount, true);
  assert.equal(args.oneWindow, true);
  assert.equal(args.persona, 'tire');
  assert.deepEqual(args.lessons, ['7']);
  assert.equal(args.unknownFlag, null);
});

test('USAGE: documents --reuse-account and the TEACH_BOT_ACCOUNT_* env vars', () => {
  assert.match(USAGE, /--reuse-account/);
  assert.match(USAGE, /TEACH_BOT_ACCOUNT_EMAIL/);
  assert.match(USAGE, /TEACH_BOT_ACCOUNT_PASSWORD/);
});
