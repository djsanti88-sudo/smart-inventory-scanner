const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/email-already-in-use": "An account already exists for this email.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/weak-password": "Choose a stronger password with at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/user-disabled": "This account is disabled. Contact support.",
  "auth/unauthorized-domain": "Sign-in is not available on this website address.",
  "auth/network-request-failed": "Check your internet connection and try again.",
  "auth/popup-blocked": "Allow pop-ups for this site, then try again.",
  "auth/popup-closed-by-user": "The sign-in window was closed.",
  "auth/cancelled-popup-request": "The sign-in window was closed.",
};

export function firebaseAuthErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

export function firebaseAuthErrorMessage(error: unknown): string {
  const code = firebaseAuthErrorCode(error);
  return (code && AUTH_ERROR_MESSAGES[code])
    || "We could not complete authentication. Please try again.";
}

export function isPopupCancellation(error: unknown): boolean {
  const code = firebaseAuthErrorCode(error);
  return code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request";
}
