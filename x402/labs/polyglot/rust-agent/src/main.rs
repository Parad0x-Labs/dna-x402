use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use dna_x402_client::verify_signed_receipt_json;

#[derive(Clone, Debug)]
struct BaseUrl {
    host: String,
    port: u16,
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    body: String,
}

fn arg_value(name: &str, fallback: Option<&str>) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .or_else(|| fallback.map(String::from))
}

fn parse_base_url(raw: &str) -> Result<BaseUrl, String> {
    let without_scheme = raw
        .strip_prefix("http://")
        .ok_or_else(|| "rust-agent only supports local http:// URLs".to_string())?;
    let host_port = without_scheme.trim_end_matches('/');
    let mut parts = host_port.split(':');
    let host = parts
        .next()
        .ok_or_else(|| "base URL missing host".to_string())?
        .to_string();
    let port = parts
        .next()
        .ok_or_else(|| "base URL missing port".to_string())?
        .parse::<u16>()
        .map_err(|error| format!("invalid port: {error}"))?;
    Ok(BaseUrl { host, port })
}

fn http_request(
    base: &BaseUrl,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    let mut stream = TcpStream::connect((base.host.as_str(), base.port))
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("read timeout setup failed: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("write timeout setup failed: {error}"))?;

    let body_text = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: {}\r\n",
        base.host,
        base.port,
        body_text.as_bytes().len()
    );
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(body_text);

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("write failed: {error}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|error| format!("read failed: {error}"))?;
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "missing HTTP status".to_string())?;
    Ok(HttpResponse {
        status,
        body: body.to_string(),
    })
}

fn json_string(body: &str, key: &str) -> Result<String, String> {
    let needle = format!("\"{}\":\"", key);
    let start = body
        .find(&needle)
        .ok_or_else(|| format!("missing JSON string key {key}"))?
        + needle.len();
    let tail = &body[start..];
    let end = tail
        .find('"')
        .ok_or_else(|| format!("unterminated JSON string key {key}"))?;
    Ok(tail[..end].to_string())
}

fn json_string_after(body: &str, after: &str, key: &str) -> Result<String, String> {
    let offset = body
        .find(after)
        .ok_or_else(|| format!("missing JSON marker {after}"))?;
    json_string(&body[offset..], key)
}

fn simple_hex(input: &str) -> String {
    let mut state: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        state ^= *byte as u64;
        state = state.wrapping_mul(0x100000001b3);
    }
    let mut out = String::new();
    for i in 0..4 {
        let offset = (i as u64).wrapping_mul(0x9e3779b97f4a7c15);
        out.push_str(&format!("{:016x}", state.wrapping_add(offset)));
    }
    out
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn payment_helper_proof(
    base: &BaseUrl,
    agent_id: &str,
    quote_id: &str,
    settlement: &str,
    amount_atomic: &str,
    recipient: &str,
    mint: &str,
) -> Result<(String, String), String> {
    let helper_body = format!(
        "{{\"agentId\":\"{}\",\"quoteId\":\"{}\",\"settlement\":\"{}\",\"amountAtomic\":\"{}\",\"recipient\":\"{}\",\"mint\":\"{}\"}}",
        escape_json(agent_id),
        escape_json(quote_id),
        escape_json(settlement),
        escape_json(amount_atomic),
        escape_json(recipient),
        escape_json(mint)
    );
    let helper = http_request(base, "POST", "/polyglot-wallet/pay", &[], Some(&helper_body))?;
    if helper.status != 200 {
        return Err(format!("payment helper expected 200, got {}: {}", helper.status, helper.body));
    }
    if settlement == "stream" {
        let stream_id = json_string(&helper.body, "streamId")?;
        let topup_signature = json_string(&helper.body, "topupSignature")?;
        let proof = format!(
            "{{\"settlement\":\"stream\",\"streamId\":\"{}\",\"amountAtomic\":\"{}\",\"topupSignature\":\"{}\"}}",
            escape_json(&stream_id),
            escape_json(amount_atomic),
            escape_json(&topup_signature)
        );
        return Ok((proof, format!("\"streamId\":\"{}\",\"topupSignature\":\"{}\"", escape_json(&stream_id), escape_json(&topup_signature))));
    }

    let tx_signature = json_string(&helper.body, "txSignature")?;
    let proof = format!(
        "{{\"settlement\":\"transfer\",\"txSignature\":\"{}\",\"amountAtomic\":\"{}\"}}",
        escape_json(&tx_signature),
        escape_json(amount_atomic)
    );
    Ok((proof, format!("\"txSignature\":\"{}\"", escape_json(&tx_signature))))
}

fn select_market_resource(base: &BaseUrl, capability: &str) -> Result<(String, String, String), String> {
    let path = format!("/market/quotes?capability={}&limit=5", capability);
    let response = http_request(base, "GET", &path, &[], None)?;
    if response.status != 200 {
        return Err(format!("market quotes expected 200, got {}", response.status));
    }
    let shop_id = json_string(&response.body, "shopId")?;
    let endpoint_id = json_string(&response.body, "endpointId")?;
    let resource = json_string(&response.body, "path")?;
    Ok((resource, shop_id, endpoint_id))
}

