// e2e/teach/personas.mjs
//
// Teach Bot persona definitions + the live-signup Playwright flow.
//
// Drives the REAL deployed Scanbin app: Firebase email/password signup (no
// email verification is enforced, so any well-formed synthetic email works),
// business creation, and business selection. Pure helpers (makeEmail,
// makePassword, classifyDeploymentMode) are exported separately so they can
// be unit-tested without a browser.
//
// Hard rule: passwords are generated in memory only and NEVER passed to
// manifest.recordCreated, logged, or included in thrown errors.

import { randomInt } from 'node:crypto';
import { recordCreated } from './manifest.mjs';

export const PERSONAS = [
  {
    key: 'tire',
    label: 'TEACH-BOT Tire Shop',
    businessName: 'TEACH-BOT Tire Shop',
    viewport: 'desktop',
    codes: {
      known: ['848983012906', '885911484047'],
      unknown: ['4950-1122'],
      vendor: ['X004DY7YUT', 'B00FLYWNYQ'],
    },
  },
  {
    key: 'cstore',
    label: 'TEACH-BOT C-Store',
    businessName: 'TEACH-BOT C-Store',
    viewport: 'desktop',
    codes: {
      known: ['049000028904'],
      unknown: ['749000000015'],
      vendor: ['X00QZ9WZ9Q'],
    },
  },
  {
    key: 'supp',
    label: 'TEACH-BOT Supplements',
    businessName: 'TEACH-BOT Supplements',
    viewport: 'mobile',
    codes: {
      known: ['850012345678'],
      unknown: ['ZQX-99417-B'],
      vendor: ['X000QKR8BT'],
    },
  },
];

/**
 * Pure 2-up split-screen window layout. Given a screen size and a window
 * slot index, returns the {x, y, width, height} for that slot: index 0 (or
 * any even index) gets the LEFT half of the screen, index 1 (or any odd
 * index) gets the RIGHT half - both full height. The index is taken modulo
 * 2 so this always describes at most 2 slots, matching the owner's "never
 * more than 2 windows visible at once" requirement; batching which persona
 * goes in which slot/round is handled separately (see teach.mjs
 * batchPersonas).
 */
export function computeSplitLayout(screenWidth, screenHeight, index) {
  const slot = ((index % 2) + 2) % 2; // 0 or 1, defensive against negatives
  const leftWidth = Math.floor(screenWidth / 2);
  const rightWidth = screenWidth - leftWidth;
  if (slot === 0) {
    return { x: 0, y: 0, width: leftWidth, height: Math.round(screenHeight) };
  }
  return { x: leftWidth, y: 0, width: rightWidth, height: Math.round(screenHeight) };
}

/**
 * Deterministic per-(runId, personaKey) synthetic email. No email
 * verification is enforced on the deployed app, so any well-formed address
 * on this reserved test domain works.
 */
export function makeEmail(runId, personaKey) {
  return `teachbot+${runId}-${personaKey}@scanbin-teachbot.test`;
}

const PASSWORD_CHARS =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';

/**
 * A strong random password, kept ONLY in memory by the caller. Never persist
 * or log this value.
 */
export function makePassword() {
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    out += PASSWORD_CHARS[randomInt(0, PASSWORD_CHARS.length)];
  }
  return `Tb${out}!9`;
}

/**
 * Pure classifier: given a probe of what the /scan and /login pages showed,
 * decide whether this deployment is behind live auth or running as an open
 * demo. Defaults to 'live_auth' (assume auth unless proven open) so an
 * ambiguous probe never causes the bot to skip signup it actually needs.
 */
export function classifyDeploymentMode(probe) {
  const hasLoginForm = Boolean(probe?.hasLoginForm);
  const hasBusinessGate = Boolean(probe?.hasBusinessGate);
  const scannerVisibleWithoutLogin = Boolean(probe?.scannerVisibleWithoutLogin);

  if (hasLoginForm || hasBusinessGate) return 'live_auth';
  if (scannerVisibleWithoutLogin) return 'demo_open';
  return 'live_auth';
}

/**
 * Best-effort live probe of the deployment. Navigates to /scan then /login
 * and inspects for the app's real testids. On any navigation error, defaults
 * hasLoginForm to true (assume auth) so a flaky probe never misclassifies a
 * live-auth deployment as open.
 */
