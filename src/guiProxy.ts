/**
 * Local reverse proxy 127.0.0.1:<random> → the dsh web server.
 *
 * dsh 0.1.2+ authenticates browsers with a SameSite=Strict cookie minted by a
 * 303 token exchange at GET /?token=…; a cross-origin VS Code webview iframe
 * can never send that cookie, so the embedded GUI would be 401. This proxy
 * lives in the extension host (Node): it injects the minted/forged browser
 * cookie into every forwarded request, sanitizes browser-sourced headers
 * (Host/Origin/sec-fetch-*), and tunnels WebSocket upgrades
 * (`/api/remote.mux`). The webview then talks to a plain loopback server with
 * no browser-cookie requirements — split-panel query params survive as-is.
 */

import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Headers the browser sets that would confuse the upstream trust fence. */
const STRIP_HEADERS = new Set([
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "host"
]);

/** Cookie value of one validated browser session (`name=value`), optional. */
export type CookieProvider = () => Promise<string | undefined> | string | undefined;

export class GuiProxy {
  private server?: http.Server;
  private readonly targetPort: number;
  private readonly cookie: CookieProvider;
  private lastPort?: number;

  constructor(targetPort: number, cookie: CookieProvider) {
    this.targetPort = targetPort;
    this.cookie = cookie;
  }

  /** `http://127.0.0.1:<port>/` while running. */
  get url(): string | undefined {
    return this.lastPort === undefined ? undefined : `http://127.0.0.1:${this.lastPort}/`;
  }

  async start(): Promise<number> {
    if (this.server !== undefined) return this.lastPort ?? 0;
    const target = { host: "127.0.0.1", port: this.targetPort };
    const server = http.createServer((req, res) => {
      void this.forward(server, req, res, target).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`gui proxy: ${String(err)}`);
      });
    });
    server.on("upgrade", (req, socket, head) => {
      this.forwardUpgrade(req, socket, head, target);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.lastPort = (server.address() as AddressInfo).port;
    return this.lastPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.lastPort = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async forward(
    server: http.Server,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number }
  ): Promise<void> {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (STRIP_HEADERS.has(lower)) continue;
      if (lower === "connection" || lower === "upgrade" || lower === "transfer-encoding") continue;
      headers[key] = value;
    }
    headers.host = `${target.host}:${target.port}`;
    const cookie = await this.cookie();
    if (cookie !== undefined && cookie !== "") headers.cookie = cookie;

    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`gui proxy: ${err.message}`);
    });
    req.pipe(upstream);
  }

  private forwardUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: { host: string; port: number }): void {
    const up = net.connect(target.port, target.host, () => {
      const raw =
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        `Host: ${target.host}:${target.port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] ?? ""}\r\n` +
        `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}\r\n` +
        (req.headers["sec-websocket-protocol"] !== undefined ? `Sec-WebSocket-Protocol: ${String(req.headers["sec-websocket-protocol"])}\r\n` : "") +
        "\r\n";
      // The cookie is read before the handshake packet: the WebSocket handshake
      // must carry it in the first upstream packet.
      void Promise.resolve(this.cookie()).then((cookie) => {
        const withCookie = cookie !== undefined && cookie !== "" ? raw.replace("HTTP/1.1\r\n", `HTTP/1.1\r\nCookie: ${cookie}\r\n`) : raw;
        up.write(withCookie);
        if (head !== undefined && head.length > 0) up.write(head);
      });
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  }
}
