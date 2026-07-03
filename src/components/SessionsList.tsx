"use client";

import { useScanStore } from "@/stores/scanStore";

// Browse-and-reopen saved sessions. Lists every saved session; "Open" switches the live view to that
// session's counts. Re-renders when the current session changes (start / finish / lock / reopen).
export function SessionsList() {
  const current = useScanStore((s) => s.currentSession); // reactive dep -> refreshes the list on any switch
  const listSessions = useScanStore((s) => s.listSessions);
  const reopenSession = useScanStore((s) => s.reopenSession);
  const sessions = listSessions();

  if (sessions.length <= 1) return null; // nothing to browse until there is more than the current one

  return (
    <div className="mt-3 w-full max-w-md rounded-lg border border-zinc-200 bg-white" data-testid="sessions-list">
      <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-700">Saved sessions</div>
      <ul className="divide-y divide-zinc-100">
        {sessions.map((s) => {
          const isCurrent = s.id === current?.id;
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-testid={`session-item-${s.id}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-zinc-800">{s.name}</span>
                  {s.locked && <span className="rounded bg-amber-100 px-1 text-xs text-amber-900">🔒</span>}
                  {isCurrent && <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">current</span>}
                </div>
                <div className="text-xs text-zinc-500">
                  {s.location} · {s.status}
                  {s.startedAt ? ` · ${new Date(s.startedAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              <button
                type="button"
                data-testid={`open-session-${s.id}`}
                disabled={isCurrent}
                onClick={() => reopenSession(s.id)}
                className="inline-flex min-h-[36px] items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                {isCurrent ? "Current" : "Open"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
