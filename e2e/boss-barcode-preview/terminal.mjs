/** A synchronous client-known alias can persist without a decodeStatus field. It is terminal only
 * when its product carries the server-issued trusted canonical identity and every review is closed. */
export function isTerminalTrustedPreviewState({ event, product, reviews }) {
  const terminalDecode = event?.decodeStatus === "verified" || event?.decodeStatus === "none" || event?.decodeStatus == null;
  return event?.status === "known" && terminalDecode && product?.status === "active" && product?.verified === true && product?.provisional !== true &&
    typeof product?.trustedExactCanonicalId === "string" && product.trustedExactCanonicalId.length > 0 &&
    (reviews ?? []).every((review) => review?.status === "resolved");
}
