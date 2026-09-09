import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  fetch: vi.fn(),
  auth: { currentUser: null as unknown },
  preferredBusinessId: null as string | null,
  signOut: vi.fn(),
  sessionItems: new Map<string, string>(),
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => mocks.signInWithEmailAndPassword(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) => mocks.createUserWithEmailAndPassword(...args),
  signInWithPopup: (...args: unknown[]) => mocks.signInWithPopup(...args),
  sendPasswordResetEmail: (...args: unknown[]) => mocks.sendPasswordResetEmail(...args),
  signOut: (...args: unknown[]) => mocks.signOut(...args),
  onAuthStateChanged: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock("@/authentication/firebaseClient", () => ({
  getFirebaseAuth: () => mocks.auth,
  getDb: vi.fn(),
}));
vi.mock("@/authentication/service/authBypass", () => ({ isAuthBypassEnabled: () => false }));
vi.mock("@/users-businesses/selectedBusiness", () => ({
  getSelectedBusinessId: () => mocks.preferredBusinessId,
}));

import {
  abandonBusinessCreation,
  createBusiness,
  ensureWorkspace,
  sendResetEmail,
  signInWithGoogle,
  signInWithPassword,
  signOut,
  signUp,
} from "./auth";

const user = {
  uid: "user-1",
  email: "owner@example.com",
  displayName: "Owner",
  getIdToken: vi.fn().mockResolvedValue("firebase-token"),
};

function provisionResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  mocks.signInWithEmailAndPassword.mockReset();
  mocks.createUserWithEmailAndPassword.mockReset();
  mocks.signInWithPopup.mockReset();
  mocks.sendPasswordResetEmail.mockReset();
  mocks.fetch.mockReset().mockResolvedValue(
    provisionResponse({ status: "ready", businessId: "business-1" }),
  );
  mocks.auth.currentUser = user;
  mocks.preferredBusinessId = null;
  mocks.signOut.mockReset();
  mocks.sessionItems.clear();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => mocks.sessionItems.get(key) ?? null,
      setItem: (key: string, value: string) => mocks.sessionItems.set(key, value),
      removeItem: (key: string) => mocks.sessionItems.delete(key),
    },
  });
  user.getIdToken.mockClear();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("shared workspace provisioning", () => {
  it("repairs a workspace after password login", async () => {
    mocks.preferredBusinessId = "business-2";
    mocks.signInWithEmailAndPassword.mockResolvedValue({ user });

    const result = await signInWithPassword("owner@example.com", "password");

    expect(result).toEqual({
      status: "ready",
      accountCreated: false,
      businessId: "business-1",
      error: null,
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/businesses/provision",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer firebase-token" }),
        body: JSON.stringify({
          mode: "ensure_default",
          preferredBusinessId: "business-2",
        }),
      }),
    );
  });

  it("distinguishes an authenticated account from a workspace failure", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });
    mocks.fetch.mockResolvedValue(
      provisionResponse({ status: "failed", reason: "workspace_unavailable" }, { status: 503 }),
    );

    const result = await signUp("owner@example.com", "password");

    expect(result).toEqual({
      status: "workspace_failed",
      accountCreated: true,
      businessId: null,
      error: "Your account is ready, but workspace setup did not finish.",
    });
  });

  it("maps Firebase details to a safe password-login message", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue({
      code: "auth/invalid-credential",
      message: "Firebase: Error with private internal detail",
    });

    const result = await signInWithPassword("owner@example.com", "wrong");

    expect(result.status).toBe("auth_failed");
    expect(result.error).toBe("Email or password is incorrect.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("allows an already-authenticated user to retry default provisioning", async () => {
    const result = await ensureWorkspace();
    expect(result.status).toBe("ready");
    expect(user.getIdToken).toHaveBeenCalledOnce();
  });

  it("returns selection_required instead of choosing among multiple memberships", async () => {
    mocks.fetch.mockResolvedValue(
      provisionResponse({
        status: "selection_required",
        businessIds: ["business-1", "business-2"],
      }),
    );

    expect(await ensureWorkspace()).toEqual({
      status: "selection_required",
      accountCreated: false,
      businessId: null,
      businessIds: ["business-1", "business-2"],
      error: null,
    });
  });

  it("creates a named business through the same authenticated endpoint", async () => {
    const result = await createBusiness("Main Street Auto");
    expect(result).toEqual({ businessId: "business-1", error: null });
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      mode: "create_named",
      name: "Main Street Auto",
    });
    expect(JSON.parse(String(request.body)).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the named-business request ID after an interrupted response", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error("connection interrupted"))
      .mockResolvedValueOnce(
        provisionResponse({ status: "existing", businessId: "business-1" }),
      );

    const result = await createBusiness("Main Street Auto");

    expect(result).toEqual({ businessId: "business-1", error: null });
    const first = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body));
    const second = JSON.parse(String((mocks.fetch.mock.calls[1][1] as RequestInit).body));
    expect(second.requestId).toBe(first.requestId);
  });

  it("reuses the request ID across separate createBusiness calls after ambiguous failure", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection interrupted"));
    expect(await createBusiness(" Main Street Auto ")).toMatchObject({ businessId: null });
    const firstRequest = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body));

    mocks.fetch.mockReset().mockResolvedValue(
      provisionResponse({ status: "existing", businessId: "business-1" }),
    );
    expect(await createBusiness("main street auto")).toEqual({
      businessId: "business-1",
      error: null,
    });
    const retriedRequest = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body));

    expect(retriedRequest.requestId).toBe(firstRequest.requestId);
  });

  it("keeps ambiguous request IDs independent across A, B, then A retries", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection interrupted"));
    await createBusiness("Alpha Shop");
    const alphaId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;
    mocks.fetch.mockClear();

    await createBusiness("Beta Shop");
    const betaId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;
    mocks.fetch.mockReset().mockResolvedValue(
      provisionResponse({ status: "existing", businessId: "alpha-business" }),
    );

    await createBusiness(" alpha   shop ");
    const alphaRetryId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;

    expect(betaId).not.toBe(alphaId);
    expect(alphaRetryId).toBe(alphaId);
  });

  it("persists only opaque fingerprints and clears all pending IDs on sign-out", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection interrupted"));
    await createBusiness("Private Customer Name");

    const persisted = JSON.stringify([...mocks.sessionItems.entries()]);
    expect(persisted).not.toContain("user-1");
    expect(persisted.toLocaleLowerCase()).not.toContain("private");
    expect(persisted.toLocaleLowerCase()).not.toContain("customer");
    expect(persisted.toLocaleLowerCase()).not.toContain("name");

    await signOut();

    expect(mocks.sessionItems.size).toBe(0);
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("explicitly abandons only the named request while preserving other pending names", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection interrupted"));
    await createBusiness("Alpha Pending");
    const alphaId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;
    mocks.fetch.mockClear();
    await createBusiness("Beta Pending");
    const betaId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;

    await abandonBusinessCreation("Alpha Pending");
    mocks.fetch.mockClear();
    await createBusiness("Alpha Pending");
    const newAlphaId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;
    mocks.fetch.mockClear();
    await createBusiness("Beta Pending");
    const betaRetryId = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)).requestId;

    expect(newAlphaId).not.toBe(alphaId);
    expect(betaRetryId).toBe(betaId);
  });
});

describe("Google and password reset errors", () => {
  it("uses the shared provisioning flow after Google authentication", async () => {
    mocks.signInWithPopup.mockResolvedValue({ user });
    const result = await signInWithGoogle();
    expect(result.status).toBe("ready");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("treats a closed Google popup as cancellation, not an error", async () => {
    mocks.signInWithPopup.mockRejectedValue({ code: "auth/popup-closed-by-user" });
    expect(await signInWithGoogle()).toEqual({
      status: "cancelled",
      accountCreated: false,
      businessId: null,
      error: null,
    });
  });

  it("maps password-reset errors without exposing Firebase internals", async () => {
    mocks.sendPasswordResetEmail.mockRejectedValue({
      code: "auth/network-request-failed",
      message: "Firebase internal URL",
    });
    expect(await sendResetEmail("owner@example.com")).toEqual({
      error: "Check your internet connection and try again.",
    });
  });
});
