import { describe, expect, it } from "vitest";
import { humanizeAgentError } from "../app/src/renderer/chat/error-humanizer.js";

// Backstop for #221: a retired model selected from the picker errors at the
// provider. Google keys these on code/status (no Anthropic-style `type`), and
// OpenAI returns model_not_found -- both should produce an actionable message
// telling the user to pick a current model, not the raw wire payload.
describe("humanizeAgentError -- retired/unavailable model", () => {
  it("explains a Google 'not found for API version' error", () => {
    const raw = JSON.stringify({
      error: {
        code: 404,
        message:
          "models/gemini-2.0-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.",
        status: "NOT_FOUND",
      },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toMatch(/no longer available|not available/i);
    expect(result.text).toMatch(/Preferences|current model/i);
    expect(result.text).not.toContain("{");
    expect(result.retriable).toBe(false);
  });

  it("explains an OpenAI deprecated/model_not_found error", () => {
    const raw = JSON.stringify({
      error: {
        message:
          "The model `gpt-4-turbo-preview` has been deprecated. Learn more at https://example",
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toMatch(/no longer available|not available/i);
    expect(result.text).toMatch(/Preferences|current model/i);
    expect(result.retriable).toBe(false);
  });

  it("does not misfire on the region geo-block message", () => {
    const raw = JSON.stringify({
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "User location is not supported for the API use.",
      },
    });
    const result = humanizeAgentError(raw);
    expect(result.text).toMatch(/region/i);
  });
});
