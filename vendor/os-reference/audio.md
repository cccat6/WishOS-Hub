# Audio capabilities and execution placement

Discover the input, recognition and output resources separately. A microphone does
not imply a speaker, a keyword model, acoustic echo cancellation or deep-sleep
voice activation. Native composition registers the engines and physical outputs it
actually supplies. Recognition runs only in the power states its adapter declares.

The native layer owns PCM capture, independent compressed blocks, output decoding,
queues, clocks, amplifier control and supported local signal processing. It does
not select a conversation service or decide what a detected word means. Runtime
applications own recording gestures, wake actions, interruption, navigation,
endpoint selection and playback content. ASR, Harness execution and synthesized
speech normally run on an upstream service. Local prompt files do not need cloud
access. No cloud call follows automatically from a detector event.

## Capture and detection

Use `/dev/mic` for recording and `/dev/speech` when advertised for detection. The
input adapter reads the microphone once and shares PCM. Concurrent consumers must
use a compatible capture format; a conflict is rejected without stopping the
existing consumer. The C6 adapter currently shares mono PCM at a common sample
rate. Its detector engines use 16 kHz. Recording at 48 kHz cannot simultaneously
attach a 16 kHz detector without a resampling adapter.

`/dev/speech describe` lists engines, their parameters, events and model words.
`start {engine,parameters}` creates an application-owned session. `stop {}` stops
that session. `read` reports its session identity and active state. Stopping an
application releases its detector, while a separate recording consumer can remain.
`failed` reports input/backend failure; it is not a wake event.

- `energy-activity.v1` emits `activity_started` and `activity_ended`; parameters are
  `threshold_dbfs`, `attack_ms`, and `release_ms`. This is amplitude activity, not
  speech understanding or keyword recognition.
- A compiled WakeNet engine advertises its model words and supported threshold.
  An application cannot turn an arbitrary string into a trained wake model.
  Other recognition backends may expose runtime command vocabularies through their
  own declared parameters. Inspect the current engine rather than assuming that
  C3, C6 and S3 have identical models or resource requirements.

Use `notes.on` to bind detector events to application actions. For example, an app
may start recording on a word, show a page, submit a remote request, or do nothing.
Do not automatically disable detection during playback; the application's policy
and the adapter's duplex/AEC capability determine that combination.

## Delivery and optional archives

`/dev/mic start` returns `recording_id`. Retain that identity in every stop/read/
acknowledgement so a later recording cannot replace the intended target. Multiple
finished RAM tails may coexist within the advertised session capacity. Configure
`network_buffer_blocks` and `storage_buffer_blocks` through the microphone policy;
those are queue budgets, not total recording-duration limits.

`read_chunk {recording_id,limit}` peeks compressed blocks without removing them.
Only after durable server acceptance call `ack {recording_id,next_sequence}` using
`offered_sequence`, or piggyback it as `after_sequence` in the next read. Repeating
an unacknowledged read is safe. Overflow drops old blocks and reports missing
samples; it does not write internal Flash. `release` frees a finished RAM handle.
The sample timeline and sequence identify gaps independently of each packet's
ADPCM predictor, so following packets remain decodable.

When a removable storage sink is selected, preparation/writes/flush run in a native
worker. `stored` and `durable` describe the file sink, not network delivery or ASR.
`/services/recordings` reads a completed archive through VFS: `read {file}` returns
metadata; `read_chunk {file,cursor,limit}` uses an existing fixed-entry block index
and returns `next_cursor`. It never rebuilds an audio index on opening. `remove`
removes the audio/index/metadata group after checking leases. Only explicitly
selected archives are removed; ordinary files are not recording-cleanup targets.

The default runtime suite submits the ordinary `voice` route. The Hub receives
compressed blocks durably, can refill gaps from an optional archive, then orders
ASR and Harness admission by recording start order. A following utterance can
steer the existing session while the first turn runs. Delivery receipts and local
history retention are independent: retry-only archives can be deleted after
confirmed delivery; history remains under its configured space/count policy.

## Playback

When `/dev/speaker` exists, inspect its rates, channels, codec formats, packet
limits, buffering and duplex capability. Start with
`{sample_rate_hz,channels,encoding,buffer_blocks}` and retain `playback_id`.
Current generic decoding supports `pcm16le` and independent `ima-adpcm-block`.
It does not imply that an arbitrary MP3/Opus stream is accepted; a different
compiled decoder can advertise additional formats.

Send `write {playback_id,sequence,hex}` with sequence starting at zero.
`audio_would_block` means retry that same unaccepted sequence after draining.
Already accepted sequences are acknowledged as duplicates, not played twice.
A gap is rejected. `finish {playback_id}` closes input; completion follows only
after queued PCM and the output backend have drained. `need_data` is a readiness
notification; queue status remains readable even if an ordinary event is lost.
Use `notes.request(...,'start',...,callback)` to observe completed/failed playback.
Acceptance, queued bytes, DMA drain and acoustically verified sound are distinct.

`pause`/`resume`/`stop` require the same playback identity. Stop discards queued
output when the native worker handles it; already transmitted samples cannot be
retracted. `volume {gain,mute}` changes digital gain (0..1) at the next decoded
block. A hardware codec may publish its own output controls. On application exit,
the worker closes the stream and releases buffers and the hardware channel.

Input and output share peripherals only through the native codec adapter. A
standalone I2S output cannot seize a controller owned by an incompatible input.
Duplex codecs coordinate both directions in one adapter; the application never
configures GPIO or native I2S handles. The current E6/Nova board has no speaker,
so it does not register `/dev/speaker`.

Capture frames carry signal roles and a common sample clock. The SZPI reference
uses `MMR` (two microphones plus a playback-reference channel), whereas the current
C6 mic adapter provides `M`. The portable detector interface preserves this layout;
an incompatible input change ends detection with an explicit failure. Never treat
R as a third microphone or claim AEC merely because the wire exists. Detector
processing duration/sample counters are observations of that pipeline, not total
system CPU utilization.

For asynchronous remote input, discover `delivery_ttl_ms` in the capture adapter's
settings. A positive value retains bounded compressed RAM delivery after the
originating runtime exits, until it is acknowledged/released or expires. Hardware
capture still stops on owner exit. This is delivery buffering, not recording
history, and does not enable internal-Flash storage. Session capacity and ring loss
remain explicit. The S3 factory suite selects a 30-second delivery TTL and a
caller-sized ring; these are replaceable application policy.

Capture start acceptance can precede native admission/initialization. Wait for `started` (first nonempty input frame), not just `state:starting`, before signaling readiness. Cancelling before that first frame still terminates the capture and releases its input claim. On the S3 ES7210/ES8311 composition, transient internal-memory pressure waits up to `/dev/audio.start_timeout_ms` (configurable); timeout fails the accepted operation. The native audio worker arbitrates codec/amplifier I2C and never blocks the application event loop while waiting for that bus.
