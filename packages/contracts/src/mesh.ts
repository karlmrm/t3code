import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import {
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthTerminalReadScope,
} from "./auth.ts";

/**
 * A mesh joins the owner's T3 Code machines over iroh. Every server keeps the
 * whole member list as signed records; see docs/adr/0001-iroh-mesh.md.
 */
export const MeshAccess = Schema.Literals(["full", "read-only"]);
export type MeshAccess = typeof MeshAccess.Type;

/** A server runs T3 Code; a client is a phone app with no server of its own. */
export const MeshMemberKind = Schema.Literals(["server", "client"]);
export type MeshMemberKind = typeof MeshMemberKind.Type;

/** How long read-only access lasts from the moment it is granted. */
export const MeshAccessDuration = Schema.Literals(["1h", "1d", "7d", "never"]);
export type MeshAccessDuration = typeof MeshAccessDuration.Type;

export const meshAccessDurationMillis = (duration: MeshAccessDuration): number | null => {
  switch (duration) {
    case "1h":
      return 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "never":
      return null;
  }
};

/** What a read-only member may do on another member: look, never act. */
export const MeshReadOnlyScopes: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthTerminalReadScope,
  AuthDiagnosticsReadScope,
];

/** One member as every server stores it. `sig` signs the other fields. */
export const MeshMemberRecord = Schema.Struct({
  v: Schema.Literal(1),
  meshId: Schema.String,
  /** The member's ed25519 public key in hex: a server's iroh endpoint id. */
  id: Schema.String,
  kind: MeshMemberKind,
  label: Schema.String,
  access: MeshAccess,
  accessExpiresAt: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  /** Where a server answers over iroh. */
  ticket: Schema.NullOr(Schema.String),
  removed: Schema.Boolean,
  rev: Schema.Number,
  signer: Schema.String,
  sig: Schema.String,
});
export type MeshMemberRecord = typeof MeshMemberRecord.Type;

export const MeshMemberStatus = Schema.Struct({
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type MeshMemberStatus = typeof MeshMemberStatus.Type;

export const MeshMemberView = Schema.Struct({
  id: Schema.String,
  kind: MeshMemberKind,
  label: Schema.String,
  access: MeshAccess,
  accessExpiresAt: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  removed: Schema.Boolean,
  expired: Schema.Boolean,
  self: Schema.Boolean,
  addedBy: Schema.String,
  updatedAt: Schema.String,
  status: MeshMemberStatus,
});
export type MeshMemberView = typeof MeshMemberView.Type;

export const MeshState = Schema.Struct({
  meshId: Schema.NullOr(Schema.String),
  selfId: Schema.NullOr(Schema.String),
  selfAccess: Schema.NullOr(MeshAccess),
  members: Schema.Array(MeshMemberView),
});
export type MeshState = typeof MeshState.Type;

export const MeshInviteCreateInput = Schema.Struct({
  access: MeshAccess,
  /** Read-only only; full access never expires. Read-only defaults to 1h. */
  duration: Schema.optionalKey(MeshAccessDuration),
});
export type MeshInviteCreateInput = typeof MeshInviteCreateInput.Type;

export const MeshInvite = Schema.Struct({
  /** The text code: `t3mesh:...`. */
  invite: Schema.String,
  /** What the QR code holds, so a phone camera opens the app. */
  url: Schema.String,
  expiresAt: Schema.String,
  access: MeshAccess,
  duration: MeshAccessDuration,
});
export type MeshInvite = typeof MeshInvite.Type;

/** The fields an invite carries. */
export const MeshInvitePayload = Schema.Struct({
  v: Schema.Literal(1),
  /** The mesh. */
  m: Schema.String,
  /** The inviter's member id. */
  n: Schema.String,
  /** The inviter's environment id. */
  e: Schema.String,
  /** The inviter's label. */
  l: Schema.String,
  /** The inviter's iroh ticket. */
  t: Schema.String,
  /** The one-time code. */
  c: Schema.String,
  /**
   * The mesh relay, so a joiner off the inviter's network reaches it. The
   * invite grants membership already, so the token adds nothing to guard.
   */
  r: Schema.optional(Schema.Struct({ u: Schema.String, k: Schema.NullOr(Schema.String) })),
});
export type MeshInvitePayload = typeof MeshInvitePayload.Type;

export const MESH_INVITE_PREFIX = "t3mesh:";
export const MESH_INVITE_URL_PREFIX = "t3code://mesh?invite=";

/** The invite text inside pasted text, a QR URL or a bare code. */
export const extractMeshInvite = (input: string): string | null => {
  const trimmed = input.trim();
  const at = trimmed.indexOf(MESH_INVITE_PREFIX);
  if (at < 0) return null;
  const rest = trimmed.slice(at);
  const decoded = rest.includes("%") ? decodeURIComponent(rest) : rest;
  const match = /^t3mesh:[A-Za-z0-9_-]+/u.exec(decoded);
  return match === null ? null : match[0];
};

export const MeshJoinInput = Schema.Struct({
  invite: Schema.String,
});
export type MeshJoinInput = typeof MeshJoinInput.Type;

export const MeshMemberUpdateInput = Schema.Struct({
  id: Schema.String,
  access: Schema.optionalKey(MeshAccess),
  duration: Schema.optionalKey(MeshAccessDuration),
  remove: Schema.optionalKey(Schema.Boolean),
});
export type MeshMemberUpdateInput = typeof MeshMemberUpdateInput.Type;

/** Another server member, reachable from this machine. */
export const MeshConnection = Schema.Struct({
  memberId: Schema.String,
  environmentId: Schema.String,
  label: Schema.String,
  access: MeshAccess,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
});
export type MeshConnection = typeof MeshConnection.Type;

export const MeshConnections = Schema.Struct({
  connections: Schema.Array(MeshConnection),
});
export type MeshConnections = typeof MeshConnections.Type;

export const MeshRelay = Schema.Struct({
  url: Schema.String,
  token: Schema.NullOr(Schema.String),
});
export type MeshRelay = typeof MeshRelay.Type;

/** The Termux forwarder's `forward.json`. */
export const MeshForwardConfig = Schema.Struct({
  relay: Schema.NullOr(Schema.Struct({ url: Schema.String })),
  forwards: Schema.Array(
    Schema.Struct({ name: Schema.String, port: Schema.Number, ticket: Schema.String }),
  ),
});
export type MeshForwardConfig = typeof MeshForwardConfig.Type;

export const MeshJoiningMember = Schema.Struct({
  id: Schema.String,
  kind: MeshMemberKind,
  label: Schema.String,
  environmentId: Schema.NullOr(Schema.String),
  ticket: Schema.NullOr(Schema.String),
});
export type MeshJoiningMember = typeof MeshJoiningMember.Type;

export const MeshPeerJoinRequest = Schema.Struct({
  code: Schema.String,
  member: MeshJoiningMember,
  /** The joiner's signature over `meshJoinProofMessage(code, id)`. */
  proof: Schema.String,
});
export type MeshPeerJoinRequest = typeof MeshPeerJoinRequest.Type;

export const MeshPeerJoinResult = Schema.Struct({
  meshId: Schema.String,
  members: Schema.Array(MeshMemberRecord),
  relay: Schema.NullOr(MeshRelay),
});
export type MeshPeerJoinResult = typeof MeshPeerJoinResult.Type;

export const MeshSessionPurpose = Schema.Literals(["client", "sync", "mcp"]);
export type MeshSessionPurpose = typeof MeshSessionPurpose.Type;

export const MeshSessionAssertion = Schema.Struct({
  member: Schema.String,
  /** The environment id of the server asked. */
  audience: Schema.String,
  issuedAt: Schema.Number,
  nonce: Schema.String,
  purpose: MeshSessionPurpose,
});
export type MeshSessionAssertion = typeof MeshSessionAssertion.Type;

export const MeshPeerSessionRequest = Schema.Struct({
  assertion: MeshSessionAssertion,
  signature: Schema.String,
  /** Records the asked server may not have yet, such as the asker's own. */
  records: Schema.optionalKey(Schema.Array(MeshMemberRecord)),
});
export type MeshPeerSessionRequest = typeof MeshPeerSessionRequest.Type;

export const MeshPeerSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
});
export type MeshPeerSessionResult = typeof MeshPeerSessionResult.Type;

