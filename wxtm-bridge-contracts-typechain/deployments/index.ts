import { KNOWN_CHAIN_IDS } from '../utils/chain'

import deployments from './deployments.json'

export type WagmiAddress = `0x${string}`

export interface Deployments {
    wXTM: WagmiAddress
    wXTMBridge: WagmiAddress
    wXTMController: WagmiAddress
}

export type DeployedChainNames = keyof typeof KNOWN_CHAIN_IDS
export type DeployedChains = (typeof KNOWN_CHAIN_IDS)[DeployedChainNames]
export type DeployedChain = DeployedChains

export function getDeployments(chainId: DeployedChain): Deployments {
    const dep = deployments[chainId]

    return {
        wXTM: dep.wXTM as WagmiAddress,
        wXTMBridge: dep.wXTMBridge as WagmiAddress,
        wXTMController: dep.wXTMController as WagmiAddress,
    }
}
