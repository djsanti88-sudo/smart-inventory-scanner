import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { InventorySession } from "@/types";

const mocks = vi.hoisted(() => {
  type StoreState = {
    currentSession: InventorySession | null;
    sessions: InventorySession[];
    listSessions: () => InventorySession[];
    reopenSession: (sessionId: string) => boolean;
  };

  const listeners = new Set<() => void>();
  let localSessions: InventorySession[] = [];
  const state: StoreState = {
    currentSession: null,
    sessions: [],
    listSessions: () => localSessions,
    reopenSession: () => true,
  };

  return {
    listeners,
    state,
    hydrateSessions: (sessions: InventorySession[]) => {
      state.sessions = sessions;
      listeners.forEach((listener) => listener());
    },
    setLocalSessions: (sessions: InventorySession[]) => {
      localSessions = sessions;
    },
    reset: () => {
      state.currentSession = null;
      state.sessions = [];
      localSessions = [];
    },
  };
});

vi.mock("@/stores/scanStore", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useScanStore: <Selected,>(selector: (state: typeof mocks.state) => Selected) =>
      React.useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => selector(mocks.state),
        () => selector(mocks.state),
      ),
  };
});

import { SessionsList } from "@/sessions/SessionsList";

function session(id: string): InventorySession {
  return {
    id,
    businessId: "business-1",
    name: `Session ${id}`,
    location: "Front counter",
    status: "completed",
    startedAt: "2026-09-08T10:00:00.000Z",
    completedAt: "2026-09-08T11:00:00.000Z",
    createdBy: "user-1",
    notes: "",
    syncStatus: "synced",
    locked: false,
    lockedAt: null,
  };
}

afterEach(() => {
  cleanup();
  mocks.reset();
});

describe("SessionsList", () => {
  it("renders hydrated sessions without a current-session change", () => {
    render(<SessionsList />);
    expect(screen.queryByTestId("sessions-list")).toBeNull();

    act(() => {
      mocks.hydrateSessions([session("newer"), session("older")]);
    });

    expect(screen.getByTestId("sessions-list")).toBeInTheDocument();
    expect(screen.getByTestId("session-item-newer")).toBeInTheDocument();
    expect(screen.getByTestId("session-item-older")).toBeInTheDocument();
  });

  it("uses listSessions when the hydrated cloud-session array is empty", () => {
    mocks.setLocalSessions([session("local-newer"), session("local-older")]);

    render(<SessionsList />);

    expect(screen.getByTestId("session-item-local-newer")).toBeInTheDocument();
    expect(screen.getByTestId("session-item-local-older")).toBeInTheDocument();
  });
});
