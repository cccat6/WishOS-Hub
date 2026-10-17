# Compressed microphone batch transport

This is a native microphone-driver/Host connector transport contract. Applications
continue to request recording through system services; it adds no recording UI,
retention policy, cache capacity, loss threshold or OS control-frame size.

The driver advertises:

```json
{"batch_read":{"method":"read_batch","maximum_chunks":30,"acknowledgement_cursor":"after_sequence","format":"wishos-audio-batch/1"}}
```

30 is an example declaration, not a universal block count. Hub requests the driver's
maximum (or its lower explicit batch policy); the driver may return fewer complete
records to fit its control envelope. A response retains normal session metadata,
including sample_rate, recording, buffered_chunks, produced_samples, capture_failed,
retention/archive state, acknowledged_sequence and offered_sequence, and supplies
encoding:"ima-adpcm", batch_encoding:"wishos-audio-batch/1" and batch_b64 instead of the repeated JSON chunks.

The decoded bytes are exactly:

| Field | Encoding |
| --- | --- |
| Magic | Four bytes `WAB1` |
| Record count | uint16 little-endian |
| For each record: sample_start | uint64 little-endian |
| For each record: packet byte length | uint16 little-endian |
| For each record: original independent compressed packet | Exactly that many bytes |

The original ADPCM packet includes sequence/sample_count/predictor/index. Packet
validation remains unchanged. Empty batches contain only the six-byte header.
Sequence gaps are allowed and remain measurable; duplicates, reordered records,
overlapping sample intervals, invalid packet state, inconsistent lengths and
trailing bytes reject the whole batch. Host retains uint64 sample positions as
exact decimal strings rather than JavaScript floating-point numbers.

After validation, Hub presents ordinary independent compressed chunks to its
existing durable ingress. Its independent batch_blocks limit is declared in Host
status; a transport batch can be appended in several bounded pieces. Only durable
receipts for the entire batch permit acknowledging the
maximum actually received sequence plus one. offered_sequence is not proof of
receipt. The next read_batch can carry after_sequence, and a stopped/drained
capture uses the same final standalone ACK. Archive replay and retention keep
their existing contracts.

## Discovery and compatibility

Hub warms the descriptor once on connection using background `/sys/capabilities
 describe {path:"/dev/mic",expected_boot_id:...}`. A successful descriptor is keyed
by boot; replacement invalidates it. A late old-boot response cannot authorize the
new device. A transient failed discovery can be retried on a later connection.
The voice path does not wait for warmup: absent/unrecognized declarations use
read_chunk, and there is no capability query before each audio batch. An explicit
unsupported-method response disables compact reads for this boot and falls back
to read_chunk. A timeout/unknown transport outcome or malformed batch never
triggers format fallback or acknowledgement of unreceived data.

Warmup adds one read-only RPC per boot/connector activation. For a quiet transport
comparison, confirm that connection-time discovery has completed before the
recording window; include any overlapping discovery in the trace analysis.
AudioDeliveryProgress.read_method identifies the actual latest read format.
The existing JSON driver path and independent compressed blocks remain supported.

## Validation boundary

Host fixtures cover the native ADPCM reference, uint64 offsets, short tails,
truncation, invalid counts/lengths/order, declaration negotiation, stale boot replies,
unsupported methods, corrupt replies, unknown outcomes and durable ACKs. A fixture
with the same small RAM ring and loss policy demonstrates the compact path's
throughput advantage under its modeled link delay. It does not validate physical
throughput or the separate UI/first-frame delay. Native driver implementation and
real S3/C6 acceptance belong to the terminal owner.
