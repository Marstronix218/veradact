// Runs once when a Next.js server process starts (not during `next build`). Next compiles this file
// for the edge runtime too; the Node-only checks sit behind the NEXT_RUNTIME branch, which Next
// replaces at build time so the edge bundle never imports them.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkStartupConfiguration } = await import("./instrumentation-node");
    checkStartupConfiguration();
  }
}
