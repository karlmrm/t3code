//! `expo.modules.t3iroh.T3IrohNative`'s native methods. Failures throw a
//! `RuntimeException` with the error chain as its message.

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};

fn throw(env: &mut JNIEnv, error: anyhow::Error) {
    let _ = env.throw_new("java/lang/RuntimeException", format!("{error:#}"));
}

fn read(env: &mut JNIEnv, value: &JString) -> Option<String> {
    if value.is_null() {
        return None;
    }
    env.get_string(value).ok().map(Into::into)
}

fn text(env: &mut JNIEnv, value: anyhow::Result<String>) -> jstring {
    match value.and_then(|s| Ok(env.new_string(s)?)) {
        Ok(s) => s.into_raw(),
        Err(error) => {
            throw(env, error);
            std::ptr::null_mut()
        }
    }
}

/// Gives `ndk_context` the VM and the app context once, which iroh's DNS
/// resolver needs to read the active network's DNS servers.
#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeInit(
    env: JNIEnv,
    _class: JClass,
    context: jni::objects::JObject,
) {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let (Ok(vm), Ok(global)) = (env.get_java_vm(), env.new_global_ref(context)) else {
            return;
        };
        let raw = global.as_obj().as_raw();
        // The app context lives as long as the process, so the reference is kept for good.
        std::mem::forget(global);
        #[cfg(target_os = "android")]
        unsafe {
            ndk_context::initialize_android_context(vm.get_java_vm_pointer().cast(), raw.cast());
        }
        #[cfg(not(target_os = "android"))]
        let _ = (vm, raw);
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeStart(
    mut env: JNIEnv,
    _class: JClass,
    key_path: JString,
    relay_url: JString,
    relay_token: JString,
) -> jstring {
    let key_path = read(&mut env, &key_path).unwrap_or_default();
    let relay = read(&mut env, &relay_url).map(|url| crate::RelaySettings {
        url,
        token: read(&mut env, &relay_token),
    });
    let result = crate::start(&key_path, relay);
    text(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeForward(
    mut env: JNIEnv,
    _class: JClass,
    ticket: JString,
) -> jint {
    let ticket = read(&mut env, &ticket).unwrap_or_default();
    match crate::forward(&ticket) {
        Ok(port) => port as jint,
        Err(error) => {
            throw(&mut env, error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeSign(
    mut env: JNIEnv,
    _class: JClass,
    message: JString,
) -> jstring {
    let message = read(&mut env, &message).unwrap_or_default();
    let result = crate::sign(&message);
    text(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeNetworkChanged(
    _env: JNIEnv,
    _class: JClass,
) {
    crate::network_changed();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeCloseForward(
    mut env: JNIEnv,
    _class: JClass,
    endpoint_id: JString,
) {
    if let Some(id) = read(&mut env, &endpoint_id) {
        crate::close_forward(&id);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3iroh_T3IrohNative_nativeStatus(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let status = crate::status();
    text(&mut env, Ok(status))
}
