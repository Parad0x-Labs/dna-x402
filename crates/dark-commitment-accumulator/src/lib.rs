use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Accumulator {
    pub value: [u8; 32],
    pub element_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MembershipWitness {
    pub element_hash: [u8; 32],
    pub witness_hash: [u8; 32],
    pub accumulator_value: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AccumulatorError {
    ElementAlreadyAdded,
    EmptyElement,
    WitnessInvalid,
}

pub fn new_accumulator() -> Accumulator {
    let mut input = Vec::new();
    input.extend_from_slice(b"acc-genesis-v1");
    input.extend_from_slice(&[0u8; 32]);
    let value = sha256(&input);
    Accumulator {
        value,
        element_count: 0,
        mainnet_ready: false,
    }
}

pub fn add_element(acc: &mut Accumulator, element: &[u8]) -> Result<[u8; 32], AccumulatorError> {
    if element.is_empty() {
        return Err(AccumulatorError::EmptyElement);
    }
    let mut elem_input = Vec::new();
    elem_input.extend_from_slice(b"acc-elem-v1");
    elem_input.extend_from_slice(element);
    let element_hash = sha256(&elem_input);

    let old_value = acc.value;
    let mut update_input = Vec::new();
    update_input.extend_from_slice(b"acc-update-v1");
    update_input.extend_from_slice(&old_value);
    update_input.extend_from_slice(&element_hash);
    acc.value = sha256(&update_input);
    acc.element_count += 1;

    Ok(element_hash)
}

pub fn create_witness(acc: &Accumulator, element_hash: &[u8; 32]) -> MembershipWitness {
    let mut w_input = Vec::new();
    w_input.extend_from_slice(b"acc-witness-v1");
    w_input.extend_from_slice(&acc.value);
    w_input.extend_from_slice(element_hash);
    let witness_hash = sha256(&w_input);
    MembershipWitness {
        element_hash: *element_hash,
        witness_hash,
        accumulator_value: acc.value,
        mainnet_ready: false,
    }
}

pub fn verify_membership(acc: &Accumulator, element: &[u8], witness: &MembershipWitness) -> bool {
    if element.is_empty() {
        return false;
    }
    let mut elem_input = Vec::new();
    elem_input.extend_from_slice(b"acc-elem-v1");
    elem_input.extend_from_slice(element);
    let element_hash = sha256(&elem_input);

    if element_hash != witness.element_hash {
        return false;
    }

    let mut w_input = Vec::new();
    w_input.extend_from_slice(b"acc-witness-v1");
    w_input.extend_from_slice(&acc.value);
    w_input.extend_from_slice(&element_hash);
    let expected_witness_hash = sha256(&w_input);

    expected_witness_hash == witness.witness_hash && acc.value == witness.accumulator_value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_verify_member() {
        let mut acc = new_accumulator();
        assert!(!acc.mainnet_ready);
        let element = b"hello-world";
        let elem_hash = add_element(&mut acc, element).unwrap();
        let witness = create_witness(&acc, &elem_hash);
        assert!(!witness.mainnet_ready);
        assert!(verify_membership(&acc, element, &witness));
    }

    #[test]
    fn test_non_member_fails() {
        let mut acc = new_accumulator();
        let elem_hash = add_element(&mut acc, b"real-element").unwrap();
        let witness = create_witness(&acc, &elem_hash);
        // Try to verify a different element using the same witness
        assert!(!verify_membership(&acc, b"fake-element", &witness));
    }

    #[test]
    fn test_empty_element_rejected() {
        let mut acc = new_accumulator();
        let result = add_element(&mut acc, b"");
        assert_eq!(result, Err(AccumulatorError::EmptyElement));
    }

    #[test]
    fn test_accumulator_value_changes_per_add() {
        let mut acc = new_accumulator();
        let initial_value = acc.value;
        add_element(&mut acc, b"element-one").unwrap();
        let after_first = acc.value;
        add_element(&mut acc, b"element-two").unwrap();
        let after_second = acc.value;
        assert_ne!(initial_value, after_first);
        assert_ne!(after_first, after_second);
        assert_ne!(initial_value, after_second);
    }

    #[test]
    fn test_witness_binds_to_accumulator_value() {
        let mut acc = new_accumulator();
        let elem_hash = add_element(&mut acc, b"bound-element").unwrap();
        // Create witness at current state
        let witness = create_witness(&acc, &elem_hash);
        // Add another element to change acc value
        add_element(&mut acc, b"extra-element").unwrap();
        // Old witness should no longer verify against updated accumulator
        assert!(!verify_membership(&acc, b"bound-element", &witness));
    }

    #[test]
    fn test_five_element_batch_all_verify() {
        let mut acc = new_accumulator();
        let elements: Vec<&[u8]> = vec![b"alpha", b"beta", b"gamma", b"delta", b"epsilon"];
        let mut hashes = Vec::new();
        for &elem in &elements {
            let h = add_element(&mut acc, elem).unwrap();
            hashes.push(h);
        }
        assert_eq!(acc.element_count, 5);
        for (i, &elem) in elements.iter().enumerate() {
            let witness = create_witness(&acc, &hashes[i]);
            assert!(
                verify_membership(&acc, elem, &witness),
                "element {} failed verification",
                i
            );
        }
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let acc = new_accumulator();
        assert!(!acc.mainnet_ready);
    }

    #[test]
    fn test_witness_mainnet_ready_false() {
        let mut acc = new_accumulator();
        let h = add_element(&mut acc, b"x").unwrap();
        let w = create_witness(&acc, &h);
        assert!(!w.mainnet_ready);
    }

    #[test]
    fn test_accumulator_genesis_nonzero() {
        let acc = new_accumulator();
        assert_ne!(acc.value, [0u8; 32]);
    }

    #[test]
    fn test_element_count_starts_zero() {
        let acc = new_accumulator();
        assert_eq!(acc.element_count, 0);
    }

    #[test]
    fn test_element_count_increments() {
        let mut acc = new_accumulator();
        add_element(&mut acc, b"a").unwrap();
        add_element(&mut acc, b"b").unwrap();
        add_element(&mut acc, b"c").unwrap();
        assert_eq!(acc.element_count, 3);
    }

    #[test]
    fn test_element_hash_nonzero() {
        let mut acc = new_accumulator();
        let h = add_element(&mut acc, b"something").unwrap();
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn test_element_hash_element_sensitive() {
        let mut acc = new_accumulator();
        let h1 = add_element(&mut acc, b"element-one").unwrap();
        let h2 = add_element(&mut acc, b"element-two").unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_verify_empty_element_fails() {
        let acc = new_accumulator();
        let dummy_witness = MembershipWitness {
            element_hash: [0u8; 32],
            witness_hash: [0u8; 32],
            accumulator_value: acc.value,
            mainnet_ready: false,
        };
        assert!(!verify_membership(&acc, b"", &dummy_witness));
    }

    #[test]
    fn test_witness_element_hash_matches() {
        let mut acc = new_accumulator();
        let h = add_element(&mut acc, b"check-me").unwrap();
        let w = create_witness(&acc, &h);
        assert_eq!(w.element_hash, h);
    }

    #[test]
    fn test_accumulator_value_nonzero_after_add() {
        let mut acc = new_accumulator();
        add_element(&mut acc, b"test").unwrap();
        assert_ne!(acc.value, [0u8; 32]);
    }
}
