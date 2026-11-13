// @effect-diagnostics extendsNativeError:off - The mesh client is plain promises for React, outside an Effect runtime.
/**
 * The phone as a mesh member (kind `client`): it joins with an invite, keeps
 * the member list from the servers it reaches, and asks each server for a
 * session over its own iroh endpoint. See docs/adr/0001-iroh-mesh.md.
 */
import {
  extractMeshInvite,
  meshAccessDurationMillis,
  meshAssertionMessage,
  meshJoinProofMessage,
  meshRecordMessage,
  MESH_INVITE_PREFIX,
  type MeshAccess,
  type MeshAccessDuration,
  type MeshInvite,
  type MeshInvitePayload,
  type MeshMemberRecord,
  type MeshRelay,
} from "@t3tools/contracts";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import { randomHex } from "../lib/uuid";
import { irohNative } from "./native";

const STORAGE_KEY = "t3code.mesh";
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 30_000;
/** After a network change, iroh needs a moment to find the new path. */
const NETWORK_CHANGE_DELAY_MS = 1500;
/**
 * A check that started on the old path can time out after the switch. A second
 * one after that timeout shows the member online again without waiting for
 * the next interval.
 */
const NETWORK_CHANGE_RECHECK_MS = NETWORK_CHANGE_DELAY_MS + REQUEST_TIMEOUT_MS + 500;
/** A session is renewed this long before it ends. */
const SESSION_RENEW_MS = 60 * 60 * 1000;

interface Persisted {
  readonly meshId: string;
  readonly records: ReadonlyArray<MeshMemberRecord>;
  readonly relay: MeshRelay | null;
}

export interface MeshMemberStatus {
  readonly online: boolean;
  readonly version: string | null;
  readonly error: string | null;
  readonly checkedAt: number;
  readonly path: "direct" | "relay" | null;
  readonly rttMs: number | null;
}

interface Session {
  readonly token: string;
  readonly expiresAt: number;
}

export interface MeshSnapshot {
  readonly available: boolean;
  readonly loaded: boolean;
  readonly selfId: string | null;
  readonly meshId: string | null;
  readonly records: ReadonlyArray<MeshMemberRecord>;
  readonly relay: MeshRelay | null;
  readonly status: Readonly<Record<string, MeshMemberStatus>>;
  readonly homeRelay: string | null;
  readonly refreshing: boolean;
  readonly lastError: string | null;
}

/** A server member this phone reaches now, for the connection catalog. */
export interface MeshClientConnection {
  readonly memberId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly expiresAt: number;
}

export class MeshClientError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly record?: MeshMemberRecord,
  ) {
    super(message);
  }
}

let snapshot: MeshSnapshot = {
  available: irohNative !== null,
  loaded: false,
  selfId: null,
  meshId: null,
  records: [],
  relay: null,
  status: {},
  homeRelay: null,
  refreshing: false,
  lastError: null,
};
const listeners = new Set<() => void>();
const sessions = new Map<string, Session>();
const ports = new Map<string, number>();
let startedRelay: string | undefined;
let refreshing: Promise<void> | null = null;

const set = (next: Partial<MeshSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
};

export const meshClient = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,
};

const native = () => {
  if (irohNative === null) throw new MeshClientError("unavailable", "iroh is not in this build.");
  return irohNative;
};

const now = () => Date.now();

const isActive = (record: MeshMemberRecord, at = now()) =>
  !record.removed && (record.accessExpiresAt === null || Date.parse(record.accessExpiresAt) > at);

const selfRecord = () => snapshot.records.find((record) => record.id === snapshot.selfId);

/** The servers this phone talks to: active, with an address, not itself. */
const reachableServers = () =>
  snapshot.records.filter(
    (record) =>
      record.kind === "server" &&
      record.ticket !== null &&
      record.environmentId !== null &&
      record.id !== snapshot.selfId &&
      isActive(record),
  );

const persist = async () => {
  if (snapshot.meshId === null) {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return;
  }
  const value: Persisted = {
    meshId: snapshot.meshId,
    records: snapshot.records,
    relay: snapshot.relay,
  };
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(value));
};

const relayKey = (relay: MeshRelay | null) =>
  relay === null ? "" : `${relay.url}|${relay.token ?? ""}`;

/** Starts iroh, restarting it when the relay changed. Returns the member id. */
const ensureStarted = async () => {
  const key = relayKey(snapshot.relay);
  if (startedRelay === key && snapshot.selfId !== null) return snapshot.selfId;
  const id = await native().start(snapshot.relay?.url ?? null, snapshot.relay?.token ?? null);
  startedRelay = key;
  if (id !== snapshot.selfId) set({ selfId: id });
  return id;
};

