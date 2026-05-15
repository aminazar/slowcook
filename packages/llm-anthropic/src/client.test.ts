import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmCreditExhaustedError } from "@slowcook-ai/core";

const messagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    public readonly messages = { create: messagesCreate };
    constructor(_args: { apiKey: string }) {}
  },
}));

const { AnthropicClient } = await import("./client.js");

describe("AnthropicClient credit-exhausted detection (sc#68)", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
  });

  it("re-throws as LlmCreditExhaustedError when SDK returns status 402", async () => {
    const apiErr = Object.assign(new Error("Payment Required"), { status: 402 });
    messagesCreate.mockRejectedValueOnce(apiErr);
    const client = new AnthropicClient("k");
    await expect(
      client.complete({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-7",
      })
    ).rejects.toBeInstanceOf(LlmCreditExhaustedError);
  });

  it("re-throws as LlmCreditExhaustedError on insufficient_quota body message", async () => {
    const apiErr = Object.assign(new Error("400 insufficient_quota: top up to continue"), { status: 400 });
    messagesCreate.mockRejectedValueOnce(apiErr);
    const client = new AnthropicClient("k");
    await expect(
      client.complete({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-7",
      })
    ).rejects.toBeInstanceOf(LlmCreditExhaustedError);
  });

  it("passes through unrelated errors unchanged", async () => {
    const apiErr = Object.assign(new Error("Internal Server Error"), { status: 500 });
    messagesCreate.mockRejectedValueOnce(apiErr);
    const client = new AnthropicClient("k");
    await expect(
      client.complete({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-7",
      })
    ).rejects.toMatchObject({ status: 500, message: "Internal Server Error" });
  });

  it("sets provider, status, topUpUrl on the typed error", async () => {
    const apiErr = Object.assign(new Error("payment required"), { status: 402 });
    messagesCreate.mockRejectedValueOnce(apiErr);
    const client = new AnthropicClient("k");
    try {
      await client.complete({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-7",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmCreditExhaustedError);
      const e = err as LlmCreditExhaustedError;
      expect(e.provider).toBe("anthropic");
      expect(e.status).toBe(402);
      expect(e.topUpUrl).toContain("console.anthropic.com");
    }
  });
});
