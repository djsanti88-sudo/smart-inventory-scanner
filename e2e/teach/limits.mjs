// e2e/teach/limits.mjs
//
// Teach Bot run limits: HONEST enforcement of run size, not dollar spend.
//
// The live decode server does not return an authoritative per-call cost, so
// this module never claims to cap spend exactly. It enforces hard gates on
// paid-lookup count and wall-clock time (paidLookupsExceeded/timeExceeded,
// consulted by canPaidLookup and by the orchestrator's lesson loop). Total
// request count (requestsExceeded) and the estimated USD figure are also
// checked and surfaced via reason(), but are only as strong as their callers:
// the orchestrator must call requestsExceeded()/usdAdvisoryExceeded() itself
// to stop a run on them - this module does not enforce them on its own. The
// USD figure is an ESTIMATED floor/upper bound derived from documented
// worst-case-per-source figures, never a measured cost. Per the owner's Paid
// API Cost Truth Rule: true spend must always be reconciled against the
// provider's billing console before quoting a wallet number - these numbers
// are for run-time decision making only, never a receipt.

/**
 * Worst-case USD per paid decode source. These are documented estimates, not
 * measured truth - the server does not echo back authoritative per-call
 * cost. True spend = provider console, always.
 */
export const SOURCE_WORST_CASE_USD = {
  gpt: 0.39,
};

function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export class RunLimits {
  constructor({
    maxPaidLookups,
    maxRequests,
    maxMinutes,
    estimatedMaxUsd,
    now = () => Date.now(),
  } = {}) {
    this.maxPaidLookups =
      maxPaidLookups ?? readEnvNumber('TEACH_MAX_PAID_LOOKUPS', 15);
    this.maxRequests = maxRequests ?? readEnvNumber('TEACH_MAX_REQUESTS', 400);
    this.maxMinutes = maxMinutes ?? readEnvNumber('TEACH_MAX_MINUTES', 30);
    this.estimatedMaxUsd =
      estimatedMaxUsd ?? readEnvNumber('TEACH_ESTIMATED_MAX_USD', 3);
    this.now = now;

    this.startedAt = null;
    this.requests = 0;
    this.paidLookups = 0;
    this.floorUsdAccrued = 0;
    this.upperUsdAccrued = 0;
  }

  start() {
    this.startedAt = this.now();
    return this.startedAt;
  }

  elapsedMinutes() {
    if (this.startedAt === null) return 0;
    return (this.now() - this.startedAt) / 60000;
  }

  timeExceeded() {
    return this.elapsedMinutes() >= this.maxMinutes;
  }

  requestsExceeded() {
    return this.requests >= this.maxRequests;
  }

  paidLookupsExceeded() {
    return this.paidLookups >= this.maxPaidLookups;
  }

  /** Advisory: whether the accrued worst-case upper bound has crossed the estimated cap. */
  usdAdvisoryExceeded() {
    return this.upperUsdAccrued >= this.estimatedMaxUsd;
  }

  recordRequest() {
    this.requests += 1;
    return !this.requestsExceeded();
  }

  recordPaidLookup(source) {
    const worstCase = Object.prototype.hasOwnProperty.call(
      SOURCE_WORST_CASE_USD,
      source
    )
      ? SOURCE_WORST_CASE_USD[source]
      : SOURCE_WORST_CASE_USD.gpt;
    this.paidLookups += 1;
    this.upperUsdAccrued += worstCase;
    this.floorUsdAccrued += worstCase / 2;
    return this.snapshot();
  }

  /**
   * Whether another paid lookup is permitted. Paid-lookup count and elapsed
   * time are the HARD gates; the USD figure is advisory (derived from
   * undocumented per-call cost) but still stops the run when it is
   * exceeded, so a run cannot silently run past its estimated budget.
   */
  canPaidLookup() {
    return (
      !this.paidLookupsExceeded() &&
      !this.timeExceeded() &&
      !this.usdAdvisoryExceeded()
    );
  }

  estimateSpend() {
    return {
      paidLookups: this.paidLookups,
      floorUsd: round4(this.floorUsdAccrued),
      upperUsd: round4(this.upperUsdAccrued),
    };
  }

  spendLine() {
    const { floorUsd, upperUsd, paidLookups } = this.estimateSpend();
    const minutes = this.elapsedMinutes().toFixed(1);
    return (
      `Estimated decode spend: floor ~$${floorUsd}, upper ~$${upperUsd} over ` +
      `${paidLookups} paid lookups (${minutes}min). NOT exact - true spend = ` +
      `provider console.`
    );
  }

  /**
   * Names the first stop condition currently in effect, or null when none
   * apply. Order: hard count/time gates before the advisory USD gate.
   */
  reason() {
    if (this.paidLookupsExceeded()) return 'paid_lookup_cap';
    if (this.requestsExceeded()) return 'request_cap';
    if (this.timeExceeded()) return 'time_cap';
    if (this.usdAdvisoryExceeded()) return 'usd_advisory';
    return null;
  }

  snapshot() {
    return {
      limits: {
        maxPaidLookups: this.maxPaidLookups,
        maxRequests: this.maxRequests,
        maxMinutes: this.maxMinutes,
        estimatedMaxUsd: this.estimatedMaxUsd,
      },
      counters: {
        requests: this.requests,
        paidLookups: this.paidLookups,
        elapsedMinutes: round4(this.elapsedMinutes()),
      },
      spend: this.estimateSpend(),
      reason: this.reason(),
    };
  }
}