fn pay_resource(base: &BaseUrl, resource: &str, agent_id: &str, settlement: &str, use_payment_helper: bool) -> Result<String, String> {
    let unpaid = http_request(base, "GET", resource, &[], None)?;
    if unpaid.status != 402 {
        return Err(format!("unpaid request expected 402, got {}", unpaid.status));
    }
    let quote_id = json_string(&unpaid.body, "quoteId")?;
    let total_atomic = json_string(&unpaid.body, "totalAtomic")?;
    let recipient = json_string(&unpaid.body, "recipient")?;
    let mint = json_string(&unpaid.body, "mint")?;
    let commitment = simple_hex(&format!("{agent_id}:{quote_id}"));
    let commit_body = format!(
        "{{\"quoteId\":\"{}\",\"payerCommitment32B\":\"{}\"}}",
        escape_json(&quote_id),
        commitment
    );
    let commit = http_request(base, "POST", "/commit", &[], Some(&commit_body))?;
    if commit.status != 201 {
        return Err(format!("commit expected 201, got {}: {}", commit.status, commit.body));
    }
    let commit_id = json_string(&commit.body, "commitId")?;
    let (payment_proof, proof_summary) = if use_payment_helper && (settlement == "transfer" || settlement == "stream") {
        payment_helper_proof(base, agent_id, &quote_id, settlement, &total_atomic, &recipient, &mint)?
    } else if settlement == "netting" {
        (
            format!(
                "{{\"settlement\":\"netting\",\"amountAtomic\":\"{}\",\"note\":\"rust-agent:{}\"}}",
                escape_json(&total_atomic),
                escape_json(agent_id)
            ),
            String::new(),
        )
    } else if settlement == "stream" {
        let stream_id = format!("rust-stream-{}", simple_hex(&format!("{agent_id}:{quote_id}:stream")));
        (
            format!(
                "{{\"settlement\":\"stream\",\"streamId\":\"{}\",\"amountAtomic\":\"{}\"}}",
                stream_id,
                escape_json(&total_atomic)
            ),
            format!("\"streamId\":\"{}\"", stream_id),
        )
    } else {
        let proof_sig = format!("rust-transfer-{}", simple_hex(&format!("{agent_id}:{quote_id}:transfer")));
        (
            format!(
                "{{\"settlement\":\"transfer\",\"txSignature\":\"{}\",\"amountAtomic\":\"{}\"}}",
                proof_sig,
                escape_json(&total_atomic)
            ),
            format!("\"txSignature\":\"{}\"", proof_sig),
        )
    };
    let finalize_body = format!(
        "{{\"commitId\":\"{}\",\"paymentProof\":{}}}",
        escape_json(&commit_id),
        payment_proof
    );
    let finalized = http_request(base, "POST", "/finalize", &[], Some(&finalize_body))?;
    if finalized.status != 200 {
        return Err(format!("finalize expected 200, got {}: {}", finalized.status, finalized.body));
    }
    let receipt_id = json_string(&finalized.body, "receiptId")?;
    let receipt_path = format!("/receipt/{receipt_id}");
    let receipt = http_request(base, "GET", &receipt_path, &[], None)?;
    if receipt.status != 200 {
        return Err(format!("receipt expected 200, got {}", receipt.status));
    }
    if !verify_signed_receipt_json(&receipt.body).map_err(|error| format!("native Rust receipt verification failed: {error:?}"))? {
        return Err("native Rust receipt signature verification failed".to_string());
    }
    let receipt_quote = json_string_after(&receipt.body, "\"payload\":", "quoteId")?;
    let receipt_commit = json_string_after(&receipt.body, "\"payload\":", "commitId")?;
    let receipt_hash = json_string(&receipt.body, "receiptHash")?;
    if receipt_quote != quote_id {
        return Err("receipt quoteId mismatch".to_string());
    }
    if receipt_commit != commit_id {
        return Err("receipt commitId mismatch".to_string());
    }
    let paid = http_request(base, "GET", resource, &[("x-dnp-commit-id", commit_id.as_str())], None)?;
    if paid.status != 200 {
        return Err(format!("paid request expected 200, got {}: {}", paid.status, paid.body));
    }
    let fixture_id = json_string(&paid.body, "fixtureId")?;
    let proof_segment = if proof_summary.is_empty() {
        String::new()
    } else {
        format!(",{proof_summary}")
    };
    Ok(format!(
        "\"resource\":\"{}\",\"settlement\":\"{}\"{},\"quoteId\":\"{}\",\"commitId\":\"{}\",\"receiptId\":\"{}\",\"receiptHash\":\"{}\",\"fixtureId\":\"{}\"",
        escape_json(resource),
        escape_json(settlement),
        proof_segment,
        escape_json(&quote_id),
        escape_json(&commit_id),
        escape_json(&receipt_id),
        escape_json(&receipt_hash),
        escape_json(&fixture_id)
    ))
}

fn run() -> Result<(), String> {
    let base_url = arg_value("--base-url", None).ok_or_else(|| "--base-url is required".to_string())?;
    let agent_id = arg_value("--agent-id", Some("rust-agent")).unwrap();
    let settlement = arg_value("--settlement", Some("transfer")).unwrap();
    let use_payment_helper = arg_value("--payment-helper-url", None).is_some();
    let base = parse_base_url(&base_url)?;
    let capability = arg_value("--market-capability", None);
    let direct_resource = arg_value("--resource", Some("/programmability/fixed-price")).unwrap();
    let (resource, shop_id, endpoint_id) = if let Some(capability) = capability {
        let selected = select_market_resource(&base, &capability)?;
        (selected.0, selected.1, selected.2)
    } else {
        (direct_resource, String::new(), String::new())
    };
    let paid = pay_resource(&base, &resource, &agent_id, &settlement, use_payment_helper)?;
    println!(
        "{{\"ok\":true,\"agentLanguage\":\"rust\",\"agentId\":\"{}\",\"marketQuote\":{{\"shopId\":\"{}\",\"endpointId\":\"{}\"}},{} }}",
        escape_json(&agent_id),
        escape_json(&shop_id),
        escape_json(&endpoint_id),
        paid
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{{\"ok\":false,\"error\":\"{}\"}}", escape_json(&error));
        std::process::exit(1);
    }
}
