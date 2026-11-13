#!/usr/bin/env bash
# Builds libt3_iroh.so for each Android ABI into android/src/main/jniLibs.
# ABIS defaults to arm64-v8a; set ABIS="arm64-v8a x86_64" for an emulator too.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
ndk="${ANDROID_NDK_HOME:-$(ls -d "$sdk"/ndk/* | sort -V | tail -1)}"
toolchain="$ndk/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64/bin"
api=24
for abi in ${ABIS:-arm64-v8a}; do
  case "$abi" in
    arm64-v8a) target=aarch64-linux-android ;;
    x86_64) target=x86_64-linux-android ;;
    armeabi-v7a) target=armv7-linux-androideabi ;;
    *) echo "unknown ABI $abi" >&2; exit 1 ;;
  esac
  clang="$toolchain/${target/armv7/armv7a}${api}-clang"
  upper="$(echo "$target" | tr '[:lower:]-' '[:upper:]_')"
  env "CC_${target//-/_}=$clang" "AR_${target//-/_}=$toolchain/llvm-ar" \
    "CARGO_TARGET_${upper}_LINKER=$clang" \
    cargo build --release --manifest-path "$here/rust/Cargo.toml" --target "$target" --lib
  mkdir -p "$here/android/src/main/jniLibs/$abi"
  cp "$here/rust/target/$target/release/libt3_iroh.so" "$here/android/src/main/jniLibs/$abi/"
done
