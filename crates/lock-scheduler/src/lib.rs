//! Lock Scheduler — assign private actions to non-conflicting batches.
//!
//! Solana parallelises transactions that don't share writable accounts.
//! Private actions that share the same nullifier shard or receipt checkpoint
//! will conflict. This scheduler predicts conflicts and routes around them.
//!
//! Privacy bonus: actions in the same lock-class produce identical account
//! access patterns — anonymity by uniformity.

pub type AccountKey = [u8; 32];

#[derive(Debug, Clone)]
pub struct WriteSet {
    pub accounts: Vec<AccountKey>,
}

impl WriteSet {
    pub fn new(accounts: Vec<AccountKey>) -> Self {
        Self { accounts }
    }
    pub fn conflicts_with(&self, other: &WriteSet) -> bool {
        self.accounts.iter().any(|a| other.accounts.contains(a))
    }
}

#[derive(Debug, Clone)]
pub struct Action {
    pub id: u64,
    pub write_set: WriteSet,
    /// Assigned shard index (0–255).
    pub shard: u8,
}

/// Assign each action to a conflict-free batch.
/// Returns a vec of batches; actions within a batch have no write conflicts.
pub fn schedule(actions: Vec<Action>) -> Vec<Vec<Action>> {
    let mut batches: Vec<Vec<Action>> = Vec::new();
    'outer: for action in actions {
        for batch in batches.iter_mut() {
            let conflicts = batch
                .iter()
                .any(|b| b.write_set.conflicts_with(&action.write_set));
            if !conflicts {
                batch.push(action);
                continue 'outer;
            }
        }
        batches.push(vec![action]);
    }
    batches
}

/// Detect if two write-sets conflict.
pub fn conflicts(a: &WriteSet, b: &WriteSet) -> bool {
    a.conflicts_with(b)
}

