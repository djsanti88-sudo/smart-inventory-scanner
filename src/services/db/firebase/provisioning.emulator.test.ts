import { afterEach, describe, expect, it } from "vitest";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { POST as provisionPOST } from "@/app/api/businesses/provision/route";
import { POST as membersPOST } from "@/app/api/businesses/members/route";
import { defaultBusinessIdFor } from "@/server/business/provisioning";
import { COLLECTIONS, memberDocId } from "@/services/db/types";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
const ready = firestoreHost.includes(":") && authHost.includes(":");
const createdUsers: string[] = [];
const createdBusinessIds = new Set<string>();

async function createEmulatorUser() {
  const email = `provision-${crypto.randomUUID()}@example.test`;
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Emulator-password-123!",
        returnSecureToken: true,
      }),
    },
  );
  const body = await response.json() as { localId?: string; idToken?: string };
  if (!response.ok || !body.localId || !body.idToken) {
    throw new Error(`Auth emulator signup failed with status ${response.status}`);
  }
  createdUsers.push(body.localId);
  return { uid: body.localId, idToken: body.idToken };
}

function provisionRequest(idToken: string, body: unknown = { mode: "ensure_default" }): Request {
  return new Request("http://localhost/api/businesses/provision", {
    method: "POST",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function memberCreateRequest(idToken: string, body: unknown): Request {
  return new Request("http://localhost/api/businesses/members", {
    method: "POST",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function signInEmulatorUser(email: string, password: string) {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json() as { localId?: string; idToken?: string };
  if (!response.ok || !body.localId || !body.idToken) {
    throw new Error(`Auth emulator password sign-in failed with status ${response.status}`);
  }
  return { uid: body.localId, idToken: body.idToken };
}

afterEach(async () => {
  if (!ready) return;
  const db = getAdminDb();
  for (const uid of createdUsers.splice(0)) {
    const memberships = await db
      .collection(COLLECTIONS.businessMembers)
      .where("userId", "==", uid)
      .get();
    await Promise.all(memberships.docs.map((membership) => membership.ref.delete()));
    await db.doc(`${COLLECTIONS.userProfiles}/${uid}`).delete();
    await getAdminAuth().deleteUser(uid).catch(() => undefined);
  }
  await Promise.all(
    [...createdBusinessIds].map((businessId) =>
      db.recursiveDelete(db.doc(`${COLLECTIONS.businesses}/${businessId}`))
    ),
  );
  createdBusinessIds.clear();
});

describe.skipIf(!ready)("provisioning route against Auth + Firestore emulators", () => {
  it("verifies a real emulator token and atomically creates all workspace documents", async () => {
    const { uid, idToken } = await createEmulatorUser();

    const response = await provisionPOST(provisionRequest(idToken));

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; businessId: string };
    createdBusinessIds.add(body.businessId);
    expect(body).toEqual({ status: "ready", businessId: defaultBusinessIdFor(uid) });

    const db = getAdminDb();
    const [business, membership, profile] = await Promise.all([
      db.doc(`${COLLECTIONS.businesses}/${body.businessId}`).get(),
      db.doc(`${COLLECTIONS.businessMembers}/${memberDocId(body.businessId, uid)}`).get(),
      db.doc(`${COLLECTIONS.userProfiles}/${uid}`).get(),
    ]);
    expect(business.data()).toMatchObject({ createdBy: uid });
    expect(membership.data()).toMatchObject({ userId: uid, role: "owner" });
    expect(profile.data()).toMatchObject({ authUserId: uid });
  });

  it("converges concurrent retries on one business and membership", async () => {
    const { uid, idToken } = await createEmulatorUser();

    const responses = await Promise.all([
      provisionPOST(provisionRequest(idToken)),
      provisionPOST(provisionRequest(idToken)),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ businessId: string }>),
    );
    bodies.forEach((body) => createdBusinessIds.add(body.businessId));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(bodies.map((body) => body.businessId))).toEqual(
      new Set([defaultBusinessIdFor(uid)]),
    );
    const membershipRows = await getAdminDb()
      .collection(COLLECTIONS.businessMembers)
      .where("userId", "==", uid)
      .get();
    expect(membershipRows.size).toBe(1);
  });

  it("never grants a victim access to a foreign preclaimed default workspace", async () => {
    const { uid, idToken } = await createEmulatorUser();
    const preclaimedId = defaultBusinessIdFor(uid);
    const db = getAdminDb();
    await db.doc(`${COLLECTIONS.businesses}/${preclaimedId}`).set({
      name: "Preclaimed workspace",
      createdBy: "attacker",
    });
    createdBusinessIds.add(preclaimedId);

    const firstResponse = await provisionPOST(provisionRequest(idToken));
    const first = await firstResponse.json() as { status: string; businessId: string };
    createdBusinessIds.add(first.businessId);
    const secondResponse = await provisionPOST(provisionRequest(idToken));
    const second = await secondResponse.json() as { status: string; businessId: string };

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(first.businessId).not.toBe(preclaimedId);
    expect(second.businessId).toBe(first.businessId);
    expect((await db.doc(`${COLLECTIONS.businesses}/${preclaimedId}`).get()).data()).toMatchObject({
      name: "Preclaimed workspace",
      createdBy: "attacker",
    });
    expect(
      (
        await db.doc(
          `${COLLECTIONS.businessMembers}/${memberDocId(preclaimedId, uid)}`,
        ).get()
      ).exists,
    ).toBe(false);
    expect((await db.doc(`${COLLECTIONS.businesses}/${first.businessId}`).get()).data()).toMatchObject({
      createdBy: uid,
    });
  });

  it("ignores a stale selected business from another account when the user has one valid membership", async () => {
    const { uid, idToken } = await createEmulatorUser();
    const db = getAdminDb();
    const ownedBusinessId = `owned-${crypto.randomUUID()}`;
    const staleBusinessId = `stale-${crypto.randomUUID()}`;
    createdBusinessIds.add(ownedBusinessId);
    createdBusinessIds.add(staleBusinessId);
    await Promise.all([
      db.doc(`${COLLECTIONS.businesses}/${ownedBusinessId}`).set({
        name: "Owned workspace",
        createdBy: uid,
      }),
      db.doc(`${COLLECTIONS.businessMembers}/${memberDocId(ownedBusinessId, uid)}`).set({
        businessId: ownedBusinessId,
        userId: uid,
        role: "owner",
      }),
      db.doc(`${COLLECTIONS.businesses}/${staleBusinessId}`).set({
        name: "Stale workspace",
        createdBy: "different-user",
      }),
    ]);

    const response = await provisionPOST(provisionRequest(idToken, {
      mode: "ensure_default",
      preferredBusinessId: staleBusinessId,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "existing",
      businessId: ownedBusinessId,
    });
    expect(
      (
        await db.doc(
          `${COLLECTIONS.businessMembers}/${memberDocId(staleBusinessId, uid)}`,
        ).get()
      ).exists,
    ).toBe(false);
  });

  it("owner-created users are real Firebase Auth users that can sign in and keep their membership", async () => {
    const { uid: ownerUid, idToken } = await createEmulatorUser();
    const provisionResponse = await provisionPOST(provisionRequest(idToken));
    const provisioned = await provisionResponse.json() as { businessId: string };
    createdBusinessIds.add(provisioned.businessId);

    const staffEmail = `staff-${crypto.randomUUID()}@example.test`;
    const staffPassword = "TempPass123!";
    const memberResponse = await membersPOST(memberCreateRequest(idToken, {
      businessId: provisioned.businessId,
      email: staffEmail,
      name: "Counter User",
      password: staffPassword,
      role: "counter",
    }));

    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.json() as {
      uid: string;
      createdAuthUser: boolean;
      passwordSet: boolean;
    };
    createdUsers.push(memberBody.uid);
    expect(memberBody).toMatchObject({ createdAuthUser: true, passwordSet: true });
    expect(memberBody.uid).not.toBe(ownerUid);

    const signedInStaff = await signInEmulatorUser(staffEmail, staffPassword);
    expect(signedInStaff.uid).toBe(memberBody.uid);

    const membership = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(provisioned.businessId, memberBody.uid)}`)
      .get();
    expect(membership.data()).toMatchObject({
      businessId: provisioned.businessId,
      userId: memberBody.uid,
      role: "counter",
      invitedBy: ownerUid,
    });
  });
});
