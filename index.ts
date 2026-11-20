import { startServer } from "./server.js";

const instance = startServer();

instance.ready.catch((err) => {
  console.error("cabinet-lite:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
instance.ready.then(() => console.log(`cabinet-lite: listening on port ${process.env.PORT ?? 9100}`));

function shutdown(signal: string) {
  console.log(`cabinet-lite: received ${signal}, shutting down`);
  void instance.stop().then(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
