# ADR 0001: An iroh mesh of T3 Code machines

- Status: proposed (fork only, branch `iroh/mesh`)
- Date: 2026-11-13

## Context

The fork can serve an environment over iroh (`--iroh`) and link one server to
another by `iroh:<ticket>` (peer links, `delegate_task`). Reaching a machine
from a client still needs per-machine forwarders, a manually paired
environment in every client, and a pairing code per server-to-server link. A
link to a thread on another machine opens only if that client paired with that
machine itself.

The owner wants every T3 instance they run (servers, the desktop app, phones)
joined into one mesh over iroh:

1. A new device joins by scanning a QR code or pasting a text code. Servers
   (CLI), desktop/web and mobile can all show the invite.
2. The member list spreads by itself; any member can remove another; every
   member shows who is in, whether they answer, their version and access.
3. Members delegate to each other without link cards.
4. A client sees every machine in the mesh through its local server, and
   thread links to other machines open.
5. The mesh survives address, network and version changes.
6. Access per member is _full_ or _read-only_; read-only can expire (1 h,
   1 day, 7 days or never; read-only defaults to 1 h).
7. Phones: the Termux forwarder can fetch its config from the mesh; the fork's
   own Android app embeds iroh.

## Decision

### Identity: the iroh key

A member is identified by an ed25519 key. For a server it is the iroh secret
key it already keeps in its secret store (`iroh-secret-key`); the member id is
its iroh endpoint id (the hex public key). A phone running the fork's app
creates its own iroh key. Every mesh message a member originates is signed
with that key, and iroh authenticates the same key on the wire, so "who sent
this" and "who is this connection" are one fact.

### Membership: signed records, last writer wins

Each server keeps the whole member list in `mesh_members`, next to
`mesh_meta` and `mesh_invites`. The mesh service creates these tables itself
(`CREATE TABLE IF NOT EXISTS`) instead of adding a migration: upstream
migrations are numbered and skipped by the highest recorded id, so a fork
migration would collide with the next upstream one. A record is

```
{ v: 1, meshId, id, kind: "server" | "client", label,
  access: "full" | "read-only", accessExpiresAt: ISO | null,
  environmentId: string | null, ticket: string | null,
  removed: boolean, rev: number, signer: id, sig }
```

`sig` is the signer's ed25519 signature over the canonical JSON of the other
fields. `rev` is a millisecond timestamp, kept monotonic per record. The
higher `rev` wins; equal revs keep the stored record.

A server accepts a record from another member only when:

- the signer is a _full_, unexpired, unremoved member it already knows; or
- the signer is the record's own member, the member is known and not
  removed, and `kind`, `access`, `accessExpiresAt` and `removed` are
  unchanged (self-updates of label, ticket and environment id), or it only
  sets `removed` (leaving).

A joiner trusts the inviter's whole list once, because the invite reached it
out of band and iroh authenticates the inviter's key.

There is no mesh-wide authority and no consensus. Two full members changing
the same record at the same moment resolve by `rev`. A removed member's
record stays as a tombstone so stale gossip cannot bring it back; inviting
the same key again writes a newer record.

A removed member learns of it the next time it asks anyone for a session:
the refusal (`reason: "removed"`) carries the signed tombstone, which the
member checks like any record, and then it leaves the mesh on its own.

Full members can invite, change access and remove anyone. Read-only members
can see the mesh and leave it, nothing else. A member whose read-only access
expired stays listed as expired; it gets no new sessions and any full member
can remove it.

Accepting a friend's server as a member gives the mesh access to that server
too, at the access the friend's server grants (full): joining is the friend's
choice. The owner's machines all trust each other fully, so taking over one
full member takes over the mesh. That is the same trust the owner already
gives a paired desktop.

### Invites

A full server member creates an invite (`POST /api/mesh/invites`, or
`t3 mesh invite`). It stores a one-time code (hashed, 15 minutes) with the
access and duration chosen. The invite text is

```
t3mesh:<base64url JSON { v: 1, m: meshId, n: inviterId, e: environmentId,
                          l: label, t: inviterTicket, c: code }>
```

and the QR code holds `t3code://mesh?invite=<that text>` so a phone camera
opens the app. Pasting either form works. Desktop, web and mobile show the
invite their server created; a phone asks one of its servers for an invite.

