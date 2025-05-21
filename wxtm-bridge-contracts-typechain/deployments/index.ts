import { KNOWN_CHAIN_IDS } from '../utils/chain'

import deployments from './deployments.json'

export type WagmiAddress = `0x${string}`

export interface Deployments {
    wXTM: WagmiAddress
    wXTMBridge: WagmiAddress
    wXTMController: WagmiAddress
}

export type DeployedTestnetChainNames = keyof typeof KNOWN_CHAIN_IDS
export type DeployedTestnetChain = (typeof KNOWN_CHAIN_IDS)[DeployedTestnetChainNames]
export type DeployedChain = DeployedTestnetChain

export function getDeployments(chainId: DeployedChain): Deployments {
    const dep = deployments[chainId]

    return {
        wXTM: dep.wXTM as WagmiAddress,
        wXTMBridge: dep.wXTMBridge as WagmiAddress,
        wXTMController: dep.wXTMController as WagmiAddress,
    }
}
