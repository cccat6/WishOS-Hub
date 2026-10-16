# Connectivity and execution placement

Discover resources and schemas on the current boot. Native drivers are compiled once;
application behavior is loaded as Lua + JSON UI + assets. TypeScript/JavaScript service
modules execute on the host. The device does not advertise a local JS/TS engine.

For saved Wi-Fi profiles, priorities, manual overrides, AP settings and independent BLE startup configuration, read [wireless configuration](wireless-config.md).

## Boot radio selection

`/sys/radio read` returns `active_protocol`, `configured_protocol`, and `reboot_required`.
`write {"protocol":"thread"}` (or `zigbee`/`off`) persists the next boot's selection.
The single image contains both native stacks; only the selected 802.15.4 driver is
registered. Stop storage/network services, finish display/recording work, then use
`/sys/power reboot` to apply selection. Changing the setting never retargets an active
interrupt callback. BLE and Wi-Fi have separate lifecycles.

Thread `start`/`stop` run asynchronously with `operation_id` and operation_completed/operation_failed receipts. Its status snapshot remains readable during initialization/teardown. `start` accepts active Operational Dataset TLVs as `dataset_hex`; omit it only
to resume an existing dataset. `read` returns role and IPv6 address; `stop` deinitializes.
Use `/net/udp` with IPv6 for datagrams. Thread membership supplies a network, not an
ecosystem account or application protocol implementation.

Zigbee `start` selects router/coordinator, endpoint, profile and channel mask. `send`
accepts short `address`, destination `endpoint`, `profile`, `cluster` and `hex` APS
payload. Set `consume_aps:true` when application code owns processing of its configured endpoint/profile; the default mirrors packets to the app while retaining SDK processing. `packet` reports incoming APS data; `tx_status` is a delivery receipt, distinct
from remote application success. `permit_join {seconds}` is explicit. `pause/resume`
pause the SDK task; complete release/reconfiguration requires reboot in this SDK.
No ecosystem adapter, account login or vendor appliance schema is built into the driver.

## Network interfaces

- `/net/http request`: bounded inline text response, or `stream:true` with a configurable
  `response_limit`; `receive` drains 512-byte hex chunks. Subscribe to `readable` and
  completion/failure events. The current adapter retains one job and its response
  until `release` or owner exit; a new request returns `network_result_pending`
  rather than overwriting an unread result. Pass its `job_id` to `receive`, `cancel`
  and `release`, and to `read` when reading a specific result. A stale ID cannot
  operate on a replacement. A full chunk queue applies backpressure; unattended
  streams can time out. Buffered responses too large to embed set `body_requires_receive`; read them with `receive {job_id,offset,length}` (up to 512 bytes) and follow `next_offset`. `cancel` requests cooperative termination; `release`
  rejects a running task and explicitly discards remaining response data. A script exit cancels its own request and releases it only after task exit. Blocking connection/TLS work can still last until its configured timeout. HTTPS takes `ca_pem`.
- `/net/tcp status/listen/connect/read/write/close`: four nonblocking IPv4 socket slots.
  `connect` takes a numeric `address`; DNS names are supported by HTTP/WS clients.
  `status` is side-effect-free; `read {id}` consumes stream bytes.
  `accepted`, `connected`, `readable`, `closed` and `failed` announce state. Binary
  data uses hex, in chunks up to 1024 bytes. Honor partial writes and `would_block`.
- `/net/udp open/send/receive/close`: numeric IPv4 or IPv6, bounded datagrams. Thread
  uses IPv6. Inspect packet source address/port and consume the readable notification.
- `/net/ws connect/send/receive/close`: WS/WSS client, bounded messages. Configure
  host/port/path, TLS CA and reconnect interval. Peer verification defaults to enabled; `verify_peer:false` explicitly selects encrypted transport without certificate authentication. DNS/TLS/reconnect run on a native
  transport task. Connect has a `connection_id`; queued sends have a `message_id`
  and a sent/send_failed completion. Close is requested immediately and reaches
  `closed` after the transport task exits. Consume the queue and observe drops.
