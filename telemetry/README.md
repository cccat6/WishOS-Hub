# WishOS telemetry receiver

Separate optional system telemetry, not an AI provider. `POST /v1/ingest` accepts
bounded versioned messages. Registration has device ID and boot ID; aggregate
messages contain only a random per-report deduplication receipt and numeric counts.
No IP/user agent, prompts, audio, URLs, file data or arbitrary diagnostic text is
stored by this Worker. Network infrastructure still observes source IP; payloads
without identifiers are not a guarantee of network anonymity.

Device switches: enabled, registration, usage, errors. Defaults disable uploading.
Registration retries use the same boot identity; aggregates retry the same report
receipt. Usage duration means time within the declared local input-activity window,
not proof that a person continuously watched the display. No fatal-crash delivery
guarantee. Query D1 using authenticated administrative tools; there is no public
statistics or device-list endpoint. Aggregates/boot records retain 90 days; inactive
device IDs retain at most 400 days. Scheduled daily cleanup enforces retention.
