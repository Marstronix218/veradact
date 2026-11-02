// Which model client extraction uses (MODEL_CLIENT=anthropic|fixture). Default: anthropic when
// ANTHROPIC_API_KEY is set, else fixture (demo and e2e without an API key; nothing is sent).
import { AnthropicModelClient, type ModelClient } from "@veradact/ai";
import { log } from "../log";
import { FixtureModelClient } from "./fixture-client";

export type ModelClientChoice = "anthropic" | "fixture";

export function modelClientChoice(env: Readonly<Record<string, string | undefined>> = process.env): ModelClientChoice {
  const value = env.MODEL_CLIENT?.trim().toLowerCase();
  if (value === "anthropic" || value === "fixture") return value;
  if (value) throw new Error("MODEL_CLIENT must be 'anthropic' or 'fixture'");
  return env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "fixture";
}

/**
 * The configured model client. Pass it as `modelClientFactory` to `runExtraction`, which calls it
 * only after the AI switches were checked. Constructing a client sends nothing.
 */
export function modelClientFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ModelClient {
  if (modelClientChoice(env) === "fixture") return new FixtureModelClient();
  return new AnthropicModelClient({
    apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: env.ANTHROPIC_MODEL?.trim() || undefined,
    timeoutMs: 120_000,
    maxRetries: 1,
    // The ai package's log fields are ids, enums and counts; core's log re-checks strings at runtime.
    log: (event, fields) => log.info(event, fields as Record<string, number | boolean | null>),
  });
}
