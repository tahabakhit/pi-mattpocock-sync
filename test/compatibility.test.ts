import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { capabilities, compatibilityGuidance } from "../src/compatibility.ts";

// A small pure metadata test complements the real Pi/optional-package fixtures.
function inventory(tools: Array<{ name: string; exposure: ToolInfo["exposure"] }>, active: string[]) {
  return { getAllTools: () => tools, getActiveTools: () => active } as unknown as ExtensionAPI;
}

test("capability guidance excludes hidden and inactive direct tools", () => {
  const pi = inventory([
    { name: "read", exposure: "direct" },
    { name: "subagent", exposure: "hidden" },
    { name: "get_subagent_result", exposure: "direct" },
    { name: "steer_subagent", exposure: "model-only" },
  ], ["read", "subagent"]);
  assert.deepEqual(capabilities(pi).missingWorkerTools, ["subagent", "get_subagent_result", "steer_subagent"]);
  assert.equal(capabilities(pi).read, true);
  assert.match(compatibilityGuidance(pi), /Stop workflows requiring those capabilities/);
});

for (const exposure of ["codemode", "deferred"] as const) {
  test(`indirect ${exposure} read requires an available entrypoint`, () => {
    const pi = inventory([{ name: "read", exposure }], []);
    assert.equal(capabilities(pi).indirectRead, true);
    assert.match(compatibilityGuidance(pi), /if no such entrypoint is available, stop skill\/supporting-file reads/);
    assert.match(compatibilityGuidance(pi), /Do not claim you can invoke read directly/);
  });
}

test("callable indirect tools are distinguished from directly declared tools", () => {
  const pi = inventory([
    { name: "subagent", exposure: "codemode" },
    { name: "get_subagent_result", exposure: "deferred" },
    { name: "steer_subagent", exposure: "direct" },
  ], ["steer_subagent"]);
  assert.deepEqual(capabilities(pi).missingWorkerTools, []);
  assert.deepEqual(capabilities(pi).indirectWorkerTools, ["subagent", "get_subagent_result"]);
  const guidance = compatibilityGuidance(pi);
  assert.match(guidance, /read capability is unavailable/);
  assert.match(guidance, /if no such entrypoint is available, stop/);
  assert.match(guidance, /not authorize commits, pushes/);
});
