import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type MeshAccess,
  type MeshAccessDuration,
  type MeshInvite,
  type MeshMemberView,
} from "@t3tools/contracts";
import { LogInIcon, UserPlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { meshEnvironment } from "~/state/mesh";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

/** One choice for a member's access: full, or read-only for a while. */
type AccessChoice = "full" | `read-only:${MeshAccessDuration}`;

const ACCESS_CHOICES: ReadonlyArray<{ readonly value: AccessChoice; readonly label: string }> = [
  { value: "full", label: "Full access" },
  { value: "read-only:1h", label: "Read-only, 1 hour" },
  { value: "read-only:1d", label: "Read-only, 1 day" },
  { value: "read-only:7d", label: "Read-only, 7 days" },
  { value: "read-only:never", label: "Read-only, no limit" },
];

const parseAccessChoice = (
  choice: AccessChoice,
): { readonly access: MeshAccess; readonly duration?: MeshAccessDuration } =>
  choice === "full"
    ? { access: "full" }
    : { access: "read-only", duration: choice.slice("read-only:".length) as MeshAccessDuration };

function AccessChoiceSelect({
  value,
  onChange,
  disabled = false,
  label,
}: {
  readonly value: AccessChoice | null;
  readonly onChange: (choice: AccessChoice) => void;
  readonly disabled?: boolean;
  readonly label: string;
}) {
  const selected = ACCESS_CHOICES.find((choice) => choice.value === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as AccessChoice);
      }}
    >
      <SelectTrigger aria-label={label} size="sm" className="min-w-44">
        <SelectValue>{selected?.label ?? "Change access"}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {ACCESS_CHOICES.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

function describeAccess(member: MeshMemberView) {
  if (member.access === "full") return "Full access";
  if (member.accessExpiresAt === null) return "Read-only";
  return member.expired
    ? `Read-only, expired ${formatTime(member.accessExpiresAt)}`
    : `Read-only until ${formatTime(member.accessExpiresAt)}`;
}

function describeStatus(member: MeshMemberView) {
  if (member.self) return "This machine";
  if (member.removed) return "Removed";
  if (member.kind === "client") {
    return member.status.lastSeenAt === null
      ? "Device"
      : `Device, last seen ${formatTime(member.status.lastSeenAt)}`;
  }
  if (member.status.online) {
    return member.status.version === null ? "Online" : `Online · ${member.status.version}`;
  }
  const seen =
    member.status.lastSeenAt === null ? "" : `, last seen ${formatTime(member.status.lastSeenAt)}`;
  return `Offline${seen}${member.status.error === null ? "" : ` · ${member.status.error}`}`;
}

export function MeshSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const mesh = useEnvironmentQuery(meshEnvironment.state({ environmentId, input: null }));
  const mayWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const search = searchableSetting("mesh");
  const state = mesh.data;
  const inMesh = state !== null && state !== undefined && state.meshId !== null;
  const isFull = inMesh && state.selfAccess === "full";
  const members = inMesh ? state.members.filter((member) => !member.removed) : [];
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={
        mayWrite && state ? (
          <div className="flex items-center gap-2">
            {inMesh ? null : <JoinMeshAction environmentId={environmentId} />}
            {!inMesh || isFull ? (
              <InviteAction environmentId={environmentId} founding={!inMesh} />
            ) : null}
          </div>
        ) : null
      }
    >
      {mesh.error ? (
        <SettingsRow title="Could not load the mesh" description={mesh.error} />
      ) : !state ? (
        <SettingsRow title="Loading the mesh…" role="status" />
      ) : !inMesh ? (
        <SettingsRow
          title="Not in a mesh"
          description="Joins your machines and phones over iroh, with no ports to open. Members reach each other and agents delegate between them. Invite a device to start one, or join with an invite."
        />
      ) : (
        members.map((member) => (
          <MeshMemberRow
            key={member.id}
            environmentId={environmentId}
            member={member}
            canManage={mayWrite && isFull}
            mayWrite={mayWrite}
          />
        ))
      )}
    </SettingsSection>
  );
}

