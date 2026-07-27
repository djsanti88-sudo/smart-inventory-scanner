export type ProvisionRequest =
  | { mode: "ensure_default"; preferredBusinessId?: string }
  | { mode: "create_named"; name: string; requestId: string };

export type ProvisionFailureCode =
  | "invalid_request"
  | "not_authenticated"
  | "workspace_unavailable";

export type ProvisionResponse =
  | { status: "ready" | "existing"; businessId: string }
  | { status: "selection_required"; businessIds: string[] }
  | { status: "failed"; reason: ProvisionFailureCode };

export type AuthFlowResult =
  | {
      status: "ready";
      accountCreated: boolean;
      businessId: string;
      error: null;
    }
  | {
      status: "workspace_failed";
      accountCreated: boolean;
      businessId: null;
      error: string;
    }
  | {
      status: "selection_required";
      accountCreated: boolean;
      businessId: null;
      businessIds: string[];
      error: null;
    }
  | {
      status: "auth_failed";
      accountCreated: false;
      businessId: null;
      error: string;
    }
  | {
      status: "cancelled";
      accountCreated: false;
      businessId: null;
      error: null;
    };
