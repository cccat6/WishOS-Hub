# On-demand NFS sharing

Discover `/services/nfs` and `/sys/storage` before acting. The server exports an existing provider, not a new SD driver. Defaults are stopped; do not start it merely to discover files.

Use `/sys/config describe/read` for `/services/nfs` settings. Configure system defaults there, or pass supported overrides to `start`. Defaults apply on the next service start. Read `active`, `configured`, `configuration_pending`, address, resource usage and counters; do not infer that changed defaults reconfigured an active listener.

Example: `start {"provider":"user","export_path":"/sd","read_only":false}`. Internal `system` and volatile `ram` exports use `read_only:true`. Provider IDs come from discovery. This implementation exports one provider per session.

The current service uses NFSv3/TCP with NFS and MOUNT on the returned port; use explicit port/mountport and nolock (Linux) or nolocks (macOS). The user mounts the exported path, not the internal `/storage/user` path. Client mount points must exist.

Ask clients to unmount before `stop`. Stop sharing before a requested network disconnect/change, sleep, shutdown, SD reconfiguration or power-off. The running service pins the provider; stopped services release their session resources. Never bypass file leases to overwrite displayed assets or active recordings.

`handles_invalidated` means a local writer changed the provider and old remote identities are invalid; the client may need to remount. NFS mutations themselves retain their session. The current bridge has no atomic replacement rename or persistent exclusive-create verifier. It must not delete a destination as a substitute. ESP32NFS 1.3.0 is pinned by commit. The OS SdFat build enables UTF-8 long names; Chinese paths work over NFS and HTTP. Canonical stored spelling and filesystem-aware case comparison preserve identity and file protection. Paths containing `~` remain conservatively rejected by this bridge for mutations/NFS access; full FAT short-alias support is not advertised.

Starting an SD export may mount the configured partition and scan free-cluster metadata. Do not treat this as a cheap presence probe. Use `/dev/sd probe` for content-independent link discovery. Monitor actual free heap and input/recording progress; throughput and hard real-time latency require target measurements.

Memory is shared between the session protocol buffers and dynamic path identities.
Defaults: `memory_max_bytes:65536`, `heap_reserve_bytes:32768`; these are configurable
policies, not a fixed file-count limit. Use `memory` to change these two limits on an
active session without restarting; lowering below current use fails and preserves
the existing limits. These live overrides do not persist or rewrite next-start policy.
`read` reports memory used/peak/allocations/failures/reason, registry bytes and identity
count. The measured heap excludes the shared TCP/IP stack. Allocation failure may
return NFS retry status; it must not silently recycle a live file identity.

`block_size` supports 512–32768 bytes, still defaulting to 4096. Larger requests use
more RAM; network polling budget and actual storage delay remain independent. Stop
can report `nfs_stop_pending`: the listener has stopped, but final storage cleanup
has not succeeded, so the provider remains pinned. Resolve the failure and call stop
again; do not power off or report a completed stop prematurely.
