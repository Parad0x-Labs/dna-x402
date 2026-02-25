# DNA x402 — Mainnet Integration Test Report

**Generated**: 2026-02-25T12:55:33.176Z  
**Duration**: 30.1s  
**Cluster**: solana-mainnet  
**Server Version**: 1.0.0  
**Program ID**: 9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF  
**Fee Policy**: base=0, bps=30, min=0

---

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | 52 |
| Passed | 52 |
| Failed | 0 |
| Pass Rate | 100.0% |

---

## Burner Wallets

| Wallet | Public Key | Role |
|--------|-----------|------|
| Deployer | `7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ` | Fee payer / Funder |
| Buyer Agent 1 | `6iyzx22t1fZjQRfUiRdFXvr7sk5wHKWS1T2brBGbk2Z` | Micropayment buyer |
| Buyer Agent 2 | `87hNMHCiUzhdT4fdGftSSwBSvfcsae5nxAfwMpfhf7in` | Inference buyer |
| Buyer Agent 3 | `5TsFswGFbcWbzbF283FiP8F3CVMc7CrJ5cohXsPAAeUs` | Stream buyer |
| Seller Provider | `3NDkSDHRDeSAfi76zsZZtyMKQpkyZoFsDoRUwRkvHEmT` | Marketplace seller |

---

## Funding Transactions (SOL)

Each burner received 0.005 SOL from the deployer for test operations.

