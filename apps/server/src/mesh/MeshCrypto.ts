// @effect-diagnostics nodeBuiltinImport:off -- ed25519 signatures with the iroh key; Effect has no ed25519.
import * as NodeCrypto from "node:crypto";

/** DER prefixes that wrap a raw ed25519 seed and public key for node:crypto. */
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A member key: an iroh secret key is an ed25519 seed, and its endpoint id the hex public key. */
export interface MeshKey {
  readonly id: string;
  readonly sign: (message: string) => string;
}

export const meshKeyFromSeed = (seed: Uint8Array): MeshKey => {
  const privateKey = NodeCrypto.createPrivateKey({
    key: Buffer.concat([PKCS8_SEED_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const id = NodeCrypto.createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(SPKI_PREFIX.length)
    .toString("hex");
  return {
    id,
    sign: (message) =>
      NodeCrypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
};

const isMemberId = (id: string): boolean => /^[0-9a-f]{64}$/u.test(id);

/** Whether `signature` is `id`'s signature over `message`. Malformed input is simply false. */
export const verifyMeshSignature = (id: string, message: string, signature: string): boolean => {
  if (!isMemberId(id)) return false;
  try {
    const publicKey = NodeCrypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(id, "hex")]),
      format: "der",
      type: "spki",
    });
    return NodeCrypto.verify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
};

export const randomToken = (bytes = 24): string =>
  NodeCrypto.randomBytes(bytes).toString("base64url");

export const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
