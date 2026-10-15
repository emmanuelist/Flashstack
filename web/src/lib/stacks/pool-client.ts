import {
  fetchCallReadOnlyFunction,
  cvToJSON,
  cvToHex,
  standardPrincipalCV,
} from "@stacks/transactions";
import { cachedRead } from "./read-cache";
import { LP_POOLS, PoolAsset, getNetwork, NetworkType } from "./config";
import type { PoolStats, PoolUserPosition } from "./types";

async function callReadOnly(
  asset: PoolAsset,
  functionName: string,
  functionArgs: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"],
  network: NetworkType
) {
  const pool = LP_POOLS[asset];
  const key = `${network}:${pool.address}.${pool.name}:${functionName}:${functionArgs.map((a) => cvToHex(a)).join(",")}`;
  const result = await cachedRead(key, () => fetchCallReadOnlyFunction({
    contractAddress: pool.address,
    contractName: pool.name,
    functionName,
    functionArgs,
    network: getNetwork(network),
    senderAddress: pool.address,
  }));
  return cvToJSON(result);
}

export async function fetchPoolStats(asset: PoolAsset, network: NetworkType): Promise<PoolStats> {
  const json = await callReadOnly(asset, "get-stats", [], network);
  const v = json.value.value;
  return {
    poolBalance:     BigInt(v["pool-balance"].value),
    totalShares:     BigInt(v["total-shares"].value),
    totalLoans:      parseInt(v["total-loans"].value, 10),
    totalVolume:     BigInt(v["total-volume"].value),
    totalFees:       BigInt(v["total-fees"].value),
    feeBasisPoints:  parseInt(v["fee-basis-points"].value, 10),
    paused:          v["paused"].value,
    maxSingleLoan:   BigInt(v["max-single-loan"].value),
  };
}

export async function fetchPoolUserPosition(
  asset: PoolAsset,
  address: string,
  network: NetworkType
): Promise<PoolUserPosition> {
  const pool = LP_POOLS[asset];
  const [sharesJson, valueJson] = await Promise.all([
    callReadOnly(asset, "get-shares", [standardPrincipalCV(address)], network),
    callReadOnly(asset, pool.valueFn, [standardPrincipalCV(address)], network),
  ]);
  // get-shares returns a bare uint; the value fn may return (ok uint).
  const value = pool.valueWrapped ? BigInt(valueJson.value.value) : BigInt(valueJson.value);
  return {
    shares:   BigInt(sharesJson.value),
    stxValue: value,
  };
}
