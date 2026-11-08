// dg serve の本体。既定で 127.0.0.1 にバインドし、認証は持たない（UI-8）

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./defaults.js";

export interface ServeOptions extends AppOptions {
  host?: string | undefined;
  /** 0 なら空いているポート */
  port?: number | undefined;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export { DEFAULT_HOST, DEFAULT_PORT };

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const server = createServer(createApp(options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    host,
    port: address.port,
    url: `http://${shownHost}:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
