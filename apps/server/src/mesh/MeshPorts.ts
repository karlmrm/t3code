// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Probes loopback ports and starts adb's server, outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { LoopbackTarget } from "../iroh/IrohTunnels.ts";

/**
 * What a full member may reach on another member through iroh: `adb` (its adb
 * server) or `port:<n>` (any loopback port there). A full member may already
 * run a terminal there, so neither grants more than it has.
 */
export type MeshPortService =
  | { readonly kind: "adb" }
  | { readonly kind: "port"; readonly port: number };

/** The machine adb runs on, from `HostProcess`. */
export interface MeshPortHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}

const DEFAULT_ADB_PORT = 5037;
const ADB_START_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 1_000;

export const parseMeshPortService = (service: string): MeshPortService | null => {
  if (service === "adb") return { kind: "adb" };
  const match = /^port:(\d{1,5})$/u.exec(service);
  if (match === null) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? { kind: "port", port } : null;
};

/** Accepts `adb`, `port:<n>` or a bare port number; returns the canonical name. */
export const normalizeMeshPortService = (service: string): string | null => {
  const trimmed = service.trim().toLowerCase();
  const name = /^\d+$/u.test(trimmed) ? `port:${trimmed}` : trimmed;
  return parseMeshPortService(name) === null ? null : name;
};

/** Where this machine's adb server listens: adb's own variables, else 127.0.0.1:5037. */
export const adbServerTarget = (env: NodeJS.ProcessEnv): LoopbackTarget => {
  const socket = /^tcp:(?:(localhost|127\.0\.0\.1):)?(\d+)$/u.exec(env.ADB_SERVER_SOCKET ?? "");
  if (socket !== null) return { host: "127.0.0.1", port: Number(socket[2]) };
  const port = Number(env.ANDROID_ADB_SERVER_PORT);
  return {
    host: "127.0.0.1",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_ADB_PORT,
  };
};

const answers = async (target: LoopbackTarget): Promise<boolean> => {
  const socket = NodeNet.connect({ host: target.host, port: target.port });
  socket.setTimeout(PROBE_TIMEOUT_MS, () => socket.destroy(new Error("timeout")));
  try {
    await NodeEvents.EventEmitter.once(socket, "connect");
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
};

/** adb from the Android SDK when one is set up or in its usual place, else from PATH. */
const findAdb = ({ platform, env, homeDirectory }: MeshPortHost): string => {
  const exe = platform === "win32" ? "adb.exe" : "adb";
  const sdks = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === "win32" && env.LOCALAPPDATA !== undefined
      ? NodePath.join(env.LOCALAPPDATA, "Android", "Sdk")
      : undefined,
    platform === "darwin"
      ? NodePath.join(homeDirectory, "Library", "Android", "sdk")
      : NodePath.join(homeDirectory, "Android", "Sdk"),
  ];
  for (const sdk of sdks) {
    if (sdk === undefined || sdk === "") continue;
    const candidate = NodePath.join(sdk, "platform-tools", exe);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return exe;
};

let starting: Promise<void> | undefined;

/** Starts adb's server when nothing answers on its port; one start at a time. */
const ensureAdbServer = async (target: LoopbackTarget, host: MeshPortHost): Promise<void> => {
  if (await answers(target)) return;
  starting ??= new Promise<void>((resolve) => {
    NodeChildProcess.execFile(
      findAdb(host),
      ["start-server"],
      {
        timeout: ADB_START_TIMEOUT_MS,
        windowsHide: true,
        env: { ...host.env, ANDROID_ADB_SERVER_PORT: String(target.port) },
      },
      () => resolve(),
    );
  }).finally(() => {
    starting = undefined;
  });
  await starting;
};

/** The loopback target for `service`, with adb's server started first; null for an unknown name. */
export const resolveMeshPortService = async (
  service: string,
  host: MeshPortHost,
): Promise<LoopbackTarget | null> => {
  const parsed = parseMeshPortService(service);
  if (parsed === null) return null;
  if (parsed.kind === "port") return { host: "127.0.0.1", port: parsed.port };
  const target = adbServerTarget(host.env);
  await ensureAdbServer(target, host);
  return target;
};
