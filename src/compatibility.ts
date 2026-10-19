import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const workerTools = ["subagent", "get_subagent_result", "steer_subagent"] as const;

/** Availability is not a guarantee of a writable worker, model, or isolation. */
export function capabilities(pi: ExtensionAPI) {
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools();
  const indirect = tools.filter(tool => tool.exposure === "codemode" || tool.exposure === "deferred");
  const reachable = new Set(tools.filter(tool => tool.exposure !== "hidden" && active.has(tool.name)).map(tool => tool.name));
  // These exposures are callable when registered, not necessarily declared to
  // the model. Their use still requires an available orchestration/search tool.
  for (const tool of indirect) reachable.add(tool.name);
  return { missingWorkerTools: workerTools.filter(name => !reachable.has(name)), read: reachable.has("read"),
    indirectRead: !active.has("read") && indirect.some(tool => tool.name === "read"),
    indirectWorkerTools: workerTools.filter(name => !active.has(name) && indirect.some(tool => tool.name === name)) };
}

export function compatibilityGuidance(pi: ExtensionAPI): string {
  const available = capabilities(pi);
  return [
    "Pi compatibility for the unchanged Matt Pocock skill content (guidance, not a security boundary):",
    available.read
      ? "When upstream says to call the Skill tool, read the relevant advertised SKILL.md using Pi's existing read capability. Resolve supporting paths relative to that skill's directory."
      : "The read capability is unavailable. Stop workflows requiring skill/supporting-file reads and explain the missing capability.",
    ...(available.indirectRead ? ["The read capability is available only indirectly. Use an installed tool orchestration/search entrypoint to reach it; if no such entrypoint is available, stop skill/supporting-file reads and explain the missing access. Do not claim you can invoke read directly."] : []),
    "Do not autonomously load a skill marked disable-model-invocation. The user can explicitly invoke /skill:name. Do not invent an unavailable Skill tool or expose unselected skills from the snapshot.",
    available.missingWorkerTools.length
      ? `Missing worker tools: ${available.missingWorkerTools.join(", ")}. Stop workflows requiring those capabilities and explain that the optional @gotgenes/pi-subagents integration must be installed/configured by the user; never install it automatically.`
      : "Use the existing subagent, get_subagent_result, and steer_subagent tools when a workflow requires them. Check their actual schemas, permissions, model availability, and the worker's writable tools; names alone do not establish those capabilities.",
    ...(available.indirectWorkerTools.length ? [`Worker tools available only indirectly: ${available.indirectWorkerTools.join(", ")}. Use the installed tool orchestration/search capability to reach them; if no such entrypoint is available, stop and explain the missing access instead of claiming you can invoke them directly.`] : []),
    "Worktree isolation is not supplied or verified by this integration or the subagent core. Stop worktree-dependent workflows unless the user independently provides and verifies the required separate worktrees. Never substitute concurrent writes in a shared checkout.",
    "For setup guidance, Pi can load CLAUDE.md subject to its normal context-file discovery and precedence. Do not silently copy or rewrite it into AGENTS.md. Check which instructions Pi actually loaded.",
    "Upstream instructions do not authorize commits, pushes, remote resources, configuration changes, or other consequential actions beyond the user's approval. Report unsupported Claude-specific capabilities instead of pretending full workflow equivalence.",
  ].join("\n");
}
