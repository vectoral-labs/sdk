// A real HTTP server for tests, so requests go through the platform `fetch`:
// method, path escaping, query strings and headers are what a live API sees.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** The raw path as received, before decoding. */
  rawPath: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  /** Parsed JSON body, or `undefined` when there was none. */
  body: unknown;
}

export type Reply = { status?: number; body: unknown } | Error;
export type Route = (req: RecordedRequest) => Reply;

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  /** Register a handler for `"<METHOD> <decoded path>"`. Later calls replace earlier ones. */
  on(key: string, route: Route | Reply | Reply[]): void;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Route>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const text = Buffer.concat(chunks).toString("utf8");
      const rec: RecordedRequest = {
        method: req.method ?? "",
        rawPath: url.pathname,
        path: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(rec);
      const route = routes.get(`${rec.method} ${rec.path}`);
      const reply: Reply = route
        ? route(rec)
        : { status: 404, body: { error: `no route for ${rec.method} ${rec.path}` } };
      if (reply instanceof Error) {
        // Drop the connection: what a network failure looks like to fetch.
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(key, route) {
      if (typeof route === "function") {
        routes.set(key, route);
      } else if (Array.isArray(route)) {
        let i = 0;
        routes.set(key, () => route[Math.min(i++, route.length - 1)]!);
      } else {
        routes.set(key, () => route);
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
