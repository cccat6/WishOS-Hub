# Optional spoken application replies

Reply selection belongs to the ordinary application, never a native driver rule:
`input.reply = {mode:"text"|"speech", voice?:"configured voice"}`. Omission means
text. Speech mode still delivers the same text. A microphone or Harness ASR
capability does not imply TTS; Codex's verified adapter currently exposes dictation,
not a verified synthesis endpoint. No provider-account credentials are repurposed.

A normal `wishos-result/2` application message may carry:

```json
{"type":"application","recipient":"origin","topic":"message","wait":"processed","data":{"text":"你好","audio":{"format":"wishos-audio/1","encoding":"ima-adpcm-block","sample_rate_hz":16000,"channels":1,"packet_bytes":331,"file":{"$asset":"reply-unique.adpcm"},"bytes":"53567","samples":"103570"}}}
```

The shown numeric values illustrate one local test, not an OS limit. Every packet
has the existing `0x42`/uint32 sequence/int16 predictor/uint8 index/reserved0/uint16
sample-count header, then two 4-bit samples per byte. Headers are 11 bytes. Full
packets hold640mono samples/331bytes; last may be shorter according to its count.
All packets independently decode. No MP3 decoder, audio-specific kernel service,
base64 model answer or device-to-model fetch is introduced. Native speaker clock/
format capabilities remain authoritative. `$asset` becomes the verified local VFS
path through the existing result resource resolver.

The ordinary player retains text, reads bounded packets with current public file
methods, writes to the public speaker, handles backpressure/completion/cancel, and
acknowledges the application action after playback/explicit cancellation. Task
leases cover the media until that acknowledgement. Home/VM exit/cancel use system
resource retirement; an exited script cannot own the only cleanup path.

## User-host configuration

Connector config adds `tts`, default disabled. The browser's existing speech tab
has a separate spoken-reply card. Local setup API:

```json
{"settings":{"source":"macos-say","voice":"Tingting","timeoutMs":60000,"maxTextBytes":12000,"maxAudioBytes":16777216}}
```

POST to `/setup/api/tts` with the existing local setup cookie/origin protection.
Sources: `disabled`, `macos-say`, `openai-compatible`. An online service example:

```json
{"settings":{"source":"openai-compatible","online":{"url":"https://your-service/v1/audio/speech","model":"your-model","voice":"your-voice"}},"token":"your-local-provider-token"}
```

The URL/model/voice are user choices, not an available-service claim. Compatible
protocol requests `{model,voice,input,response_format:"wav"}` and bounded PCM16
WAV output, resampled on the Host to mono16kHz before independent ADPCM encoding.
HTTP errors preserve only status codes, never arbitrary provider bodies. Redirects
are rejected so Authorization is not forwarded elsewhere. Cancellation/deadlines
cover synthesis, reads and conversion. The macOS adapter runs `/usr/bin/say`
without a shell, using a private temporary input/output directory, then removes it.
It uses the user's installed voices, not a downloaded model. Missing voices or
unsupported platform are explicit optional-media failures.

Tokens go only into existing user-host LocalSecrets; config exports retain tokenRef
or tokenEnv, never a value. A user-owned Hub can resolve its own environment secret.
WishOS public relay/server does not collect model keys or authoritative sessions.
No currently configured native Harness has been advertised as a TTS provider.

## Explicit temporary transfer target

Only pure message actions without existing files/sequence/system operations are
currently enriched. Mixed application packages/persistent resources retain their
original assets/actions and normal routing, with `audio_error` describing that
optional media restriction. No multi-transfer envelope is added in this scope.

Before synthesis/transfer the Host discovers speaker format and:

```json
{"begin_options":{"provider":{"type":"string","selection":"declared_policy_target"},"lifetime":{"type":"string","choices":["retained","request"],"default":"retained"}}}
```

It chooses an available nonpersistent target already admitted in `policy.targets`
and checks capacity/quota. Begin includes explicit provider plus `lifetime:"request"`
and the original remote_request_id. The target identity and lifetime enter the
transfer request digest; native validation remains authoritative. Ordinary automatic
storage selection skips `explicit_only` targets, so a RAM entry appended to the
policy cannot divert application installs. Neither global policy changes nor
fallback to internal Flash are performed for speech. Undeclared extensions,
missing RAM and quota refusal leave text plus a bounded `audio_error.code`.

Synthesis artifacts are pinned during the cached managed-result preparation and
normal chunked hash-verified transfer. After admission, AssetTransfers owns pending
media by the remote request, then AgentService adopts temporary ownership. Final
ACK/exit/cancel retires it while honoring read leases. If a begin/chunk/commit reply
is uncertain, Host does not replay that side effect: it returns text plus
`tts_delivery_uncertain`; terminal cancellation/retirement of that exact remote
request also cleans an unadopted transaction even without a returned transfer ID.

## Validation boundaries

Host tests cover codec blocks, configured HTTP responses, admitted RAM targets,
quota/unknown delivery and text preservation. Native acceptance separately checks
speaker drain, processed acknowledgement, Home/cancel and request-lifetime cleanup.
Known synthesized acoustic input and human voice/gesture/quality testing are
separate scopes. The compatible online endpoint still needs the user's own service
configuration and authorization.

Protocol reference: [OpenAI speech generation](https://developers.openai.com/api/docs/guides/text-to-speech).
This reference defines a compatible request format, not access through a Codex subscription.