export async function probeDeployment(page, baseURL) {
  const probe = {
    hasLoginForm: true,
    hasBusinessGate: false,
    scannerVisibleWithoutLogin: false,
  };

  try {
    await page.goto(`${baseURL}/scan`, { waitUntil: 'domcontentloaded' });
    try {
      probe.scannerVisibleWithoutLogin = await page
        .getByTestId('scanner-input')
        .isVisible({ timeout: 2000 });
    } catch {
      probe.scannerVisibleWithoutLogin = false;
    }
    try {
      probe.hasBusinessGate = await page
        .getByTestId('business-context-banner')
        .isVisible({ timeout: 1000 });
    } catch {
      probe.hasBusinessGate = false;
    }
  } catch {
    // Navigation failure: leave defaults (assume auth).
  }

  try {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    try {
      const emailVisible = await page
        .getByTestId('login-email')
        .isVisible({ timeout: 2000 });
      const buttonVisible = await page
        .getByTestId('login-button')
        .isVisible({ timeout: 2000 });
      probe.hasLoginForm = Boolean(emailVisible && buttonVisible);
    } catch {
      probe.hasLoginForm = true;
    }
  } catch {
    probe.hasLoginForm = true;
  }

  const mode = classifyDeploymentMode(probe);
  return { ...probe, mode };
}

/**
 * Runs the real signup UI flow for one persona against the live deployed
 * app: sign up -> create business -> select business -> land on /scan.
 * Returns { email, businessName, businessId, personaKey } plus a
 * non-enumerable-in-manifest `_password` field the caller may read but must
 * never log or persist.
 *
 * Optional `creds` ({ email, password }) overrides the default per-run
 * generated identity - used by the account-reuse fallback path (first-ever
 * run of a stable reused account: nothing to log into yet, so it signs up
 * ONCE using the SAME stable creds every later run will log in with).
 */
export async function signUpPersona(page, { persona, runId, baseURL }, deps = {}, creds = null) {
  const email = creds?.email ?? makeEmail(runId, persona.key);
  const password = creds?.password ?? makePassword();
  let step = 'goto /login';

  try {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

    step = 'toggle to sign-up mode';
    const signUpToggle = page.getByRole('button', {
      name: /sign ?up|create account|need an account/i,
    });
    try {
      if (await signUpToggle.first().isVisible({ timeout: 3000 })) {
        await signUpToggle.first().click();
      }
    } catch {
      // Toggle may already be in signup mode or absent; continue.
    }

    step = 'fill signup form';
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);

    step = 'submit signup form';
    await page.getByTestId('login-button').click();

    step = 'wait for /business redirect';
    await page.waitForURL('**/business', { timeout: 30000 });

    step = 'fill business name';
    await page.getByTestId('business-name').fill(persona.businessName);

    step = 'create business';
    await page.getByTestId('create-business').click();

    step = 'locate created business select button';
    const selectButton = page.locator('[data-testid^="select-business-"]').first();
    await selectButton.waitFor({ state: 'visible', timeout: 15000 });
    const testId = await selectButton.getAttribute('data-testid');
    const businessId = testId ? testId.replace(/^select-business-/, '') : null;
    if (!businessId) {
      throw new Error('signUpPersona: could not read businessId from select-business testid');
    }

    step = 'click select business';
    await selectButton.click();

    step = 'wait for /scan and scanner-input';
    await page.waitForURL('**/scan', { timeout: 30000 });
    await page.getByTestId('scanner-input').waitFor({ state: 'visible', timeout: 15000 });

    const record = deps.recordCreated ?? recordCreated;
    await record(runId, 'accounts', { email, personaKey: persona.key });
    await record(runId, 'businesses', {
      id: businessId,
      label: persona.businessName,
      personaKey: persona.key,
    });

    return {
      email,
      businessName: persona.businessName,
      businessId,
      personaKey: persona.key,
      _password: password,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`signUpPersona failed at step "${step}" for persona "${persona.key}": ${reason}`);
  }
}

