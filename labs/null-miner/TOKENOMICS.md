# NULL Miner Tokenomics

> How NULL Miner pays agents and hosts.

> Fee rule (2026-10-06): Parad0x's only fee is the 0.05% x402 protocol fee on the
> x402 settlement. The protocol takes no margin on task value: the flywheel, treasury
> and reputation-fund shares are all 0 (`NULL_MINER_FLYWHEEL_BPS = 0` in
> `crates/null-flywheel-core`).

---

## The core loop

```
Task buyer pays USDC (x402; 0.05% x402 protocol fee on the settlement)
        │
        ├──► 90% → Agent stealth wallet (USDC)
        │
        ├──► 10% → Integrating platform (the app that sourced the task; it sets this share)
        │
        └──►  0% → null-flywheel-core (no protocol cut of task value)
```

The agent earns USDC. NULL yield to the hosting node is accounted per task by the
emission rules below; with a 0 flywheel rate, no USDC from task value is converted.

---

## Emission formula

```
null_per_task = (task_usdc_value × flywheel_rate_bps / 10_000) 
                / null_usdc_spot_price

host_yield_null = null_per_task × host_performance_score
```

Where `host_performance_score` is:
- `uptime_ratio` (last 24h): 0.0–1.0
- `task_completion_rate`: completed / claimed (0.0–1.0)  
- `reputation_multiplier`: from `dark-agent-passport` score (0.8–1.5×)

**Reputation multiplier tiers:**
| Passport Score | Multiplier | Access |
|---|---|---|
| 0–199 (Bronze) | 0.8× | Tier 1 tasks only (chaff, small bandwidth) |
| 200–499 (Silver) | 1.0× | Tier 1–2 tasks |
| 500–799 (Gold) | 1.2× | All task types |
| 800–1000 (Elite) | 1.5× | Private/enterprise tasks + priority queue |

This means holding more NULL (staking → higher rep) earns more NULL. Virtuous cycle without being a Ponzi — it's gated by *real task volume*, not just staking.

---

## NULL staking → task tier unlock

Stake NULL → unlock higher-value task categories:

```
0 NULL staked    → Tier 1 only (chaff tasks, $0.001–$0.01/task)
100 NULL staked  → Tier 2 (bandwidth, app store, $0.01–$0.10/task)
1,000 NULL staked → Tier 3 (location proof, sensor data, $0.10–$1.00/task)
10,000 NULL staked → Tier 4 (enterprise dark pool tasks, $1–$100/task)
```

Uses `crates/dark-staking-rewards/` — already built.

---

## Anti-inflation mechanisms

**1. Task completion gating** (from io.net playbook)
Emissions only trigger on *completed* tasks, not claimed ones. If an agent claims a task but doesn't complete it, no NULL minted. Rate: zero. This is the core fix Helium needed.

**2. Utilization-linked rate**
```
effective_rate_bps = base_rate_bps × min(1.0, network_utilization / 0.8)
```
Below 80% utilization → emissions scale down proportionally. Protects against the "ghost nodes" problem (nodes online but no tasks available).

**3. No protocol-funded purchases**
The protocol takes 0% of task value, so no task USDC is routed into NULL purchases.

**4. Epoch-locked emissions** (from `null-flywheel-core`)
The existing flywheel already has epoch management. Emissions are bounded per epoch. A single high-value task cannot generate unbounded NULL — there's a per-epoch cap.

---

## Fee split

| Share | Rate | Recipient |
|---|---|---|
| Agent payout | 90% of task USDC value | Agent stealth wallet |
| Platform share | 10% of task USDC value | Integrating platform (operator pricing) |
| Protocol margin | 0% | none |
| Flywheel | 0% | none |
| Treasury | 0% | none |
| Reputation fund | 0% | none |
| x402 protocol fee | 0.05% (5 bps) of the x402 settlement | Parad0x treasury |