function MeshMemberRow({
  environmentId,
  member,
  canManage,
  mayWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: MeshMemberView;
  readonly canManage: boolean;
  readonly mayWrite: boolean;
}) {
  // Re-renders each minute, so expiry times stay current.
  useNowMinute();
  const update = useAtomCommand(meshEnvironment.updateMember, { label: "change mesh member" });
  const leave = useAtomCommand(meshEnvironment.leave, { label: "leave mesh" });
  const [busy, setBusy] = useState(false);
  const run = async (
    action: () => Promise<{ readonly _tag: string }>,
    failure: string,
  ): Promise<void> => {
    setBusy(true);
    const result = (await action()) as Parameters<typeof isAtomCommandInterrupted>[0];
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(failure, String(squashAtomCommandFailure(result)));
    }
  };
  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      member.self
        ? "Leave the mesh? This machine stops seeing the others, and they stop reaching it. Joining again needs a new invite."
        : `Remove ${member.label} from the mesh? Every member stops trusting it, and its sessions end.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    await run(
      () =>
        member.self
          ? leave({ environmentId, input: null })
          : update({ environmentId, input: { id: member.id, remove: true } }),
      member.self ? "Could not leave the mesh" : `Could not remove ${member.label}`,
    );
  };
  const changeAccess = (choice: AccessChoice) =>
    void run(
      () => update({ environmentId, input: { id: member.id, ...parseAccessChoice(choice) } }),
      `Could not change ${member.label}'s access`,
    );
  const dot = member.self
    ? "bg-success"
    : member.expired
      ? "bg-destructive"
      : member.status.online
        ? "bg-success"
        : member.status.error !== null
          ? "bg-warning"
          : "bg-muted-foreground/30";
  const status = describeStatus(member);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot tooltipText={status} dotClassName={dot} pingClassName={null} />
            <h3 className="text-sm font-medium text-foreground">{member.label}</h3>
            <span className="text-xs text-muted-foreground">
              {member.kind === "client" ? "device" : "server"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {describeAccess(member)} · {status}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground/70">
            {member.id.slice(0, 16)}
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {canManage && !member.self ? (
            <AccessChoiceSelect
              value={null}
              label={`Change ${member.label}'s access`}
              disabled={busy}
              onChange={changeAccess}
            />
          ) : null}
          {(canManage && !member.self) || (member.self && mayWrite) ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void remove()}
            >
              {member.self ? "Leave" : "Remove"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InviteAction({
  environmentId,
  founding,
}: {
  readonly environmentId: EnvironmentId;
  readonly founding: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<AccessChoice>("full");
  const [invite, setInvite] = useState<MeshInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const create = useAtomCommand(meshEnvironment.createInvite, { label: "create mesh invite" });
  const { copyToClipboard, isCopied } = useCopyToClipboard<null>({
    onCopy: () =>
      toastManager.add({
        type: "success",
        title: "Invite copied",
        description: "Paste it on the joining machine: Settings → Connections → Mesh → Join.",
      }),
  });
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setInvite(null);
      setChoice("full");
    }
  };
  const submit = async () => {
    setBusy(true);
    const result = await create({ environmentId, input: parseAccessChoice(choice) });
    setBusy(false);
    if (result._tag === "Success") setInvite(result.value);
    else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not create an invite", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : handleOpenChange(next))}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <UserPlusIcon className="size-3" />
            Invite
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{founding ? "Start a mesh" : "Invite to the mesh"}</DialogTitle>
          <DialogDescription>
            {founding
              ? "This machine founds the mesh. Scan the code with the T3 Code app, or paste the invite on another machine."
              : "Scan the code with the T3 Code app, or paste the invite on another machine."}{" "}
            An invite works once, for 15 minutes.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {invite === null ? (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium">Access for the new member</span>
              <AccessChoiceSelect
                value={choice}
                label="Access for the new member"
                disabled={busy}
                onChange={setChoice}
              />
              <p className="text-xs text-muted-foreground">
                Read-only members can watch threads and terminals, never act. Use it to show someone
                a running job; it ends by itself.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-center rounded-xl border border-border/60 bg-white p-4">
                <QRCodeSvg
                  value={invite.url}
                  size={208}
                  level="L"
                  marginSize={2}
                  title="Mesh invite. Scan with the T3 Code app"
                />
              </div>
              <Textarea
                readOnly
                value={invite.invite}
                rows={4}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <p className="text-xs text-muted-foreground">
                {invite.access === "full"
                  ? "Full access."
                  : `Read-only for ${ACCESS_CHOICES.find((entry) => entry.value === `read-only:${invite.duration}`)?.label.replace("Read-only, ", "") ?? invite.duration}.`}{" "}
                Valid until {formatTime(invite.expiresAt)}. On a server: <code>t3 mesh join</code>{" "}
                with this text.
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {invite === null ? "Cancel" : "Done"}
          </DialogClose>
          {invite === null ? (
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? "Creating…" : "Create invite"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => copyToClipboard(invite.invite, null)}>
              {isCopied ? "Copied" : "Copy invite"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function JoinMeshAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const join = useAtomCommand(meshEnvironment.join, { label: "join mesh" });
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setText("");
  };
  const submit = async () => {
    if (busy || text.trim().length === 0) return;
    setBusy(true);
    const result = await join({ environmentId, input: text.trim() });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Joined the mesh",
        description: `${result.value.members.filter((member) => !member.removed).length} members. The others appear in the sidebar shortly.`,
      });
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not join the mesh", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : handleOpenChange(next))}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <LogInIcon className="size-3" />
            Join
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Join a mesh</DialogTitle>
          <DialogDescription>
            Paste an invite from a member: Settings → Connections → Mesh → Invite there, or{" "}
            <code>t3 mesh invite</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="t3mesh:…"
              rows={4}
              disabled={busy}
              autoFocus
              spellCheck={false}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || text.trim().length === 0}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