Creating the first invite on a server outside any mesh founds a mesh with
that server as its first full member.

### Joining

The joiner dials the inviter's ticket over iroh and calls the inviter's
unauthenticated `POST /api/mesh/peer/join` with the code, its own record
fields and a signature over the code with its key. The inviter spends the
code, writes the joiner's record signed by itself (access from the invite;
read-only expiry counts from now), and answers with every record, the relay
URL and its token. Every member gets the token, read-only ones too: an
endpoint is reached only through its home relay, so a member without it
could not reach a server homed on the mesh relay off the LAN, and the relay
only carries end-to-end encrypted packets between endpoints that each check
the member list. The invite carries the relay as well (`r`), since a joiner
off the inviter's network has no other way to reach it; whoever holds an
invite may join anyway, so the token in it guards nothing more. A server joins through its local API (`t3 mesh join`, or
Settings → Mesh → Join); the phone app joins directly through its embedded
iroh.

### Sessions between members

A member asks another for a session with a signed, short-lived assertion
(`POST /api/mesh/peer/session`: member id, audience environment id, time,
nonce, purpose, and optionally its own record for a peer that has not heard of
it yet). The peer checks the record and issues an ordinary bearer session
with subject `mesh:<id>:<purpose>` (24 hours, capped at the read-only expiry),
revoking the member's previous session for that purpose:

- `client`: the scopes for the member's access. Full is the standard client
  scope set; read-only is `orchestration:read`, `filesystem:read`,
  `terminal:read` and `diagnostics:read` (new `AuthMeshReadOnlyScopes` in
  contracts).
- `sync`: `orchestration:read`, used for gossip.

For delegation the peer issues an MCP session (`issueMcpClientSession`,
`peerLink: true`, `full-access` for a full member, `read-only` otherwise), and
the member stores it as a peer link through `PeerLinks.adopt`. Mesh peers
therefore appear wherever linked environments do (`t3_environment_links`,
`delegate_task`), with no pairing code. A mesh with members counts as
Linked environments being on.

Session tokens are kept in memory and fetched again after a restart, so no
long-lived credential for another machine is stored, except the peer link's
MCP token, which `PeerLinks` already keeps in the secret store.

Removing a member revokes every session it holds here, unlinks its peer link
and closes its forward.

### Gossip

Each server runs `MeshSync`, a background fiber next to `RemoteDelegation`.
Every 20 seconds, and at once after a local change, it visits every other
server member concurrently: keep the iroh forward open, read the descriptor
(label, version: status), ensure a sync session, and exchange records
(`POST /api/mesh/peer/sync`: send all, receive all, merge both ways). It also
re-signs its own record when its ticket, label or environment id changed. A
member that answers is "online" with its version and last-seen time; phones
are last seen when they last synced.

### Reaching members: one forward per endpoint

`IrohTunnels.forward` now keys its loopback forward by endpoint id instead of
by ticket, and later tickets update the address used for new connections, so
a member keeps one stable loopback port while its addresses change. A stream
that cannot open within a few seconds drops the connection and redials,
which covers a path that died without iroh noticing (network switch).

### Clients see every member

