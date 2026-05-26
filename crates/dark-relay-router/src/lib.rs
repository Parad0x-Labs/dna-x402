//! Leader-aware private relay path scorer for Dark Null.
//!
//! Scores relay routes (DirectRpc / Jito / SWQoS) against:
//! - Upcoming Solana leader schedule (timing-correlation risk)
//! - Fingerprint risk per route type
//! - Expected landing probability
//! - Timing jitter budget
//!
//! The `devnet-tests` feature enables a live `fetch_leader_schedule` test.

use rand::Rng;
use solana_sdk::pubkey::Pubkey;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteKind {
    /// Submit directly to a public RPC node. Transaction is visible in mempool.
    DirectRpc,
    /// Submit via Jito block engine. Bundle is protected from mempool inspection.
    Jito,
    /// Submit via a staked validator's private connection. Semi-private.
    StakeWeightedQos,
}

#[derive(Debug, Clone)]
pub struct RelayRoute {
    pub kind: RouteKind,
    pub endpoint: String,
}

#[derive(Debug, Clone)]
pub struct PrivacyScore {
    /// Added delay for timing de-correlation (milliseconds).
    pub timing_jitter_ms: u64,
    /// 0.0 = invisible, 1.0 = fully fingerprinted.
    pub fingerprint_risk: f32,
    /// Probability the transaction lands in the next N slots.
    pub landing_probability: f32,
    /// Combined score: higher is better.  `landing * (1 - fingerprint_risk)`.
    pub composite: f32,
}

/// One slot assignment from the leader schedule.
#[derive(Debug, Clone)]
pub struct LeaderWindow {
    pub slot: u64,
    pub leader: Pubkey,
}

#[derive(Debug)]
pub enum RelayError {
    Rpc(String),
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Rpc(msg) => write!(f, "relay rpc error: {msg}"),
        }
    }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/// Score a route against a leader window snapshot.
///
/// Privacy model:
/// - DirectRpc: mempool-visible → high fingerprint risk
/// - Jito: bundle-protected → low fingerprint risk, highest landing rate
/// - SWQoS: semi-private staked path → medium fingerprint, high landing
pub fn score_route(route: &RelayRoute, leaders: &[LeaderWindow]) -> PrivacyScore {
    let (base_fingerprint, base_landing, jitter_ms) = match route.kind {
        RouteKind::DirectRpc => (0.70_f32, 0.88_f32, 150_u64),
        RouteKind::Jito => (0.15_f32, 0.97_f32, 50_u64),
        RouteKind::StakeWeightedQos => (0.45_f32, 0.93_f32, 100_u64),
    };

    // More leader windows visible → lower timing-correlation risk.
    let leader_adj = if leaders.is_empty() {
        0.15_f32
    } else {
        0.02_f32
    };
    let fingerprint_risk = (base_fingerprint + leader_adj).min(1.0);

    PrivacyScore {
        timing_jitter_ms: jitter_ms,
        fingerprint_risk,
        landing_probability: base_landing,
        composite: base_landing * (1.0 - fingerprint_risk),
    }
}

/// Add bounded random jitter to a base delay (never exceeds 2× base).
pub fn jitter_delay_ms(base_ms: u64, rng: &mut impl Rng) -> u64 {
    let extra = rng.gen_range(0..=base_ms);
    base_ms + extra
}