export const MeshPeerSyncRequest = Schema.Struct({
  records: Schema.Array(MeshMemberRecord),
});
export type MeshPeerSyncRequest = typeof MeshPeerSyncRequest.Type;

export const MeshPeerSyncResult = Schema.Struct({
  records: Schema.Array(MeshMemberRecord),
  relay: Schema.optionalKey(Schema.NullOr(MeshRelay)),
});
export type MeshPeerSyncResult = typeof MeshPeerSyncResult.Type;

/** The bytes a joiner signs to prove it holds the key it joins with. */
export const meshJoinProofMessage = (code: string, id: string) => `t3-mesh-join-v1\n${code}\n${id}`;

/** The bytes a member signs to ask another for a session. */
export const meshAssertionMessage = (assertion: MeshSessionAssertion) =>
  `t3-mesh-session-v1\n${assertion.member}\n${assertion.audience}\n${assertion.issuedAt}\n${assertion.nonce}\n${assertion.purpose}`;

/** The bytes a record's signer signs: every field but `sig`, in a fixed order. */
export const meshRecordMessage = (record: Omit<MeshMemberRecord, "sig">) =>
  `t3-mesh-member-v1\n${JSON.stringify([
    record.v,
    record.meshId,
    record.id,
    record.kind,
    record.label,
    record.access,
    record.accessExpiresAt,
    record.environmentId,
    record.ticket,
    record.removed,
    record.rev,
    record.signer,
  ])}`;

export const MeshErrorReason = Schema.Literals([
  "not_in_mesh",
  "already_in_mesh",
  "not_allowed",
  "invalid_invite",
  "invite_rejected",
  "unknown_member",
  "removed",
  "expired",
  "unreachable",
  "invalid_request",
  "storage",
]);
export type MeshErrorReason = typeof MeshErrorReason.Type;

export class MeshError extends Schema.TaggedError<MeshError>()(
  "MeshError",
  {
    reason: MeshErrorReason,
    message: Schema.String,
    /** With `removed`: the signed tombstone, so the removed member can verify it and leave. */
    record: Schema.optionalKey(MeshMemberRecord),
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(MeshError)(this, { status: 400 });
  }
}
