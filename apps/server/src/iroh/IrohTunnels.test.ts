// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- Plain HTTP through a real tunnel.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fallbackRelays, IrohTunnels, relayMap } from "./IrohTunnels.ts";

const iroh = NodeModule.createRequire(import.meta.url)(
  "@number0/iroh",
) as typeof import("@number0/iroh");

const key = (fill: number) => new Uint8Array(32).fill(fill);

const serveText = (text: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer((request, response) => {
        response.end(`${text} ${request.method} ${request.url}`);
      });
      server.listen(0, "127.0.0.1");
      await NodeEvents.EventEmitter.once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      return { server, port: address.port };
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

const openTunnels = (fill: number, listen: boolean) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      IrohTunnels.open({ secretKey: key(fill), listen, relay: "none" }, (message, cause) => {
        throw new Error(`${message}: ${String(cause)}`);
      }),
    ),
    (tunnels) => Effect.promise(() => tunnels.close()),
  );

it.live("forwards HTTP to the listening machine's loopback port, one stream per connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* serveText("box");
      const listening = yield* openTunnels(1, true);
      listening.serve({ host: "127.0.0.1", port: target.port });
      const dialing = yield* openTunnels(2, false);

      const origin = yield* Effect.promise(() => dialing.forward(listening.loopbackTicket()));
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([
          fetch(`${origin}/one`).then((response) => response.text()),
          fetch(`${origin}/two`, { method: "POST", body: "x".repeat(200_000) }).then((response) =>
            response.text(),
          ),
        ]),
      );
      expect(first).toBe("box GET /one");
      expect(second).toBe("box POST /two");
      // The same ticket reuses its forward.
      expect(yield* Effect.promise(() => dialing.forward(listening.loopbackTicket()))).toBe(origin);
    }),
  ),
);

it.live("the endpoint id follows the secret key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* openTunnels(3, false);
      const id = first.endpointId;
      yield* Effect.promise(() => first.close());
      const again = yield* openTunnels(3, false);
      expect(again.endpointId).toBe(id);
    }),
  ),
);

it("homes on one's own relay alone, with n0's relays held back as the fallback", () => {
  const map = relayMap(iroh, {
    url: "https://relay.example.com",
    authToken: "secret",
    fallback: true,
  });
  expect(map.urls()).toEqual(["https://relay.example.com/"]);
  expect(map.get("https://relay.example.com/")?.authToken).toBe("secret");

  const n0 = iroh.RelayMode.defaultMode().relayMap().urls();
  expect(fallbackRelays(iroh).map((relay) => relay.url)).toEqual(n0);
});
