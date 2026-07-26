// e2e/teach/cleanup.mjs
//
// Teach Bot cleanup CLI/module. Removes ONLY the live data a specific Teach
// Bot run created, using the exact IDs recorded in that run's manifest -
// never a blind sweep of any collection.
//
// Firebase Auth users cannot be deleted from a plain client without being
// signed in as that user, so cleanup:
//   - deletes Firestore business/doc records it can reach (best-effort),
//   - lists the Auth accounts + businesses for the owner to remove by hand
//     in the Firebase console.
//
// Safe-by-default: without --confirm this only prints a dry-run plan and
// touches nothing. `main()` wires a NO-OP deleteFirestoreDoc stub (see TODO
// below) so even --confirm cannot delete real data until that stub is
// replaced with a real Firestore REST call.

import { pathToFileURL } from 'node:url';
import { readManifest as readManifestFromDisk } from './manifest.mjs';

/**
 * Parse CLI args into { runId, dryRun, confirm }.
 * --run-id <id>  required
 * --dry-run      default true when neither --dry-run nor --confirm given
 * --confirm      performs deletion; wins over --dry-run if both are passed
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let runId = null;
  let dryRunFlag = false;
  let confirmFlag = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--run-id') {
      runId = args[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--run-id=')) {
      runId = arg.slice('--run-id='.length);
    } else if (arg === '--dry-run') {
      dryRunFlag = true;
    } else if (arg === '--confirm') {
      confirmFlag = true;
    }
  }

  if (!runId) {
    throw new Error('parseArgs: --run-id <id> is required');
  }

  if (dryRunFlag && confirmFlag) {
    // eslint-disable-next-line no-console
    console.warn(
      'cleanup: both --dry-run and --confirm passed - --confirm wins, deletion will proceed'
    );
    return { runId, dryRun: false, confirm: true };
  }

  if (confirmFlag) {
    return { runId, dryRun: false, confirm: true };
  }

  // Default: dry-run (whether or not --dry-run was explicitly passed).
  return { runId, dryRun: true, confirm: false };
}

/**
 * Build a cleanup plan strictly from manifest.created - never a blind sweep.
 * @param {object|null} manifest
 * @param {string} runId used only for the error message when manifest is missing
 */
export function planCleanup(manifest, runId = '<unknown>') {
  if (!manifest || typeof manifest !== 'object' || !manifest.created) {
    throw new Error(`No manifest for run ${runId} - refusing to clean (no blind sweeps).`);
  }

  const accounts = Array.isArray(manifest.created.accounts) ? manifest.created.accounts : [];
  const businesses = Array.isArray(manifest.created.businesses) ? manifest.created.businesses : [];
  const docs = Array.isArray(manifest.created.docs) ? manifest.created.docs : [];

  const summary =
    `Run ${manifest.runId ?? runId}: ${accounts.length} account(s), ` +
    `${businesses.length} business(es), ${docs.length} doc(s) recorded as created.`;

  return { accounts, businesses, docs, summary };
}

function docPathOf(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path;
  return JSON.stringify(entry);
}

function emailOf(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.email ?? entry.uid ?? entry.id ?? JSON.stringify(entry);
  }
  return String(entry);
}

/**
 * Execute (or dry-run) cleanup for one run.
 * @param {{ runId: string, dryRun: boolean, confirm: boolean }} opts
 * @param {{ readManifest: Function, deleteFirestoreDoc: Function, log: Function }} deps
 */
export async function runCleanup({ runId, dryRun, confirm }, deps) {
  const { readManifest, deleteFirestoreDoc, log } = deps;

  const manifest = await readManifest(runId).catch(() => null);
  if (!manifest) {
    throw new Error(`No manifest for run ${runId} - refusing to clean (no blind sweeps).`);
  }

  const plan = planCleanup(manifest, runId);

  if (dryRun && !confirm) {
    log(`[dry-run] ${plan.summary}`);
    for (const account of plan.accounts) {
      log(`[dry-run] would flag Auth account for manual console removal: ${emailOf(account)}`);
    }
    for (const business of plan.businesses) {
      log(`[dry-run] would DELETE business doc: ${docPathOf(business)}`);
    }
    for (const doc of plan.docs) {
      log(`[dry-run] would DELETE doc: ${docPathOf(doc)}`);
    }
    return { planned: true, plan };
  }

  // confirm path: delete businesses + docs (best-effort), never touch accounts.
  const deleted = [];
  const failed = [];

  for (const business of plan.businesses) {
    const target = docPathOf(business);
    try {
      await deleteFirestoreDoc(target);
      deleted.push(target);
    } catch (err) {
      failed.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const doc of plan.docs) {
    const target = docPathOf(doc);
    try {
      await deleteFirestoreDoc(target);
      deleted.push(target);
    } catch (err) {
      failed.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const manualAuthRemoval = plan.accounts.map(emailOf);
  if (manualAuthRemoval.length > 0) {
    log(
      `${manualAuthRemoval.length} Auth account(s) recorded by this run must be removed manually ` +
        `via the Firebase console (client SDKs cannot delete other users' Auth accounts): ` +
        manualAuthRemoval.join(', ')
    );
  }

  return { deleted, failed, manualAuthRemoval, plan };
}

/** Real CLI entry point. */
export async function main(argv) {
  const { runId, dryRun, confirm } = parseArgs(argv);

  const deps = {
    readManifest: readManifestFromDisk,
    // TODO(real-firestore-delete): wire real Firestore REST deletion here
    // once the orchestrator records concrete doc paths in the manifest.
    // Left as a logging no-op (even on --confirm) so cleanup stays
    // safe-by-default until that wiring lands.
    deleteFirestoreDoc: async (path) => {
      // eslint-disable-next-line no-console
      console.log(`would DELETE ${path} (wire Firestore REST here)`);
    },
    log: (msg) => {
      // eslint-disable-next-line no-console
      console.log(msg);
    },
  };

  const result = await runCleanup({ runId, dryRun, confirm }, deps);

  console.log('\n--- Teach Bot cleanup summary ---');
  console.log(result.plan.summary);
  if (result.planned) {
    console.log('Dry run only - nothing was deleted. Re-run with --confirm to proceed.');
  } else {
    console.log(`Deleted: ${result.deleted.length}, failed: ${result.failed.length}`);
    if (result.failed.length > 0) {
      console.log('Failures:', JSON.stringify(result.failed, null, 2));
    }
  }
  console.log(
    'REMINDER: Firebase Auth accounts created by this run (if any) must be removed by hand ' +
      'via the Firebase console - they cannot be deleted from this script.'
  );

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}
