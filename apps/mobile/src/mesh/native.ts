import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface Subscription {
  readonly remove: () => void;
}

/** The Rust iroh endpoint in modules/t3-iroh. Android only. */
export interface T3IrohNativeModule {
  /** Starts the endpoint, or restarts it when the relay changed. Returns the member id. */
  readonly start: (relayUrl: string | null, relayToken: string | null) => Promise<string>;
  /** A loopback port that reaches the endpoint in `ticket`. */
  readonly forward: (ticket: string) => Promise<number>;
  /** Signs with the member key: base64url without padding. */
  readonly sign: (message: string) => Promise<string>;
  readonly closeForward: (endpointId: string) => Promise<void>;
  /** JSON: home relays and the selected path to each forwarded peer. */
  readonly status: () => Promise<string>;
  readonly networkChanged: () => Promise<void>;
  readonly addListener: (
    event: "onNetworkChange",
    listener: (event: { readonly network: string | null }) => void,
  ) => Subscription;
}

export const irohNative: T3IrohNativeModule | null =
  Platform.OS === "android" ? requireOptionalNativeModule<T3IrohNativeModule>("T3Iroh") : null;