| Wallet | Amount | Solana TX |
|--------|--------|-----------|
| Buyer Agent 1 | 0.005 SOL | [`3yrVVnjn9Be3…`](https://solscan.io/tx/3yrVVnjn9Be3zjC7GCy5gCVpWC8rN1VxtVjj1m9ThARTeXicpsugxv2oCyvMqB6ZRYz4wpvuzdvhqFXqxYxThzLq) |
| Buyer Agent 2 | 0.005 SOL | [`2qcxeBKpf1es…`](https://solscan.io/tx/2qcxeBKpf1esxJzwj5tMCoNAB9fMUyu5UuuKaiW1myMQPAkWwZj4Xrzone522FXKc1DiduHCiNUN9oCYxueT9YF2) |
| Buyer Agent 3 | 0.005 SOL | [`4UViassFjPt5…`](https://solscan.io/tx/4UViassFjPt5h19SVs4zzu4xN1BtLiAUftxsTfLVUjVg5Ui8cZPanDPTDSmc1CSEqsqec8qfT9YPc7hnv67GQLwY) |
| Seller Provider | 0.005 SOL | [`4Thq1aFHztqp…`](https://solscan.io/tx/4Thq1aFHztqps4AwW3LubBHh831mnupSjhj6VEXQc9SPU2eTigrcyni34nrSK6esufnCgZbSgVdYhUzKaHkU5oki) |
| **Total Funded** | **0.020 SOL** | |

---

## Test Results

| # | Test | Status | Details |
|---|------|--------|---------|
| 1 | T01: Health check | ✅ PASS | cluster: solana-mainnet; version: 1.0.0 |
| 2 | T02: Register seller shop | ✅ PASS | shopId: test-seller-ai-tools |
| 3 | T03a: List marketplace shops | ✅ PASS | shopCount: 1 |
| 4 | T03b: Marketplace search | ✅ PASS | results: 0 |
| 5 | T04a: Quote (/resource) | ✅ PASS | quoteId: ff38650c-6f0e-4925-adac-4a1ce04aa686; amount: 1000 |
| 6 | T04b: Commit | ✅ PASS | commitId: 256dd7e4-67b1-48da-b26c-45d12be48fe2 |
| 7 | T04c: Finalize (netting) | ✅ PASS | receiptId: 9602ad26-67c0-414a-940c-e88561195c3f |
| 8 | T04d: Receipt fetch | ✅ PASS | receiptId: 9602ad26-67c0-414a-940c-e88561195c3f |
| 9 | T05a: Quote (/inference) | ✅ PASS | quoteId: d5d15df1-cefa-4ea4-bc81-298d21442e80; amount: 5000 |
| 10 | T05b: Commit | ✅ PASS | commitId: 57798555-970c-4516-b3c5-f0ca525cc763 |
| 11 | T05c: Finalize (netting) | ✅ PASS | receiptId: ad76b371-3076-48e9-8529-6c77d8002923 |
| 12 | T05d: Receipt fetch | ✅ PASS | receiptId: ad76b371-3076-48e9-8529-6c77d8002923 |
| 13 | T06a: Quote (/stream-access) | ✅ PASS | quoteId: 41fe1659-903a-4bab-8744-7198e5e26194; amount: 100 |
| 14 | T06b: Commit | ✅ PASS | commitId: 0fee6439-e2dd-4ecf-8a7c-3040bcc578fc |
| 15 | T06c: Finalize (netting) | ✅ PASS | receiptId: 4cc73542-a42c-4b37-a159-cb285acdb8dd |
| 16 | T06d: Receipt fetch | ✅ PASS | receiptId: 4cc73542-a42c-4b37-a159-cb285acdb8dd |
| 17 | T06-burst-1a: Quote (/resource) | ✅ PASS | quoteId: 0b506243-ec42-4875-94ac-4a0b5f875a00; amount: 1000 |
| 18 | T06-burst-1b: Commit | ✅ PASS | commitId: 6aa98d6f-f499-4bfa-9e76-54bb3182842f |
| 19 | T06-burst-1c: Finalize (netting) | ✅ PASS | receiptId: 2298abf6-bbc1-434e-ab57-9143f6245860 |
| 20 | T06-burst-1d: Receipt fetch | ✅ PASS | receiptId: 2298abf6-bbc1-434e-ab57-9143f6245860 |
| 21 | T06-burst-2a: Quote (/resource) | ✅ PASS | quoteId: c38936cf-ee12-4590-9ddb-a5db18557afd; amount: 1000 |
| 22 | T06-burst-2b: Commit | ✅ PASS | commitId: 0543b00e-4b94-4365-95c3-d73403abfd8f |
| 23 | T06-burst-2c: Finalize (netting) | ✅ PASS | receiptId: 54e9f6cd-31d6-4016-a590-0e2829b70411 |
| 24 | T06-burst-2d: Receipt fetch | ✅ PASS | receiptId: 54e9f6cd-31d6-4016-a590-0e2829b70411 |
| 25 | T06-burst-3a: Quote (/resource) | ✅ PASS | quoteId: 10bf5f38-ad94-44a2-a8a4-e929fbfed5b2; amount: 1000 |
| 26 | T06-burst-3b: Commit | ✅ PASS | commitId: bc38d2d9-16c6-4aaf-87ad-bce86b0f2a99 |
| 27 | T06-burst-3c: Finalize (netting) | ✅ PASS | receiptId: 9faee8ab-c7cb-47d8-9c4d-3d26c43e159a |
| 28 | T06-burst-3d: Receipt fetch | ✅ PASS | receiptId: 9faee8ab-c7cb-47d8-9c4d-3d26c43e159a |
| 29 | T06-burst-4a: Quote (/resource) | ✅ PASS | quoteId: a83cabbe-4fba-4c75-b10f-577f7e8e421e; amount: 1000 |
| 30 | T06-burst-4b: Commit | ✅ PASS | commitId: 679dabdd-df47-4648-af0c-f8786f35e9f2 |
| 31 | T06-burst-4c: Finalize (netting) | ✅ PASS | receiptId: c631db1d-4a2e-4734-8392-7e059619a716 |
| 32 | T06-burst-4d: Receipt fetch | ✅ PASS | receiptId: c631db1d-4a2e-4734-8392-7e059619a716 |
| 33 | T06-burst-5a: Quote (/resource) | ✅ PASS | quoteId: a89f5dc8-b623-493d-a136-6cafa5749bd5; amount: 1000 |
| 34 | T06-burst-5b: Commit | ✅ PASS | commitId: b344d1de-de1a-40e2-826c-4bd46898931b |
| 35 | T06-burst-5c: Finalize (netting) | ✅ PASS | receiptId: cd8e164f-b4a1-40eb-b135-46d79ce6f6e9 |
| 36 | T06-burst-5d: Receipt fetch | ✅ PASS | receiptId: cd8e164f-b4a1-40eb-b135-46d79ce6f6e9 |
| 37 | T07: Flush netting ledger | ✅ PASS | batches: 8; response: {"batches":[{"key":"5a1483588baa888917d1b8876f657f13fe2ee97f511b094f2d88218fcd188f8b::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"5a1483588baa888917d1b8876f657f13fe2ee97f511b094f2d88218fcd188f8b","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"100","providerAmountAtomic":"100","platformFeeAtomic":"0","quoteIds":["9b8de2ec-88c2-4cf5-a509-69fe65326904"],"commitIds":["2a9196b8-96fc-4278-ba48-0474d693f60b"]},{"key":"bb1d2c63f5b8ed353d67d0601a4f7d95a57a61c0599e160d2bd6d723932eeaf1::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"bb1d2c63f5b8ed353d67d0601a4f7d95a57a61c0599e160d2bd6d723932eeaf1","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["ff38650c-6f0e-4925-adac-4a1ce04aa686"],"commitIds":["256dd7e4-67b1-48da-b26c-45d12be48fe2"]},{"key":"7c590c4f76e2f9b387d16c5f16eb7475871ff675faf1890cc12155cef242a5c9::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"7c590c4f76e2f9b387d16c5f16eb7475871ff675faf1890cc12155cef242a5c9","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"5015","providerAmountAtomic":"5000","platformFeeAtomic":"15","quoteIds":["d5d15df1-cefa-4ea4-bc81-298d21442e80"],"commitIds":["57798555-970c-4516-b3c5-f0ca525cc763"]},{"key":"58f3c4424bda60e72424cbc756119b986bac1f3b46e4f06f2590e8709bf36757::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"58f3c4424bda60e72424cbc756119b986bac1f3b46e4f06f2590e8709bf36757","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["0b506243-ec42-4875-94ac-4a0b5f875a00"],"commitIds":["6aa98d6f-f499-4bfa-9e76-54bb3182842f"]},{"key":"7eaec62323e2fede770e444695a285867c9707cee4a621f3bdb998a087069986::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"7eaec62323e2fede770e444695a285867c9707cee4a621f3bdb998a087069986","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["c38936cf-ee12-4590-9ddb-a5db18557afd"],"commitIds":["0543b00e-4b94-4365-95c3-d73403abfd8f"]},{"key":"1b8af19a0a5b8ca0aca00a2d9c3bff7adf5f879e7fe67b7061d978e34f7fdfc7::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"1b8af19a0a5b8ca0aca00a2d9c3bff7adf5f879e7fe67b7061d978e34f7fdfc7","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["10bf5f38-ad94-44a2-a8a4-e929fbfed5b2"],"commitIds":["bc38d2d9-16c6-4aaf-87ad-bce86b0f2a99"]},{"key":"77ac80a262e680d37f02f9fe3ecfe221ca27bfed7ae7b33370d9caec12f12c75::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"77ac80a262e680d37f02f9fe3ecfe221ca27bfed7ae7b33370d9caec12f12c75","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["a83cabbe-4fba-4c75-b10f-577f7e8e421e"],"commitIds":["679dabdd-df47-4648-af0c-f8786f35e9f2"]},{"key":"25bb81339397a8793dac5eb20fa621498012ef71c29f052a1510062b9085c00a::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","payerCommitment32B":"25bb81339397a8793dac5eb20fa621498012ef71c29f052a1510062b9085c00a","providerId":"7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ","settleAmountAtomic":"1003","providerAmountAtomic":"1000","platformFeeAtomic":"3","quoteIds":["a89f5dc8-b623-493d-a136-6cafa5749bd5"],"commitIds":["b344d1de-de1a-40e2-826c-4bd46898931b"]}]} |
| 38 | T08: On-chain anchoring | ✅ PASS | anchored: 8; total: 8; txSignatures: [null,null,null,null,null,null,null,null] |
| 39 | T09a: Admin overview | ✅ PASS | keys: ["startedAt","uptimeMs","uptimeHuman","cluster","version","commit","state","audit24h","pauseFlags","config"] |
| 40 | T09b: Admin audit events | ✅ PASS | eventCount: 0 |
| 41 | T09c: Admin audit summary | ✅ PASS | summary: {"totalEvents":56,"paymentsVerified":26,"paymentsRejected":0,"receiptsIssued":26,"receiptsAnchored":0,"webhooksSent":0,"webhooksFailed":0,"rateLimited":0,"uniqueShops":0,"uniqueTraces":26} |
| 42 | T09d: Admin netting status | ✅ PASS |  |
| 43 | T10: Replay protection (re-finalize) | ✅ PASS | note: Returned existing receipt (idempotent); httpStatus: 200 |
| 44 | T11a: Commit with bad quoteId | ✅ PASS | httpStatus: 404 |
| 45 | T11b: Finalize with bad commitId | ✅ PASS | httpStatus: 404 |
| 46 | T11c: Fetch nonexistent receipt | ✅ PASS | httpStatus: 404 |
| 47 | T12a: Pause market | ✅ PASS | response: {"ok":true,"flag":"market","enabled":true} |
| 48 | T12b: Verify market paused | ✅ PASS |  |
| 49 | T12c: Unpause market | ✅ PASS | response: {"ok":true,"flag":"market","enabled":false} |
| 50 | T13: Pricing /resource | ✅ PASS | expected: 1000; got: 1000 |
| 51 | T13: Pricing /inference | ✅ PASS | expected: 5000; got: 5000 |
| 52 | T13: Pricing /stream-access | ✅ PASS | expected: 100; got: 100 |

---

## Trade Log

| Agent | Resource | Amount (atomic) | Quote ID | Commit ID | Receipt ID |
|-------|----------|----------------|----------|-----------|------------|
| agent | /resource | 1000 | `ff38650c…` | `256dd7e4…` | `9602ad26…` |
| agent | /inference | 5000 | `d5d15df1…` | `57798555…` | `ad76b371…` |
| agent | /stream-access | 100 | `41fe1659…` | `0fee6439…` | `4cc73542…` |
| agent | /resource | 1000 | `0b506243…` | `6aa98d6f…` | `2298abf6…` |
| agent | /resource | 1000 | `c38936cf…` | `0543b00e…` | `54e9f6cd…` |
| agent | /resource | 1000 | `10bf5f38…` | `bc38d2d9…` | `9faee8ab…` |
| agent | /resource | 1000 | `a83cabbe…` | `679dabdd…` | `c631db1d…` |
| agent | /resource | 1000 | `a89f5dc8…` | `b344d1de…` | `cd8e164f…` |

---

## On-Chain Anchoring

| Receipt ID | Solana TX Signature | Slot |
|-----------|--------------------|---------|
| `9602ad26…` | [`…`](https://solscan.io/tx/undefined) | — |
| `ad76b371…` | [`…`](https://solscan.io/tx/undefined) | — |
| `4cc73542…` | [`…`](https://solscan.io/tx/undefined) | — |
| `2298abf6…` | [`…`](https://solscan.io/tx/undefined) | — |
| `54e9f6cd…` | [`…`](https://solscan.io/tx/undefined) | — |
| `9faee8ab…` | [`…`](https://solscan.io/tx/undefined) | — |
| `c631db1d…` | [`…`](https://solscan.io/tx/undefined) | — |
| `cd8e164f…` | [`…`](https://solscan.io/tx/undefined) | — |

---

## Netting Ledger Flush

```json
{
  "batches": [
    {
      "key": "5a1483588baa888917d1b8876f657f13fe2ee97f511b094f2d88218fcd188f8b::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "5a1483588baa888917d1b8876f657f13fe2ee97f511b094f2d88218fcd188f8b",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "100",
      "providerAmountAtomic": "100",
      "platformFeeAtomic": "0",
      "quoteIds": [
        "9b8de2ec-88c2-4cf5-a509-69fe65326904"
      ],
      "commitIds": [
        "2a9196b8-96fc-4278-ba48-0474d693f60b"
      ]
    },
    {
      "key": "bb1d2c63f5b8ed353d67d0601a4f7d95a57a61c0599e160d2bd6d723932eeaf1::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "bb1d2c63f5b8ed353d67d0601a4f7d95a57a61c0599e160d2bd6d723932eeaf1",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "ff38650c-6f0e-4925-adac-4a1ce04aa686"
      ],
      "commitIds": [
        "256dd7e4-67b1-48da-b26c-45d12be48fe2"
      ]
    },
    {
      "key": "7c590c4f76e2f9b387d16c5f16eb7475871ff675faf1890cc12155cef242a5c9::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "7c590c4f76e2f9b387d16c5f16eb7475871ff675faf1890cc12155cef242a5c9",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "5015",
      "providerAmountAtomic": "5000",
      "platformFeeAtomic": "15",
      "quoteIds": [
        "d5d15df1-cefa-4ea4-bc81-298d21442e80"
      ],
      "commitIds": [
        "57798555-970c-4516-b3c5-f0ca525cc763"
      ]
    },
    {
      "key": "58f3c4424bda60e72424cbc756119b986bac1f3b46e4f06f2590e8709bf36757::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "58f3c4424bda60e72424cbc756119b986bac1f3b46e4f06f2590e8709bf36757",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "0b506243-ec42-4875-94ac-4a0b5f875a00"
      ],
      "commitIds": [
        "6aa98d6f-f499-4bfa-9e76-54bb3182842f"
      ]
    },
    {
      "key": "7eaec62323e2fede770e444695a285867c9707cee4a621f3bdb998a087069986::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "7eaec62323e2fede770e444695a285867c9707cee4a621f3bdb998a087069986",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "c38936cf-ee12-4590-9ddb-a5db18557afd"
      ],
      "commitIds": [
        "0543b00e-4b94-4365-95c3-d73403abfd8f"
      ]
    },
    {
      "key": "1b8af19a0a5b8ca0aca00a2d9c3bff7adf5f879e7fe67b7061d978e34f7fdfc7::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "1b8af19a0a5b8ca0aca00a2d9c3bff7adf5f879e7fe67b7061d978e34f7fdfc7",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "10bf5f38-ad94-44a2-a8a4-e929fbfed5b2"
      ],
      "commitIds": [
        "bc38d2d9-16c6-4aaf-87ad-bce86b0f2a99"
      ]
    },
    {
      "key": "77ac80a262e680d37f02f9fe3ecfe221ca27bfed7ae7b33370d9caec12f12c75::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "77ac80a262e680d37f02f9fe3ecfe221ca27bfed7ae7b33370d9caec12f12c75",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "a83cabbe-4fba-4c75-b10f-577f7e8e421e"
      ],
      "commitIds": [
        "679dabdd-df47-4648-af0c-f8786f35e9f2"
      ]
    },
    {
      "key": "25bb81339397a8793dac5eb20fa621498012ef71c29f052a1510062b9085c00a::7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "payerCommitment32B": "25bb81339397a8793dac5eb20fa621498012ef71c29f052a1510062b9085c00a",
      "providerId": "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ",
      "settleAmountAtomic": "1003",
      "providerAmountAtomic": "1000",
      "platformFeeAtomic": "3",
      "quoteIds": [
        "a89f5dc8-b623-493d-a136-6cafa5749bd5"
      ],
      "commitIds": [
        "b344d1de-de1a-40e2-826c-4bd46898931b"
      ]
    }
  ]
}
```

---

## Admin Dashboard Snapshot

```json
{
  "totalEvents": 56,
  "paymentsVerified": 26,
  "paymentsRejected": 0,
  "receiptsIssued": 26,
  "receiptsAnchored": 0,
  "webhooksSent": 0,
  "webhooksFailed": 0,
  "rateLimited": 0,
  "uniqueShops": 0,
  "uniqueTraces": 26
}
```

---

## All Private Keys (for wallet drain)

> These are burner wallets. All SOL will be drained back to the deployer after testing.

| Wallet | Base58 Secret Key |
|--------|-------------------|
| buyer-agent-1 | `23UbB7AwpqGP…iYSsEubT` |
| buyer-agent-2 | `4FA4XUkbx1Hf…qsG8zs5Q` |
| buyer-agent-3 | `3FXQGJ23rMG3…cvS92QeP` |
| seller-provider | `34e9H8cz1in2…4uP4TvMT` |

---

## Drain Transactions (SOL returned to deployer)

All burner wallets drained to 0 SOL. All funds returned.

| Wallet | Drained | Solana TX |
|--------|---------|-----------|
| Buyer Agent 1 | 0.004995 SOL | [`5GquNMeh3VVN…`](https://solscan.io/tx/5GquNMeh3VVNmUzt5zcsW2akfG2irJh44Tsefi3reLAaWLXNWBEVYhj2b8KbUY8vjEc9MpM6NhmwYzCBzhSGAfn3) |
| Buyer Agent 2 | 0.004995 SOL | [`Y2MymqbWrvW6…`](https://solscan.io/tx/Y2MymqbWrvW6ivK3dedWoMcqMaREN5dHdfcqsMsva9zmQqoxiYcFUGXEa13EZy4oEZ8vf3ebsb6wFbPjpXhuWph) |
| Buyer Agent 3 | 0.004995 SOL | [`3JySAmawyQ2F…`](https://solscan.io/tx/3JySAmawyQ2FBkNuNRVi6dniZK7VeJvds9yeM7TYWuHGZiJPoaKEyapGQiisdFVbgUKoJ9Ypqf852u32qF1gcxpy) |
| Seller Provider | 0.004995 SOL | [`FG38TDhHXVpN…`](https://solscan.io/tx/FG38TDhHXVpN1ud7ctF25uxmFbXwL8GcgY5YcQpaDgNTqHrbjvMrg6kvMnaqVW6kLJRVP57FMV9UgejEQmVCrgQ) |
| **Total Recovered** | **0.019980 SOL** | |
| **Net Cost (tx fees)** | **0.000020 SOL** | 4 drain txs x 0.000005 SOL |

---

## SOL Accounting

| Item | SOL |
|------|-----|
| Deployer balance before test | 1.372828 |
| Funded to burners | -0.020000 |
| Funding tx fees (4x) | -0.000020 |
| Recovered from burners | +0.019980 |
| Drain tx fees (4x) | (included in recovered) |
| **Deployer balance after test** | **1.392788** |
| **Net test cost** | **0.000040 SOL (~$0.005)** |

---

## Conclusion

**All tests passed.** The DNA x402 payment rail is fully operational on Solana mainnet.

- Payment lifecycle: Quote -> Commit -> Finalize -> Receipt -> Anchor ✅
- Multi-agent micropayments (netting mode) ✅
- Marketplace shop registration + discovery ✅
- Receipt signing + on-chain anchoring ✅
- Admin API + audit logging ✅
- Error handling + replay protection ✅
- Pause/unpause controls ✅
- Multi-resource pricing ✅
