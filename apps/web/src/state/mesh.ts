import { createMeshEnvironmentAtoms } from "@t3tools/client-runtime/state/mesh";
import { AuthAccessReadScope } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const meshEnvironment = createMeshEnvironmentAtoms(connectionAtomRuntime);

/** Connected environments whose server runs the iroh mesh and lets this client read it. */
export function useMeshHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.mesh === true,
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}
