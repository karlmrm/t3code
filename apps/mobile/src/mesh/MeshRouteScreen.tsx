import { useFocusEffect, useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import type {
  MeshAccess,
  MeshAccessDuration,
  MeshInvite,
  MeshMemberRecord,
} from "@t3tools/contracts";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import * as Dialog from "../components/ui/Dialog";
import { ListActionRow } from "../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../components/ui/ScreenScrollView";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { mesh, meshClient, parseMeshInvite, type MeshMemberStatus } from "./meshClient";
import { QrCodeSvg } from "./QrCodeSvg";

type MeshRouteParams = { readonly invite?: string };

const DURATIONS: ReadonlyArray<{ readonly value: MeshAccessDuration; readonly label: string }> = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "never", label: "No limit" },
];

const inviteMeshId = (invite: string) => {
  try {
    return parseMeshInvite(invite).m;
  } catch {
    return null;
  }
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const accessText = (record: MeshMemberRecord) =>
  record.access === "full"
    ? "Full access"
    : record.accessExpiresAt === null
      ? "Read-only"
      : Date.parse(record.accessExpiresAt) <= Date.now()
        ? "Read-only, expired"
        : `Read-only until ${new Date(record.accessExpiresAt).toLocaleString()}`;

const isExpired = (record: MeshMemberRecord) =>
  record.accessExpiresAt !== null && Date.parse(record.accessExpiresAt) <= Date.now();

const hasFullAccess = (record: MeshMemberRecord) =>
  record.access === "full" &&
  (record.accessExpiresAt === null || Date.parse(record.accessExpiresAt) > Date.now());

const statusText = (status: MeshMemberStatus | undefined) => {
  if (status === undefined) return "Checking…";
  if (!status.online) return `Offline${status.error ? `: ${status.error}` : ""}`;
  const path =
    status.path === null
      ? ""
      : ` · ${status.path}${status.rttMs === null ? "" : ` ${status.rttMs} ms`}`;
  return `Online${status.version ? ` · ${status.version}` : ""}${path}`;
};

function AccessPicker(props: {
  readonly access: MeshAccess;
  readonly duration: MeshAccessDuration;
  readonly onChange: (access: MeshAccess, duration: MeshAccessDuration) => void;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        <Chip
          label="Full access"
          selected={props.access === "full"}
          onPress={() => props.onChange("full", props.duration)}
        />
        <Chip
          label="Read-only"
          selected={props.access === "read-only"}
          onPress={() => props.onChange("read-only", props.duration)}
        />
      </View>
      {props.access === "read-only" ? (
        <View className="flex-row flex-wrap gap-2">
          {DURATIONS.map((entry) => (
            <Chip
              key={entry.value}
              size="small"
              label={entry.label}
              selected={props.duration === entry.value}
              onPress={() => props.onChange("read-only", entry.value)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function JoinSection(props: { readonly initialInvite: string }) {
  const [invite, setInvite] = useState(props.initialInvite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const focused = useIsFocused();

  const join = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      await mesh.join(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(messageOf(cause));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Join a mesh"
      footer="Scan the invite QR on a member (Settings → Connections → Mesh → Invite, or t3 mesh invite), or paste its code."
    >
      <View className="gap-3 p-4">
        {scanning && permission?.granted && focused ? (
          <View className="h-64 overflow-hidden rounded-2xl">
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                if (!data.includes("t3mesh:")) return;
                setScanning(false);
                setInvite(data);
                void join(data);
              }}
            />
          </View>
        ) : null}
        <AppTextInput
          value={invite}
          onChangeText={(value) => {
            setInvite(value);
            setError(null);
          }}
          placeholder="t3mesh:…"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        <View className="flex-row gap-2">
          <Button
            label={scanning ? "Stop camera" : "Scan QR"}
            icon="qrcode.viewfinder"
            onPress={async () => {
              if (scanning) return setScanning(false);
              const granted = permission?.granted || (await requestPermission()).granted;
              if (granted) setScanning(true);
            }}
          />
          <Button
            label="Join"
            tone="primary"
            loading={busy}
            disabled={invite.trim().length === 0}
            onPress={() => void join(invite)}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function InviteSection() {
  const [access, setAccess] = useState<MeshAccess>("read-only");
  const [duration, setDuration] = useState<MeshAccessDuration>("1h");
  const [invite, setInvite] = useState<MeshInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection
      title="Invite a device"
      footer="The code works once, for 15 minutes. Read-only devices look but never act."
    >
      <View className="gap-3 p-4">
        <AccessPicker
          access={access}
          duration={duration}
          onChange={(nextAccess, nextDuration) => {
            setAccess(nextAccess);
            setDuration(nextDuration);
            setInvite(null);
          }}
        />
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        {invite ? (
          <View className="items-center gap-3">
            <View className="rounded-xl bg-white p-3">
              <QrCodeSvg value={invite.url} size={240} />
            </View>
            <Text selectable className="text-xs text-foreground-muted" numberOfLines={3}>
              {invite.invite}
            </Text>
            <View className="flex-row gap-2">
              <Button
                label="Copy code"
                icon="doc.on.doc"
                onPress={() => void Clipboard.setStringAsync(invite.invite)}
              />
              <Button
                label="Share"
                icon="square.and.arrow.up"
                onPress={() => void Share.share({ message: invite.invite })}
              />
            </View>
          </View>
        ) : (
          <Button
            label="Create invite"
            tone="primary"
            loading={busy}
            onPress={async () => {
              setBusy(true);
              setError(null);
              try {
                setInvite(await mesh.createInvite(access, duration));
              } catch (cause) {
                setError(messageOf(cause));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </View>
    </SettingsSection>
  );
}

function MemberRow(props: {
  readonly record: MeshMemberRecord;
  readonly self: boolean;
  readonly canManage: boolean;
  readonly status: MeshMemberStatus | undefined;
}) {
  const { record } = props;
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<MeshAccess>(record.access);
  const [duration, setDuration] = useState<MeshAccessDuration>("1h");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setOpen(false);
    } catch (cause) {
      Dialog.alert("Mesh", messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const detail = props.self
    ? "This phone"
    : record.kind === "client"
      ? "Phone"
      : isExpired(record)
        ? null
        : statusText(props.status);
  return (
    <View>
      <ListActionRow
        icon={record.kind === "client" ? "iphone" : "desktopcomputer"}
        label={record.label}
        description={detail === null ? accessText(record) : `${accessText(record)} · ${detail}`}
        detail={record.id.slice(0, 10)}
        disabled={!props.canManage || props.self}
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View className="gap-3 bg-grouped-card px-4 pb-4">
          <AccessPicker
            access={access}
            duration={duration}
            onChange={(nextAccess, nextDuration) => {
              setAccess(nextAccess);
              setDuration(nextDuration);
            }}
          />
          <View className="flex-row gap-2">
            <Button
              label="Change access"
              tone="primary"
              loading={busy}
              onPress={() => void run(() => mesh.changeAccess(record.id, access, duration))}
            />
            <Button
              label="Remove"
              tone="danger"
              disabled={busy}
              onPress={() =>
                Dialog.confirm({
                  title: `Remove ${record.label}?`,
                  message: "It loses access to every machine in the mesh.",
                  confirmText: "Remove",
                  destructive: true,
                  onConfirm: () => void run(() => mesh.removeMember(record.id)),
                })
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function MeshRouteScreen({ route }: StaticScreenProps<MeshRouteParams | undefined>) {
  const state = useSyncExternalStore(meshClient.subscribe, meshClient.getSnapshot);
  const insets = useSafeAreaInsets();
  const routeInvite = route.params?.invite ?? "";
  useFocusEffect(
    useCallback(() => {
      void mesh.start().then(() => mesh.refresh().catch(() => undefined));
    }, []),
  );

  const self = state.records.find((record) => record.id === state.selfId);
  const selfFull = self !== undefined && hasFullAccess(self);
  const members = state.records
    .filter((record) => !record.removed)
    .sort((a, b) =>
      a.id === state.selfId ? -1 : b.id === state.selfId ? 1 : a.label.localeCompare(b.label),
    );

  return (
    <SettingsScreen
      title="Mesh"
      refresh={
        state.meshId === null
          ? undefined
          : {
              accessibilityLabel: "Refresh mesh",
              disabled: state.refreshing,
              onPress: () => void mesh.refresh().catch(() => undefined),
            }
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!state.available ? (
          <Text className="text-foreground-muted">This build of the app has no iroh.</Text>
        ) : !state.loaded ? null : state.meshId === null ? (
          <JoinSection key={routeInvite} initialInvite={routeInvite} />
        ) : (
          <>
            <SettingsSection
              title={`Mesh ${state.meshId.slice(0, 10)}`}
              footer={[
                state.homeRelay ? `Relay: ${state.homeRelay}` : "No relay yet",
                state.lastError,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {members.map((record) => (
                <MemberRow
                  key={`${record.id}:${record.rev}`}
                  record={record}
                  self={record.id === state.selfId}
                  canManage={selfFull}
                  status={state.status[record.id]}
                />
              ))}
            </SettingsSection>
            {selfFull ? <InviteSection /> : null}
            {routeInvite && inviteMeshId(routeInvite) !== state.meshId ? (
              <Text className="text-sm text-foreground-muted">
                This phone is already in a mesh. Leave it to join another.
              </Text>
            ) : null}
            <SettingsSection>
              <ListActionRow
                icon="xmark"
                label="Leave the mesh"
                tone="danger"
                onPress={() =>
                  Dialog.confirm({
                    title: "Leave the mesh?",
                    message: "This phone loses its connections to the mesh machines.",
                    confirmText: "Leave",
                    destructive: true,
                    onConfirm: () => void mesh.leave(),
                  })
                }
              />
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
