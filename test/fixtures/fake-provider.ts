import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deterministic, in-process response. No API client, sockets, or real credentials.
export default function fakeProvider(pi: ExtensionAPI) {
  let sessionId = "";
  pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
  pi.registerProvider("m0-fixture", {
    api: "m0-fixture",
    baseUrl: "https://fixture.invalid",
    apiKey: "not-a-secret-test-only",
    models: [{
      id: "echo", name: "M0 fixture", reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      pi.events.emit("m0:request", context);
      // Synthetic fixture requests only; files stay in the disposable test home.
      appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "requests.jsonl"),
        JSON.stringify({ sessionId, context }) + "\n");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id,
        api: model.api, timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      message.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      message.content[0] = { type: "text", text: "fixture answer" };
      stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture answer", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "fixture answer", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
