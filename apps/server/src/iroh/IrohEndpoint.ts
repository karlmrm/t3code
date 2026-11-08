import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { IrohTunnels, type LoopbackTarget } from "./IrohTunnels.ts";

/** A peer address that names an iroh ticket instead of a URL: `iroh:<ticket>`. */
const IROH_ROUTE_PREFIX = "iroh:";
const SECRET_KEY_NAME = "iroh-secret-key";

export const isIrohRoute = (url: string): boolean =>
  url.trim().toLowerCase().startsWith(IROH_ROUTE_PREFIX);

export const irohRouteTicket = (url: string): string =>
  url.trim().slice(IROH_ROUTE_PREFIX.length).replace(/^\/\//u, "");

export const irohRoute = (ticket: string): string => `${IROH_ROUTE_PREFIX}${ticket}`;

export class IrohError extends Schema.TaggedError<IrohError>()("IrohError", {
  operation: Schema.Literals(["open", "listen", "forward"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `iroh failed to ${this.operation}.`;
  }
}

/**
 * This server's iroh endpoint. It opens on first use: when the server listens
 * (`--iroh`) or a peer link names an `iroh:` address.
 */
export class IrohEndpoint extends Context.Service<
  IrohEndpoint,
  {
    /** Forwards incoming streams to `target`; returns this machine's endpoint id and ticket. */
    readonly listen: (
      target: LoopbackTarget,
    ) => Effect.Effect<{ readonly endpointId: string; readonly ticket: string }, IrohError>;
    /** The ticket while this server listens over iroh. */
    readonly ticket: Effect.Effect<Option.Option<string>>;
    /** A loopback origin that reaches the peer named by an `iroh:` address. */
    readonly forward: (route: string) => Effect.Effect<string, IrohError>;
  }
>()("t3/iroh/IrohEndpoint") {}

/**
 * `dialOnly` endpoints take a fresh key and never listen. A short-lived CLI
 * process must not announce this machine's key: discovery would point the
 * server's peers at it.
 */
const make = Effect.fnUntraced(function* (options: { readonly dialOnly: boolean }) {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const opened = yield* Ref.make<Option.Option<IrohTunnels>>(Option.none());
  const ticket = yield* Ref.make<Option.Option<string>>(Option.none());
  const opening = yield* Semaphore.make(1);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const tunnels = opening.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(opened);
      if (Option.isSome(current)) return current.value;
      const secretKey = options.dialOnly
        ? globalThis.crypto.getRandomValues(new Uint8Array(32))
        : yield* secrets
            .getOrCreateRandom(SECRET_KEY_NAME, 32)
            .pipe(Effect.mapError((cause) => new IrohError({ operation: "open", cause })));
      const relayUrl = config.iroh?.relayUrl;
      const relayToken = config.iroh?.relayToken;
      const created = yield* Effect.tryPromise({
        try: () =>
          IrohTunnels.open(
            {
              secretKey,
              listen: !options.dialOnly && (config.iroh?.listen ?? false),
              relay:
                relayUrl === undefined
                  ? undefined
                  : {
                      url: relayUrl,
                      authToken: relayToken === undefined ? undefined : Redacted.value(relayToken),
                      fallback: config.iroh?.relayFallback ?? true,
                    },
            },
            (message, cause) => runFork(Effect.logWarning(message, { cause })),
          ),
        catch: (cause) => new IrohError({ operation: "open", cause }),
      });
      yield* Ref.set(opened, Option.some(created));
      return created;
    }),
  );

  yield* Effect.addFinalizer(() =>
    Ref.get(opened).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current) ? Effect.promise(() => current.value.close()) : Effect.void,
      ),
      Effect.ignore,
    ),
  );

  return IrohEndpoint.of({
    listen: Effect.fn("IrohEndpoint.listen")(function* (target) {
      const endpoint = yield* tunnels;
      endpoint.serve(target);
      const current = yield* Effect.tryPromise({
        try: () => endpoint.ticket(),
        catch: (cause) => new IrohError({ operation: "listen", cause }),
      });
      yield* Ref.set(ticket, Option.some(current));
      return { endpointId: endpoint.endpointId, ticket: current };
    }),
    ticket: Ref.get(ticket),
    forward: Effect.fn("IrohEndpoint.forward")(function* (route) {
      const endpoint = yield* tunnels;
      return yield* Effect.tryPromise({
        try: () => endpoint.forward(irohRouteTicket(route)),
        catch: (cause) => new IrohError({ operation: "forward", cause }),
      });
    }),
  });
});

export const layer = Layer.effect(IrohEndpoint, make({ dialOnly: false }));

/** Reaches `iroh:<ticket>` at the origin given for its ticket, with no network. */
export const layerTest = (origins: Readonly<Record<string, string>> = {}) =>
  Layer.succeed(
    IrohEndpoint,
    IrohEndpoint.of({
      listen: Effect.fn("IrohEndpoint.listen")(function* () {
        return yield* Effect.die(new Error("IrohEndpoint.layerTest does not listen"));
      }),
      ticket: Effect.succeedNone,
      forward: Effect.fn("IrohEndpoint.forward")(function* (route) {
        const origin = origins[irohRouteTicket(route)];
        if (origin === undefined) {
          return yield* new IrohError({ operation: "forward", cause: new Error("unknown ticket") });
        }
        return origin;
      }),
    }),
  );

/** For CLI commands that reach peers while this machine's server may be running. */
export const layerDialOnly = Layer.effect(IrohEndpoint, make({ dialOnly: true }));
