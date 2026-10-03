/** Types for the bridge, so the tests can import it. The bridge itself is plain JavaScript on purpose. */
export function bridge(options: {
  url: string;
  token: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}): { done: Promise<void> };

export function tokenFrom(env: Record<string, string | undefined>): string | null;