const portFor = async (record: MeshMemberRecord) => {
  if (record.ticket === null)
    throw new MeshClientError("unreachable", `${record.label} has no address.`);
  const port = await native().forward(record.ticket);
  ports.set(record.id, port);
  return port;
};

const originFor = async (record: MeshMemberRecord) => `http://127.0.0.1:${await portFor(record)}`;

const request = async <T>(
  origin: string,
  path: string,
  init: { readonly body?: unknown; readonly token?: string } = {},
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = (json ?? {}) as {
        readonly reason?: string;
        readonly message?: string;
        readonly record?: MeshMemberRecord;
      };
      throw new MeshClientError(
        error.reason ?? `http_${response.status}`,
        error.message ?? `The server answered ${response.status}.`,
        error.record,
      );
    }
    return json as T;
  } catch (error) {
    if (error instanceof MeshClientError) throw error;
    throw new MeshClientError(
      "unreachable",
      controller.signal.aborted ? "No answer in time." : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
};

const decodeBase64Url = (value: string) => {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return decodeURIComponent(
    Array.from(binary, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
  );
};

/** The fields of an invite pasted, scanned or opened as a link. */
export const parseMeshInvite = (input: string): MeshInvitePayload => {
  const invite = extractMeshInvite(input);
  if (invite === null) throw new MeshClientError("invalid_invite", "That is not a mesh invite.");
  try {
    const payload = JSON.parse(
      decodeBase64Url(invite.slice(MESH_INVITE_PREFIX.length)),
    ) as MeshInvitePayload;
    if (payload.v !== 1 || !payload.t || !payload.c || !payload.m || !payload.n) throw new Error();
    return payload;
  } catch {
    throw new MeshClientError("invalid_invite", "That invite is damaged. Copy it again.");
  }
};

const sessionAt = async (record: MeshMemberRecord): Promise<Session> => {
  const cached = sessions.get(record.id);
  if (cached !== undefined && cached.expiresAt - now() > SESSION_RENEW_MS) return cached;
  const self = await ensureStarted();
  const assertion = {
    member: self,
    audience: record.environmentId ?? "",
    issuedAt: now(),
    nonce: randomHex(12),
    purpose: "client" as const,
  };
  const signature = await native().sign(meshAssertionMessage(assertion));
  const own = selfRecord();
  const issued = await request<{ token: string; expiresAt: string }>(
    await originFor(record),
    "/api/mesh/peer/session",
    { body: { assertion, signature, records: own === undefined ? [] : [own] } },
  );
  const session = { token: issued.token, expiresAt: Date.parse(issued.expiresAt) };
  sessions.set(record.id, session);
  return session;
};

/** Takes newer revisions of records; servers checked the signatures already. */
const merge = (incoming: ReadonlyArray<MeshMemberRecord>) => {
  const byId = new Map(snapshot.records.map((record) => [record.id, record]));
  let changed = false;
  for (const record of incoming) {
    if (record.meshId !== snapshot.meshId) continue;
    const known = byId.get(record.id);
    if (known !== undefined && known.rev >= record.rev) continue;
    byId.set(record.id, record);
    changed = true;
  }
  if (changed) set({ records: [...byId.values()] });
  return changed;
};

const forget = async () => {
  const ids = [...ports.keys()];
  sessions.clear();
  ports.clear();
  for (const id of ids)
    await native()
      .closeForward(id)
      .catch(() => undefined);
  set({ meshId: null, records: [], relay: null, status: {}, lastError: null });
  await persist();
};

/** This phone was removed: the record proves it, so leave quietly. */
const handleRemoved = async (error: unknown) => {
  if (
    error instanceof MeshClientError &&
    error.reason === "removed" &&
    error.record?.id === snapshot.selfId
  ) {
    await forget();
    return true;
  }
  return false;
};

interface PathStatus {
  readonly peers?: ReadonlyArray<{
    readonly id: string;
    readonly path: { readonly kind: "direct" | "relay"; readonly rttMs: number } | null;
  }>;
  readonly home?: ReadonlyArray<{ readonly url: string; readonly connected: boolean }>;
}

const readPaths = async () => {
  try {
    return JSON.parse(await native().status()) as PathStatus;
  } catch {
    return {} as PathStatus;
  }
};

const checkServer = async (record: MeshMemberRecord): Promise<MeshMemberStatus> => {
  const checkedAt = now();
  try {
    const origin = await originFor(record);
    const descriptor = await request<{ serverVersion?: string }>(
      origin,
      "/.well-known/t3/environment",
    );
    await sessionAt(record);
    return {
      online: true,
      version: descriptor.serverVersion ?? null,
      error: null,
      checkedAt,
      path: null,
      rttMs: null,
    };
  } catch (error) {
    if (await handleRemoved(error)) throw error;
    return {
      online: false,
      version: snapshot.status[record.id]?.version ?? null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
      path: null,
      rttMs: null,
    };
  }
};

const syncWith = async (record: MeshMemberRecord, extra: ReadonlyArray<MeshMemberRecord> = []) => {
  const session = await sessionAt(record);
  const own = selfRecord();
  const result = await request<{
    records: ReadonlyArray<MeshMemberRecord>;
    relay?: MeshRelay | null;
  }>(await originFor(record), "/api/mesh/peer/sync", {
    token: session.token,
    body: { records: [...(own === undefined ? [] : [own]), ...extra] },
  });
  merge(result.records);
  if (result.relay !== undefined && relayKey(result.relay) !== relayKey(snapshot.relay)) {
    set({ relay: result.relay });
  }
};

const doRefresh = async () => {
  if (snapshot.meshId === null) return;
  set({ refreshing: true });
  try {
    await ensureStarted();
    const servers = reachableServers();
    const checked = await Promise.all(servers.map(checkServer));
    if (snapshot.meshId === null) return;
    const status: Record<string, MeshMemberStatus> = {};
    servers.forEach((record, index) => (status[record.id] = checked[index]!));
    let synced = false;
    let lastError: string | null = null;
    for (const record of servers) {
      if (!status[record.id]?.online) continue;
      try {
        await syncWith(record);
        synced = true;
        break;
      } catch (error) {
        if (await handleRemoved(error)) return;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!synced && servers.length > 0) {
      lastError ??= "No machine in the mesh answers right now.";
    }
    const own = selfRecord();
    if (own !== undefined && own.removed) {
      await forget();
      return;
    }
    // Members no longer listed lose their forward.
    const live = new Set(reachableServers().map((record) => record.id));
    for (const id of ports.keys()) {
      if (!live.has(id)) {
        ports.delete(id);
        sessions.delete(id);
        await native()
          .closeForward(id)
          .catch(() => undefined);
      }
    }
    const paths = await readPaths();
    for (const peer of paths.peers ?? []) {
      const entry = status[peer.id];
      if (entry !== undefined && peer.path !== null) {
        status[peer.id] = { ...entry, path: peer.path.kind, rttMs: peer.path.rttMs };
      }
    }
    set({
      status,
      lastError,
      homeRelay: paths.home?.find((relay) => relay.connected)?.url ?? null,
    });
    await ensureStarted();
    await persist();
  } finally {
    set({ refreshing: false });
  }
};

/** Checks every server, renews sessions and takes the newest member list. */
const refresh = () => {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
};

const deviceLabel = () => Device.modelName ?? Device.deviceName ?? "Phone";

/** Joins the mesh an invite names. The inviter decides the access. */
const join = async (input: string, label = deviceLabel()) => {
  if (snapshot.meshId !== null) {
    throw new MeshClientError(
      "already_in_mesh",
      "This phone is already in a mesh. Leave it first.",
    );
  }
  const invite = parseMeshInvite(input);
  // Off the inviter's network, only the mesh relay reaches it.
  if (invite.r !== undefined) set({ relay: { url: invite.r.u, token: invite.r.k } });
  const self = await ensureStarted();
  const port = await native().forward(invite.t);
  const proof = await native().sign(meshJoinProofMessage(invite.c, self));
  const result = await request<{
    meshId: string;
    members: ReadonlyArray<MeshMemberRecord>;
    relay: MeshRelay | null;
  }>(`http://127.0.0.1:${port}`, "/api/mesh/peer/join", {
    body: {
      code: invite.c,
      member: { id: self, kind: "client", label, environmentId: null, ticket: null },
      proof,
    },
  });
  if (!result.members.some((record) => record.id === self)) {
    throw new MeshClientError("invite_rejected", `${invite.l} answered with a broken mesh.`);
  }
  ports.set(invite.n, port);
  set({
    meshId: result.meshId,
    records: result.members,
    relay: result.relay ?? snapshot.relay,
    lastError: null,
  });
  await persist();
  await refresh();
};

/** Signs a new revision of `record` with this phone's key and hands it to the mesh. */
const publish = async (record: Omit<MeshMemberRecord, "sig" | "rev" | "signer">) => {
  const self = await ensureStarted();
  const known = snapshot.records.find((entry) => entry.id === record.id);
  const unsigned = {
    ...record,
    rev: Math.max(now(), (known?.rev ?? 0) + 1),
    signer: self,
  };
  const signed: MeshMemberRecord = {
    ...unsigned,
    sig: await native().sign(meshRecordMessage(unsigned)),
  };
  let delivered = false;
  let lastError: unknown = null;
  for (const server of reachableServers()) {
    try {
      await syncWith(server, [signed]);
      delivered = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!delivered) {
    throw lastError instanceof Error
      ? lastError
      : new MeshClientError("unreachable", "No machine in the mesh answers right now.");
  }
  merge([signed]);
  await persist();
};

const memberRecord = (id: string) => {
  const record = snapshot.records.find((entry) => entry.id === id);
  if (record === undefined) throw new MeshClientError("unknown_member", "That member is gone.");
  return record;
};

const leave = async () => {
  const own = selfRecord();
  if (own !== undefined && !own.removed) {
    const { sig: _sig, rev: _rev, signer: _signer, ...fields } = own;
    // Leaving needs no answer: the servers drop the phone once its sessions run out.
    await publish({ ...fields, removed: true }).catch(() => undefined);
  }
  await forget();
};

const removeMember = async (id: string) => {
  const { sig: _sig, rev: _rev, signer: _signer, ...fields } = memberRecord(id);
  await publish({ ...fields, removed: true });
};

const changeAccess = async (id: string, access: MeshAccess, duration: MeshAccessDuration) => {
  const { sig: _sig, rev: _rev, signer: _signer, ...fields } = memberRecord(id);
  const millis = access === "full" ? null : meshAccessDurationMillis(duration);
  await publish({
    ...fields,
    access,
    accessExpiresAt: millis === null ? null : new Date(now() + millis).toISOString(),
  });
};

/** An invite made by a server this phone reaches; the phone has no server of its own. */
const createInvite = async (access: MeshAccess, duration: MeshAccessDuration) => {
  let lastError: unknown = null;
  for (const server of reachableServers()) {
    try {
      const session = await sessionAt(server);
      return await request<MeshInvite>(await originFor(server), "/api/mesh/invites", {
        token: session.token,
        body: access === "full" ? { access } : { access, duration },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MeshClientError("unreachable", "No machine in the mesh answers right now.");
};

/** The servers reachable now, with their sessions. */
const connections = (): ReadonlyArray<MeshClientConnection> =>
  reachableServers().flatMap((record) => {
    const port = ports.get(record.id);
    const session = sessions.get(record.id);
    if (port === undefined || session === undefined || session.expiresAt <= now()) return [];
    if (snapshot.status[record.id]?.online === false) return [];
    return [
      {
        memberId: record.id,
        environmentId: record.environmentId!,
        label: record.label,
        httpBaseUrl: `http://127.0.0.1:${port}`,
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        token: session.token,
        expiresAt: session.expiresAt,
      },
    ];
  });

let started = false;
/** Loads the saved mesh and keeps it fresh while the app is in front. Idempotent. */
const startMesh = async () => {
  if (started || irohNative === null) return;
  started = true;
  try {
    const saved = await SecureStore.getItemAsync(STORAGE_KEY);
    if (saved !== null) {
      const value = JSON.parse(saved) as Persisted;
      set({ meshId: value.meshId, records: value.records, relay: value.relay });
    }
  } catch {
    // A broken save is a phone outside any mesh.
  }
  set({ loaded: true });
  if (snapshot.meshId !== null) await ensureStarted().catch(() => undefined);
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => void refresh().catch(() => undefined);
  const resume = () => {
    tick();
    timer ??= setInterval(tick, REFRESH_INTERVAL_MS);
  };
  const pause = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  AppState.addEventListener("change", (state) => (state === "active" ? resume() : pause()));
  irohNative.addListener("onNetworkChange", () => {
    setTimeout(tick, NETWORK_CHANGE_DELAY_MS);
    setTimeout(tick, NETWORK_CHANGE_RECHECK_MS);
  });
  if (AppState.currentState === "active") resume();
};

export const mesh = {
  start: startMesh,
  refresh,
  join,
  leave,
  removeMember,
  changeAccess,
  createInvite,
  connections,
};
