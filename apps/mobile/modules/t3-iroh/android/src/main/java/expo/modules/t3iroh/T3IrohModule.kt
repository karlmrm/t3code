package expo.modules.t3iroh

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class IrohException(message: String?) : CodedException("ERR_IROH", message ?: "iroh failed", null)

/**
 * The phone's iroh endpoint. Its key lives in the app's files, so the phone keeps
 * one mesh identity; network changes reach iroh at once, so a move between Wi-Fi
 * and mobile data finds the new path without waiting for iroh's own timer.
 */
class T3IrohModule : Module() {
  private var callback: ConnectivityManager.NetworkCallback? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IrohException("No Android context")

  private fun <T> native(block: () -> T): T =
    try {
      block()
    } catch (error: RuntimeException) {
      throw IrohException(error.message)
    }

  override fun definition() = ModuleDefinition {
    Name("T3Iroh")

    Events("onNetworkChange")

    AsyncFunction("start") { relayUrl: String?, relayToken: String? ->
      val keyPath = File(context.filesDir, "iroh/secret.key").absolutePath
      val id = native {
        T3IrohNative.nativeInit(context.applicationContext)
        T3IrohNative.nativeStart(keyPath, relayUrl, relayToken)
      }
      watchNetwork()
      id
    }

    AsyncFunction("forward") { ticket: String -> native { T3IrohNative.nativeForward(ticket) } }

    AsyncFunction("sign") { message: String -> native { T3IrohNative.nativeSign(message) } }

    AsyncFunction("closeForward") { endpointId: String ->
      native { T3IrohNative.nativeCloseForward(endpointId) }
    }

    AsyncFunction("status") { native { T3IrohNative.nativeStatus() } }

    AsyncFunction("networkChanged") { native { T3IrohNative.nativeNetworkChanged() } }

    OnDestroy { unwatchNetwork() }
  }

  private fun watchNetwork() {
    if (callback != null) return
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
    val next =
      object : ConnectivityManager.NetworkCallback() {
        private var current: Network? = null
        private var addresses: List<String> = emptyList()

        private fun changed(network: Network, properties: LinkProperties?) {
          val now = properties?.linkAddresses?.map { it.toString() } ?: addresses
          if (network == current && now == addresses) return
          val first = current == null
          current = network
          addresses = now
          if (first) return
          T3IrohNative.nativeNetworkChanged()
          sendEvent("onNetworkChange", mapOf("network" to network.toString()))
        }

        override fun onAvailable(network: Network) = changed(network, null)

        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) =
          changed(network, properties)

        override fun onLost(network: Network) {
          if (network == current) {
            T3IrohNative.nativeNetworkChanged()
            sendEvent("onNetworkChange", mapOf("network" to null))
          }
        }
      }
    manager.registerDefaultNetworkCallback(next)
    callback = next
  }

  private fun unwatchNetwork() {
    val registered = callback ?: return
    callback = null
    try {
      appContext.reactContext
        ?.getSystemService(ConnectivityManager::class.java)
        ?.unregisterNetworkCallback(registered)
    } catch (_: IllegalArgumentException) {}
  }
}
