// e2e/teach/limits.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RunLimits, SOURCE_WORST_CASE_USD } from './limits.mjs';

describe('RunLimits defaults from env', () => {
  test('uses env values when fields are unset', () => {
    const prev = {
      TEACH_MAX_PAID_LOOKUPS: process.env.TEACH_MAX_PAID_LOOKUPS,
      TEACH_MAX_REQUESTS: process.env.TEACH_MAX_REQUESTS,
      TEACH_MAX_MINUTES: process.env.TEACH_MAX_MINUTES,
      TEACH_ESTIMATED_MAX_USD: process.env.TEACH_ESTIMATED_MAX_USD,
    };
    process.env.TEACH_MAX_PAID_LOOKUPS = '7';
    process.env.TEACH_MAX_REQUESTS = '99';
    process.env.TEACH_MAX_MINUTES = '5';
    process.env.TEACH_ESTIMATED_MAX_USD = '1.5';
    try {
      const limits = new RunLimits();
      assert.equal(limits.maxPaidLookups, 7);
      assert.equal(limits.maxRequests, 99);
      assert.equal(limits.maxMinutes, 5);
      assert.equal(limits.estimatedMaxUsd, 1.5);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('falls back to hardcoded defaults when env is unset/invalid', () => {
    const prev = {
      TEACH_MAX_PAID_LOOKUPS: process.env.TEACH_MAX_PAID_LOOKUPS,
      TEACH_MAX_REQUESTS: process.env.TEACH_MAX_REQUESTS,
    };
    delete process.env.TEACH_MAX_PAID_LOOKUPS;
    process.env.TEACH_MAX_REQUESTS = 'not-a-number';
    try {
      const limits = new RunLimits();
      assert.equal(limits.maxPaidLookups, 15);
      assert.equal(limits.maxRequests, 400);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('explicit constructor args win over env', () => {
    process.env.TEACH_MAX_PAID_LOOKUPS = '7';
    try {
      const limits = new RunLimits({ maxPaidLookups: 3 });
      assert.equal(limits.maxPaidLookups, 3);
    } finally {
      delete process.env.TEACH_MAX_PAID_LOOKUPS;
    }
  });
});

describe('paid lookup accrual and cap', () => {
  test('recordPaidLookup accrues worst-case USD; canPaidLookup flips false at cap', () => {
    const limits = new RunLimits({
      maxPaidLookups: 2,
      maxRequests: 400,
      maxMinutes: 30,
      estimatedMaxUsd: 1000,
    });
    limits.start();
    assert.equal(limits.canPaidLookup(), true);

    limits.recordPaidLookup('gpt');
    assert.equal(limits.paidLookups, 1);
    assert.equal(limits.upperUsdAccrued, SOURCE_WORST_CASE_USD.gpt);
    assert.equal(limits.canPaidLookup(), true);

    limits.recordPaidLookup('gpt');
    assert.equal(limits.paidLookups, 2);
    assert.equal(limits.paidLookupsExceeded(), true);
    assert.equal(limits.canPaidLookup(), false);
    assert.equal(limits.reason(), 'paid_lookup_cap');
  });

  test('unknown source is treated as gpt worst case', () => {
    const limits = new RunLimits({ maxPaidLookups: 10 });
    limits.recordPaidLookup('mystery-source');
    assert.equal(limits.upperUsdAccrued, SOURCE_WORST_CASE_USD.gpt);
  });
});

describe('time limit', () => {
  test('timeExceeded() becomes true once now() advances past maxMinutes', () => {
    let currentTime = 1_000_000;
    const limits = new RunLimits({ maxMinutes: 10, now: () => currentTime });
    limits.start();
    assert.equal(limits.timeExceeded(), false);

    currentTime += 9 * 60 * 1000; // 9 minutes elapsed
    assert.equal(limits.timeExceeded(), false);

    currentTime += 2 * 60 * 1000; // 11 minutes elapsed total
    assert.equal(limits.timeExceeded(), true);
    assert.equal(limits.reason(), 'time_cap');
  });

  test('canPaidLookup() is false once time is exceeded even under count cap', () => {
    let currentTime = 0;
    const limits = new RunLimits({
      maxPaidLookups: 100,
      maxMinutes: 1,
      now: () => currentTime,
    });
    limits.start();
    currentTime += 2 * 60 * 1000;
    assert.equal(limits.canPaidLookup(), false);
  });
});

describe('request limit', () => {
  test('recordRequest returns false once past maxRequests', () => {
    const limits = new RunLimits({ maxRequests: 3 });
    assert.equal(limits.recordRequest(), true); // 1
    assert.equal(limits.recordRequest(), true); // 2
    assert.equal(limits.recordRequest(), false); // 3 - reaches cap, stop
    assert.equal(limits.requestsExceeded(), true);
    assert.equal(limits.reason(), 'request_cap');
  });
});

describe('estimateSpend', () => {
  test('floor is less than upper and both scale with paid lookups', () => {
    const limits = new RunLimits({ maxPaidLookups: 100 });
    const zero = limits.estimateSpend();
    assert.equal(zero.floorUsd, 0);
    assert.equal(zero.upperUsd, 0);

    limits.recordPaidLookup('gpt');
    const one = limits.estimateSpend();
    assert.ok(one.floorUsd < one.upperUsd);
    assert.equal(one.upperUsd, SOURCE_WORST_CASE_USD.gpt);
    assert.equal(one.floorUsd, SOURCE_WORST_CASE_USD.gpt / 2);

    limits.recordPaidLookup('gpt');
    const two = limits.estimateSpend();
    assert.ok(two.floorUsd > one.floorUsd);
    assert.ok(two.upperUsd > one.upperUsd);
    assert.equal(two.paidLookups, 2);
  });

  test('unknown source counted as gpt in estimateSpend', () => {
    const limits = new RunLimits({ maxPaidLookups: 100 });
    limits.recordPaidLookup('totally-unknown');
    const spend = limits.estimateSpend();
    assert.equal(spend.upperUsd, SOURCE_WORST_CASE_USD.gpt);
  });
});

describe('spendLine', () => {
  test('mentions provider console and does not claim exactness', () => {
    const limits = new RunLimits({ maxPaidLookups: 100 });
    limits.start();
    limits.recordPaidLookup('gpt');
    const line = limits.spendLine();
    assert.match(line, /provider console/i);
    assert.match(line, /NOT exact/);
    assert.match(line, /floor ~\$/);
    assert.match(line, /upper ~\$/);
  });
});

describe('reason()', () => {
  test('names the correct first-hit cap in priority order', () => {
    // paid lookup cap takes priority when multiple caps are hit at once
    let currentTime = 0;
    const limits = new RunLimits({
      maxPaidLookups: 1,
      maxRequests: 1,
      maxMinutes: 1,
      now: () => currentTime,
    });
    limits.start();
    limits.recordRequest();
    limits.recordPaidLookup('gpt');
    currentTime += 2 * 60 * 1000;
    assert.equal(limits.reason(), 'paid_lookup_cap');
  });

  test('returns request_cap when only requests are over', () => {
    const limits = new RunLimits({
      maxPaidLookups: 100,
      maxRequests: 1,
      maxMinutes: 100,
    });
    limits.recordRequest();
    limits.recordRequest();
    assert.equal(limits.reason(), 'request_cap');
  });

  test('returns usd_advisory when only the advisory cap is over', () => {
    const limits = new RunLimits({
      maxPaidLookups: 100,
      maxRequests: 100,
      maxMinutes: 100,
      estimatedMaxUsd: 0.05,
    });
    limits.recordPaidLookup('gpt'); // 0.06 > 0.05
    assert.equal(limits.reason(), 'usd_advisory');
    assert.equal(limits.canPaidLookup(), false);
  });

  test('returns null when nothing is exceeded', () => {
    const limits = new RunLimits({ maxPaidLookups: 100, maxRequests: 100, maxMinutes: 100 });
    limits.start();
    assert.equal(limits.reason(), null);
  });
});

describe('snapshot', () => {
  test('exposes limits, counters, spend and reason', () => {
    const limits = new RunLimits({ maxPaidLookups: 5, maxRequests: 5, maxMinutes: 5 });
    limits.start();
    limits.recordRequest();
    limits.recordPaidLookup('gpt');
    const snap = limits.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['counters', 'limits', 'reason', 'spend']);
    assert.equal(snap.counters.requests, 1);
    assert.equal(snap.counters.paidLookups, 1);
    assert.equal(snap.limits.maxPaidLookups, 5);
    assert.equal(snap.spend.paidLookups, 1);
  });
});
