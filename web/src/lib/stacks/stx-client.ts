import {
  fetchCallReadOnlyFunction,
  cvToJSON,
  cvToHex,
} from "@stacks/transactions";
import { cachedRead } from "./read-cache";
import { STX_CONTRACT_ADDRESS, STX_CONTRACT_NAME, getNetwork, NetworkType } from "./config";
import type { ProtocolStats } from "./types";

async function callReadOnly(
  functionName: string,
  functionArgs: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"],
  network: NetworkType
) {
  const key = `${network}:${STX_CONTRACT_ADDRESS}.${STX_CONTRACT_NAME}:${functionName}:${functionArgs.map((a) => cvToHex(a)).join(",")}`;
  const result = await cachedRead(key, () => fetchCallReadOnlyFunction({
    contractAddress: STX_CONTRACT_ADDRESS,
    contractName: STX_CONTRACT_NAME,
    functionName,
    functionArgs,
    network: getNetwork(network),
    senderAddress: STX_CONTRACT_ADDRESS,
  }));
  return cvToJSON(result);
}

export async function fetchStxProtocolStats(network: NetworkType): Promise<ProtocolStats> {
  const json = await callReadOnly("get-stats", [], network);
  const v = json.value.value;
  return {
    totalFlashMints: parseInt(v["total-loans"].value, 10),
    totalVolume:     BigInt(v["total-volume"].value),
    totalFeesCollected: BigInt(v["total-fees"].value),
    currentFeeBp:    parseInt(v["fee-basis-points"].value, 10),
    paused:          v["paused"].value,
    maxSingleLoan:   BigInt(v["max-single-loan"].value),
    reserve:         BigInt(v["reserve"].value),
  };
}