/// Assign an action to a nullifier shard (0–255) based on the first account key's first byte.
pub fn shard_for(key: &AccountKey) -> u8 {
    key[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(first_byte: u8) -> AccountKey {
        let mut k = [0u8; 32];
        k[0] = first_byte;
        k
    }

    #[test]
    fn test_no_conflict_same_batch() {
        let a1 = Action {
            id: 1,
            write_set: WriteSet::new(vec![key(1)]),
            shard: 1,
        };
        let a2 = Action {
            id: 2,
            write_set: WriteSet::new(vec![key(2)]),
            shard: 2,
        };
        let batches = schedule(vec![a1, a2]);
        assert_eq!(
            batches.len(),
            1,
            "disjoint write-sets should land in same batch"
        );
        assert_eq!(batches[0].len(), 2);
    }

    #[test]
    fn test_conflict_splits_batches() {
        let shared = key(42);
        let a1 = Action {
            id: 1,
            write_set: WriteSet::new(vec![shared]),
            shard: 42,
        };
        let a2 = Action {
            id: 2,
            write_set: WriteSet::new(vec![shared]),
            shard: 42,
        };
        let batches = schedule(vec![a1, a2]);
        assert_eq!(
            batches.len(),
            2,
            "conflicting actions must be in separate batches"
        );
    }

    #[test]
    fn test_empty_actions() {
        let batches = schedule(vec![]);
        assert!(
            batches.is_empty(),
            "empty input should produce empty batches"
        );
    }

    #[test]
    fn test_three_actions_two_batches() {
        // A and B conflict; C is disjoint from both
        let shared = key(10);
        let a = Action {
            id: 1,
            write_set: WriteSet::new(vec![shared, key(20)]),
            shard: 10,
        };
        let b = Action {
            id: 2,
            write_set: WriteSet::new(vec![shared, key(30)]),
            shard: 10,
        };
        let c = Action {
            id: 3,
            write_set: WriteSet::new(vec![key(99)]),
            shard: 99,
        };
        let batches = schedule(vec![a, b, c]);
        assert_eq!(
            batches.len(),
            2,
            "A+B conflict → 2 batches; C joins the first available"
        );
        let total: usize = batches.iter().map(|b| b.len()).sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_shard_deterministic() {
        let k = key(77);
        assert_eq!(shard_for(&k), 77);
        assert_eq!(shard_for(&k), shard_for(&k));
    }

    #[test]
    fn test_all_conflict_n_batches() {
        // All actions share the same account key — every action goes to its own batch
        let shared = key(5);
        let actions: Vec<Action> = (0..5u64)
            .map(|i| Action {
                id: i,
                write_set: WriteSet::new(vec![shared]),
                shard: 5,
            })
            .collect();
        let batches = schedule(actions);
        assert_eq!(
            batches.len(),
            5,
            "all-conflict actions must each get their own batch"
        );
        for batch in &batches {
            assert_eq!(batch.len(), 1);
        }
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_write_set_conflicts_with_itself() {
        let ws = WriteSet::new(vec![key(5), key(10)]);
        assert!(ws.conflicts_with(&ws));
    }

    #[test]
    fn test_write_set_no_conflict_disjoint() {
        let a = WriteSet::new(vec![key(1), key(2)]);
        let b = WriteSet::new(vec![key(3), key(4)]);
        assert!(!a.conflicts_with(&b));
    }

    #[test]
    fn test_conflicts_function_symmetric() {
        let a = WriteSet::new(vec![key(7)]);
        let b = WriteSet::new(vec![key(7)]);
        assert!(conflicts(&a, &b));
        assert!(conflicts(&b, &a));
    }

    #[test]
    fn test_single_action_one_batch() {
        let a = Action {
            id: 99,
            write_set: WriteSet::new(vec![key(1)]),
            shard: 1,
        };
        let batches = schedule(vec![a]);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[0][0].id, 99);
    }

    #[test]
    fn test_shard_for_max_byte() {
        let k = key(255);
        assert_eq!(shard_for(&k), 255);
    }

    #[test]
    fn test_shard_for_zero_byte() {
        let k = [0u8; 32];
        assert_eq!(shard_for(&k), 0);
    }

    #[test]
    fn test_total_actions_preserved() {
        let actions: Vec<Action> = (0..6u64)
            .map(|i| Action {
                id: i,
                write_set: WriteSet::new(vec![key(i as u8)]),
                shard: i as u8,
            })
            .collect();
        let batches = schedule(actions);
        let total: usize = batches.iter().map(|b| b.len()).sum();
        assert_eq!(total, 6);
    }

    #[test]
    fn test_chain_conflict_scheduling() {
        // A=[1,2], B=[2,3], C=[3,4] — A conflicts B, B conflicts C, A not C
        let a = Action {
            id: 1,
            write_set: WriteSet::new(vec![key(1), key(2)]),
            shard: 1,
        };
        let b = Action {
            id: 2,
            write_set: WriteSet::new(vec![key(2), key(3)]),
            shard: 2,
        };
        let c = Action {
            id: 3,
            write_set: WriteSet::new(vec![key(3), key(4)]),
            shard: 3,
        };
        let batches = schedule(vec![a, b, c]);
        let total: usize = batches.iter().map(|b| b.len()).sum();
        assert_eq!(total, 3);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_action_ids_preserved() {
        let a = Action {
            id: 111,
            write_set: WriteSet::new(vec![key(1)]),
            shard: 1,
        };
        let b = Action {
            id: 222,
            write_set: WriteSet::new(vec![key(2)]),
            shard: 2,
        };
        let batches = schedule(vec![a, b]);
        let all_ids: Vec<u64> = batches
            .iter()
            .flat_map(|b| b.iter().map(|a| a.id))
            .collect();
        assert!(all_ids.contains(&111));
        assert!(all_ids.contains(&222));
    }

    #[test]
    fn test_empty_write_sets_no_conflict() {
        let a = WriteSet::new(vec![]);
        let b = WriteSet::new(vec![]);
        assert!(!conflicts(&a, &b));
    }
}
