// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- test keys come from node:crypto.
import * as NodeCrypto from "node:crypto";

import { meshRecordMessage, type MeshMemberRecord } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { meshKeyFromSeed, type MeshKey } from "./MeshCrypto.ts";
import { mergeRecords, shouldAccept } from "./MeshRecords.ts";

const MESH = "mesh-1";
const NOW = 1_800_000_000_000;

const key = (): MeshKey => meshKeyFromSeed(NodeCrypto.randomBytes(32));

const record = (
  member: MeshKey,
  signer: MeshKey,
  fields: Partial<Omit<MeshMemberRecord, "sig" | "id" | "signer">> = {},
): MeshMemberRecord => {
  const unsigned = {
    v: 1 as const,
    meshId: MESH,
    id: member.id,
    kind: "server" as const,
    label: "box",
    access: "full" as const,
    accessExpiresAt: null,
    environmentId: "env",
    ticket: null,
    removed: false,
    rev: NOW,
    ...fields,
    signer: signer.id,
  };
  return { ...unsigned, sig: signer.sign(meshRecordMessage(unsigned)) };
};

describe("mesh records", () => {
  const founder = key();
  const reader = key();
  const known = () =>
    new Map([
      [founder.id, record(founder, founder)],
      [reader.id, record(reader, founder, { access: "read-only" })],
    ]);

  it("takes a newer record signed by a full member", () => {
    const joiner = key();
    expect(shouldAccept(known(), record(joiner, founder, { rev: NOW + 1 }), MESH, NOW)).toBe(true);
  });

  it("refuses records signed by read-only members, forged or from another mesh", () => {
    const joiner = key();
    expect(shouldAccept(known(), record(joiner, reader), MESH, NOW)).toBe(false);
    const forged = { ...record(joiner, founder), label: "evil" };
    expect(shouldAccept(known(), forged, MESH, NOW)).toBe(false);
    expect(shouldAccept(known(), record(joiner, founder, { meshId: "other" }), MESH, NOW)).toBe(
      false,
    );
  });

  it("lets a member update its own address and leave, but not raise its access", () => {
    const map = known();
    expect(
      shouldAccept(
        map,
        record(reader, reader, { access: "read-only", ticket: "t", rev: NOW + 1 }),
        MESH,
        NOW,
      ),
    ).toBe(true);
    expect(shouldAccept(map, record(reader, reader, { rev: NOW + 1 }), MESH, NOW)).toBe(false);
    expect(
      shouldAccept(
        map,
        record(reader, reader, { access: "read-only", removed: true, rev: NOW + 1 }),
        MESH,
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps the higher revision and ignores replays", () => {
    const map = known();
    const removal = record(reader, founder, { access: "read-only", removed: true, rev: NOW + 5 });
    expect(mergeRecords(map, [removal], MESH, NOW)).toHaveLength(1);
    const stale = record(reader, founder, { access: "read-only", rev: NOW + 2 });
    expect(mergeRecords(map, [stale], MESH, NOW)).toHaveLength(0);
    expect(map.get(reader.id)?.removed).toBe(true);
  });

  it("accepts a chain in one batch: a new full member and what it signed", () => {
    const second = key();
    const third = key();
    const map = known();
    const accepted = mergeRecords(
      map,
      [record(third, second, { rev: NOW + 2 }), record(second, founder, { rev: NOW + 1 })],
      MESH,
      NOW,
    );
    expect(accepted.map((entry) => entry.id).sort()).toEqual([second.id, third.id].sort());
  });

  it("stops an expired read-only member from acting", () => {
    const map = new Map(known());
    map.set(
      reader.id,
      record(reader, founder, {
        access: "read-only",
        accessExpiresAt: new Date(NOW - 1).toISOString(),
      }),
    );
    expect(
      shouldAccept(
        map,
        record(reader, reader, {
          access: "read-only",
          accessExpiresAt: new Date(NOW - 1).toISOString(),
          ticket: "x",
          rev: NOW + 1,
        }),
        MESH,
        NOW,
      ),
    ).toBe(false);
  });
});
