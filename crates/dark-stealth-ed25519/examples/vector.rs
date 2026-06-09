//! Prints a deterministic test vector so the JS client (scripts/nullpay) can be
//! cross-checked byte-for-byte against the Rust crate.
//!
//!   cargo run -p dark-stealth-ed25519 --example vector

use dark_stealth_ed25519::{derive, keygen, recover, sign, MetaAddress};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn main() {
    let mut spend_seed = [0u8; 32];
    spend_seed[0] = 1;
    spend_seed[1] = 0x11;
    let mut ephem_seed = [0u8; 32];
    ephem_seed[0] = 0xE1;
    ephem_seed[1] = 0x11;

    let keys = keygen(&spend_seed).unwrap();
    let meta = keys.meta_address();
    println!("meta_spend  {}", hex(&meta.spend_pub));
    println!("meta_view   {}", hex(&meta.view_pub));

    let meta2 = MetaAddress::from_bytes(&meta.to_bytes()).unwrap();
    let payment = derive(&meta2, &ephem_seed).unwrap();
    println!("stealth_pub {}", hex(&payment.stealth_pub));
    println!("ephem_pub   {}", hex(&payment.ephem_pub));

    let sk = recover(&keys, &payment).unwrap();
    println!("stealth_sec {}", hex(&sk.secret_bytes()));

    let msg = b"nullpay-sweep-tx";
    let sig = sign(&sk, msg);
    println!("sig         {}", hex(&sig));
}
