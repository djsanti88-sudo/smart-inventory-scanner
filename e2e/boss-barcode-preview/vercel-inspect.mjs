function normalizeInspectUrl(value) {
  const candidate = value.includes("://") ? value : `https://${value}`;
  let parsed;
  try { parsed = new URL(candidate); }
  catch { throw new Error("Vercel inspect did not return deployment identity metadata."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || !parsed.hostname.endsWith(".vercel.app")) {
    throw new Error("Vercel inspect did not return deployment identity metadata.");
  }
  return parsed.origin;
}

export function normalizeVercelInspectMetadata(value, trustedProject = undefined) {
  const legacyProjectId = value?.projectId ?? value?.project?.id;
  const url = value?.url ?? value?.deployment?.url;
  const target = value?.target ?? value?.targetEnvironment ?? value?.deployment?.target;
  const readyState = value?.readyState ?? value?.state ?? value?.deployment?.readyState;
  const hasTopLevelName = Object.prototype.hasOwnProperty.call(value ?? {}, "name");
  const linkedNameMatches = typeof trustedProject?.projectName === "string" && value?.name === trustedProject.projectName;
  const projectId = legacyProjectId ?? (linkedNameMatches ? trustedProject.projectId : null);
  // CLI 58 places the deployment's project name at top level, not a project id. A top-level name
  // must therefore bind exactly to the trusted local link before that link's id is attached.
  if (hasTopLevelName && !linkedNameMatches) throw new Error("Vercel inspect did not return deployment identity metadata.");
  if (typeof projectId !== "string" || typeof url !== "string" || typeof target !== "string" || typeof readyState !== "string") throw new Error("Vercel inspect did not return deployment identity metadata.");
  return { projectId, url: normalizeInspectUrl(url), target, readyState };
}
