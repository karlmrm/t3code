// @effect-diagnostics effectFnOpportunity:off globalDate:off globalDateInEffect:off globalJsonInEffect:off -- Records are plain JSON with ISO dates on the wire; ms clocks keep them comparable.
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentId,
  MESH_INVITE_PREFIX,
  MESH_INVITE_URL_PREFIX,
  MeshError,
  type MeshAccess,
  type MeshAccessDuration,
  type MeshConnection,
  type MeshConnections,
  type MeshForwardConfig,
  type MeshInvite,
  type MeshInviteCreateInput,
  MeshInvitePayload,
  type MeshMemberRecord,
  type MeshMemberStatus,
  type MeshMemberUpdateInput,
  type MeshPeerJoinRequest,
  type MeshPeerJoinResult,
  type MeshPeerSessionRequest,
  type MeshPeerSessionResult,
  type MeshPeerSyncRequest,
  type MeshPeerSyncResult,
  type MeshRelay,
  MeshReadOnlyScopes,
  type MeshSessionPurpose,
  type MeshState,
  extractMeshInvite,
  meshAccessDurationMillis,
  meshAssertionMessage,
  meshJoinProofMessage,
  meshRecordMessage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as IrohEndpoint from "../iroh/IrohEndpoint.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { forkParked } from "../serverActivation.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import { meshKeyFromSeed, randomToken, sha256, verifyMeshSignature } from "./MeshCrypto.ts";
import { isActive, isActiveFull, isExpired, mergeRecords } from "./MeshRecords.ts";

const MeshPeerApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mesh)
  .annotateMerge(EnvironmentHttpApi.annotations);

const SYNC_INTERVAL = Duration.seconds(20);
const PEER_TIMEOUT = Duration.seconds(12);
const INVITE_TTL_MS = 15 * 60 * 1000;
const ASSERTION_SKEW_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A cached session at a peer is renewed this long before it ends. */
const SESSION_RENEW_MS = 60 * 60 * 1000;
/** A delegation link is renewed this long before it ends. */
const LINK_RENEW_MS = 2 * 24 * 60 * 60 * 1000;
const FIRST_FORWARD_PORT = 4773;

const isMeshError = Schema.is(MeshError);

const meshError = (reason: MeshError["reason"], message: string, record?: MeshMemberRecord) =>
  new MeshError(record === undefined ? { reason, message } : { reason, message, record });

const storageError = (cause: unknown) =>
  Effect.logWarning("Mesh storage failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        meshError(
          "storage",
          "The mesh could not be read or saved here. The server log has details.",
        ),
      ),
    ),
  );

const scopesFor = (access: MeshAccess): ReadonlyArray<AuthEnvironmentScope> =>
  access === "full" ? AuthStandardClientScopes : MeshReadOnlyScopes;

const sessionSubject = (id: string, purpose: MeshSessionPurpose) => `mesh:${id}:${purpose}`;
const mcpLabel = (id: string) => `mesh:${id}`;

const parseSubject = (subject: string) => {
  const match = /^mesh:([0-9a-f]{64}):(client|sync)$/u.exec(subject);
  return match === null ? null : { id: match[1]!, purpose: match[2] as MeshSessionPurpose };
};

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      v: Schema.Literal(1),
      meshId: Schema.String,
      id: Schema.String,
      kind: Schema.Literals(["server", "client"]),
      label: Schema.String,
      access: Schema.Literals(["full", "read-only"]),
      accessExpiresAt: Schema.NullOr(Schema.String),
      environmentId: Schema.NullOr(Schema.String),
      ticket: Schema.NullOr(Schema.String),
      removed: Schema.Boolean,
      rev: Schema.Number,
      signer: Schema.String,
      sig: Schema.String,
    }),
  ),
);
const decodeInvitePayload = Schema.decodeUnknownOption(Schema.fromJsonString(MeshInvitePayload));
const decodeRelay = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.NullOr(Schema.String) })),
);

interface CachedSession {
  readonly token: string;
  readonly expiresAt: number;
}

const OFFLINE: MeshMemberStatus = { online: false, lastSeenAt: null, version: null, error: null };

