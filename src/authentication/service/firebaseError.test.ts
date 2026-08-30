import { describe, expect, it } from "vitest";
import { firebaseAuthErrorMessage, firebaseAuthErrorCode } from "./firebaseError";

describe("firebaseAuthErrorMessage", () => {
  it.each([
    ["auth/invalid-credential", "Email or password is incorrect."],
    ["auth/email-already-in-use", "An account already exists for this email."],
    ["auth/invalid-email", "Enter a valid email address."],
    ["auth/weak-password", "Choose a stronger password with at least 6 characters."],
    ["auth/unauthorized-domain", "Sign-in is not available on this website address."],
    ["auth/network-request-failed", "Check your internet connection and try again."],
  ])("maps %s to safe copy", (code, expected) => {
    expect(firebaseAuthErrorMessage({ code, message: "Firebase: secret internal detail" })).toBe(expected);
  });

  it("never exposes an unknown Firebase message", () => {
    expect(firebaseAuthErrorMessage({
      code: "auth/internal-error",
      message: "Firebase: Error (auth/internal-error). service-account@example.test",
    })).toBe("We could not complete authentication. Please try again.");
  });

  it("extracts Firebase codes without depending on Error subclasses", () => {
    expect(firebaseAuthErrorCode({ code: "auth/popup-closed-by-user" })).toBe("auth/popup-closed-by-user");
    expect(firebaseAuthErrorCode(new Error("plain error"))).toBeNull();
  });
});
