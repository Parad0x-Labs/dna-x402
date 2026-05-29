/**
 * null-miner-sdk dual-track profile tests.
 */

import {
  OSS_PROFILE,
  COMMERCIAL_PROFILE,
  setProfile,
  getProfile,
  isCommercial,
  isNullEmissionActive,
  profileFingerprint,
  lotteryConfigFromProfile,
  flywheelConfigFromProfile,
} from "../src/config/profiles";

afterEach(() => {
  setProfile(OSS_PROFILE);
});

test("OSS profile uses devnet track", () => {
  expect(OSS_PROFILE.track).toBe("oss");
  expect(OSS_PROFILE.network).toBe("devnet");
});

test("OSS profile has zero fees and no NULL extraction", () => {
  expect(OSS_PROFILE.houseFeeBps).toBe(0);
  expect(OSS_PROFILE.nullEmissionPct).toBe(0);
  expect(OSS_PROFILE.lotteryTicketPriceNull).toBe(0);
  expect(OSS_PROFILE.maxNullPerEpochAtomic).toBe(0);
});

test("commercial profile uses mainnet-beta track", () => {
  expect(COMMERCIAL_PROFILE.track).toBe("commercial");
  expect(COMMERCIAL_PROFILE.network).toBe("mainnet-beta");
});

test("commercial profile labels the pilot as external-audit pending", () => {
  expect(COMMERCIAL_PROFILE.description.toLowerCase()).toContain("external audit pending");
});

test("commercial profile has pilot fee and emission accounting config", () => {
  expect(COMMERCIAL_PROFILE.houseFeeBps).toBe(50);
  expect(COMMERCIAL_PROFILE.nullEmissionPct).toBe(5);
  expect(COMMERCIAL_PROFILE.lotteryTicketPriceNull).toBe(10_000_000);
});

test("commercial profile pins the public NULL mint", () => {
  expect(COMMERCIAL_PROFILE.nullMint).toBe("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump");
});

test("default profile is OSS", () => {
  expect(getProfile().track).toBe("oss");
});

test("setProfile switches the active profile", () => {
  setProfile(COMMERCIAL_PROFILE);
  expect(getProfile().track).toBe("commercial");
});

test("isCommercial reflects the active profile", () => {
  expect(isCommercial()).toBe(false);
  setProfile(COMMERCIAL_PROFILE);
  expect(isCommercial()).toBe(true);
});

test("isNullEmissionActive reflects configured emission accounting", () => {
  expect(isNullEmissionActive()).toBe(false);
  setProfile(COMMERCIAL_PROFILE);
  expect(isNullEmissionActive()).toBe(true);
});

test("profileFingerprint is stable-length hex", () => {
  const fp = profileFingerprint(OSS_PROFILE);
  expect(fp).toHaveLength(16);
  expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
});

test("profileFingerprint separates OSS and commercial profiles", () => {
  expect(profileFingerprint(OSS_PROFILE)).not.toBe(profileFingerprint(COMMERCIAL_PROFILE));
});

test("lotteryConfigFromProfile maps OSS as zero-fee", () => {
  expect(lotteryConfigFromProfile(OSS_PROFILE).houseFeeBps).toBe(0);
  expect(lotteryConfigFromProfile(OSS_PROFILE).ticketPriceNull).toBe(0);
});

test("lotteryConfigFromProfile maps commercial as 50 bps", () => {
  expect(lotteryConfigFromProfile(COMMERCIAL_PROFILE).houseFeeBps).toBe(50);
  expect(lotteryConfigFromProfile(COMMERCIAL_PROFILE).ticketPriceNull).toBe(10_000_000);
});

test("flywheelConfigFromProfile maps OSS as disabled", () => {
  expect(flywheelConfigFromProfile(OSS_PROFILE).emissionRatePct).toBe(0);
  expect(flywheelConfigFromProfile(OSS_PROFILE).maxNullPerEpoch).toBe(0);
});

test("flywheelConfigFromProfile maps commercial emission accounting", () => {
  expect(flywheelConfigFromProfile(COMMERCIAL_PROFILE).emissionRatePct).toBe(5);
  expect(flywheelConfigFromProfile(COMMERCIAL_PROFILE).maxNullPerEpoch).toBe(1_000_000_000_000);
});

test("OSS program IDs use non-empty placeholders before devnet deploy", () => {
  expect(Object.values(OSS_PROFILE.programs).every((id) => id.length > 10)).toBe(true);
});

test("commercial program IDs stay explicit TODOs before mainnet deploy", () => {
  expect(Object.values(COMMERCIAL_PROFILE.programs).every((id) => id === "TODO_POST_DEPLOY")).toBe(true);
});

test("commercial profile uses the public Solana RPC", () => {
  expect(COMMERCIAL_PROFILE.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
});

test("OSS profile uses the public devnet RPC", () => {
  expect(OSS_PROFILE.rpcUrl).toBe("https://api.devnet.solana.com");
});

test("active profile resets to OSS after each test", () => {
  expect(getProfile()).toBe(OSS_PROFILE);
});
