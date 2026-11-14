import { expect, it } from "@effect/vitest";

import { adbServerTarget, normalizeMeshPortService, parseMeshPortService } from "./MeshPorts.ts";

it("names adb's server and loopback ports, nothing else", () => {
  expect(parseMeshPortService("adb")).toEqual({ kind: "adb" });
  expect(parseMeshPortService("port:27183")).toEqual({ kind: "port", port: 27183 });
  expect(parseMeshPortService("port:0")).toBeNull();
  expect(parseMeshPortService("port:70000")).toBeNull();
  expect(parseMeshPortService("ssh")).toBeNull();
  expect(parseMeshPortService("port:22 ")).toBeNull();

  expect(normalizeMeshPortService(" ADB ")).toBe("adb");
  expect(normalizeMeshPortService("27183")).toBe("port:27183");
  expect(normalizeMeshPortService("port:8081")).toBe("port:8081");
  expect(normalizeMeshPortService("10.0.0.1:22")).toBeNull();
});

it("finds adb's server where adb itself would look", () => {
  expect(adbServerTarget({})).toEqual({ host: "127.0.0.1", port: 5037 });
  expect(adbServerTarget({ ANDROID_ADB_SERVER_PORT: "5040" })).toEqual({
    host: "127.0.0.1",
    port: 5040,
  });
  expect(adbServerTarget({ ADB_SERVER_SOCKET: "tcp:localhost:5041" })).toEqual({
    host: "127.0.0.1",
    port: 5041,
  });
  // A server on another host is not this machine's to share.
  expect(adbServerTarget({ ADB_SERVER_SOCKET: "tcp:10.0.0.2:5037" })).toEqual({
    host: "127.0.0.1",
    port: 5037,
  });
});
