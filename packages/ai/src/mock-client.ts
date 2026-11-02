import type { ExtractionInput, ModelClient, RawCandidate } from "./model-client";

export type MockResponse =
  | RawCandidate[]
  | Error
  | ((input: ExtractionInput, call: number) => RawCandidate[] | Promise<RawCandidate[]>);

/**
 * Scripted model client for tests. Responses are consumed in order (an Error entry is thrown,
 * a function is called); once the script is exhausted every call returns []. `calls` counts
 * every extract() invocation, which is how the AI-off tests prove zero model calls.
 */
export class MockModelClient implements ModelClient {
  readonly name: string;
  /** Inputs of every call, in order. */
  readonly callLog: ExtractionInput[] = [];
  private readonly script: MockResponse[];

  constructor(script: MockResponse[] = [], name = "mock") {
    this.script = [...script];
    this.name = name;
  }

  /** Number of extract() calls so far. */
  get calls(): number {
    return this.callLog.length;
  }

  async extract(input: ExtractionInput): Promise<RawCandidate[]> {
    const call = this.callLog.length;
    this.callLog.push(input);
    const next = this.script[call];
    if (next === undefined) return [];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(input, call);
    return next.map((c) => ({ ...c, suggested_depends_on: [...c.suggested_depends_on] }));
  }
}
