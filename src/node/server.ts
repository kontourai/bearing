import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { createCatalogHandler, internalErrorResponse, type CatalogHandlerOptions } from "../api.js";

export interface StartCatalogServerOptions extends CatalogHandlerOptions {
  host?: string;
  port?: number;
}

export interface RunningCatalogServer {
  url: string;
  close(): Promise<void>;
}

const send = async (outgoing: ServerResponse, response: Response): Promise<void> => {
  const body = response.body === null ? undefined : Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(body);
};

export const startCatalogServer = async (options: StartCatalogServerOptions): Promise<RunningCatalogServer> => {
  const handler = createCatalogHandler({
    catalog: options.catalog,
    maxConcurrentRankRequests: options.maxConcurrentRankRequests,
    maxRankResponseBytes: options.maxRankResponseBytes,
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4244;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const requestHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        requestHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = incoming.method ?? "GET";
      const request = new Request(`http://bearing.local${incoming.url ?? "/"}`, {
        method,
        headers: requestHeaders,
        body: method === "GET" || method === "HEAD"
          ? undefined
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await send(outgoing, await handler(request));
    } catch {
      // A failure after the head was written cannot become a 500; drop the
      // connection so the client sees a truncated response, not a wrong one.
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      // createCatalogHandler validated options.catalog above, so its digest
      // and asOf are the ones every handler response reports.
      await send(outgoing, internalErrorResponse(options.catalog, incoming.method === "HEAD"));
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
