import type {
  EnvironmentId,
  MeshInviteCreateInput,
  MeshMemberUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { executeConnectedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

const MESH_REQUEST_TIMEOUT_MS = 10_000;
/** Joining dials the inviter over iroh first, which can take a while on a new path. */
const MESH_JOIN_TIMEOUT_MS = 45_000;

/** The iroh mesh as one server sees it, managed with this client's session there. */
export function createMeshEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const state = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:mesh:state",
    staleTimeMs: 5_000,
    // Member status comes from the server's own sync round.
    refreshIntervalMs: 10_000,
    execute: (_input: null) =>
      executeConnectedEnvironmentHttpRequest({
        group: "mesh",
        method: "GET",
        url: (urls) => urls.state(),
        timeoutMs: MESH_REQUEST_TIMEOUT_MS,
        request: ({ client, headers }) => client.state({ headers }),
      }),
  });
  const refreshState = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => registry.refresh(state({ environmentId, input: null })));
  return {
    state,
    createInvite: createEnvironmentCommand(runtime, {
      label: "environment-data:mesh:create-invite",
      execute: (input: MeshInviteCreateInput, registry, environmentId) =>
        executeConnectedEnvironmentHttpRequest({
          group: "mesh",
          method: "POST",
          url: (urls) => urls.createInvite(),
          timeoutMs: MESH_JOIN_TIMEOUT_MS,
          request: ({ client, headers }) => client.createInvite({ headers, payload: input }),
        }).pipe(Effect.tap(() => refreshState(environmentId, registry))),
    }),
    join: createEnvironmentCommand(runtime, {
      label: "environment-data:mesh:join",
      execute: (invite: string, registry, environmentId) =>
        executeConnectedEnvironmentHttpRequest({
          group: "mesh",
          method: "POST",
          url: (urls) => urls.join(),
          timeoutMs: MESH_JOIN_TIMEOUT_MS,
          request: ({ client, headers }) => client.join({ headers, payload: { invite } }),
        }).pipe(Effect.tap(() => refreshState(environmentId, registry))),
    }),
    updateMember: createEnvironmentCommand(runtime, {
      label: "environment-data:mesh:update-member",
      execute: (input: MeshMemberUpdateInput, registry, environmentId) =>
        executeConnectedEnvironmentHttpRequest({
          group: "mesh",
          method: "POST",
          url: (urls) => urls.updateMember(),
          timeoutMs: MESH_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.updateMember({ headers, payload: input }),
        }).pipe(Effect.tap(() => refreshState(environmentId, registry))),
    }),
    leave: createEnvironmentCommand(runtime, {
      label: "environment-data:mesh:leave",
      execute: (_input: null, registry, environmentId) =>
        executeConnectedEnvironmentHttpRequest({
          group: "mesh",
          method: "POST",
          url: (urls) => urls.leave(),
          timeoutMs: MESH_JOIN_TIMEOUT_MS,
          request: ({ client, headers }) => client.leave({ headers }),
        }).pipe(Effect.tap(() => refreshState(environmentId, registry))),
    }),
  };
}