- `/net/http-server route`: install GET/POST/PUT/DELETE routes at `/` or below `/app/`, either
  static responses or `dynamic:true`. Dynamic requests return HTTP 202 with an ID,
  emit `request`, and can be read/responded/released through this resource. Clients
  retrieve the response via `/os/invoke`. Six routes/four requests, 2048-byte bodies.
  `stop` removes routes/requests. This shares the existing HTTP listener on port 80.
  An app-owned GET `/` replaces the default management page while that application
  runs; stopping/replacing it restores the package page if no replacement route is
  registered. `/os/*` remains reserved for system transport. Larger pages can load
  additional app routes/resources; the bounded text-response limit still applies.
- `/dev/wifi scan_start/scan_results/scan_clear`: async scan with result paging.
  Existing connection, TX-power and modem-sleep interfaces remain available.

## BLE

`/dev/ble start`, `restart` and `stop` return operation IDs and complete on the native lifecycle worker. Use `notes.request` before depending on the new service. `start` supports `mode:"gatt"`, `"hid"`, or `"central"`.
GATT accepts a service UUID and up to four `{uuid,properties}` characteristics;
property bits are READ=2, WRITE=8, NOTIFY=16. `write` sets a characteristic index and
optionally notifies. Incoming writes generate events.
HID accepts `report_map_hex`; applications own the report layout and button mapping.
Input report IDs 1..4 map to indices 0..3. Send a release report as well as a press.
The presenter example is application code, not a fixed board-button behavior.
Central mode provides bounded `scan`/`scan_results`/`scan_stop`, and takes an address/type in `connect`; `gatt_read`, `gatt_write`, and
`subscribe` take service/characteristic UUIDs. These run asynchronously and report
operation events. Stop only after the operation finishes. Pairing/peer behavior and
radio coexistence need target verification; compiled does not mean paired.

## Local programs and remote work

Use local timers, conditions, networking, parsing, rendering and button rules for
repeatable behavior. Do not invoke a Harness on every timer tick just to fetch a URL.
Lua accesses the same resource ABI with `notes.call`, subscribes to events, and loads
from a file without rebuilding firmware. Examples: `examples/agent-os/local-poll`,
`presenter`, and `remote-events`.

AI/Harness work uses `/services/ai`, as described in [managed services](managed-services.md).
Its system-owned lifetime, typed result processing and safe app activation continue
when the requesting VM exits. The lower-level `/services/remote` outbox carries
route/identity/deadline for the system bridge and ordinary non-AI service handlers;
AI applications must not recreate provider/Harness protocols around that outbox.
The outbox is volatile; reboot clears its records. Host durability does not turn a
lost device receipt into proof of physical completion.

`/services/link` configures a system control connection independently of the
loaded application. Set `enabled:true` with endpoint fields, or `enabled:false`; this is not a user work mode and does not change Wi-Fi association. The device also serves the same ABI at `/os/invoke` over HTTP.
When enabled, the connection opens WS/WSS to the configured host/port/path and serves the same
resource ABI over `wishos-rpc/1`. Read desired/applied revisions, pending activation
and actual connection separately. Configuration replaces the previous settings;
`persist:true` saves them. Application replacement does not terminate this link.

The separate Hub accepts active devices at `/os/device?id=<device_id>`. A Hub with a direct device address can use `protocol:"wishos"` and `deviceUrl`. Both attach the same
remote dispatcher and durable host journal. The Hub MCP at `/mcp` discovers
resource methods. No E6
geometry or waveform exists in the WishOS MCP contract.

The managed `wishos.ai` server route waits for the bound Harness, stages large resources and returns a typed result. Its internal voice collector invokes the selected ASR/Harness adapters; upload, Harness completion and device effect completion remain distinct. The
separate Hub owns ASR/Harness admission and its durable journal. Applications use the
system AI route rather than implementing model-provider protocols. A non-AI remote
service can implement the declared request/result protocol without invoking a model.
Use the current Hub entry points and guidance; removed Notes Monitor adapters and
old standalone bridge commands are not part of the WishOS contract. Unknown
side-effect outcomes must not be silently replayed.


Zigbee start/send carry operation IDs. A failure before starting its worker releases
admission. After the vendor SDK acquires an unreleasable cluster graph, a failed
start reports `reboot_required` and rejects repeated allocations. Pause is rejected
while an APS send is in flight so its confirmation cannot be suspended indefinitely.
