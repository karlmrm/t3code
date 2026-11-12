import { createMeshEnvironmentAtoms } from "@t3tools/client-runtime/state/mesh";
import { AuthAccessReadScope } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const meshEnvironment = createMeshEnvironmentAtoms(connectionAtomRuntime);

const isMeshConnection = (target: object) =>
  "connectionId" in target &&
  typeof target.connectionId === "string" &&
  target.connectionId.startsWith("mesh:");

/**
 * Connected environments whose server runs the iroh mesh and lets this client read it.
 * Members reached through the mesh show the same list, so only machines this
 * client connects to itself are listed.
 */
export function useMeshHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      !isMeshConnection(environment.entry.target) &&
      environment.serverConfig?.environment.capabilities.mesh === true,
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}