/// Rank routes by composite privacy score (best first).
pub fn rank_routes(mut routes: Vec<RelayRoute>, leaders: &[LeaderWindow]) -> Vec<RelayRoute> {
    routes.sort_by(|a, b| {
        let sa = score_route(a, leaders).composite;
        let sb = score_route(b, leaders).composite;
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    routes
}

// ── Live RPC (feature-gated) ──────────────────────────────────────────────────

/// Fetch the current leader schedule from a Solana JSON-RPC endpoint.
///
/// Enabled with `--features devnet-tests`.
#[cfg(feature = "devnet-tests")]
pub async fn fetch_leader_schedule(rpc_url: &str) -> Result<Vec<LeaderWindow>, RelayError> {
    use std::str::FromStr;

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getLeaderSchedule",
        "params": [null]
    });

    let resp = reqwest::Client::new()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| RelayError::Rpc(e.to_string()))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| RelayError::Rpc(e.to_string()))?;

    let result = json
        .get("result")
        .ok_or_else(|| RelayError::Rpc("no result field".into()))?;

    let mut windows = Vec::new();
    if let Some(obj) = result.as_object() {
        for (pubkey_str, slots) in obj {
            if let Ok(leader) = Pubkey::from_str(pubkey_str) {
                if let Some(slots_arr) = slots.as_array() {
                    for slot_val in slots_arr.iter().take(4) {
                        if let Some(slot) = slot_val.as_u64() {
                            windows.push(LeaderWindow { slot, leader });
                        }
                    }
                }
            }
        }
    }

    windows.sort_by_key(|w| w.slot);
    Ok(windows)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn leaders_sample() -> Vec<LeaderWindow> {
        (0..4)
            .map(|i| LeaderWindow {
                slot: i,
                leader: Pubkey::new_unique(),
            })
            .collect()
    }

    #[test]
    fn test_jitter_within_bounds() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(1234);
        for base in [0, 10, 50, 200, 1000] {
            for _ in 0..200 {
                let jitter = jitter_delay_ms(base, &mut rng);
                assert!(jitter <= base * 2, "jitter {jitter} exceeded 2×base={base}");
                assert!(jitter >= base, "jitter {jitter} less than base={base}");
            }
        }
    }

    #[test]
    fn test_route_ranking_stable() {
        let leaders = leaders_sample();
        let routes = vec![
            RelayRoute {
                kind: RouteKind::DirectRpc,
                endpoint: "https://a.rpc".into(),
            },
            RelayRoute {
                kind: RouteKind::Jito,
                endpoint: "https://b.jito".into(),
            },
            RelayRoute {
                kind: RouteKind::StakeWeightedQos,
                endpoint: "https://c.swq".into(),
            },
        ];
        let ranked1 = rank_routes(routes.clone(), &leaders);
        let ranked2 = rank_routes(routes, &leaders);
        // Deterministic: same input → same order
        for (a, b) in ranked1.iter().zip(ranked2.iter()) {
            assert_eq!(a.kind, b.kind);
        }
    }

    #[test]
    fn test_jito_scores_higher_than_direct() {
        let leaders = leaders_sample();
        let jito = RelayRoute {
            kind: RouteKind::Jito,
            endpoint: "".into(),
        };
        let direct = RelayRoute {
            kind: RouteKind::DirectRpc,
            endpoint: "".into(),
        };

        let jito_score = score_route(&jito, &leaders);
        let direct_score = score_route(&direct, &leaders);

        assert!(
            jito_score.composite > direct_score.composite,
            "Jito composite={} must beat DirectRpc composite={}",
            jito_score.composite,
            direct_score.composite
        );
    }

    #[test]
    fn test_empty_leader_schedule_increases_risk() {
        let jito_no_leaders = score_route(
            &RelayRoute {
                kind: RouteKind::Jito,
                endpoint: "".into(),
            },
            &[],
        );
        let jito_with_leaders = score_route(
            &RelayRoute {
                kind: RouteKind::Jito,
                endpoint: "".into(),
            },
            &leaders_sample(),
        );
        // Empty schedule → higher fingerprint risk → lower composite
        assert!(jito_no_leaders.fingerprint_risk > jito_with_leaders.fingerprint_risk);
    }

    #[test]
    fn test_rank_routes_best_first() {
        let leaders = leaders_sample();
        let routes = vec![
            RelayRoute {
                kind: RouteKind::DirectRpc,
                endpoint: "".into(),
            },
            RelayRoute {
                kind: RouteKind::Jito,
                endpoint: "".into(),
            },
            RelayRoute {
                kind: RouteKind::StakeWeightedQos,
                endpoint: "".into(),
            },
        ];
        let ranked = rank_routes(routes, &leaders);
        // Top-ranked route must have composite >= next
        let composites: Vec<f32> = ranked
            .iter()
            .map(|r| score_route(r, &leaders).composite)
            .collect();
        for w in composites.windows(2) {
            assert!(
                w[0] >= w[1],
                "routes not sorted best-first: {:.3} < {:.3}",
                w[0],
                w[1]
            );
        }
    }

    // ── Devnet integration test (requires --features devnet-tests) ──

    #[cfg(feature = "devnet-tests")]
    #[tokio::test]
    async fn test_fetch_live_leader_schedule() {
        let url = std::env::var("SOLANA_RPC_URL")
            .unwrap_or_else(|_| "https://api.devnet.solana.com".into());
        let schedule = fetch_leader_schedule(&url)
            .await
            .expect("leader schedule fetch");
        assert!(
            !schedule.is_empty(),
            "devnet must return at least one leader window"
        );
    }
}
