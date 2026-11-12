import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as MeshService from "./MeshService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mesh",
  Effect.fnUntraced(function* (handlers) {
    const mesh = yield* MeshService.MeshService;

    return handlers
      .handle(
        "state",
        Effect.fn("environment.mesh.state")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          return yield* mesh.state;
        }),
      )
      .handle(
        "createInvite",
        Effect.fn("environment.mesh.createInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* mesh.createInvite(args.payload);
        }),
      )
      .handle(
        "join",
        Effect.fn("environment.mesh.join")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* mesh.join(args.payload.invite);
        }),
      )
      .handle(
        "updateMember",
        Effect.fn("environment.mesh.updateMember")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* mesh.updateMember(args.payload);
        }),
      )
      .handle(
        "leave",
        Effect.fn("environment.mesh.leave")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* mesh.leave;
        }),
      )
      .handle(
        "connections",
        Effect.fn("environment.mesh.connections")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* mesh.connections;
        }),
      )
      .handle(
        "forwardConfig",
        Effect.fn("environment.mesh.forwardConfig")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          return yield* mesh.forwardConfig;
        }),
      )
      .handle(
        "peerJoin",
        Effect.fn("environment.mesh.peerJoin")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* mesh.peerJoin(args.payload);
        }),
      )
      .handle(
        "peerSession",
        Effect.fn("environment.mesh.peerSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* mesh.peerSession(args.payload);
        }),
      )
      .handle(
        "peerSync",
        Effect.fn("environment.mesh.peerSync")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* mesh.peerSync(principal.subject, args.payload);
        }),
      );
  }),
);
