// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- Pipes raw sockets to iroh's QUIC streams and pings the relay, outside Effect.
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";

import type {
  BiStream,
  Connection,
  Endpoint,
  EndpointAddr,
  RecvStream,
  RelayConfig,
  RelayMap,
  SendStream,
} from "@number0/iroh";

type IrohModule = typeof import("@number0/iroh");

// The native binding stays external; single-executables require disk packages instead of importing them.
const requireForIroh = NodeModule.createRequire(import.meta.url);

/**
 * dumbpipe's protocol, so its `connect-tcp` can reach a listening server
 * before a client speaks iroh itself: the side that opens a stream sends
 * `hello` first, because a QUIC stream only reaches the peer once it carries data.
 */
const TUNNEL_ALPN = Array.from(Buffer.from("DUMBPIPEV0"));
const HANDSHAKE = Buffer.from("hello");
/**
 * Named ports beyond the T3 HTTP port, such as adb's server. The opener sends
 * the name (one length byte, then UTF-8); the listener answers one status byte
 * from `PortStatus` and, on `open`, splices the stream to what its gate named.
 */
const PORT_ALPN = Array.from(Buffer.from("T3PORT/1"));
const MAX_PORT_SERVICE_BYTES = 64;
const PortStatus = { open: 0, refused: 1, unreachable: 2 } as const;
const READ_CHUNK_BYTES = 64 * 1024;
const ACCEPT_RETRY_MS = 1000;
const RELAY_CHECK_MS = 2000;
const RELAY_PING_TIMEOUT_MS = 2000;
/** A stream that does not open this fast rides a dead path (say, after a network switch). */
const OPEN_STREAM_TIMEOUT_MS = 6000;

export interface IrohTunnelOptions {
  /** 32 bytes; the endpoint id, and so the ticket, follows from it. */
  readonly secretKey: Uint8Array;
  readonly listen: boolean;
  /** n0's public relays when absent; none: direct addresses only. */
  readonly relay?: "none" | IrohRelayConfig | undefined;
}

/** A relay of one's own; with `fallback`, n0's public relays stand in while it is down. */
export interface IrohRelayConfig {
  readonly url: string;
  readonly authToken?: string | undefined;
  readonly fallback?: boolean | undefined;
}

export interface LoopbackTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Decides who reaches which named port: the target for `service` when the
 * peer `remoteId` may use it, else null. It may also start the service.
 */
export type PortGate = (remoteId: string, service: string) => Promise<LoopbackTarget | null>;

interface PortForward {
  readonly server: NodeNet.Server;
  readonly peer: string;
  readonly service: string;
  readonly sockets: Set<NodeNet.Socket>;
  error: string | null;
}

/**
 * The configured relay alone. Given n0's relays as well, iroh would home on
 * whichever answers fastest, so the configured relay could lose to a public
 * one while up; n0's relays join only while it is down (`watchRelay`). A peer
 * is reached through its home relay, so every peer needs the token.
 */
export function relayMap(iroh: IrohModule, relay: IrohRelayConfig): RelayMap {
  const map = iroh.RelayMap.empty();
  map.insert({
    url: relay.url,
    ...(relay.authToken === undefined ? {} : { authToken: relay.authToken }),
  });
  return map;
}

/** n0's public relays, which stand in while the configured relay is down. */
export function fallbackRelays(iroh: IrohModule): ReadonlyArray<RelayConfig> {
  const map = iroh.RelayMode.defaultMode().relayMap();
  return map.urls().flatMap((url) => {
    const config = map.get(url);
    return config === null ? [] : [config];
  });
}