/**
 * Runs the real sign-IN UI flow for one persona against the live deployed
 * app, using STABLE pre-existing credentials (not a freshly generated
 * password): fill email+password on /login (default "signin" mode, no
 * toggle needed) -> submit -> land on /scan directly, or on /business first
 * if the account has no business yet (mirrors signUpPersona's post-auth
 * landing so both flows return the same shape).
 *
 * Returns the same shape as signUpPersona: { email, businessName,
 * businessId, personaKey, _password }. `_password` echoes back the caller's
 * own already-in-memory `creds.password` (never logged, never read from the
 * DOM) so callers can treat the two functions interchangeably.
 */
export async function loginPersona(page, { persona, baseURL, creds }, deps = {}) {
  const email = creds?.email;
  const password = creds?.password;
  if (!email || !password) {
    throw new Error('loginPersona: creds.email and creds.password are required');
  }
  let step = 'goto /login';

  try {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

    step = 'fill sign-in form';
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);

    step = 'submit sign-in form';
    await page.getByTestId('login-button').click();

    step = 'wait for /business or /scan';
    await Promise.race([
      page.waitForURL('**/scan', { timeout: 30000 }),
      page.waitForURL('**/business', { timeout: 30000 }),
    ]);

    let businessId = null;
    if (/\/business(?:$|[/?#])/.test(page.url())) {
      step = 'fill business name (first-ever login, no business yet)';
      await page.getByTestId('business-name').fill(persona.businessName);

      step = 'create business';
      await page.getByTestId('create-business').click();

      step = 'locate created business select button';
      const selectButton = page.locator('[data-testid^="select-business-"]').first();
      await selectButton.waitFor({ state: 'visible', timeout: 15000 });
      const testId = await selectButton.getAttribute('data-testid');
      businessId = testId ? testId.replace(/^select-business-/, '') : null;
      if (!businessId) {
        throw new Error('loginPersona: could not read businessId from select-business testid');
      }

      step = 'click select business';
      await selectButton.click();

      step = 'wait for /scan and scanner-input';
      await page.waitForURL('**/scan', { timeout: 30000 });
    }

    step = 'wait for scanner-input';
    await page.getByTestId('scanner-input').waitFor({ state: 'visible', timeout: 15000 });

    if (!businessId) {
      // Returning account with an existing business: try to read it off a
      // business-context banner testid if present; otherwise leave null
      // (callers only need it to match signUpPersona's shape, not to gate
      // any behavior when reuse is on).
      try {
        const banner = page.getByTestId('business-context-banner');
        const attr = await banner.getAttribute('data-business-id', { timeout: 1000 });
        businessId = attr ?? null;
      } catch {
        businessId = null;
      }
    }

    // Deliberately does NOT call recordCreated: this account was NOT created
    // by this run (it's the stable reused account), so it must never be
    // marked as something cleanup.mjs would delete. Only signUpPersona
    // records an account as "created".

    return {
      email,
      businessName: persona.businessName,
      businessId,
      personaKey: persona.key,
      _password: password,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`loginPersona failed at step "${step}" for persona "${persona.key}": ${reason}`);
  }
}

/**
 * Pure decision of which auth flow a persona setup should attempt.
 * Account-reuse (login-first, falling back to signup only if the account
 * doesn't exist yet) requires BOTH reuse mode to be explicitly on AND a
 * stable password to actually be configured - a half-configured environment
 * (reuse requested but no password set) must never attempt a login with no
 * credential, so it safely falls back to the original per-run signup flow.
 */
export function chooseAuthFlow({ reuse, hasPassword } = {}) {
  if (reuse && hasPassword) return 'login-first';
  return 'signup';
}

/**
 * Pure selection of which (email, useStableCreds) a persona setup should
 * use. Mirrors chooseAuthFlow's gating: reuse only actually applies the
 * stable email when both reuse is on AND a stable password is configured;
 * otherwise this returns the original per-run makeEmail address unchanged.
 */
export function resolveIdentity({ reuse, runId, personaKey, stableEmail, hasStablePassword } = {}) {
  const useStableCreds = Boolean(reuse) && Boolean(hasStablePassword);
  return {
    email: useStableCreds ? stableEmail : makeEmail(runId, personaKey),
    useStableCreds,
  };
}

/**
 * Creates an isolated browser context sized for the persona's viewport, so
 * each persona gets its own storage (cookies, localStorage) with no
 * cross-persona bleed.
 */
export async function newPersonaContext(browser, persona) {
  const viewport =
    persona.viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  return browser.newContext({ viewport, acceptDownloads: true });
}