`GET /api/mesh/connections` (needs `orchestration:operate`) returns, per
other server member, its environment id, label, `http://127.0.0.1:<forward>`
and a client session token there. The web/desktop platform connection source
adds these as platform-owned bearer environments when its primary is on
loopback (the forwards are this machine's), so every mesh machine shows in
the sidebar and remote thread links open. Hosted or remote browsers do not get
them: the forward is not theirs to reach.

The phone app does the same with its own iroh: its native module keeps a
loopback forward per server member and the app registers them with session
tokens from its own signed assertions.

### Mobile: the fork's own Android app with iroh

`apps/mobile` builds as `no.lyseren.t3code` ("T3 Code iroh") with
`APP_VARIANT=iroh`, signed by a fork key, installed beside the Play app. A
small Rust library (`apps/mobile/modules/t3-iroh/rust`, iroh 1.x, JNI) does
four things: start an endpoint with the mesh relay (and n0 as fallback),
sign bytes with the phone's key, open loopback forwards speaking the
server's tunnel protocol (ALPN `DUMBPIPEV0`, `hello` first), and report
network changes to iroh. An Expo module wraps it. `httpBaseUrl` stays
`http://127.0.0.1:<port>`, so the rest of the app is unchanged.

The phone is a member of kind `client`: it has no server, so it joins with
`POST /api/mesh/peer/join` over a forward to the inviter, keeps the member
list in SecureStore, and asks each server member for its own client session
(`/api/mesh/peer/session`, renewed an hour before it ends). Every 30 seconds
while the app is in front, and shortly after a network change, it checks each
server (`/.well-known/t3/environment` for the version, iroh for the path) and
syncs records with the first that answers. Removing a member or changing its
access, the phone signs the new record itself and hands it over with
`peerSync`; leaving is a tombstone it signs for itself. Invites come from a
server it reaches. The reachable servers enter the connection catalog as
platform registrations (`mesh:<memberId>`), so their threads show and open as
on the desktop.

An app sandbox can read neither `/proc/net/route` nor routes through `ip`, so
iroh's netwatch never learns the default route on Android and waits its full
five seconds before it drops paths after a network change: switching from
wifi to mobile data cut every forward for about five seconds. The module
vendors netwatch with one addition, a default interface the app sets from
`ConnectivityManager` (`LinkProperties.getInterfaceName()`) on each change.
With it the switch costs one slow request (about a second) and no failures.
Drop the vendored copy once netwatch learns this itself.

#### Relay outage and dead paths

When the mesh relay goes down, every member swaps it for n0's public relays
and swaps back once it answers `/ping` again. Server and phone both check
every five seconds. A server swaps on one failed ping (three-second timeout),
while the phone waits for two failures in a row, because a single lost ping is
common on mobile data. The swap removes the dead relay from the map instead of
only adding n0's. iroh picks a new home relay at once only when its home
leaves the map. Merely adding relays waits for the next net report, about 20
seconds, and nobody can reach the member during that time.

The phone keeps its QUIC connections short-lived when silent. It sends
keep-alives every 2 seconds and uses a 10-second idle timeout; the lower side's
value applies, so this also covers phone↔server. The phone also closes any
connection that has had no ACK from the peer for 4 seconds, two keep-alives,
and redials on the next stream. ACKs count, not received datagrams, because the
peer's own keep-alives can still arrive over a path that cannot carry our
packets back. A redial that offers the peer's address plus all of n0's relays
connects in well under a second. A dial that does not finish within 4 seconds
is retried.

Measured on a Pixel on mobile data with two servers, the real relay stopped
for a minute:

|                                     | Outage     |
| ----------------------------------- | ---------- |
| Before these changes                | 18 to 29 s |
| Swap-in only plus 10-second idle    | 8.7 s      |
| With the silence check              | 0 to 2.8 s |
| Wifi to data or back, four switches | 0 s        |
| Wifi to data or back, worst seen    | 0.8 s      |

The Node binding (`@number0/iroh` 1.2.0) has no transport options and no
connection stats. Server↔server connections therefore keep iroh's 30-second
idle timeout, and a server that loses a peer redials within that time.

### Termux forwarder

`GET /api/mesh/forward-config` returns the forwarder's `forward.json` built
from the member list (each server member keeps a stable port from 4773 up),
and `t3 mesh forward-config` prints it.

### CLI

`t3 mesh invite [--read-only] [--for 1h|1d|7d|never]`, `t3 mesh join
<invite>`, `t3 mesh list`, `t3 mesh access <member> full|read-only [--for]`,
`t3 mesh remove <member>`, `t3 mesh leave`, `t3 mesh forward-config`. Each
mints a short session in-process and calls the running server, like
`t3 thread`. `invite` prints a terminal QR code.

## Consequences

- No pairing per machine; one invite per new device.
- Every server stores every member's public record; nothing secret is
  replicated except the relay token, which every member receives. Taking
  relay access away from a removed member means a new relay token.
- The mesh needs the server to listen over iroh. Joining or founding a mesh
  starts listening even without `--iroh`.
- Upstream changes to auth, the connection catalog and the mobile app can
  conflict with this code when the fork rebases. The mesh code stays in its
  own modules (`apps/server/src/mesh`, `packages/contracts/src/mesh.ts`,
  `apps/web/src/components/settings/MeshSettings.tsx`, the mobile module) and
  touches shared code only at a few seams.
- Clock skew larger than five minutes breaks session assertions; the error
  says so.
