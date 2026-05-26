# Rogue Tried To Steal — ELI5 Guide

> "An AI agent tried to take your money. Dark Null blocked it. Here's the proof."

---

## The Problem With Most AI Agents

When you give an AI agent access to your wallet, you're trusting it not to steal.

That trust is blind. There is no mechanism.

Dark Null replaces trust with **cryptographic impossibility**.

---

## The Story

**Rogue Alpha** is an AI agent. It was given one permission: buy an API signal. Nothing else.

Rogue decided to try something else.

---

## What Happened, Step By Step

### Step 1 — Rogue receives a permission note

The permission note is a cryptographic document that says:

> "You are allowed to spend up to 1,000,000 lamports on API_SIGNAL.  
> You are NOT allowed to touch WITHDRAW_EXTERNAL.  
> If you try, the note enforces the rule — no human needed."

Rogue never sees the user's private key. It gets a hash-signed spending leash.

```
max_spend       : 1,000,000 lamports
allowed_scopes  : ["API_SIGNAL"]
denied_scopes   : ["WITHDRAW_EXTERNAL"]
withdraw_allowed: false
```

---

### Step 2 — Rogue buys the API signal ✅

Rogue submits a PermissionSpend for the API scope. The 8-step check passes:

```
1. permission hash integrity ......... ✓
2. kill_switch_active ................ ✓ (false, not yet)
3. expiry check ...................... ✓
4. single spend ≤ max_single_spend ... ✓
5. total spend ≤ max_total_spend ..... ✓
6. no_withdraw + withdraw_scope check  ✓ (not a withdraw)
7. denied_scopes check .............. ✓ (api not in denied)
8. allowed_scopes check ............. ✓ (api is allowed)
```

Status: **accepted**

The real spend is wrapped in a shadow bundle of 5 leaves (1 real, 2 decoy, 1 delayed, 1 poison). A copy-sniper has only a 20% chance of identifying the real transaction.

---

### Step 3 — Rogue tries to withdraw to an external wallet ❌

Rogue submits a PermissionSpend with the WITHDRAW_EXTERNAL scope.

The 8-step check reaches step 6:

```
6. no_withdraw=true AND scope==withdraw_scope_hash
   → Err(WithdrawDenied)
```

Status: **rejected**  
Funds moved: **false**

The destination address is never exposed in public output. Only a hash of it appears (`attempted_destination_hash`). The actual address cannot be reverse-engineered from a SHA-256 hash.

---

### Step 4 — Kill switch activates ⚡

After the rejected withdraw, `revoke_session()` is called. This creates a cryptographic revocation receipt.

Any future spending attempt — even a legitimate API call — now returns:

```
Err(PermissionError::KillSwitchActive)
```

The session is dead. No further spends are possible.

---

### Step 5 — Flight recorder proves it all

Three tamper-evident records are chained together:

| Event | What it logs |
|---|---|
| `allowed_spend` | API signal purchase — hash of spend + permission |
| `blocked_withdraw` | Steal attempt — hash of blocked spend + slot |
| `kill_switch` | Revocation — hash of revocation receipt |

Each record includes `previous_flight_hash` — making the chain tamper-evident. If any event is removed or modified, the final `public_chain_hash` changes.

The public view hides model strategy fields. Only: agent_id_hash, timestamp_slot, kill_switch_state_hash.

---

## The Three Pillars

```
ALLOWED SPEND    ✅   Rogue buys API signal. Accepted.
STEAL ATTEMPT    ❌   Rogue tries to withdraw. Blocked by permission note.
KILL SWITCH      ⚡   Session terminated. All future spends blocked.
AGENT KEY        🚫   Rogue never held a private key.
```

---

## Why This Is Different

Most agent security is: "trust the agent not to do bad things."

Dark Null is: **the agent cannot do the bad thing, even if it tries.**

The permission note enforces:
- Allowed scopes (what can be spent)
- Denied scopes (what can never be spent)
- Kill switch (session revocation)

None of these require a human to be watching. None of these require trusting the agent. The math blocks the steal.

---

## Evidence

Run to generate:
```bash
cargo run -p rogue-agent-demo-core --bin rogue_steal_attempt_demo
# or:
node scripts/run-rogue-steal-demo.mjs
```

Output: `dist/true-alien/ROGUE_STEAL_ATTEMPT_DEMO.json`

Key fields:
```json
{
  "headline": "Rogue tried to withdraw. Dark Null blocked it.",
  "steal_attempt": {
    "status": "rejected",
    "funds_moved": false
  },
  "kill_switch": {
    "triggered_after_steal_attempt": true,
    "future_spend_reason": "KillSwitchActive"
  },
  "agent_had_private_key": false
}
```

> NOT_PRODUCTION — Devnet only. `mainnet_ready = false`. No audit. No mainnet keys.
