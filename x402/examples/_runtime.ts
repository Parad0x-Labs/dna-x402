export async function loadSdk() {
  try {
    return await import("dna-x402");
  } catch {
    return await import("../src/sdk/index.js");
  }
}

export async function loadSellerSdk() {
  try {
    return await import("dna-x402/seller");
  } catch {
    return await import("../src/sdk/seller.js");
  }
}

export async function loadDemoSdk() {
  try {
    return await import("dna-x402/demo");
  } catch {
    return await import("../src/demo/index.js");
  }
}
