import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createCatalogHandler } from "../api.js";
import type { CatalogSnapshot } from "../types.js";

export interface StartCatalogServerOptions {
  catalog: CatalogSnapshot;
  host?: string;
  port?: number;
}

export interface RunningCatalogServer {
  url: string;
  close(): Promise<void>;
}

export const startCatalogServer = async (options: StartCatalogServerOptions): Promise<RunningCatalogServer> => {
  const handler = createCatalogHandler({ catalog: options.catalog });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4244;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== "GET" && incoming.method !== "HEAD") incoming.resume();
      const requestHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        requestHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(`http://bearing.local${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers: requestHeaders,
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body === null) {
        outgoing.end();
      } else {
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end('{"error":{"code":"INTERNAL_ERROR","message":"Request handling failed."},"schemaVersion":"bearing.api.error/v1"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
};
