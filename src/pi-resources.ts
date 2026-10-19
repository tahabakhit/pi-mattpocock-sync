import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "./snapshot.ts";

export interface SnapshotSource { current(): Snapshot | undefined }
export interface ResourceStatus {
  readonly status: "unavailable" | "offered" | "withheld";
  readonly commit?: string;
  readonly version?: string;
  readonly offeredNames: readonly string[];
  readonly conflicts: readonly string[];
  readonly conflictOrigins: readonly string[];
  readonly unsupportedFields: readonly string[];
}

/** Minimal native resource adapter. No updater, commands, workers or file rewrites. */
export function createSnapshotExtension(
  source: SnapshotSource,
  report: (status: ResourceStatus) => void = () => {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("resources_discover", (_event, ctx) => {
      const snapshot = source.current();
      const existing = new Map(pi.getCommands().filter(command => command.source === "skill").map(command => [command.name, command.sourceInfo.path]));
      const conflicts = snapshot?.skills.filter(skill => existing.has(`skill:${skill.name}`)).map(skill => skill.name) ?? [];
      const conflictOrigins = conflicts.map(name => JSON.stringify(existing.get(`skill:${name}`)));
      const offered = conflicts.length ? [] : snapshot?.skills ?? [];
      const status: ResourceStatus = Object.freeze({
        status: !snapshot ? "unavailable" : conflicts.length ? "withheld" : "offered",
        commit: snapshot?.commit, version: snapshot?.version,
        offeredNames: Object.freeze(offered.map(skill => skill.name)),
        conflicts: Object.freeze(conflicts), conflictOrigins: Object.freeze(conflictOrigins), unsupportedFields: snapshot?.unsupportedFields ?? [],
      });
      report(status);
      // Fields/names were validated before reaching this adapter. No raw manifest
      // bodies, provider errors, or upstream executable resources are emitted/run.
      const warnings: string[] = [];
      if (conflicts.length) warnings.push(`Withheld all synced skills: conflicting names ${conflicts.map((name, index) => `${name} (${conflictOrigins[index]})`).join(", ")}.`);
      if (status.unsupportedFields.length) warnings.push(`Unsupported plugin fields: ${status.unsupportedFields.join(", ")}. Only skills are exposed.`);
      for (const warning of warnings) {
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else console.warn(`pi-mattpocock-sync: ${warning}`);
      }
      // Other dynamic contributors are still buffered by Pi here. This is an
      // offered set, not proof of the final registry after Pi's deduplication.
      return { skillPaths: snapshot ? offered.map(skill => join(snapshot.root, skill.path)) : [] };
    });
  };
}
