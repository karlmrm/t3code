import { meshRecordMessage, type MeshMemberRecord } from "@t3tools/contracts";

import { verifyMeshSignature } from "./MeshCrypto.ts";

/** Whether a read-only grant has run out at `now` (ms). */
export const isExpired = (record: MeshMemberRecord, now: number): boolean =>
  record.accessExpiresAt !== null && Date.parse(record.accessExpiresAt) <= now;

/** A member that may act: listed, not removed, not expired. */
export const isActive = (record: MeshMemberRecord | undefined, now: number): boolean =>
  record !== undefined && !record.removed && !isExpired(record, now);

/** A member that may change other members. */
export const isActiveFull = (record: MeshMemberRecord | undefined, now: number): boolean =>
  isActive(record, now) && record!.access === "full";

const hasValidSignature = (record: MeshMemberRecord): boolean => {
  const { sig, ...unsigned } = record;
  return verifyMeshSignature(record.signer, meshRecordMessage(unsigned), sig);
};

/**
 * Whether `known` should take `incoming`. Newer revisions win; a record is
 * believed when a full member signed it, or when its own member changed only
 * what a member may change about itself (label, ticket, environment id) or left.
 */
export const shouldAccept = (
  known: ReadonlyMap<string, MeshMemberRecord>,
  incoming: MeshMemberRecord,
  meshId: string,
  now: number,
): boolean => {
  if (incoming.meshId !== meshId || incoming.v !== 1) return false;
  const existing = known.get(incoming.id);
  if (existing !== undefined && incoming.rev <= existing.rev) return false;
  if (!hasValidSignature(incoming)) return false;
  if (incoming.signer !== incoming.id) {
    return isActiveFull(known.get(incoming.signer), now);
  }
  // Signed by the member itself.
  if (existing === undefined || existing.removed) return false;
  const grantUnchanged =
    existing.kind === incoming.kind &&
    existing.access === incoming.access &&
    existing.accessExpiresAt === incoming.accessExpiresAt;
  if (!grantUnchanged) return isActiveFull(existing, now);
  // Leaving is always allowed; other self-updates need a member still in good standing.
  return incoming.removed || isActive(existing, now);
};

/**
 * Merges `incoming` into `known` until nothing more is accepted, so a record
 * signed by a member that arrives in the same batch still counts. Returns the
 * accepted records.
 */
export const mergeRecords = (
  known: Map<string, MeshMemberRecord>,
  incoming: ReadonlyArray<MeshMemberRecord>,
  meshId: string,
  now: number,
): ReadonlyArray<MeshMemberRecord> => {
  const accepted = new Map<string, MeshMemberRecord>();
  let pending = [...incoming];
  for (let pass = 0; pass < 8 && pending.length > 0; pass++) {
    const rest: Array<MeshMemberRecord> = [];
    for (const record of pending) {
      if (shouldAccept(known, record, meshId, now)) {
        known.set(record.id, record);
        accepted.set(record.id, record);
      } else {
        rest.push(record);
      }
    }
    if (rest.length === pending.length) break;
    pending = rest;
  }
  return [...accepted.values()];
};
