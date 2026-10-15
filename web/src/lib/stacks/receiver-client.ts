import {
  fetchCallReadOnlyFunction,
  cvToJSON,
  cvToHex,
  contractPrincipalCV,
} from "@stacks/transactions";
import { cachedRead } from "./read-cache";
import {
  STX_CONTRACT_ADDRESS,
  STX_CONTRACT_NAME,
  SBTC_CONTRACT_ADDRESS,
  SBTC_CONTRACT_NAME,
  getNetwork,
  NetworkType,
} from "./config";

export type FlashCore = "stx" | "sbtc";

const CORES: Record<FlashCore, { address: string; name: string }> = {
  stx:  { address: STX_CONTRACT_ADDRESS,  name: STX_CONTRACT_NAME },
  sbtc: { address: SBTC_CONTRACT_ADDRESS, name: SBTC_CONTRACT_NAME },
};

async function callReadOnly(
  core: FlashCore,
  functionName: string,
  functionArgs: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"],
  network: NetworkType
) {
  const { address, name } = CORES[core];
  const key = `${network}:${address}.${name}:${functionName}:${functionArgs.map((a) => cvToHex(a)).join(",")}`;
  const result = await cachedRead(key, () => fetchCallReadOnlyFunction({
    contractAddress: address,
    contractName: name,
    functionName,
    functionArgs,
    network: getNetwork(network),
    senderAddress: address,
  }));
  return cvToJSON(result);
}

/** Whether the core will accept `receiver` in flash-loan right now. */
export async function fetchReceiverApproved(
  core: FlashCore,
  receiver: { address: string; name: string },
  network: NetworkType
): Promise<boolean> {
  const json = await callReadOnly(
    core,
    "is-approved-receiver",
    [contractPrincipalCV(receiver.address, receiver.name)],
    network
  );
  // stx-core returns a bare bool; sbtc-core returns (ok bool).
  return "success" in json ? json.value.value : json.value;
}

export async function fetchCorePaused(core: FlashCore, network: NetworkType): Promise<boolean> {
  const json = await callReadOnly(core, "get-stats", [], network);
  return json.value.value["paused"].value;
}
