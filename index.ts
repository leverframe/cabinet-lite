import { startServer } from "./server.js";

const instance = startServer();

function shutdown(signal: string) {
  console.log(`cabinet-lite: received ${signal}, shutting down`);
  void instance.stop().then(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
console.log(`cabinet-lite: listening on port ${process.env.PORT ?? 9100}`);
