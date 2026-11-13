package expo.modules.t3iroh

/** The Rust endpoint in libt3_iroh.so. Failures throw RuntimeException. */
internal object T3IrohNative {
  init {
    System.loadLibrary("t3_iroh")
  }

  /** Hands Rust the app context, so iroh reads the system DNS servers. Call before start. */
  @JvmStatic external fun nativeInit(context: android.content.Context)

  @JvmStatic external fun nativeStart(keyPath: String, relayUrl: String?, relayToken: String?): String

  @JvmStatic external fun nativeForward(ticket: String): Int

  @JvmStatic external fun nativeSign(message: String): String

  /** [defaultInterface] is the default network's interface, which iroh cannot read itself. */
  @JvmStatic external fun nativeNetworkChanged(defaultInterface: String?)

  @JvmStatic external fun nativeCloseForward(endpointId: String)

  @JvmStatic external fun nativeStatus(): String
}
