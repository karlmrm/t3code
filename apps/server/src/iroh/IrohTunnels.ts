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
 * peer, the way `ssh -L` does.
 */
export class IrohTunnels {
  private readonly forwards = new Map<string, Promise<NodeNet.Server>>();
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

  /** Accepts connections until the endpoint closes, forwarding each stream to `target`. */
  serve(target: LoopbackTarget): void {
    if (this.serving) return;
    this.serving = true;
    // An endpoint opened only to dial (a peer link) starts listening when a mesh needs it.
    this.endpoint.setAlpns([TUNNEL_ALPN]);
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

  private async openForward(key: string): Promise<NodeNet.Server> {
    let connection: Promise<Connection> | undefined;
    // One QUIC connection per peer, reopened once it closes.
    const connected = (): Promise<Connection> => {
      if (connection === undefined) {
        const peer = this.peers.get(key);
        if (peer === undefined) return Promise.reject(new Error("unknown iroh peer"));
        const dialing = this.endpoint.connect(peer, TUNNEL_ALPN);
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
    const server = NodeNet.createServer((socket) => {
      socket.pause();
      void (async () => {
        let stream: BiStream;
        try {
          stream = await openStream();
        } catch {
          stream = await openStream();
        }
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
    await this.endpoint.close();
  }
}
