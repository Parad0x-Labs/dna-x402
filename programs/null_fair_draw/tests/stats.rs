// Statistical tests of the draw math, run natively on the same functions the
// program uses (stream::point, stream::remap via stream::reference_draw).
// Each test runs 10^6 simulated draws (seeds SHA-256(tag || i)), computes a
// chi-square statistic against the exact expected distribution and fails if
// the p-value is below 0.001. `NFD_STATS_DRAWS` overrides the draw count.

use null_fair_draw::stream;
use solana_program::hash::hashv;

const ALPHA: f64 = 0.001;

fn draws() -> u64 {
    std::env::var("NFD_STATS_DRAWS").ok().and_then(|v| v.parse().ok()).unwrap_or(1_000_000)
}

fn seed(tag: &str, i: u64) -> [u8; 32] {
    hashv(&[tag.as_bytes(), &i.to_le_bytes()]).to_bytes()
}

/// ln Gamma(x) for x > 0 (Lanczos, g = 7, n = 9).
fn ln_gamma(x: f64) -> f64 {
    const C: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        let pi = std::f64::consts::PI;
        return (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut a = C[0];
    let t = x + 7.5;
    for (i, c) in C.iter().enumerate().skip(1) {
        a += c / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// Regularized upper incomplete gamma Q(a, x).
fn gamma_q(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 1.0;
    }
    if x < a + 1.0 {
        // Series for P(a, x).
        let mut sum = 1.0 / a;
        let mut del = sum;
        let mut ap = a;
        for _ in 0..10_000 {
            ap += 1.0;
            del *= x / ap;
            sum += del;
            if del.abs() < sum.abs() * 1e-15 {
                break;
            }
        }
        1.0 - sum * (-x + a * x.ln() - ln_gamma(a)).exp()
    } else {
        // Continued fraction (modified Lentz).
        let tiny = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / tiny;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..10_000 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < tiny {
                d = tiny;
            }
            c = b + an / c;
            if c.abs() < tiny {
                c = tiny;
            }
            d = 1.0 / d;
            let del = d * c;
            h *= del;
            if (del - 1.0).abs() < 1e-15 {
                break;
            }
        }
        (-x + a * x.ln() - ln_gamma(a)).exp() * h
    }
}

/// Chi-square statistic and p-value of `observed` against `expected` counts.
fn chi_square(observed: &[u64], expected: &[f64]) -> (f64, usize, f64) {
    let stat: f64 = observed
        .iter()
        .zip(expected)
        .map(|(&o, &e)| {
            let d = o as f64 - e;
            d * d / e
        })
        .sum();
    let df = observed.len() - 1;
    (stat, df, gamma_q(df as f64 / 2.0, stat / 2.0))
}

fn report(name: &str, n: u64, observed: &[u64], expected: &[f64]) {
    let (stat, df, p) = chi_square(observed, expected);
    println!("STATS {name}: draws={n} cells={} chi2={stat:.2} df={df} p={p:.4}", observed.len());
    assert!(p >= ALPHA, "{name}: p = {p} < {ALPHA}");
}

#[test]
fn p_value_function_matches_known_values() {
    // Q(df/2, x/2): chi2 = 3.841 at df 1 -> 0.05; chi2 = 124.342 at df 100 -> 0.05.
    assert!((gamma_q(0.5, 3.841_458_8 / 2.0) - 0.05).abs() < 1e-6);
    assert!((gamma_q(50.0, 124.342_1 / 2.0) - 0.05).abs() < 1e-5);
    assert!((gamma_q(5.0, 4.0) - 0.628_836_935).abs() < 1e-8);
    assert!((ln_gamma(10.0) - 362_880f64.ln()).abs() < 1e-10);
}

/// Unweighted single winner over n = 97 indices (a modulus that is not a power of two).
#[test]
fn unweighted_index_is_uniform() {
    let n = draws();
    let m = 97u64;
    let mut c = vec![0u64; m as usize];
    for i in 0..n {
        c[stream::point(&seed("stats-index", i), 0, m) as usize] += 1;
    }
    report("unweighted index (n=97)", n, &c, &vec![n as f64 / m as f64; m as usize]);
}

/// Weighted single winner: leaf i has weight i + 1 (total 210).
#[test]
fn weighted_winner_is_proportional_to_weight() {
    let n = draws();
    let weights: Vec<u64> = (1..=20).collect();
    let total: u64 = weights.iter().sum();
    let mut c = vec![0u64; weights.len()];
    for i in 0..n {
        let w = stream::reference_draw(&weights, &[], &seed("stats-weighted", i), 0, 1);
        c[w[0].unwrap()] += 1;
    }
    let e: Vec<f64> = weights.iter().map(|&w| n as f64 * w as f64 / total as f64).collect();
    report("weighted winner (w=1..20)", n, &c, &e);
}

/// Two winners without replacement, weighted: P(i then j) = w_i/T * w_j/(T - w_i).
#[test]
fn weighted_pairs_without_replacement() {
    let n = draws();
    let weights = [1u64, 2, 3, 4, 5, 6];
    let k = weights.len();
    let total: f64 = weights.iter().sum::<u64>() as f64;
    let mut c = vec![0u64; k * k];
    for i in 0..n {
        let w = stream::reference_draw(&weights, &[], &seed("stats-pairs", i), 0, 2);
        let (a, b) = (w[0].unwrap(), w[1].unwrap());
        assert_ne!(a, b, "a leaf won twice");
        c[a * k + b] += 1;
    }
    let mut obs = Vec::new();
    let mut exp = Vec::new();
    for a in 0..k {
        for b in 0..k {
            if a == b {
                assert_eq!(c[a * k + b], 0);
                continue;
            }
            let wa = weights[a] as f64;
            let wb = weights[b] as f64;
            obs.push(c[a * k + b]);
            exp.push(n as f64 * wa / total * wb / (total - wa));
        }
    }
    report("weighted ordered pairs (w=1..6)", n, &obs, &exp);
}

/// Three winners without replacement, unweighted, from six: all 120 ordered
/// triples equally likely.
#[test]
fn unweighted_triples_without_replacement() {
    let n = draws();
    let weights = [1u64; 6];
    let mut c = std::collections::HashMap::<(usize, usize, usize), u64>::new();
    for i in 0..n {
        let w = stream::reference_draw(&weights, &[], &seed("stats-triples", i), 0, 3);
        let t = (w[0].unwrap(), w[1].unwrap(), w[2].unwrap());
        assert!(t.0 != t.1 && t.1 != t.2 && t.0 != t.2);
        *c.entry(t).or_default() += 1;
    }
    assert_eq!(c.len(), 120);
    let obs: Vec<u64> = c.values().copied().collect();
    report("unweighted ordered triples (6 choose 3)", n, &obs, &vec![n as f64 / 120.0; 120]);
}

/// Re-draw continuation: after leaves {0, 3} won, the next winner is drawn
/// from the rest with probability w_i / (T - w_0 - w_3).
#[test]
fn redraw_excludes_previous_winners_proportionally() {
    let n = draws();
    let weights = [4u64, 1, 2, 7, 3, 5];
    let rest: Vec<usize> = vec![1, 2, 4, 5];
    let rem: f64 = rest.iter().map(|&i| weights[i] as f64).sum();
    let mut c = vec![0u64; weights.len()];
    for i in 0..n {
        let w = stream::reference_draw(&weights, &[0, 3], &seed("stats-redraw", i), 7, 1);
        c[w[0].unwrap()] += 1;
    }
    assert_eq!(c[0] + c[3], 0);
    let obs: Vec<u64> = rest.iter().map(|&i| c[i]).collect();
    let exp: Vec<f64> = rest.iter().map(|&i| n as f64 * weights[i] as f64 / rem).collect();
    report("re-draw after winners {0,3}", n, &obs, &exp);
}
