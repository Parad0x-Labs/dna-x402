# NULL Miner Tokenomics

> How to extend the existing NULL Flywheel without inflating NULL to zero.
> Based on lessons from Grass, Helium, io.net — what worked and what broke.

---

## The core loop

```
Task buyer pays USDC
        │
        ├──► 90% → Agent stealth wallet (USDC)
        │
        └──►  5% → null-flywheel-core
                        │
                        ├──► buys NULL from open market at spot price
                        │    (same mechanism as existing 5bp fee path)
                        └──► distributes NULL to hosting node (phone owner)
                             proportional to: tasks_completed × uptime_score
```

The agent earns USDC. The human host earns NULL. These are different wallets, different tokens. Clean separation.

---

## Why 5% to flywheel (not more, not less)

**Grass lesson:** They emit GRASS tokens funded by protocol margin. At $50M ARR and 8.5M nodes, per-node daily earnings are small but consistent. The token holds value because buy pressure (protocol buying from market) roughly matches sell pressure (miners selling rewards).

**Helium lesson:** When emissions >> real network usage, token inflates to near-zero. Helium's 2025 restructuring tied emissions to actual data usage. Before that: infinite rewards for hosting hotspots nobody used.

**Our constraint:** NULL emission rate must not exceed the rate at which the protocol buys NULL from the market to fund those rewards. At 5% of task USDC value going to flywheel:
- $10,000/day task volume → $500/day buying NULL from market
- If 1,000 active nodes, each earns ~$0.50/day in NULL
- At $0.01 NULL price → 50 NULL/day per node
- That's sustainable as long as task volume grows with node count

**The floor:** Tie emission rate dynamically to utilization. If task fill rate < 50%, halve the emission rate. If fill rate > 90%, emission rate stays full. This is exactly what io.net did in their 2025 tokenomics overhaul.

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

**3. Market buyback source**
The flywheel uses *real USDC from task buyers* to buy NULL from the open market. This is not inflationary minting — it's revenue-funded buyback. Same model as Grass's transition plan from reserve-funded to revenue-funded emissions.

**4. Epoch-locked emissions** (from `null-flywheel-core`)
The existing flywheel already has epoch management. Emissions are bounded per epoch. A single high-value task cannot generate unbounded NULL — there's a per-epoch cap.

---

## Revenue model for the protocol

| Revenue source | Rate | Notes |
|---|---|---|
| Task margin | 10% of task USDC value | Agent gets 90%, protocol gets 10% |
| From protocol margin: | | |
| → Flywheel (NULL buyback) | 5% of task value | Funds host yield |
| → Treasury | 3% of task value | Protocol ops + development |
| → Reputation fund | 2% of task value | Funds badge minting + passport ops |

At $100K/day task volume:
- $10K/day to protocol
- $5K/day buying NULL → distributed as host yield
- $3K/day treasury
- $2K/day reputation fund

At $1M/day task volume (Grass-comparable):
- $100K/day protocol revenue
- $50K/day NULL buyback pressure
- At 1M active nodes: $0.05/day each in NULL (small but meaningful)
- At 100K active nodes: $0.50/day each in NULL (more meaningful)

---

## Comparison to existing DePINs

| Project | Revenue | Payout method | Inflation risk |
|---|---|---|---|
| Grass | $50M+ ARR | Reserve → buyback (transitioning) | Medium — reserve-funded early |
| io.net | $20M ARR | Block rewards + job earnings | Low — tied to utilization since 2025 overhaul |
| Helium | $9.5M ARR | HNT emissions | Was high, fixed via Data Credits burn |
| **NULL Miner** | Target: start at x402 agent traffic, scale | Revenue-funded buyback from day 1 | Low — no reserve-funded phase, pure revenue buyback |

**NULL Miner's tokenomics are cleaner than every existing DePIN** because:
- No reserve-funded emission phase (no "pre-market" inflation risk)
- Revenue-funded from task 1 (x402 USDC is real money)
- Utilization-gated (io.net's 2025 lesson applied from day 1)
- Staking for tier access (creates buy pressure without Ponzi mechanics)
