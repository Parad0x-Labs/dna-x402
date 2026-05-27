use sha2::{Digest, Sha256};

pub struct Payroll {
    pub payroll_id: [u8; 32],
    pub org_hash: [u8; 32],
    pub salary_root: [u8; 32],
    pub employee_count: u32,
    pub total_committed: u64,
    pub mainnet_ready: bool,
    emp_ids: Vec<[u8; 32]>,
}

pub struct SalaryCommitment {
    pub emp_id: [u8; 32],
    pub commitment: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum PayrollError {
    ZeroOrgSecret,
    ZeroEmployeeSecret,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(ids: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for id in ids {
        for i in 0..32 {
            acc[i] ^= id[i];
        }
    }
    acc
}

pub fn new_payroll(org_secret: &[u8; 32]) -> Result<Payroll, PayrollError> {
    if org_secret == &[0u8; 32] {
        return Err(PayrollError::ZeroOrgSecret);
    }
    let org_hash = sha256_multi(&[b"payroll-org-v1", org_secret]);
    let payroll_id = sha256_multi(&[b"payroll-id-v1", &org_hash]);
    Ok(Payroll {
        payroll_id,
        org_hash,
        salary_root: [0u8; 32],
        employee_count: 0,
        total_committed: 0,
        mainnet_ready: false,
        emp_ids: Vec::new(),
    })
}

pub fn add_employee(
    payroll: &mut Payroll,
    emp_secret: &[u8; 32],
    salary: u64,
    blinding: &[u8; 32],
) -> Result<SalaryCommitment, PayrollError> {
    if emp_secret == &[0u8; 32] {
        return Err(PayrollError::ZeroEmployeeSecret);
    }
    let emp_hash = sha256_multi(&[b"payroll-emp-v1", emp_secret]);
    let salary_le = salary.to_le_bytes();
    let commitment = sha256_multi(&[b"payroll-salary-v1", &emp_hash, &salary_le, blinding]);
    let emp_id = sha256_multi(&[b"payroll-eid-v1", &payroll.payroll_id, &emp_hash]);

    payroll.emp_ids.push(emp_id);
    payroll.employee_count += 1;
    payroll.total_committed = payroll.total_committed.saturating_add(salary);

    let count_le = payroll.employee_count.to_le_bytes();
    let folded = xor_fold(&payroll.emp_ids);
    payroll.salary_root = sha256_multi(&[b"payroll-root-v1", &folded, &count_le]);

    Ok(SalaryCommitment { emp_id, commitment })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org_secret() -> [u8; 32] {
        [0x11u8; 32]
    }
    fn emp1_secret() -> [u8; 32] {
        [0x22u8; 32]
    }
    fn emp2_secret() -> [u8; 32] {
        [0x33u8; 32]
    }
    fn blinding() -> [u8; 32] {
        [0xaau8; 32]
    }

    #[test]
    fn new_payroll_mainnet_ready_false() {
        let p = new_payroll(&org_secret()).unwrap();
        assert_eq!(p.mainnet_ready, false);
        assert_ne!(p.payroll_id, [0u8; 32]);
        assert_eq!(p.employee_count, 0);
    }

    #[test]
    fn add_employee_updates_root() {
        let mut p = new_payroll(&org_secret()).unwrap();
        let root_before = p.salary_root;
        add_employee(&mut p, &emp1_secret(), 50000, &blinding()).unwrap();
        assert_ne!(p.salary_root, root_before);
        assert_eq!(p.employee_count, 1);
    }

    #[test]
    fn total_committed_accumulates() {
        let mut p = new_payroll(&org_secret()).unwrap();
        add_employee(&mut p, &emp1_secret(), 50000, &blinding()).unwrap();
        add_employee(&mut p, &emp2_secret(), 60000, &blinding()).unwrap();
        assert_eq!(p.total_committed, 110000);
    }

    #[test]
    fn zero_org_rejected() {
        let result = new_payroll(&[0u8; 32]);
        assert_eq!(result.err(), Some(PayrollError::ZeroOrgSecret));
    }

    #[test]
    fn zero_emp_rejected() {
        let mut p = new_payroll(&org_secret()).unwrap();
        let result = add_employee(&mut p, &[0u8; 32], 50000, &blinding());
        assert_eq!(result.err(), Some(PayrollError::ZeroEmployeeSecret));
    }

    #[test]
    fn salary_root_changes_on_second_add() {
        let mut p = new_payroll(&org_secret()).unwrap();
        add_employee(&mut p, &emp1_secret(), 50000, &blinding()).unwrap();
        let root_after_1 = p.salary_root;
        add_employee(&mut p, &emp2_secret(), 60000, &blinding()).unwrap();
        assert_ne!(p.salary_root, root_after_1);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_payroll_id_nonzero() {
        let p = new_payroll(&org_secret()).unwrap();
        assert_ne!(p.payroll_id, [0u8; 32]);
    }

    #[test]
    fn test_org_hash_nonzero() {
        let p = new_payroll(&org_secret()).unwrap();
        assert_ne!(p.org_hash, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let p = new_payroll(&org_secret()).unwrap();
        assert!(!p.mainnet_ready);
    }

    #[test]
    fn test_employee_count_zero_initially() {
        let p = new_payroll(&org_secret()).unwrap();
        assert_eq!(p.employee_count, 0);
    }

    #[test]
    fn test_total_committed_zero_initially() {
        let p = new_payroll(&org_secret()).unwrap();
        assert_eq!(p.total_committed, 0);
    }

    #[test]
    fn test_commitment_nonzero() {
        let mut p = new_payroll(&org_secret()).unwrap();
        let sc = add_employee(&mut p, &emp1_secret(), 50_000, &blinding()).unwrap();
        assert_ne!(sc.commitment, [0u8; 32]);
    }

    #[test]
    fn test_emp_id_nonzero() {
        let mut p = new_payroll(&org_secret()).unwrap();
        let sc = add_employee(&mut p, &emp1_secret(), 50_000, &blinding()).unwrap();
        assert_ne!(sc.emp_id, [0u8; 32]);
    }

    #[test]
    fn test_payroll_id_deterministic() {
        let p1 = new_payroll(&org_secret()).unwrap();
        let p2 = new_payroll(&org_secret()).unwrap();
        assert_eq!(p1.payroll_id, p2.payroll_id);
    }

    #[test]
    fn test_commitment_salary_sensitive() {
        let mut p = new_payroll(&org_secret()).unwrap();
        let sc1 = add_employee(&mut p, &emp1_secret(), 50_000, &blinding()).unwrap();
        let mut p2 = new_payroll(&org_secret()).unwrap();
        let sc2 = add_employee(&mut p2, &emp1_secret(), 60_000, &blinding()).unwrap();
        assert_ne!(sc1.commitment, sc2.commitment);
    }

    #[test]
    fn test_employee_count_increments() {
        let mut p = new_payroll(&org_secret()).unwrap();
        add_employee(&mut p, &emp1_secret(), 50_000, &blinding()).unwrap();
        assert_eq!(p.employee_count, 1);
        add_employee(&mut p, &emp2_secret(), 60_000, &blinding()).unwrap();
        assert_eq!(p.employee_count, 2);
    }
}