export class MeshService extends Context.Service<
  MeshService,
  {
    readonly state: Effect.Effect<MeshState, MeshError>;
    readonly createInvite: (input: MeshInviteCreateInput) => Effect.Effect<MeshInvite, MeshError>;
    readonly join: (invite: string) => Effect.Effect<MeshState, MeshError>;
    readonly updateMember: (input: MeshMemberUpdateInput) => Effect.Effect<MeshState, MeshError>;
    readonly leave: Effect.Effect<MeshState, MeshError>;
    readonly connections: Effect.Effect<MeshConnections, MeshError>;
    readonly forwardConfig: Effect.Effect<MeshForwardConfig, MeshError>;
    readonly peerJoin: (
      request: MeshPeerJoinRequest,
    ) => Effect.Effect<MeshPeerJoinResult, MeshError>;
    readonly peerSession: (
      request: MeshPeerSessionRequest,
    ) => Effect.Effect<MeshPeerSessionResult, MeshError>;
    readonly peerSync: (
      subject: string,
      request: MeshPeerSyncRequest,
    ) => Effect.Effect<MeshPeerSyncResult, MeshError>;
    /** Keeps members in step and reachable, in the background. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope | HttpServer.HttpServer>;
  }
>()("t3/mesh/MeshService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const iroh = yield* IrohEndpoint.IrohEndpoint;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;

  const seed = yield* secrets
    .getOrCreateRandom(IrohEndpoint.SECRET_KEY_NAME, 32)
    .pipe(Effect.orDie);
  const key = meshKeyFromSeed(seed);

  yield* Effect.all(
    [
      sql`CREATE TABLE IF NOT EXISTS mesh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS mesh_members (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        forward_port INTEGER NOT NULL,
        added_at TEXT NOT NULL
      )`,
      sql`CREATE TABLE IF NOT EXISTS mesh_invites (
        code_hash TEXT PRIMARY KEY,
        access TEXT NOT NULL,
        duration TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )`,
    ],
    { discard: true },
  ).pipe(Effect.orDie);

  const lock = yield* Semaphore.make(1);
  const statuses = yield* Ref.make(new Map<string, MeshMemberStatus>());
  const sessions = new Map<string, CachedSession>();
  const seenNonces = new Map<string, number>();
  const cleaned = new Set<string>();
  const wake = yield* Queue.sliding<void>(1);
  const target = yield* Ref.make<Option.Option<IrohEndpoint.LoopbackTarget>>(Option.none());
  const relayUrl = config.iroh?.relayUrl;
  const relayToken = config.iroh?.relayToken;
  const ownRelay: MeshRelay | null =
    relayUrl === undefined
      ? null
      : { url: relayUrl, token: relayToken === undefined ? null : Redacted.value(relayToken) };

  const clientFor = (origin: string) =>
    HttpApiClient.make(MeshPeerApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  /** Anything but the peer's own mesh refusal is "could not reach it". */
  const reachPeer = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeout(PEER_TIMEOUT),
      Effect.mapError((error: unknown) =>
        isMeshError(error)
          ? error
          : meshError(
              "unreachable",
              `${label} did not answer: ${error instanceof Error ? error.message : String(error)}`,
            ),
      ),
    );

  // Storage

  const readMeta = (name: string) =>
    sql<{ readonly value: string }>`SELECT value FROM mesh_meta WHERE key = ${name}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.value)),
      Effect.catch(storageError),
    );
  const writeMeta = (name: string, value: string) =>
    sql`INSERT INTO mesh_meta (key, value) VALUES (${name}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.asVoid,
      Effect.catch(storageError),
    );

  const meshIdNow = readMeta("mesh_id");

  const readMembers = sql<{
    readonly id: string;
    readonly record_json: string;
    readonly forward_port: number;
  }>`SELECT id, record_json, forward_port FROM mesh_members`.pipe(
    Effect.map((rows) => {
      const records = new Map<string, MeshMemberRecord>();
      const ports = new Map<string, number>();
      for (const row of rows) {
        const record = decodeRecord(row.record_json);
        if (Option.isSome(record)) {
          records.set(row.id, record.value);
          ports.set(row.id, row.forward_port);
        }
      }
      return { records, ports };
    }),
    Effect.catch(storageError),
  );

  const saveRecord = Effect.fn("MeshService.saveRecord")(
    function* (record: MeshMemberRecord) {
      const now = yield* DateTime.now;
      yield* sql`
      INSERT INTO mesh_members (id, record_json, forward_port, added_at)
      VALUES (
        ${record.id}, ${JSON.stringify(record)},
        (SELECT COALESCE(MAX(forward_port), ${FIRST_FORWARD_PORT - 1}) + 1 FROM mesh_members),
        ${DateTime.formatIso(now)}
      )
      ON CONFLICT (id) DO UPDATE SET record_json = excluded.record_json
    `;
    },
    (effect) => effect.pipe(Effect.catch(storageError)),
  );

  const sign = (unsigned: Omit<MeshMemberRecord, "sig">): MeshMemberRecord => ({
    ...unsigned,
    sig: key.sign(meshRecordMessage(unsigned)),
  });

  const nextRev = (existing: MeshMemberRecord | undefined) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => Math.max(now, (existing?.rev ?? 0) + 1)));

  /** The mesh this server is in, failing outside one. */
  const requireMesh = Effect.gen(function* () {
    const meshId = yield* meshIdNow;
    if (Option.isNone(meshId)) {
      return yield* meshError("not_in_mesh", "This machine is not in a mesh.");
    }
    const { records, ports } = yield* readMembers;
    return { meshId: meshId.value, records, ports, self: records.get(key.id) };
  });

  /** Requires this server to be a full, current member: the one who may change the mesh. */
  const requireFull = Effect.gen(function* () {
    const mesh = yield* requireMesh;
    const now = yield* Clock.currentTimeMillis;
    if (!isActiveFull(mesh.self, now)) {
      return yield* meshError("not_allowed", "Only a member with full access can change the mesh.");
    }
    return { ...mesh, self: mesh.self! };
  });

  const ensureListening = Effect.gen(function* () {
    const loopback = yield* Ref.get(target);
    if (Option.isNone(loopback)) {
      return yield* meshError("unreachable", "The server is still starting. Try again shortly.");
    }
    return yield* iroh.listen(loopback.value).pipe(
      Effect.map((listening) => listening.ticket),
      Effect.mapError((cause) =>
        meshError("unreachable", `This machine could not listen over iroh: ${cause.message}`),
      ),
    );
  });

  const selfFields = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const ticket = yield* iroh.currentTicket;
    return {
      label: descriptor.label,
      environmentId: descriptor.environmentId as string,
      version: descriptor.serverVersion,
      ticket: Option.getOrNull(ticket),
    };
  });

  const view = Effect.fn("MeshService.view")(function* (
    meshId: string | null,
    records: Map<string, MeshMemberRecord>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const known = yield* Ref.get(statuses);
    const self = records.get(key.id);
    const own = yield* selfFields;
    const members = [...records.values()]
      .sort((a, b) => (a.id === key.id ? -1 : b.id === key.id ? 1 : a.label.localeCompare(b.label)))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        label: record.label,
        access: record.access,
        accessExpiresAt: record.accessExpiresAt,
        environmentId: record.environmentId,
        removed: record.removed,
        expired: isExpired(record, now),
        self: record.id === key.id,
        addedBy: record.signer,
        updatedAt: new Date(record.rev).toISOString(),
        status:
          record.id === key.id
            ? {
                online: true,
                lastSeenAt: new Date(now).toISOString(),
                version: own.version,
                error: null,
              }
            : (known.get(record.id) ?? OFFLINE),
      }));
    return {
      meshId,
      selfId: key.id,
      selfAccess: self === undefined ? null : self.access,
      members,
    } satisfies MeshState;
  });

  const state: MeshService["Service"]["state"] = Effect.gen(function* () {
    const meshId = yield* meshIdNow;
    if (Option.isNone(meshId)) return yield* view(null, new Map());
    const { records } = yield* readMembers;
    return yield* view(meshId.value, records);
  });

  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  // Sessions issued here to members

  const revokeMemberSessions = (id: string) =>
    auth.listSessions().pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all.filter(
            (session) =>
              session.subject.startsWith(`mesh:${id}:`) ||
              (session.subject === "mcp-client" && session.client.label === mcpLabel(id)),
          ),
          (session) => auth.revokeSession(session.sessionId),
          { discard: true },
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const revokeSubject = (subject: string, label?: string) =>
    auth.listSessions().pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all.filter((session) =>
            label === undefined
              ? session.subject === subject
              : session.subject === subject && session.client.label === label,
          ),
          (session) => auth.revokeSession(session.sessionId),
          { discard: true },
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const markSeen = (id: string, version: string | null, error: string | null) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(statuses, (current) => {
          const next = new Map(current);
          const previous = current.get(id) ?? OFFLINE;
          next.set(
            id,
            error === null
              ? {
                  online: true,
                  lastSeenAt: new Date(now).toISOString(),
                  version: version ?? previous.version,
                  error: null,
                }
              : { ...previous, online: false, error },
          );
          return next;
        }),
      ),
    );

  /** Leaves the mesh here: forgets every member and what this server holds for them. */
  const clearMesh = Effect.gen(function* () {
    const { records } = yield* readMembers.pipe(
      Effect.orElseSucceed(() => ({ records: new Map<string, MeshMemberRecord>() })),
    );
    for (const record of records.values()) {
      if (record.id === key.id) continue;
      if (record.environmentId !== null) {
        yield* peerLinks
          .unlink(EnvironmentId.make(record.environmentId))
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* iroh.closeForward(record.id);
      yield* revokeMemberSessions(record.id);
    }
    yield* Effect.all(
      [sql`DELETE FROM mesh_members`, sql`DELETE FROM mesh_meta`, sql`DELETE FROM mesh_invites`],
      { discard: true },
    ).pipe(Effect.catch(storageError));
    sessions.clear();
    cleaned.clear();
    yield* Ref.set(statuses, new Map());
  });

  /** Merges records from a peer and acts on what changed. */
  const absorb = (incoming: ReadonlyArray<MeshMemberRecord>) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const mesh = yield* requireMesh;
          const now = yield* Clock.currentTimeMillis;
          const accepted = mergeRecords(mesh.records, incoming, mesh.meshId, now);
          for (const record of accepted) yield* saveRecord(record);
          const self = mesh.records.get(key.id);
          if (self !== undefined && self.removed) {
            yield* Effect.logInfo("This machine was removed from the mesh", { by: self.signer });
            yield* clearMesh;
            return { accepted, left: true };
          }
          return { accepted, left: false };
        }),
      )
      .pipe(
        // Changes from a peer (a removal, a new address) act here now, not on the next round.
        Effect.tap((result) => (result.accepted.length > 0 && !result.left ? signal : Effect.void)),
      );

  // Calls to other members

  const assertionFor = (
    member: MeshMemberRecord,
    purpose: MeshSessionPurpose,
    records: ReadonlyArray<MeshMemberRecord>,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const assertion = {
          member: key.id,
          audience: member.environmentId ?? "",
          issuedAt: now,
          nonce: randomToken(12),
          purpose,
        };
        return {
          assertion,
          signature: key.sign(meshAssertionMessage(assertion)),
          records,
        } satisfies MeshPeerSessionRequest;
      }),
    );

  const originOf = (member: MeshMemberRecord) =>
    member.ticket === null
      ? Effect.fail(meshError("unreachable", `${member.label} has no iroh address.`))
      : iroh
          .forward(IrohEndpoint.irohRoute(member.ticket))
          .pipe(
            Effect.mapError((cause) =>
              meshError("unreachable", `Could not open iroh to ${member.label}: ${cause.message}`),
            ),
          );

  /** A session at `member`, from the cache or asked for with a signed assertion. */
  const sessionAt = Effect.fn("MeshService.sessionAt")(function* (
    member: MeshMemberRecord,
    purpose: "client" | "sync",
    records: ReadonlyArray<MeshMemberRecord>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cacheKey = `${member.id}:${purpose}`;
    const cached = sessions.get(cacheKey);
    if (cached !== undefined && cached.expiresAt - SESSION_RENEW_MS > now) return cached;
    const client = yield* clientFor(yield* originOf(member));
    const request = yield* assertionFor(member, purpose, records);
    const issued = yield* reachPeer(
      member.label,
      client.mesh.peerSession({ payload: request }),
    ).pipe(
      Effect.tapError((error) =>
        error.reason === "removed" && error.record !== undefined
          ? absorb([error.record]).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    const session = { token: issued.token, expiresAt: Date.parse(issued.expiresAt) };
    sessions.set(cacheKey, session);
    return session;
  });

  const recordsList = (records: Map<string, MeshMemberRecord>) => [...records.values()];

  /** Keeps a delegation link to `member`, so agents here can work there. */
  const ensureLink = Effect.fn("MeshService.ensureLink")(function* (
    member: MeshMemberRecord,
    self: MeshMemberRecord,
    records: ReadonlyArray<MeshMemberRecord>,
  ) {
    if (member.environmentId === null || member.ticket === null) return;
    const access = self.access === "full" ? "full-access" : "read-only";
    const now = yield* DateTime.now;
    const existing = yield* peerLinks
      .get(EnvironmentId.make(member.environmentId))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (
      Option.isSome(existing) &&
      existing.value.access === access &&
      existing.value.urls.some(IrohEndpoint.isIrohRoute) &&
      DateTime.toEpochMillis(existing.value.expiresAt) - LINK_RENEW_MS > DateTime.toEpochMillis(now)
    ) {
      return;
    }
    const client = yield* clientFor(yield* originOf(member));
    const request = yield* assertionFor(member, "mcp", records);
    const issued = yield* reachPeer(member.label, client.mesh.peerSession({ payload: request }));
    yield* peerLinks
      .adopt({
        environmentId: EnvironmentId.make(member.environmentId),
        label: member.label,
        urls: [IrohEndpoint.irohRoute(member.ticket)],
        access,
        token: issued.token,
        expiresAt: DateTime.makeUnsafe(issued.expiresAt),
      })
      .pipe(Effect.mapError((cause) => meshError("storage", cause.message)));
    yield* Effect.logInfo("Linked mesh member for delegation", { member: member.label, access });
  });

  const syncMember = Effect.fn("MeshService.syncMember")(
    function* (
      member: MeshMemberRecord,
      self: MeshMemberRecord,
      records: ReadonlyArray<MeshMemberRecord>,
    ) {
      const client = yield* clientFor(yield* originOf(member));
      const descriptor = yield* reachPeer(member.label, client.metadata.descriptor());
      if (descriptor.environmentId !== member.environmentId) {
        return yield* meshError(
          "unreachable",
          `${member.label}'s address answers as ${descriptor.label}.`,
        );
      }
      const sync = (session: CachedSession) =>
        reachPeer(
          member.label,
          client.mesh.peerSync({
            headers: { authorization: `Bearer ${session.token}` },
            payload: { records },
          }),
        );
      const result = yield* sync(yield* sessionAt(member, "sync", records)).pipe(
        Effect.catch(() => {
          // A restarted peer forgot the session: ask once more.
          sessions.delete(`${member.id}:sync`);
          return sessionAt(member, "sync", records).pipe(Effect.flatMap(sync));
        }),
      );
      yield* markSeen(member.id, descriptor.serverVersion, null);
      if (result.relay !== undefined && result.relay !== null) {
        yield* writeMeta("relay", JSON.stringify(result.relay)).pipe(Effect.ignore);
      }
      const absorbed = yield* absorb(result.records);
      if (absorbed.left) return;
      yield* ensureLink(member, self, records).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not link mesh member for delegation", {
            member: member.label,
            error: error.message,
          }),
        ),
      );
    },
    (effect, member) =>
      effect.pipe(Effect.catch((error) => markSeen(member.id, null, error.message))),
  );

  /** Re-signs this server's record when its address, name or environment changed. */
  const refreshSelf = lock.withPermits(1)(
    Effect.gen(function* () {
      const mesh = yield* requireMesh;
      const self = mesh.self;
      if (self === undefined || self.removed) return;
      const own = yield* selfFields;
      if (
        self.label === own.label &&
        self.environmentId === own.environmentId &&
        (own.ticket === null || self.ticket === own.ticket)
      ) {
        return;
      }
      const updated = sign({
        ...self,
        label: own.label,
        environmentId: own.environmentId,
        ticket: own.ticket ?? self.ticket,
        rev: yield* nextRev(self),
        signer: key.id,
      });
      yield* saveRecord(updated);
    }),
  );

  /** Drops what a removed or expired member still holds here. */
  const cleanUp = (records: Map<string, MeshMemberRecord>, now: number) =>
    Effect.forEach(
      [...records.values()],
      (record) =>
        Effect.gen(function* () {
          const marker = `${record.id}:${record.rev}`;
          if (record.id === key.id || isActive(record, now) || cleaned.has(marker)) return;
          cleaned.add(marker);
          if (record.environmentId !== null) {
            yield* peerLinks
              .unlink(EnvironmentId.make(record.environmentId))
              .pipe(Effect.ignoreCause({ log: true }));
          }
          if (record.removed) yield* iroh.closeForward(record.id);
          yield* revokeMemberSessions(record.id);
          sessions.delete(`${record.id}:client`);
          sessions.delete(`${record.id}:sync`);
        }),
      { discard: true },
    );

  const syncOnce = Effect.gen(function* () {
    if (Option.isNone(yield* meshIdNow)) return;
    yield* ensureListening.pipe(Effect.ignore);
    yield* refreshSelf.pipe(Effect.ignoreCause({ log: true }));
    const mesh = yield* requireMesh;
    const self = mesh.self;
    if (self === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanUp(mesh.records, now);
    const records = recordsList(mesh.records);
    yield* Effect.forEach(
      records.filter(
        (record) => record.id !== key.id && record.kind === "server" && isActive(record, now),
      ),
      (member) => syncMember(member, self, records),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const start: MeshService["Service"]["start"] = Effect.fn("MeshService.start")(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address !== "string" && "port" in address) {
      yield* Ref.set(
        target,
        Option.some({
          host: loopbackUrlHostForAddress(address).replace(/^\[|\]$/gu, ""),
          port: address.port,
        }),
      );
    }
    yield* forkParked(
      Effect.forever(
        syncOnce.pipe(
          Effect.andThen(
            Queue.take(wake).pipe(
              Effect.asVoid,
              Effect.timeoutOrElse({ duration: SYNC_INTERVAL, orElse: () => Effect.void }),
            ),
          ),
        ),
      ),
    );
  });

  // Local API

  const createInvite: MeshService["Service"]["createInvite"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const ticket = yield* ensureListening;
        let meshId = Option.getOrUndefined(yield* meshIdNow);
        if (meshId === undefined) {
          // The first invite founds a mesh with this server as its first member.
          meshId = randomToken(16);
          const own = yield* selfFields;
          yield* writeMeta("mesh_id", meshId);
          yield* saveRecord(
            sign({
              v: 1,
              meshId,
              id: key.id,
              kind: "server",
              label: own.label,
              access: "full",
              accessExpiresAt: null,
              environmentId: own.environmentId,
              ticket,
              removed: false,
              rev: yield* nextRev(undefined),
              signer: key.id,
            }),
          );
          yield* Effect.logInfo("Founded a mesh", { meshId });
        }
        const { self } = yield* requireFull;
        const duration: MeshAccessDuration =
          input.access === "full" ? "never" : (input.duration ?? "1h");
        const code = randomToken(18);
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = now + INVITE_TTL_MS;
        yield* sql`
          INSERT INTO mesh_invites (code_hash, access, duration, expires_at, used_at)
          VALUES (${sha256(code)}, ${input.access}, ${duration}, ${expiresAt}, NULL)
        `.pipe(Effect.catch(storageError));
        yield* sql`DELETE FROM mesh_invites WHERE expires_at < ${now - INVITE_TTL_MS}`.pipe(
          Effect.ignore,
        );
        const payload: MeshInvitePayload = {
          v: 1,
          m: meshId,
          n: key.id,
          e: self.environmentId ?? "",
          l: self.label,
          t: ticket,
          c: code,
        };
        const invite = `${MESH_INVITE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
        return {
          invite,
          url: `${MESH_INVITE_URL_PREFIX}${invite}`,
          expiresAt: new Date(expiresAt).toISOString(),
          access: input.access,
          duration,
        } satisfies MeshInvite;
      }),
    );

  const join: MeshService["Service"]["join"] = Effect.fn("MeshService.join")(function* (text) {
    const extracted = extractMeshInvite(text);
    const payload =
      extracted === null
        ? Option.none()
        : decodeInvitePayload(
            Buffer.from(extracted.slice(MESH_INVITE_PREFIX.length), "base64url").toString("utf8"),
          );
    if (Option.isNone(payload)) {
      return yield* meshError("invalid_invite", "That is not a mesh invite.");
    }
    const invite = payload.value;
    const current = yield* meshIdNow;
    if (Option.isSome(current)) {
      const { self } = yield* requireMesh;
      if (current.value === invite.m && self !== undefined && !self.removed) {
        return yield* meshError("already_in_mesh", "This machine is already in that mesh.");
      }
      return yield* meshError(
        "already_in_mesh",
        "This machine is in another mesh. Leave it first.",
      );
    }
    if (invite.n === key.id) {
      return yield* meshError("invalid_invite", "That invite is from this machine.");
    }
    const ticket = yield* ensureListening;
    const own = yield* selfFields;
    const origin = yield* iroh
      .forward(IrohEndpoint.irohRoute(invite.t))
      .pipe(
        Effect.mapError((cause) =>
          meshError("unreachable", `Could not open iroh to ${invite.l}: ${cause.message}`),
        ),
      );
    const client = yield* clientFor(origin);
    const result = yield* reachPeer(
      invite.l,
      client.mesh.peerJoin({
        payload: {
          code: invite.c,
          member: {
            id: key.id,
            kind: "server",
            label: own.label,
            environmentId: own.environmentId,
            ticket,
          },
          proof: key.sign(meshJoinProofMessage(invite.c, key.id)),
        },
      }),
    );
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          // The inviter's list is trusted once: the invite came out of band and
          // iroh proved the answer came from the inviter's key.
          const inviter = result.members.find((record) => record.id === invite.n);
          const mine = result.members.find((record) => record.id === key.id);
          const now = yield* Clock.currentTimeMillis;
          if (
            result.meshId !== invite.m ||
            inviter === undefined ||
            !isActiveFull(inviter, now) ||
            mine === undefined ||
            mine.signer !== invite.n
          ) {
            return yield* meshError("invite_rejected", `${invite.l} answered with a broken mesh.`);
          }
          yield* writeMeta("mesh_id", result.meshId);
          if (result.relay !== null) yield* writeMeta("relay", JSON.stringify(result.relay));
          for (const record of result.members) {
            if (record.meshId !== result.meshId) continue;
            const { sig, ...unsigned } = record;
            if (verifyMeshSignature(record.signer, meshRecordMessage(unsigned), sig)) {
              yield* saveRecord(record);
            }
          }
          yield* Effect.logInfo("Joined a mesh", { meshId: result.meshId, via: invite.l });
        }),
      )
      .pipe(Effect.andThen(signal), Effect.andThen(state));
  });

  const updateMember: MeshService["Service"]["updateMember"] = Effect.fn(
    "MeshService.updateMember",
  )(function* (input) {
    if (input.id === key.id && input.remove === true) return yield* leave;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const mesh = yield* requireFull;
        const existing = mesh.records.get(input.id);
        if (existing === undefined) {
          return yield* meshError("unknown_member", "That machine is not in the mesh.");
        }
        const now = yield* Clock.currentTimeMillis;
        const access = input.access ?? existing.access;
        const duration: MeshAccessDuration = access === "full" ? "never" : (input.duration ?? "1h");
        const changesGrant = input.access !== undefined || input.duration !== undefined;
        const millis = meshAccessDurationMillis(duration);
        const updated = sign({
          ...existing,
          access,
          accessExpiresAt: changesGrant
            ? millis === null
              ? null
              : new Date(now + millis).toISOString()
            : existing.accessExpiresAt,
          removed: input.remove === true ? true : existing.removed && !changesGrant,
          rev: yield* nextRev(existing),
          signer: key.id,
        });
        yield* saveRecord(updated);
        if (updated.removed || isExpired(updated, now)) {
          yield* cleanUp(new Map([[updated.id, updated]]), now);
        } else if (updated.access !== existing.access) {
          // Sessions it holds here carry the old scopes.
          yield* revokeMemberSessions(updated.id);
        }
      }),
    );
    yield* signal;
    return yield* state;
  });

  const leave: MeshService["Service"]["leave"] = Effect.gen(function* () {
    const mesh = yield* requireMesh;
    if (mesh.self !== undefined && !mesh.self.removed) {
      const tombstone = sign({
        ...mesh.self,
        removed: true,
        rev: yield* nextRev(mesh.self),
        signer: key.id,
      });
      yield* saveRecord(tombstone);
      const records = [...mesh.records.values()].map((record) =>
        record.id === key.id ? tombstone : record,
      );
      // Tell whoever answers; the rest hear it through them.
      yield* Effect.forEach(
        records.filter(
          (record) => record.id !== key.id && record.kind === "server" && !record.removed,
        ),
        (member) =>
          Effect.gen(function* () {
            const client = yield* clientFor(yield* originOf(member));
            const session = yield* sessionAt(member, "sync", records);
            yield* reachPeer(
              member.label,
              client.mesh.peerSync({
                headers: { authorization: `Bearer ${session.token}` },
                payload: { records },
              }),
            );
          }).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      );
    }
    yield* lock.withPermits(1)(clearMesh);
    yield* Effect.logInfo("Left the mesh");
    return yield* state;
  });

  const connections: MeshService["Service"]["connections"] = Effect.gen(function* () {
    const mesh = yield* requireMesh;
    const now = yield* Clock.currentTimeMillis;
    if (!isActive(mesh.self, now)) return { connections: [] };
    const records = recordsList(mesh.records);
    const found = yield* Effect.forEach(
      records.filter(
        (record) =>
          record.id !== key.id &&
          record.kind === "server" &&
          record.environmentId !== null &&
          isActive(record, now),
      ),
      (member) =>
        Effect.gen(function* () {
          const origin = yield* originOf(member);
          const session = yield* sessionAt(member, "client", records);
          return Option.some({
            memberId: member.id,
            environmentId: member.environmentId!,
            label: member.label,
            access: mesh.self!.access,
            httpBaseUrl: origin,
            wsBaseUrl: origin.replace(/^http/u, "ws"),
            token: session.token,
            expiresAt: new Date(session.expiresAt).toISOString(),
          } satisfies MeshConnection);
        }).pipe(Effect.orElseSucceed(() => Option.none<MeshConnection>())),
      { concurrency: "unbounded" },
    );
    return { connections: found.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])) };
  });

  const forwardConfig: MeshService["Service"]["forwardConfig"] = Effect.gen(function* () {
    const mesh = yield* requireMesh;
    const now = yield* Clock.currentTimeMillis;
    const relay =
      ownRelay ?? Option.getOrNull(Option.flatMap(yield* readMeta("relay"), decodeRelay));
    return {
      relay: relay === null ? null : { url: relay.url },
      forwards: [...mesh.records.values()]
        .filter(
          (record) => record.kind === "server" && record.ticket !== null && isActive(record, now),
        )
        .map((record) => ({
          name: record.label,
          port: mesh.ports.get(record.id) ?? FIRST_FORWARD_PORT,
          ticket: record.ticket!,
        })),
    };
  });

  // Peer API

  const relayFor = Effect.fn("MeshService.relayFor")(function* (access: MeshAccess) {
    if (access !== "full") return null;
    return ownRelay ?? Option.getOrNull(Option.flatMap(yield* readMeta("relay"), decodeRelay));
  });

  const peerJoin: MeshService["Service"]["peerJoin"] = (request) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const mesh = yield* requireFull;
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql<{
            readonly access: string;
            readonly duration: string;
            readonly expires_at: number;
            readonly used_at: number | null;
          }>`SELECT access, duration, expires_at, used_at FROM mesh_invites
           WHERE code_hash = ${sha256(request.code)}`.pipe(Effect.catch(storageError));
          const invite = rows[0];
          if (invite === undefined || invite.used_at !== null || invite.expires_at < now) {
            return yield* meshError(
              "invite_rejected",
              "That invite is unknown, expired or already used. Ask for a new one.",
            );
          }
          if (
            !verifyMeshSignature(
              request.member.id,
              meshJoinProofMessage(request.code, request.member.id),
              request.proof,
            )
          ) {
            return yield* meshError(
              "invite_rejected",
              "The joining machine did not prove its key.",
            );
          }
          if (request.member.id === key.id) {
            return yield* meshError("invite_rejected", "That is this machine.");
          }
          yield* sql`UPDATE mesh_invites SET used_at = ${now} WHERE code_hash = ${sha256(request.code)}`.pipe(
            Effect.catch(storageError),
          );
          const access = invite.access === "full" ? "full" : "read-only";
          const millis =
            access === "full"
              ? null
              : meshAccessDurationMillis(invite.duration as MeshAccessDuration);
          const existing = mesh.records.get(request.member.id);
          const record = sign({
            v: 1,
            meshId: mesh.meshId,
            id: request.member.id,
            kind: request.member.kind,
            label: request.member.label,
            access,
            accessExpiresAt: millis === null ? null : new Date(now + millis).toISOString(),
            environmentId: request.member.environmentId,
            ticket: request.member.ticket,
            removed: false,
            rev: yield* nextRev(existing),
            signer: key.id,
          });
          yield* saveRecord(record);
          mesh.records.set(record.id, record);
          yield* markSeen(record.id, null, null);
          yield* Effect.logInfo("A machine joined the mesh", {
            member: record.label,
            kind: record.kind,
            access,
          });
          return {
            meshId: mesh.meshId,
            members: recordsList(mesh.records),
            relay: yield* relayFor(access),
          } satisfies MeshPeerJoinResult;
        }),
      )
      .pipe(Effect.tap(() => signal));

  /** The member asking, checked against this server's list after taking its records. */
  const activeMember = Effect.fn("MeshService.activeMember")(function* (id: string) {
    const mesh = yield* requireMesh;
    const now = yield* Clock.currentTimeMillis;
    const member = mesh.records.get(id);
    if (member === undefined) {
      return yield* meshError("unknown_member", "This machine does not know that member.");
    }
    if (member.removed) {
      return yield* meshError("removed", "That machine was removed from the mesh.", member);
    }
    if (isExpired(member, now)) {
      return yield* meshError("expired", "That machine's access to the mesh has expired.");
    }
    return { mesh, member, now };
  });

  const peerSession: MeshService["Service"]["peerSession"] = Effect.fn("MeshService.peerSession")(
    function* (request) {
      const { assertion } = request;
      const descriptor = yield* environment.getDescriptor;
      const now = yield* Clock.currentTimeMillis;
      if (assertion.audience !== descriptor.environmentId) {
        return yield* meshError("invalid_request", "That request was meant for another machine.");
      }
      if (Math.abs(now - assertion.issuedAt) > ASSERTION_SKEW_MS) {
        return yield* meshError(
          "invalid_request",
          "The clocks of the two machines differ by more than five minutes.",
        );
      }
      if (
        !verifyMeshSignature(assertion.member, meshAssertionMessage(assertion), request.signature)
      ) {
        return yield* meshError("not_allowed", "The request was not signed by that member.");
      }
      for (const [nonce, expires] of seenNonces) if (expires < now) seenNonces.delete(nonce);
      const nonceKey = `${assertion.member}:${assertion.nonce}`;
      if (seenNonces.has(nonceKey)) {
        return yield* meshError("invalid_request", "That request was already used.");
      }
      seenNonces.set(nonceKey, now + 2 * ASSERTION_SKEW_MS);
      if (request.records !== undefined && request.records.length > 0) {
        yield* absorb(request.records).pipe(Effect.ignore);
      }
      const { member } = yield* activeMember(assertion.member);
      yield* markSeen(member.id, null, null);
      const cap =
        member.accessExpiresAt === null ? Infinity : Date.parse(member.accessExpiresAt) - now;
      if (assertion.purpose === "mcp") {
        if (member.kind !== "server") {
          return yield* meshError("not_allowed", "Only servers delegate.");
        }
        yield* revokeSubject("mcp-client", mcpLabel(member.id));
        const issued = yield* auth
          .issueMcpClientSession({
            label: mcpLabel(member.id),
            access: member.access === "full" ? "full-access" : "read-only",
            peerLink: true,
            client: { deviceType: "bot" },
          })
          .pipe(Effect.mapError(() => meshError("storage", "Could not issue a session.")));
        return {
          token: issued.token,
          expiresAt: DateTime.formatIso(DateTime.toUtc(issued.expiresAt)),
        };
      }
      const subject = sessionSubject(member.id, assertion.purpose);
      yield* revokeSubject(subject);
      const issued = yield* auth
        .issueSession({
          subject,
          label: `${member.label} (mesh)`,
          scopes:
            assertion.purpose === "sync" ? [AuthOrchestrationReadScope] : scopesFor(member.access),
          ttl: Duration.millis(Math.max(60_000, Math.min(SESSION_TTL_MS, cap))),
        })
        .pipe(Effect.mapError(() => meshError("storage", "Could not issue a session.")));
      return { token: issued.token, expiresAt: DateTime.formatIso(issued.expiresAt) };
    },
  );

  const peerSync: MeshService["Service"]["peerSync"] = Effect.fn("MeshService.peerSync")(
    function* (subject, request) {
      const parsed = parseSubject(subject);
      if (parsed === null) {
        return yield* meshError("not_allowed", "Only mesh members sync.");
      }
      yield* absorb(request.records);
      // Removed while asking: the reply carries the tombstone.
      const { mesh, member } = yield* activeMember(parsed.id);
      yield* markSeen(member.id, null, null);
      return {
        records: recordsList(mesh.records),
        relay: yield* relayFor(member.access),
      } satisfies MeshPeerSyncResult;
    },
  );

  return MeshService.of({
    state,
    createInvite,
    join,
    updateMember,
    leave,
    connections,
    forwardConfig,
    peerJoin,
    peerSession,
    peerSync,
    start,
  });
});

export const layer = Layer.effect(MeshService, make);
