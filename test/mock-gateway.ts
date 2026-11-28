import http from "node:http";
import type { AddressInfo } from "node:net";

export function startMockGateway(port: number): Promise<http.Server> {
  const srv = makeMockGateway();
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

export function startMockGatewayEphemeral(): Promise<{
  srv: http.Server;
  port: number;
}> {
  const srv = makeMockGateway();
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ srv, port: (srv.address() as AddressInfo).port }),
    ),
  );
}

function makeMockGateway(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live", via: "status" }));
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const auth = req.headers.authorization ?? "";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (auth !== "Bearer test-token") {
        res.write(
          'data: {"choices":[{"delta":{"content":"unauthorized"}}]}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
}
