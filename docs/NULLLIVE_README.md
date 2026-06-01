# NullLive

Continuous hardware attestation for live streams.

Not a camera app. Not a deepfake detector.
A proof heartbeat: if the hardware signature stops, the badge goes dark.

---

## What it does

Every 5–30 seconds, the client signs a hash of the current frame with the device key and emits an attestation packet. Every 1–5 minutes, a batch of packets is assembled into a Merkle tree, stored permanently on Arweave via Irys, and the Merkle root is anchored on Solana via the `live_attestation` program. Viewers see a badge that reflects the freshness of the last successful anchor — it either updates or goes dark.

Verification does not require trusting our server. The chain of custody lives on-chain and on Arweave — neither can be retroactively altered. The client app, Solana RPC, and Irys/Arweave indexing are still software dependencies, but none of them can rewrite a committed anchor.

---

## Proof levels

These levels are cumulative. Each one adds a narrower claim on top of the previous one. Be precise about what each level does and does not assert.

### Level 1 — AppSigned

The stream output was signed by this application using a device-held key at capture time.

**What this proves:** This exact byte sequence existed at the claimed timestamp and has not been modified since signing. The signature is verifiable by anyone with the public key.

**What this does NOT prove:** That the bytes originated from a camera. The application could sign any bytes — a pre-recorded file, generated frames, arbitrary memory. Level 1 is a tamper-evidence seal, not a camera-origin claim.

### Level 2 — TeeCamera

The signing key is bound to a platform TEE-backed camera capture path where the OS provides that guarantee. On Android this is CameraX with a TEE-backed key; on Qualcomm devices it can be the Content Integrity framework. On iOS, Secure Enclave provides key custody — camera-path binding depends on which Apple APIs expose that guarantee; treat this as TEE key custody, not automatic camera-origin proof.

**What this proves:** The frame was captured via the OS camera subsystem and the signing key is bound to that capture path. Arbitrary in-memory injection or frame substitution from userland is prevented by the TEE boundary.

**What this does NOT prove:** That the physical scene in front of the camera is real. A physical screen replaying a recording in front of the camera would pass Level 2. Screen-recording artifacts may or may not be detectable depending on hardware.

### Level 3 — IspPhysical (research / best-effort)

ISP-level heuristics suggest the capture source is a physical scene rather than a screen recording. Signals include moiré pattern detection, PWM flicker timing, rolling shutter warp, and depth sensor variance.

**What this proves:** The ISP pipeline observed signals statistically associated with physical capture. This makes replay attacks moderately harder.

**What this does NOT prove:** Physical reality. All Level 3 signals are probabilistic heuristics. A sufficiently high-quality playback setup or adversarially modified ISP pipeline can fool them. Level 3 is a research direction, not a shipped certainty claim. Do not represent it as proof of physical reality.

---

## Badge UX

When all anchors are current and verification passes:

```
LIVE VERIFIED
Hardware attested 4s ago
Solana slot: 421,849,103
Level 2 — TEE camera path
```

Badge states:
- **Green / LIVE VERIFIED** — last anchor within 30 seconds, verification passes
- **Yellow / ATTESTATION DELAYED** — heartbeat gap > 30 seconds; stream may still be live but proof is stale
- **Dark / UNVERIFIED** — gap > 90 seconds, or signature/root verification failed, or session ended

The badge reflects the proof state, not the stream quality. A stream can be live and healthy while the badge is dark if the attestation pipeline breaks.

---

## What NullLive proves and does not prove

**It proves:**

- A specific byte sequence (frame hash) was produced at the claimed time by a device holding the registered key.
- The sequence of frames has a continuous, verifiable audit trail anchored on Solana and stored permanently on Arweave.
- If the trail breaks, the badge shows it — there is no silent gap.
- At Level 2+: the signing key is bound to the OS camera capture path, not accessible from arbitrary userland code.

**It does not prove:**

- That the content is real, truthful, or unmanipulated in meaning.
- That the person in frame is who they claim to be.
- That a physical camera is aimed at a physical scene (Level 2 does not cover this; Level 3 is a probabilistic heuristic only).
- That the device is not compromised at the OS level.
- That the stream has not been selectively edited between anchor points (frame-level granularity is the configured signing interval, not every frame in a compressed video stream).

NullLive is a provenance tool. It tells you the proof chain exists and is unbroken. What you infer about reality from that chain is your own judgment.

---

## Architecture