/** iroh-relay answers `/ping` with 200 when it serves. */
async function relayAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/ping", url), {
      signal: AbortSignal.timeout(RELAY_PING_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function pumpStreamToSocket(recv: RecvStream, socket: NodeNet.Socket): Promise<void> {
  for (;;) {
    const chunk = await recv.read(READ_CHUNK_BYTES);
    // quinn reports a finished stream as a read of no bytes.
    if (chunk.length === 0) {
      socket.end();
      return;
    }
    if (!socket.write(Buffer.from(chunk))) {
      await NodeEvents.EventEmitter.once(socket, "drain");
    }
  }
}

async function pumpSocketToStream(socket: NodeNet.Socket, send: SendStream): Promise<void> {
  for await (const chunk of socket) {
    await send.writeAll(Array.from(chunk as Buffer));
  }
  await send.finish();
}

/** Copies both directions until each side finishes; a failure on either tears down both. */
async function splice(stream: BiStream, socket: NodeNet.Socket): Promise<void> {
  const results = await Promise.allSettled([
    pumpStreamToSocket(stream.recv, socket),
    pumpSocketToStream(socket, stream.send),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    socket.destroy();
    await stream.send.reset(0n).catch(() => undefined);
  }
}

async function connectSocket(target: LoopbackTarget): Promise<NodeNet.Socket> {
  const socket = NodeNet.connect({ host: target.host, port: target.port });
  await NodeEvents.EventEmitter.once(socket, "connect");
  return socket;
}

/**
 * One iroh endpoint per server. Listening forwards each incoming stream to
 * the server's loopback port; `forward` gives a loopback port that reaches a
 * peer, the way `ssh -L` does. `servePorts` and `forwardPort` do the same for
 * named ports a gate allows, such as adb's.
 */
export class IrohTunnels {
  private readonly forwards = new Map<string, Promise<NodeNet.Server>>();
  private readonly portForwards = new Map<number, PortForward>();
  private portGate: PortGate | undefined;
  /** The newest address per forwarded endpoint id; a later ticket updates it. */
  private readonly peers = new Map<string, EndpointAddr>();
  private serving = false;
  private closed = false;
  private readonly iroh: IrohModule;
  private readonly endpoint: Endpoint;
  private readonly onError: (message: string, cause: unknown) => void;

  private constructor(
    iroh: IrohModule,
    endpoint: Endpoint,
    onError: (message: string, cause: unknown) => void,
  ) {
    this.iroh = iroh;
    this.endpoint = endpoint;
    this.onError = onError;
  }

  static async open(
    options: IrohTunnelOptions,
    onError: (message: string, cause: unknown) => void,
  ): Promise<IrohTunnels> {
    // Loaded on first use, so a platform without the native binding only loses iroh.
    const iroh = requireForIroh("@number0/iroh") as IrohModule;
    const relayMode =
      options.relay === "none"
        ? iroh.RelayMode.disabled()
        : options.relay
          ? iroh.RelayMode.custom(relayMap(iroh, options.relay))
          : undefined;
    const endpoint = await iroh.Endpoint.bind(
      {
        secretKey: Array.from(options.secretKey),
        alpns: options.listen ? [TUNNEL_ALPN] : [],
      },
      relayMode,
    );
    const tunnels = new IrohTunnels(iroh, endpoint, onError);
    if (typeof options.relay === "object" && options.relay.fallback) {
      tunnels.watchRelay(options.relay);
    }
    return tunnels;
  }

  /**
   * Swaps the configured relay for n0's while it does not answer, and back
   * once it does. iroh picks a new home relay at once only when its home
   * leaves the map; merely adding relays waits for the next net report
   * (about 20 s), and peers cannot reach this endpoint in the meantime.
   */
  private watchRelay(relay: IrohRelayConfig): void {
    const own = {
      url: relay.url,
      ...(relay.authToken === undefined ? {} : { authToken: relay.authToken }),
    };
    const fallback = fallbackRelays(this.iroh);
    let onFallback = false;
    void (async () => {
      while (!this.closed) {
        const up = await relayAnswers(relay.url);
        if (!up && !onFallback) {
          for (const config of fallback) await this.endpoint.insertRelay(config);
          await this.endpoint.removeRelay(own.url);
          onFallback = true;
          this.onError("iroh relay does not answer; using n0's relays", relay.url);
        } else if (up && onFallback) {
          await this.endpoint.insertRelay(own);
          for (const config of fallback) await this.endpoint.removeRelay(config.url);
          onFallback = false;
          this.onError("iroh relay answers again; leaving n0's relays", relay.url);
        }
        await NodeTimersPromises.setTimeout(RELAY_CHECK_MS);
      }
    })().catch((cause) => {
      if (!this.closed) this.onError("iroh relay watch stopped", cause);
    });
  }

  get endpointId(): string {
    return this.endpoint.id().toString();
  }

  /** A ticket with this endpoint's id, relay, and current direct addresses. */
  async ticket(): Promise<string> {
    await this.endpoint.online();
    return this.iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString();
  }

  /** A ticket that reaches this endpoint from the same machine only, with no relay. */
  loopbackTicket(): string {
    const addresses = this.endpoint.boundSockets().flatMap((socket) => {
      const port = socket.slice(socket.lastIndexOf(":") + 1);
      return socket.startsWith("[") ? [] : [`127.0.0.1:${port}`];
    });
    return this.iroh.EndpointTicket.fromAddr(
      new this.iroh.EndpointAddr(this.endpoint.id(), null, addresses),
    ).toString();
  }

  private listenAlpns(): Array<Array<number>> {
    return this.portGate === undefined ? [TUNNEL_ALPN] : [TUNNEL_ALPN, PORT_ALPN];
  }

  /** Lets peers reach named ports through `gate`, once `serve` listens. */
  servePorts(gate: PortGate): void {
    const first = this.portGate === undefined;
    this.portGate = gate;
    if (first && this.serving) this.endpoint.setAlpns(this.listenAlpns());
  }

  /** Accepts connections until the endpoint closes, forwarding each stream to `target`. */
  serve(target: LoopbackTarget): void {
    if (this.serving) return;
    this.serving = true;
    // An endpoint opened only to dial (a peer link) starts listening when a mesh needs it.
    this.endpoint.setAlpns(this.listenAlpns());
    void (async () => {
      while (!this.closed) {
        let incoming: Awaited<ReturnType<Endpoint["acceptNext"]>>;
        try {
          incoming = await this.endpoint.acceptNext();
        } catch (cause) {
          // One failed accept, e.g. during a network change, must not stop the listener.
          if (this.closed) return;
          this.onError("iroh failed to accept a connection", cause);
          await NodeTimersPromises.setTimeout(ACCEPT_RETRY_MS);
          continue;
        }
        if (incoming === null) {
          return;
        }
        void this.serveConnection(incoming, target);
      }
    })();
  }

  private async serveConnection(
    incoming: NonNullable<Awaited<ReturnType<Endpoint["acceptNext"]>>>,
    target: LoopbackTarget,
  ): Promise<void> {
    let connection: Connection;
    try {
      connection = await (await incoming.accept()).connect();
    } catch {
      return; // A failed handshake is the remote's problem.
    }
    if (Buffer.from(connection.alpn()).equals(Buffer.from(PORT_ALPN))) {
      return this.servePortConnection(connection);
    }
    for (;;) {
      let stream: BiStream;
      try {
        stream = await connection.acceptBi();
      } catch {
        return; // The connection closed.
      }
      void (async () => {
        const handshake = Buffer.from(await stream.recv.readExact(HANDSHAKE.length));
        if (!handshake.equals(HANDSHAKE)) {
          await stream.send.reset(1n);
          return;
        }
        await splice(stream, await connectSocket(target));
      })().catch(async () => {
        await stream.send.reset(1n).catch(() => undefined);
      });
    }
  }

  private async servePortConnection(connection: Connection): Promise<void> {
    const remoteId = connection.remoteId().toString();
    for (;;) {
      let stream: BiStream;
      try {
        stream = await connection.acceptBi();
      } catch {
        return;
      }
      void (async () => {
        const [length] = await stream.recv.readExact(1);
        if (length === undefined || length === 0 || length > MAX_PORT_SERVICE_BYTES) {
          await stream.send.reset(1n);
          return;
        }
        const service = Buffer.from(await stream.recv.readExact(length)).toString("utf8");
        const gate = this.portGate;
        const target = gate === undefined ? null : await gate(remoteId, service).catch(() => null);
        if (target === null) {
          await stream.send.writeAll([PortStatus.refused]);
          await stream.send.finish();
          return;
        }
        let socket: NodeNet.Socket;
        try {
          socket = await connectSocket(target);
        } catch {
          await stream.send.writeAll([PortStatus.unreachable]);
          await stream.send.finish();
          return;
        }
        await stream.send.writeAll([PortStatus.open]);
        await splice(stream, socket);
      })().catch(async () => {
        await stream.send.reset(1n).catch(() => undefined);
      });
    }
  }

  /**
   * A loopback origin reaching the peer in `ticket`. One forward per endpoint
   * id, kept until close: a later ticket for the same endpoint only updates the
   * address new connections dial, so the port stays while addresses change.
   */
  async forward(ticket: string): Promise<string> {
    const addr = this.iroh.EndpointTicket.fromString(ticket).endpointAddr();
    const key = addr.id().toString();
    this.peers.set(key, addr);
    let server = this.forwards.get(key);
    if (server === undefined) {
      server = this.openForward(key);
      this.forwards.set(key, server);
      server.catch(() => this.forwards.delete(key));
    }
    const address = (await server).address();
    if (address === null || typeof address === "string") {
      throw new Error("iroh forward has no TCP address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** Opens streams to the peer `key` on `alpn`, over one QUIC connection reopened once it closes. */
  private dialer(key: string, alpn: Array<number>): () => Promise<BiStream> {
    let connection: Promise<Connection> | undefined;
    const connected = (): Promise<Connection> => {
      if (connection === undefined) {
        const peer = this.peers.get(key);
        if (peer === undefined) return Promise.reject(new Error("unknown iroh peer"));
        const dialing = this.endpoint.connect(peer, alpn);
        connection = dialing;
        dialing.catch(() => {
          if (connection === dialing) connection = undefined;
        });
      }
      const current = connection;
      return current.then((open) => {
        if (open.closeReason() === null) return open;
        if (connection === current) connection = undefined;
        return connected();
      });
    };
    const openStream = async (): Promise<BiStream> => {
      const current = await connected();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          current.openBi(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("iroh stream did not open")),
              OPEN_STREAM_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (cause) {
        // Drop the connection so the next attempt dials afresh.
        current.close(0n, Array.from(Buffer.from("stale")));
        connection = undefined;
        throw cause;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    return async () => {
      try {
        return await openStream();
      } catch {
        return await openStream();
      }
    };
  }

  private async openForward(key: string): Promise<NodeNet.Server> {
    const openStream = this.dialer(key, TUNNEL_ALPN);
    const server = NodeNet.createServer((socket) => {
      socket.pause();
      void (async () => {
        const stream = await openStream();
        await stream.send.writeAll(Array.from(HANDSHAKE));
        socket.resume();
        await splice(stream, socket);
      })().catch((cause) => {
        socket.destroy();
        this.onError("iroh forward failed", cause);
      });
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    return server;
  }

  /**
   * Listens on loopback `port` (0: any free one) and carries each connection
   * to `service` at the peer in `ticket`. Returns the port. Asking again for
   * the same port, peer and service only updates the peer's address.
   */
  async forwardPort(ticket: string, service: string, port: number): Promise<number> {
    const addr = this.iroh.EndpointTicket.fromString(ticket).endpointAddr();
    const peer = addr.id().toString();
    const name = Buffer.from(service, "utf8");
    if (name.length === 0 || name.length > MAX_PORT_SERVICE_BYTES) {
      throw new Error(`invalid port service name: ${service}`);
    }
    this.peers.set(peer, addr);
    const existing = this.portForwards.get(port);
    if (existing !== undefined) {
      if (existing.peer === peer && existing.service === service) return port;
      throw new Error(`port ${port} already forwards ${existing.service}`);
    }
    const openStream = this.dialer(peer, PORT_ALPN);
    const sockets = new Set<NodeNet.Socket>();
    let forward: PortForward | undefined;
    const fail = (socket: NodeNet.Socket, error: string) => {
      socket.destroy();
      if (forward !== undefined) forward.error = error;
    };
    const server = NodeNet.createServer((socket) => {
      socket.pause();
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      void (async () => {
        const stream = await openStream();
        await stream.send.writeAll([name.length, ...name]);
        const [status] = await stream.recv.readExact(1);
        if (status !== PortStatus.open) {
          await stream.send.finish().catch(() => undefined);
          return fail(
            socket,
            status === PortStatus.refused
              ? `the peer refused ${service}`
              : `${service} does not answer at the peer`,
          );
        }
        if (forward !== undefined) forward.error = null;
        socket.resume();
        await splice(stream, socket);
      })().catch((cause) =>
        fail(socket, `could not reach the peer: ${cause instanceof Error ? cause.message : cause}`),
      );
    });
    server.listen(port, "127.0.0.1");
    await Promise.race([
      NodeEvents.EventEmitter.once(server, "listening"),
      NodeEvents.EventEmitter.once(server, "error").then(([cause]) => Promise.reject(cause)),
    ]);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("iroh port forward has no TCP address");
    }
    forward = { server, peer, service, sockets, error: null };
    this.portForwards.set(address.port, forward);
    return address.port;
  }

  /** Why the last connection through the forward on `port` failed; null once one got through. */
  portForwardError(port: number): string | null {
    return this.portForwards.get(port)?.error ?? null;
  }

  async closePortForward(port: number): Promise<void> {
    const forward = this.portForwards.get(port);
    this.portForwards.delete(port);
    if (forward !== undefined) {
      const closed = new Promise<void>((resolve) => forward.server.close(() => resolve()));
      for (const socket of forward.sockets) socket.destroy();
      await closed;
    }
  }

  /** Closes the forward to `endpointId`, if one is open. */
  async closeForward(endpointId: string): Promise<void> {
    const server = this.forwards.get(endpointId);
    this.forwards.delete(endpointId);
    this.peers.delete(endpointId);
    if (server !== undefined) (await server.catch(() => undefined))?.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const servers = await Promise.allSettled(this.forwards.values());
    for (const result of servers) {
      if (result.status === "fulfilled") result.value.close();
    }
    this.forwards.clear();
    for (const forward of this.portForwards.values()) {
      forward.server.close();
      for (const socket of forward.sockets) socket.destroy();
    }
    this.portForwards.clear();
    await this.endpoint.close();
  }
}
