"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createBusinessMember,
  createBusiness,
  type CreatableMemberRole,
  ensureWorkspace,
  listMemberships,
  signOut,
  type Membership,
} from "@/authentication/auth";
import { SELECTED_BUSINESS_CHANGED_EVENT, setSelectedBusinessId } from "@/users-businesses/selectedBusiness";
import { useRouter } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";

// Business-creation + membership flow. A signed-in user sees the businesses they belong to (with their
// admin/counter role) and can create a new business (becoming its admin via the hardened RPC). This is
// the foundation; Phase 2 wires the selected business into the live scan/count workflow.
export default function BusinessPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [name, setName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberPassword, setMemberPassword] = useState("");
  const [memberRole, setMemberRole] = useState<CreatableMemberRole>("counter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [memberNotice, setMemberNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setMemberships(await listMemberships());
    } catch {
      setLoadError("We could not load your businesses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    listMemberships()
      .then((nextMemberships) => {
        if (active) setMemberships(nextMemberships);
      })
      .catch(() => {
        if (active) setLoadError("We could not load your businesses.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Enter a business name.");
      return;
    }
    setBusy(true);
    const { error: err } = await createBusiness(name.trim());
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setName("");
    await refresh();
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMemberNotice("");
    const business = memberships.find((membership) => membership.role === "owner") ?? memberships[0];
    if (!business) {
      setError("Create or select a business before adding users.");
      return;
    }
    if (!memberEmail.trim()) {
      setError("Enter the user's email.");
      return;
    }
    setBusy(true);
    const result = await createBusinessMember({
      businessId: business.businessId,
      email: memberEmail,
      name: memberName,
      ...(memberPassword.trim() ? { password: memberPassword } : {}),
      role: memberRole,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMemberEmail("");
    setMemberName("");
    setMemberPassword("");
    setMemberNotice(
      result.passwordSet
        ? "User added to Firebase Auth and can sign in with the temporary password."
        : result.createdAuthUser
        ? "User added and created in Firebase Auth. Send them a password reset link before first login."
        : "Existing Firebase user linked to this business.",
    );
    await refresh();
  }

  async function handleRepairWorkspace() {
    setBusy(true);
    setError("");
    const result = await ensureWorkspace();
    if (result.status === "ready") {
      await refresh();
    } else if (result.status === "selection_required") {
      await refresh();
    } else if (result.status !== "cancelled") {
      setError(result.error);
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Your businesses</h1>
        <button
          onClick={async () => {
            // F1: attempt one awaited drain first, then warn HONESTLY if unsynced work would be lost.
            const left = await useScanStore.getState().prepareSignOut();
            const message =
              left === 0
                ? "Log out now? Your counts are saved - you can sign back in any time to keep going."
                : `${left} scan${left === 1 ? "" : "s"} could not sync to the cloud yet. Signing out now will discard ${left === 1 ? "it" : "them"} permanently. Sign out anyway?`;
            if (!window.confirm(message)) return; // cancel aborts sign-out entirely: no reset, no signOut
            useScanStore.getState().resetForSignOut();
            await signOut();
            router.replace("/login");
          }}
          className="text-sm text-zinc-500 hover:underline"
          data-testid="sign-out"
        >
          Sign out
        </button>
      </div>

      <ul className="mt-4 space-y-2" data-testid="membership-list">
        {loading && <li className="text-sm text-zinc-400">Loading...</li>}
        {!loading && loadError && (
          <li className="text-sm text-red-600" data-testid="business-load-error">
            {loadError}{" "}
            <button
              type="button"
              onClick={refresh}
              data-testid="retry-business-load"
              className="font-semibold text-blue-700 hover:underline"
            >
              Try again
            </button>
          </li>
        )}
        {!loading && !loadError && memberships.length === 0 && (
          <li className="text-sm text-zinc-500">
            No businesses yet.{" "}
            <button
              type="button"
              onClick={handleRepairWorkspace}
              disabled={busy}
              data-testid="repair-workspace"
              className="font-semibold text-blue-700 hover:underline disabled:opacity-50"
            >
              Set up my workspace
            </button>
          </li>
        )}
        {memberships.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-3">
            <span className="text-sm font-medium text-zinc-800">{m.businessName}</span>
            <span className="flex items-center gap-2">
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">{m.role}</span>
              <button
                type="button"
                data-testid={`select-business-${m.businessId}`}
                onClick={() => {
                  setSelectedBusinessId(m.businessId);
                  window.dispatchEvent(
                    new CustomEvent(SELECTED_BUSINESS_CHANGED_EVENT, { detail: { businessId: m.businessId } }),
                  );
                  router.push("/scan");
                }}
                className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Select
              </button>
            </span>
          </li>
        ))}
      </ul>

      <form onSubmit={handleCreate} className="mt-6 rounded-xl border border-zinc-200 bg-white p-4">
        <label className="block text-sm font-medium text-zinc-700" htmlFor="business-name">New business name</label>
        <div className="mt-1 flex gap-2">
          <input
            id="business-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="business-name"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            placeholder="e.g. Main Street Auto"
          />
          <button
            type="submit"
            disabled={busy}
            data-testid="create-business"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600" data-testid="business-error">{error}</p>}
        <p className="mt-2 text-xs text-zinc-400">You become the owner of any business you create.</p>
      </form>

      <form onSubmit={handleAddMember} className="mt-6 rounded-xl border border-zinc-200 bg-white p-4">
        <h2 className="text-base font-semibold text-zinc-900">Add user</h2>
        <p className="mt-1 text-xs text-zinc-500">
          This creates or links the email in Firebase Auth, then adds the Firebase uid to this business.
        </p>
        <label className="mt-3 block text-sm font-medium text-zinc-700" htmlFor="member-email">User email</label>
        <input
          id="member-email"
          type="email"
          value={memberEmail}
          onChange={(e) => setMemberEmail(e.target.value)}
          data-testid="member-email"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          placeholder="tech@example.com"
        />
        <label className="mt-3 block text-sm font-medium text-zinc-700" htmlFor="member-name">Name</label>
        <input
          id="member-name"
          value={memberName}
          onChange={(e) => setMemberName(e.target.value)}
          data-testid="member-name"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          placeholder="Tech One"
        />
        <label className="mt-3 block text-sm font-medium text-zinc-700" htmlFor="member-role">Role</label>
        <select
          id="member-role"
          value={memberRole}
          onChange={(e) => setMemberRole(e.target.value as CreatableMemberRole)}
          data-testid="member-role"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="counter">Counter</option>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <label className="mt-3 block text-sm font-medium text-zinc-700" htmlFor="member-password">Temporary password</label>
        <input
          id="member-password"
          type="password"
          value={memberPassword}
          onChange={(e) => setMemberPassword(e.target.value)}
          data-testid="member-password"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          placeholder="At least 8 characters"
        />
        <p className="mt-1 text-xs text-zinc-500">
          If left blank, the Firebase Auth user is still created but must use password reset before first login.
        </p>
        <button
          type="submit"
          disabled={busy || memberships.length === 0}
          data-testid="add-member"
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add Firebase user"}
        </button>
        {memberNotice && <p className="mt-2 text-sm text-green-700" data-testid="member-notice">{memberNotice}</p>}
      </form>
    </div>
  );
}
