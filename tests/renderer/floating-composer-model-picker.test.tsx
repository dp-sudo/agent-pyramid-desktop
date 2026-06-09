import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FloatingComposerModelPicker } from "../../src/renderer/src/ui/components/composer/FloatingComposerModelPicker";
import type { ModelConfigProfile } from "../../src/shared/agent-contracts";

describe("FloatingComposerModelPicker", () => {
  it("exposes dialog and active selection semantics", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerModelPicker, {
        id: "composer-model-picker",
        profiles: [
          modelProfile("profile-1", "Primary", "model-a"),
          modelProfile("profile-2", "Fast", "model-b"),
        ],
        selectedModel: "model-a",
        selectedProfileId: "profile-2",
        selectedReasoningEffort: "high",
        onSelectModel: vi.fn(),
        onSelectReasoningEffort: vi.fn(),
      }),
    );

    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("id=\"composer-model-picker\"");
    expect(html).toContain("aria-label=\"composer.model\"");
    expect(html).toContain("Primary");
    expect(html).toContain("Fast");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("aria-pressed=\"false\"");
  });
});

function modelProfile(
  id: string,
  name: string,
  model: string,
): ModelConfigProfile {
  return {
    id,
    name,
    config: {
      model_provide: "Custom",
      model,
      protocol: "openai-compatible",
      base_url: "https://example.invalid/v1",
      OPENAI_API_KEY: "",
      model_context_window: 1000,
      model_auto_compact_token_limit: 900,
      max_tokens: 100,
      thinking: false,
      model_reasoning_effort: "medium",
      agent_autonomy: "balanced",
    },
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}
