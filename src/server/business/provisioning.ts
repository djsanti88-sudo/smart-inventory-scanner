import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import type { ProvisionRequest } from "@/services/auth/provisioningTypes";

export interface ProvisionIdentity {
  uid: string;
  email: string;
  name: string;
}

export type ProvisionBusinessResult =
  | { status: "ready" | "existing"; businessId: string }
  | { status: "selection_required"; businessIds: string[] };

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function defaultBusinessIdFor(uid: string): string {
  return stableId("default", uid);
}

export function namedBusinessIdFor(uid: string, requestId: string): string {
  return stableId("biz", `${uid}:${requestId}`);
}

const DEFAULT_BUSINESS_POINTER = "defaultBusinessId";
const PROVISIONING_REQUESTS = "businessProvisioningRequests";

function isSafeBusinessId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function profilePayload(
  identity: ProvisionIdentity,
  includeSignedUpAt: boolean,
): Record<string, unknown> {
  const timestamp = FieldValue.serverTimestamp();
  return {
    authUserId: identity.uid,
    email: identity.email,
    name: identity.name,
    updatedAt: timestamp,
    lastLoginAt: timestamp,
    ...(includeSignedUpAt ? { signedUpAt: timestamp, createdAt: timestamp } : {}),
  };
}

export async function provisionBusiness(
  db: Firestore,
  identity: ProvisionIdentity,
  request: ProvisionRequest,
): Promise<ProvisionBusinessResult> {
  const profileRef = db.doc(`${COLLECTIONS.userProfiles}/${identity.uid}`);
  // Generated once per invocation. If a predictable legacy ID was preclaimed, the profile write
  // makes concurrent transactions converge on the first successfully committed fallback.
  const fallbackDefaultBusinessId = stableId(
    "default",
    `${identity.uid}:${randomUUID()}`,
  );
  const fallbackNamedBusinessId =
    request.mode === "create_named"
      ? stableId("biz", `${identity.uid}:${request.requestId}:${randomUUID()}`)
      : null;

  return db.runTransaction(async (tx) => {
    if (request.mode === "ensure_default") {
      const membershipsQuery = db
        .collection(COLLECTIONS.businessMembers)
        .where("userId", "==", identity.uid);
      const [memberships, profile] = await Promise.all([
        tx.get(membershipsQuery),
        tx.get(profileRef),
      ]);

      const membershipRows = memberships.docs
        .map((snapshot) => {
          const data = snapshot.data();
          return {
            businessId: typeof data.businessId === "string" ? data.businessId : "",
            role: typeof data.role === "string" ? data.role : "",
          };
        })
        .filter((row) => isSafeBusinessId(row.businessId));
      const uniqueBusinessIds = [...new Set(membershipRows.map((row) => row.businessId))];
      const businessSnapshots = await Promise.all(
        uniqueBusinessIds.map((businessId) =>
          tx.get(db.doc(`${COLLECTIONS.businesses}/${businessId}`))
        ),
      );
      const validBusinessIds = uniqueBusinessIds
        .filter((_businessId, index) => businessSnapshots[index].exists)
        .sort();
      const preferred = request.preferredBusinessId;

      if (preferred && validBusinessIds.includes(preferred)) {
        tx.set(profileRef, profilePayload(identity, !profile.exists), { merge: true });
        return { status: "existing", businessId: preferred };
      }
      if (validBusinessIds.length === 1) {
        tx.set(profileRef, profilePayload(identity, !profile.exists), { merge: true });
        return { status: "existing", businessId: validBusinessIds[0] };
      }
      if (validBusinessIds.length > 1) {
        tx.set(profileRef, profilePayload(identity, !profile.exists), { merge: true });
        return { status: "selection_required", businessIds: validBusinessIds };
      }

      const deterministicBusinessId = defaultBusinessIdFor(identity.uid);
      const profileData = profile.exists ? profile.data() : undefined;
      const storedDefaultBusinessId =
        typeof profileData?.[DEFAULT_BUSINESS_POINTER] === "string"
        && isSafeBusinessId(profileData[DEFAULT_BUSINESS_POINTER] as string)
          ? profileData[DEFAULT_BUSINESS_POINTER] as string
          : null;
      const candidateBusinessIds = [
        ...new Set(
          [storedDefaultBusinessId, deterministicBusinessId].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      ];
      const candidateBusinesses = await Promise.all(
        candidateBusinessIds.map((businessId) =>
          tx.get(db.doc(`${COLLECTIONS.businesses}/${businessId}`))
        ),
      );
      const ownedCandidateIndex = candidateBusinesses.findIndex(
        (snapshot) =>
          snapshot.exists && snapshot.data()?.createdBy === identity.uid,
      );
      const deterministicIndex = candidateBusinessIds.indexOf(deterministicBusinessId);
      const deterministicBusiness =
        deterministicIndex >= 0 ? candidateBusinesses[deterministicIndex] : null;
      const deterministicWasPreclaimed =
        deterministicBusiness?.exists
        && deterministicBusiness.data()?.createdBy !== identity.uid;
      const businessId =
        ownedCandidateIndex >= 0
          ? candidateBusinessIds[ownedCandidateIndex]
          : deterministicWasPreclaimed
            ? fallbackDefaultBusinessId
            : deterministicBusinessId;
      const businessRef = db.doc(`${COLLECTIONS.businesses}/${businessId}`);
      const membershipRef = db.doc(
        `${COLLECTIONS.businessMembers}/${memberDocId(businessId, identity.uid)}`,
      );
      const business =
        ownedCandidateIndex >= 0
          ? candidateBusinesses[ownedCandidateIndex]
          : deterministicWasPreclaimed
            ? { exists: false, data: () => undefined }
            : deterministicBusiness!;
      const membership = await tx.get(membershipRef);
      const timestamp = FieldValue.serverTimestamp();

      tx.set(
        profileRef,
        {
          ...profilePayload(identity, !profile.exists),
          [DEFAULT_BUSINESS_POINTER]: businessId,
        },
        { merge: true },
      );
      if (!business.exists) {
        tx.set(businessRef, {
          name: "My Business",
          createdBy: identity.uid,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      const existingMembership = membership.exists ? membership.data() : undefined;
      if (!membership.exists || existingMembership?.role !== "owner") {
        tx.set(membershipRef, {
          businessId,
          userId: identity.uid,
          role: "owner",
          ...(membership.exists ? {} : { createdAt: timestamp }),
          updatedAt: timestamp,
        }, { merge: true });
      }
      return {
        status:
          business.exists
          && membership.exists
          && membership.data()?.role === "owner"
            ? "existing"
            : "ready",
        businessId,
      };
    }

    const deterministicBusinessId = namedBusinessIdFor(identity.uid, request.requestId);
    const requestRef = db.doc(
      `${PROVISIONING_REQUESTS}/${stableId("request", `${identity.uid}:${request.requestId}`)}`,
    );
    const [profile, requestState] = await Promise.all([
      tx.get(profileRef),
      tx.get(requestRef),
    ]);
    const storedBusinessId =
      requestState.exists
      && requestState.data()?.userId === identity.uid
      && typeof requestState.data()?.businessId === "string"
      && isSafeBusinessId(requestState.data()?.businessId as string)
        ? requestState.data()?.businessId as string
        : null;
    const candidateBusinessIds = [
      ...new Set(
        [storedBusinessId, deterministicBusinessId].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    const candidateBusinesses = await Promise.all(
      candidateBusinessIds.map((businessId) =>
        tx.get(db.doc(`${COLLECTIONS.businesses}/${businessId}`))
      ),
    );
    const ownedCandidateIndex = candidateBusinesses.findIndex(
      (snapshot) =>
        snapshot.exists && snapshot.data()?.createdBy === identity.uid,
    );
    const deterministicIndex = candidateBusinessIds.indexOf(deterministicBusinessId);
    const deterministicBusiness =
      deterministicIndex >= 0 ? candidateBusinesses[deterministicIndex] : null;
    const deterministicWasPreclaimed =
      deterministicBusiness?.exists
      && deterministicBusiness.data()?.createdBy !== identity.uid;
    const businessId =
      ownedCandidateIndex >= 0
        ? candidateBusinessIds[ownedCandidateIndex]
        : deterministicWasPreclaimed
          ? fallbackNamedBusinessId!
          : deterministicBusinessId;
    const business =
      ownedCandidateIndex >= 0
        ? candidateBusinesses[ownedCandidateIndex]
        : deterministicWasPreclaimed
          ? { exists: false, data: () => undefined }
          : deterministicBusiness!;
    const businessRef = db.doc(`${COLLECTIONS.businesses}/${businessId}`);
    const membershipRef = db.doc(
      `${COLLECTIONS.businessMembers}/${memberDocId(businessId, identity.uid)}`,
    );
    const membership = await tx.get(membershipRef);
    const timestamp = FieldValue.serverTimestamp();

    tx.set(profileRef, profilePayload(identity, !profile.exists), { merge: true });
    tx.set(
      requestRef,
      {
        userId: identity.uid,
        businessId,
        ...(requestState.exists ? {} : { createdAt: timestamp }),
        updatedAt: timestamp,
      },
      { merge: true },
    );
    if (!business.exists) {
      tx.set(businessRef, {
        name: request.name,
        createdBy: identity.uid,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    if (!membership.exists || membership.data()?.role !== "owner") {
      tx.set(membershipRef, {
        businessId,
        userId: identity.uid,
        role: "owner",
        ...(membership.exists ? {} : { createdAt: timestamp }),
        updatedAt: timestamp,
      }, { merge: true });
    }

    return {
      status:
        business.exists
        && membership.exists
        && membership.data()?.role === "owner"
          ? "existing"
          : "ready",
      businessId,
    };
  });
}
