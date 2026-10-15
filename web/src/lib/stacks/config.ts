import { STACKS_TESTNET, STACKS_MAINNET, StacksNetwork } from "@stacks/network";

export type NetworkType = "testnet" | "mainnet";

// STX flash loan core (reserve engine) — mainnet
export const STX_CONTRACT_ADDRESS = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
export const STX_CONTRACT_NAME = "flashstack-stx-core";

// sBTC flash loan core (canonical sBTC — mainnet)
export const SBTC_CONTRACT_ADDRESS = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
export const SBTC_CONTRACT_NAME = "flashstack-sbtc-core";
export const SBTC_TOKEN_ADDRESS = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
export const SBTC_TOKEN_NAME = "sbtc-token";

// LP Pool — external depositors earn yield from flash loan fees.
// v2 (hardened, virtual shares/assets) under the secure post-rotation wallet.
// The v1 pools (SP20XD46…) are deprecated and paused.
export const POOL_CONTRACT_ADDRESS = "SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG";
export const POOL_CONTRACT_NAME = "flashstack-stx-pool-v2";

// Multi-asset LP pool registry. Add a new asset here (e.g. USDCx) once its
// hardened pool is deployed — the UI is asset-driven, no per-asset code.
const POOL_DEPLOYER = "SPR9PQANV6XHSDNRAX2GNKCA5Z1KH61961KE0BYG";

export interface LpPoolMeta {
  symbol: string;
  decimals: number;
  sharePrecision: bigint;
  address: string;
  name: string;
  /** read-only fn returning an LP's asset value */
  valueFn: string;
  /** true if valueFn returns (ok uint) rather than a bare uint */
  valueWrapped: boolean;
  /** native STX vs a SIP-010 token — decides the deposit post-condition */
  nativeStx: boolean;
  /** SIP-010 contract id + asset name, for the fungible deposit post-condition */
  tokenContract?: string;
  tokenName?: string;
}

export const LP_POOLS = {
  stx: {
    symbol: "STX", decimals: 6, sharePrecision: 1_000_000n,
    address: POOL_DEPLOYER, name: "flashstack-stx-pool-v2",
    valueFn: "get-stx-value", valueWrapped: false, nativeStx: true,
  },
  sbtc: {
    symbol: "sBTC", decimals: 8, sharePrecision: 100_000_000n,
    address: POOL_DEPLOYER, name: "flashstack-sbtc-pool-v2",
    valueFn: "get-lp-value", valueWrapped: true, nativeStx: false,
    tokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    tokenName: "sbtc-token",
  },
} satisfies Record<string, LpPoolMeta>;

export type PoolAsset = keyof typeof LP_POOLS;

export const STX_RECEIVER_CONTRACTS = [
  { name: "stx-test-receiver", label: "STX Test Receiver", description: "Borrow STX, repay principal + fee", address: STX_CONTRACT_ADDRESS },
];

export const SBTC_RECEIVER_CONTRACTS = [
  { name: "sbtc-test-receiver", label: "sBTC Test Receiver", description: "Borrow canonical sBTC, repay principal + fee", address: SBTC_CONTRACT_ADDRESS },
];

export const HIRO_API_URLS: Record<NetworkType, string> = {
  testnet: "https://api.testnet.hiro.so",
  mainnet: "https://api.mainnet.hiro.so",
};

export function getNetwork(networkType: NetworkType): StacksNetwork {
  return networkType === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
}

export function getApiUrl(networkType: NetworkType): string {
  return HIRO_API_URLS[networkType];
}
