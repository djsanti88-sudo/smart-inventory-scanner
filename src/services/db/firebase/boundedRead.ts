// Shared bounded-attempt retry for one-shot Firestore reads (getDoc/getDocs). One-shot reads have NO
// built-in retry (unlike onSnapshot, which keeps listening after a transport error). If the transport
// channel errors mid-request (observed: emulator channel 400s; equally possible on real networks going
// through a flaky connection), the returned promise can hang forever with nothing thrown. Every
// one-shot read reachable from the fresh-device bootstrap chain (BusinessContextGate -> getSession /
// listMemberships -> setBusinessContext -> loadBusinessData, and any direct caller of listMemberships
// outside that chain, e.g. the business-switcher page) must be bounded through this helper so a stuck
// transport always surfaces as an honest rejection instead of an infinite silent hang.
export const READ_ATTEMPT_TIMEOUT_MS = 20_000;
export const READ_MAX_ATTEMPTS = 3;
export const READ_RETRY_BACKOFF_MS = 500;

// Marks a rejection as coming from OUR OWN timeout (a stuck transport that never settled), as opposed
// to a real rejection the read itself produced (permission-denied, unavailable, etc). retryingRead
// retries only on this class of error - a genuine app-level rejection is not a hang, retrying it wastes
// time and (worse) would otherwise force normalizing whatever shape Firestore rejected with (some
// SDK/test-mock rejections are plain `{ code }` objects, not Error instances) into a generic Error,
// destroying the `.code` callers rely on to distinguish e.g. permission-denied from a real outage.
class BoundedReadTimeoutError extends Error {}

// Races a fresh attempt against a per-attempt timeout. A timed-out attempt's underlying promise is
// abandoned (not cancelled - Firestore gives no cancel handle), so if it settles later it is ignored:
// `settled` guarantees only the winner (timeout vs the real settle, whichever comes first) ever resolves
// or rejects this wrapper, so a late straggler can never double-apply a result.
export function withAttemptTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BoundedReadTimeoutError(`Timed out loading ${label} after ${ms}ms.`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Bounded-attempt retry for a single Firestore read. `factory` must issue a FRESH getDoc()/getDocs()
// call on each attempt (never reuse a prior attempt's promise) since a timed-out attempt is abandoned,
// not cancelled. Reads are idempotent, so re-issuing is safe. Retries ONLY a per-attempt timeout (a
// stuck transport); any real rejection from the read itself propagates immediately, UNCHANGED (original
// shape and any `.code` preserved), since that is a deterministic app-level answer, not a hang.
export async function retryingRead<T>(
  label: string,
  factory: () => Promise<T>,
  attempts = READ_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withAttemptTimeout(factory(), READ_ATTEMPT_TIMEOUT_MS, label);
    } catch (e) {
      lastError = e;
      if (!(e instanceof BoundedReadTimeoutError)) throw e; // real rejection: never retried, shape preserved
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_BACKOFF_MS * attempt));
      }
    }
  }
  throw lastError; // every attempt timed out - lastError is a BoundedReadTimeoutError (a real Error)
}