```
frame captured on device
  → device key signs frame hash every 5-30s (Level 1/2/3)
  → attestation packet: {
        session_id,    // hex32 — unique per stream session
        frame_hash,    // hex32 — SHA-256 of frame bytes
        frame_index,
        capture_ts,    // unix seconds
        device_pubkey, // base58
        streamer_pubkey,
        attestation_level,
        signature      // base58 — device key signs frame_hash
      }

every 1-5 min:
  → batch packets into Merkle tree (SHA-256 leaf hashes)
  → store full batch JSON on Arweave via Irys (permanent, content-addressed)
  → anchor Merkle root on Solana live_attestation program
       - instruction: AnchorAttestation
       - data: session_id | merkle_root | batch_start_ts | batch_end_ts |
               frame_count | storage_uri_hash (4 bytes of Arweave tx ID)
  → badge updates via PDA poll or websocket

viewer verification:
  → fetch latest StreamSession PDA from Solana (indexed by session_id)
  → check merkle_root freshness vs. current slot
  → optionally fetch Arweave batch and re-verify individual packet signatures
  → display badge level and age
```

---

## Solana program schema

Program: `live_attestation` (part of the DNA x402 / Parad0x Labs on-chain suite)

### StartStream (66 bytes total: 1 discriminant + 65 data)

Creates a `StreamSession` PDA for the session. Called once at stream start.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `session_id` | `[u8; 32]` | 32 | Unique per stream, chosen by client |
| `device_pubkey` | `[u8; 32]` | 32 | Public key of the attesting device |
| `attestation_level` | `u8` | 1 | 1, 2, or 3 |

### AnchorAttestation (89 bytes total: 1 discriminant + 88 data)

Updates the session PDA with the latest Merkle root. Called every batch interval.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `session_id` | `[u8; 32]` | 32 | Must match existing PDA |
| `merkle_root` | `[u8; 32]` | 32 | Root of this batch's Merkle tree |
| `batch_start_ts` | `u32` | 4 | Unix seconds |
| `batch_end_ts` | `u32` | 4 | Unix seconds |
| `frame_count` | `u32` | 4 | Number of packets in this batch |
| `storage_uri_hash` | `[u8; 4]` | 4 | First 4 bytes of Arweave tx ID |
| *(padding)* | | 8 | Alignment to 88 bytes |

### EndStream (33 bytes total: 1 discriminant + 32 data)

Marks the session ended. After this, no further anchors are accepted.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `session_id` | `[u8; 32]` | 32 | Session to close |

---

## Use cases

**Streamers** — provide verifiable evidence that a live stream was produced by a real device with a continuous proof trail. Useful for streamers whose audience questions whether content is live or AI-generated.

**Public figures** — AMAs, press conferences, and live Q&As can attach a proof trail. A viewer can verify the session started at a specific Solana slot and ran continuously.

**Journalists** — field footage can carry an unbroken attestation trail from capture to publication. The trail does not prove what the footage depicts is true; it proves the footage was not silently recut or inserted after the fact.

**Exchanges and projects** — live token announcements, audit readouts, or governance votes carry an on-chain timestamp and attestation chain. Forgery requires compromising both the device key and rewriting Arweave and Solana simultaneously.

**Platforms** — display a "hardware attested" badge alongside existing live indicators. The badge reflects the actual proof state; it goes dark automatically if the stream client stops attesting.

---

## Research: Hardware Capture Provenance

The following is active research and is not a current shipping claim.

**Qualcomm Snapdragon Content Integrity** signs image data at the ISP level before it reaches the application processor's userland. If this signing path becomes widely accessible, Level 3 attestation could include an ISP-origin certificate alongside the TEE signature. This would make replay attacks require defeating hardware at two separate silicon boundaries.

**Screen artifact detection** — physical camera capture of a real scene produces signals that are difficult to replicate from a screen playback:
- Moiré patterns from LCD/OLED subpixel grids
- PWM flicker timing at display refresh frequency
- Rolling shutter warp inconsistent with display frame timing
- Depth sensor variance that a flat screen cannot replicate

These signals are statistical. They are meaningful in aggregate and degrade gracefully as display technology improves. They are not a hard boundary. The research direction is to include ISP-level heuristic outputs as part of the Level 3 attestation packet, with explicit confidence scores rather than a binary claim.

**Current status:** Level 3 is defined in the SDK enum and program for forward compatibility. It is not currently emitted by any shipping client. Do not market Level 3 as a current feature.

---

## Built on

- **x402** — payment rail for attestation fees
- **Liquefy** — receipt infrastructure
- **Arweave / Irys** — permanent batch storage
- **Solana** — `receipt_anchor` + `live_attestation` on-chain programs
- **$NULL** — protocol token

---

## Monetization

Anchoring a batch to the Solana `live_attestation` program costs a small amount of $NULL, paid by the streamer's client. The fee is per anchor, not per viewer. Verification is always free — any viewer can read the PDA and check the Arweave data at no cost. The protocol earns on creation; it does not charge for reads.

This means a streamer with a large audience pays a flat, predictable cost regardless of viewer count. Platforms integrating the badge pay nothing to display it.
