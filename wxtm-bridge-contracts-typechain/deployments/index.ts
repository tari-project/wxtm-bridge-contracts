import { KNOWN_CHAIN_IDS } from '../utils/chain'

import deployments from './deployments.json'

export type WagmiAddress = `0x${string}`

export interface Deployments {
    wXTM: WagmiAddress
    wXTMBridge: WagmiAddress
    wXTMController: WagmiAddress
    // wTARI set: undefined on chains without a wTARI deployment
    wTARI?: WagmiAddress
    wTARIController?: WagmiAddress
    wTARIBridge?: WagmiAddress
    wTARIBridgeStartBlock?: number
}

export type DeployedChainNames = keyof typeof KNOWN_CHAIN_IDS
export type DeployedChains = (typeof KNOWN_CHAIN_IDS)[DeployedChainNames]
export type DeployedChain = DeployedChains

const allDeployments = deployments as { [chainId: string]: { [name: string]: string | number } | undefined }

export function getDeployments(chainId: DeployedChain | number): Deployments {
    const dep = allDeployments[chainId] ?? {}

    return {
        wXTM: dep.wXTM as WagmiAddress,
        wXTMBridge: dep.wXTMBridge as WagmiAddress,
        wXTMController: dep.wXTMController as WagmiAddress,
        wTARI: dep.wTARI as WagmiAddress | undefined,
        wTARIController: dep.wTARIController as WagmiAddress | undefined,
        wTARIBridge: dep.wTARIBridge as WagmiAddress | undefined,
        wTARIBridgeStartBlock: dep.wTARIBridgeStartBlock as number | undefined,
    }
}

/** Chain ids with a wTARI deployment. */
export function getWtariChains(): number[] {
    const chains: number[] = []
    for (const chainId of Object.keys(allDeployments)) {
        if (allDeployments[chainId]?.wTARI) {
            chains.push(Number(chainId))
        }
    }
    return chains
}
