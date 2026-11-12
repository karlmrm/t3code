// @effect-diagnostics globalDate:off globalDateInEffect:off -- prints the server's ISO times as local times.
import {
  EnvironmentHttpApi,
  MeshAccess,
  MeshAccessDuration,
  type MeshMemberView,
  type MeshState,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class MeshServerNotRunningError extends Schema.TaggedError<MeshServerNotRunningError>()(
  "MeshServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class MeshMemberNotFoundError extends Schema.TaggedError<MeshMemberNotFoundError>()(
  "MeshMemberNotFoundError",
  { member: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No single member matches ${this.member}. \`t3 mesh list\` shows them.`;
  }
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const meshClientFor = (baseUrl: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl });
type MeshClient = Effect.Success<ReturnType<typeof meshClientFor>>["mesh"];

/** Calls the running server's mesh API with a short session minted here. */
const withMesh = Effect.fn("cli.mesh.withMesh")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (client: MeshClient, headers: { readonly authorization: string }) => Effect.Effect<A, E>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new MeshServerNotRunningError({ baseDir: config.baseDir });
    }
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueSession({
        subject: "mesh-cli",
        label: "t3 mesh cli",
        ttl: Duration.minutes(5),
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const client = yield* meshClientFor(runtimeState.value.origin);
    return yield* run(client.mesh, { authorization: `Bearer ${issued.token}` });
  }).pipe(
    Effect.scoped,
    Effect.tapError((error) =>
      Console.error(
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error),
      ),
    ),
    Effect.provide(
      Layer.mergeAll(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const shortId = (id: string) => id.slice(0, 10);

const describeAccess = (member: MeshMemberView) =>
  member.access === "full"
    ? "full"
    : member.accessExpiresAt === null
      ? "read-only"
      : `read-only until ${new Date(member.accessExpiresAt).toLocaleString()}${member.expired ? " (expired)" : ""}`;

const formatMeshState = (state: MeshState) => {
  if (state.meshId === null) {
    return "This machine is not in a mesh. `t3 mesh invite` founds one; `t3 mesh join <invite>` joins one.\n";
  }
  const lines = state.members.map((member) => {
    const status = member.self
      ? "this machine"
      : member.removed
        ? "removed"
        : member.status.online
          ? `online${member.status.version === null ? "" : `, ${member.status.version}`}`
          : `offline${member.status.lastSeenAt === null ? "" : `, last seen ${new Date(member.status.lastSeenAt).toLocaleString()}`}${member.status.error === null ? "" : ` (${member.status.error})`}`;
    return `${member.label} [${member.kind}] ${shortId(member.id)}\n  ${status}; access ${describeAccess(member)}`;
  });
  return `Mesh ${shortId(state.meshId)}, ${state.members.filter((member) => !member.removed).length} members\n\n${lines.join("\n")}\n`;
};

const inviteCommand = Command.make("invite", {
  ...projectLocationFlags,
  readOnly: Flag.Boolean("read-only").pipe(
    Flag.withDescription("Invite with read-only access: it can look, never act."),
    Flag.withDefault(false),
  ),
  duration: Flag.Literals("for", MeshAccessDuration.literals).pipe(
    Flag.withDescription(
      "How long read-only access lasts (default 1h). Full access never expires.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Invite a device into this machine's mesh (founding one if needed). Prints a QR code and a text code, valid for 15 minutes and one use.",
  ),
  Command.withHandler((flags) =>
    withMesh(flags, (mesh, headers) =>
      Effect.gen(function* () {
        const access = flags.readOnly ? "read-only" : "full";
        const invite = yield* mesh.createInvite({
          headers,
          payload: {
            access,
            ...(Option.isSome(flags.duration) ? { duration: flags.duration.value } : {}),
          },
        });
        if (flags.json) {
          yield* Console.log(encodeJson(invite));
          return;
        }
        yield* Console.log(renderTerminalQrCode(invite.url));
        yield* Console.log(
          `\nAccess: ${invite.access}${invite.access === "read-only" ? ` for ${invite.duration}` : ""}. Valid until ${new Date(invite.expiresAt).toLocaleTimeString()}.\n\nScan with the T3 Code app, or paste on the joining machine:\n\n  t3 mesh join ${invite.invite}\n`,
        );
      }),
    ),
  ),
);

const joinCommand = Command.make("join", {
  ...projectLocationFlags,
  invite: Argument.String("invite").pipe(
    Argument.withDescription("The invite text (t3mesh:…) or QR link from a mesh member."),
  ),
}).pipe(
  Command.withDescription("Join a mesh with an invite from one of its members."),
  Command.withHandler((flags) =>
    withMesh(flags, (mesh, headers) =>
      mesh
        .join({ headers, payload: { invite: flags.invite } })
        .pipe(Effect.flatMap((state) => Console.log(formatMeshState(state)))),
    ),
  ),
);

const listCommand = Command.make("list", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List mesh members with their status, version and access."),
  Command.withHandler((flags) =>
    withMesh(flags, (mesh, headers) =>
      mesh
        .state({ headers })
        .pipe(
          Effect.flatMap((state) =>
            Console.log(flags.json ? encodeJson(state) : formatMeshState(state)),
          ),
        ),
    ),
  ),
);

/** The member a name, id or id prefix names. */
const findMember = (state: MeshState, name: string) => {
  const lowered = name.toLowerCase();
  const matches = state.members.filter(
    (member) =>
      !member.removed && (member.id.startsWith(lowered) || member.label.toLowerCase() === lowered),
  );
  return matches.length === 1 ? Option.some(matches[0]!) : Option.none<MeshMemberView>();
};

const memberArgument = Argument.String("member").pipe(
  Argument.withDescription("The member's name, or the start of its id (`t3 mesh list`)."),
);

const updateWith = (
  flags: { readonly baseDir: Option.Option<string>; readonly member: string },
  change: (id: string) => {
    readonly id: string;
    readonly access?: MeshAccess;
    readonly duration?: MeshAccessDuration;
    readonly remove?: boolean;
  },
) =>
  withMesh(flags, (mesh, headers) =>
    Effect.gen(function* () {
      const state = yield* mesh.state({ headers });
      const member = findMember(state, flags.member);
      if (Option.isNone(member)) {
        return yield* new MeshMemberNotFoundError({ member: flags.member });
      }
      const next = yield* mesh.updateMember({ headers, payload: change(member.value.id) });
      yield* Console.log(formatMeshState(next));
    }),
  );

const accessCommand = Command.make("access", {
  ...projectLocationFlags,
  member: memberArgument,
  access: Argument.Literals("access", MeshAccess.literals),
  duration: Flag.Literals("for", MeshAccessDuration.literals).pipe(
    Flag.withDescription("How long read-only access lasts (default 1h)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Change a member's access: full, or read-only for a while."),
  Command.withHandler((flags) =>
    updateWith(flags, (id) => ({
      id,
      access: flags.access,
      ...(Option.isSome(flags.duration) ? { duration: flags.duration.value } : {}),
    })),
  ),
);

const removeCommand = Command.make("remove", {
  ...projectLocationFlags,
  member: memberArgument,
}).pipe(
  Command.withDescription("Remove a member from the mesh, everywhere."),
  Command.withHandler((flags) => updateWith(flags, (id) => ({ id, remove: true }))),
);

const leaveCommand = Command.make("leave", { ...projectLocationFlags }).pipe(
  Command.withDescription("Take this machine out of its mesh."),
  Command.withHandler((flags) =>
    withMesh(flags, (mesh, headers) =>
      mesh.leave({ headers }).pipe(Effect.andThen(Console.log("Left the mesh.\n"))),
    ),
  ),
);

const forwardConfigCommand = Command.make("forward-config", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Print forward.json for the Termux iroh forwarder: one stable local port per server in the mesh.",
  ),
  Command.withHandler((flags) =>
    withMesh(flags, (mesh, headers) =>
      mesh
        .forwardConfig({ headers })
        .pipe(Effect.flatMap((config) => Console.log(JSON.stringify(config, null, 2)))),
    ),
  ),
);

export const meshCommand = Command.make("mesh").pipe(
  Command.withDescription(
    "Join this machine's T3 Code into a mesh over iroh: every member sees and reaches the others.",
  ),
  Command.withSubcommands([
    inviteCommand,
    joinCommand,
    listCommand,
    accessCommand,
    removeCommand,
    leaveCommand,
    forwardConfigCommand,
  ]),
);
