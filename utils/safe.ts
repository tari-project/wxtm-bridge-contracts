import {
    getCompatibilityFallbackHandlerDeployments,
    getSafeL2SingletonDeployments,
    getSafeSingletonDeployments,
} from '@safe-global/safe-deployments'
import { Contract, ethers, providers } from 'ethers'

const SAFE_ABI = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]
const SAFE_VERSIONS = ['1.3.0', '1.4.1', '1.5.0']
// keccak256 of the SafeProxy runtime code each official factory deploys. v1.3.0 from the factories'
// proxyRuntimeCode(); v1.4.1 and v1.5.0 by simulating proxyCreationCode() (v1.4.1 matches the reference Safes).
const SAFE_PROXY_CODE_HASHES = [
    '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000', // v1.3.0
    '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c', // v1.4.1
    '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f', // v1.5.0
]
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001'
const SAFE_FALLBACK_HANDLER_SLOT = ethers.utils.id('fallback_manager.handler.address')
const SAFE_GUARD_SLOT = ethers.utils.id('guard_manager.guard.address')
// v1.5.0 only; always zero on older versions.
const SAFE_MODULE_GUARD_SLOT = ethers.utils.id('module_manager.module_guard.address')

/** Official Safe and SafeL2 singletons for `chainId`, from @safe-global/safe-deployments (lowercase). */
export function safeSingletons(chainId: number): string[] {
    // The local hardhat network is not listed; it uses Ethereum mainnet's set.
    const network = chainId === 31337 ? '1' : String(chainId)
    const singletons: string[] = []
    for (const version of SAFE_VERSIONS) {
        for (const deployment of [
            getSafeSingletonDeployments({ version }),
            getSafeL2SingletonDeployments({ version }),
        ]) {
            const addresses = deployment?.networkAddresses[network] ?? []
            for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
                singletons.push(address.toLowerCase())
            }
        }
    }
    return singletons
}

/**
 * Official CompatibilityFallbackHandler deployments for `chainId`, from @safe-global/safe-deployments (lowercase).
 * Safe's FallbackManager CALLs the handler for unknown selectors with the Safe as msg.sender, so only the
 * official CompatibilityFallbackHandler (whose functions only read the Safe, or simulate and revert) is allowed.
 * ExtensibleFallbackHandler is excluded because it can delegate calls and EIP-1271 verification to custom
 * handler contracts; TokenCallbackHandler is excluded because standard Safe setups never use it.
 */
export function safeFallbackHandlers(chainId: number): string[] {
    const network = chainId === 31337 ? '1' : String(chainId)
    const handlers: string[] = []
    for (const version of SAFE_VERSIONS) {
        const deployment = getCompatibilityFallbackHandlerDeployments({ version })
        const addresses = deployment?.networkAddresses[network] ?? []
        for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
            handlers.push(address.toLowerCase())
        }
    }
    return handlers
}

export async function checkHasCode(provider: providers.Provider, label: string, address: string) {
    if ((await provider.getCode(address)) === '0x') {
        throw new Error(`${label} ${address} has no code on the target chain`)
    }
}

/**
 * Official SafeProxy code, official singleton, official or zero fallback handler, no modules, no guards, at least one
 * owner and 1 <= threshold <= owners (an uninitialised proxy has neither); owners/threshold equal to the reference
 * Safe if given. Returns the owners and the threshold.
 */
export async function checkSafe(
    provider: providers.Provider,
    label: string,
    safe: string,
    referenceProvider?: providers.Provider,
    referenceSafe?: string
) {
    await checkHasCode(provider, label, safe)
    if (!SAFE_PROXY_CODE_HASHES.includes(ethers.utils.keccak256(await provider.getCode(safe)))) {
        throw new Error(`${label} ${safe} is not an official SafeProxy (runtime code hash mismatch)`)
    }
    const target = new Contract(safe, SAFE_ABI, provider)

    const singleton = ethers.utils.hexDataSlice(await provider.getStorageAt(safe, 0), 12)
    const { chainId } = await provider.getNetwork()
    if (!safeSingletons(chainId).includes(singleton.toLowerCase())) {
        throw new Error(`${label} ${safe} singleton ${singleton} is not an official Safe singleton on chain ${chainId}`)
    }
    // Zero is allowed deliberately: FallbackManager then returns without calling anything.
    const fallbackSlot = await provider.getStorageAt(safe, SAFE_FALLBACK_HANDLER_SLOT)
    if (!ethers.BigNumber.from(ethers.utils.hexDataSlice(fallbackSlot, 0, 12)).isZero()) {
        throw new Error(`${label} ${safe} fallback handler slot ${fallbackSlot} is not a clean address`)
    }
    const fallbackHandler = ethers.utils.hexDataSlice(fallbackSlot, 12)
    if (
        fallbackHandler !== ethers.constants.AddressZero &&
        !safeFallbackHandlers(chainId).includes(fallbackHandler.toLowerCase())
    ) {
        throw new Error(
            `${label} ${safe} fallback handler ${fallbackHandler} is not an official Safe fallback handler on chain ${chainId}`
        )
    }
    const [modules] = await target.getModulesPaginated(SAFE_SENTINEL, 10)
    if (modules.length > 0) {
        throw new Error(`${label} ${safe} has modules enabled: ${modules.join(', ')}`)
    }
    if (!ethers.BigNumber.from(await provider.getStorageAt(safe, SAFE_GUARD_SLOT)).isZero()) {
        throw new Error(`${label} ${safe} has a transaction guard set`)
    }
    if (!ethers.BigNumber.from(await provider.getStorageAt(safe, SAFE_MODULE_GUARD_SLOT)).isZero()) {
        throw new Error(`${label} ${safe} has a module guard set`)
    }

    const threshold: ethers.BigNumber = await target.getThreshold()
    const owners: string[] = await target.getOwners()
    if (owners.length === 0 || threshold.lt(1) || threshold.gt(owners.length)) {
        throw new Error(`${label} ${safe} has threshold ${threshold} of ${owners.length} owners`)
    }
    if (!referenceProvider || !referenceSafe) return { owners, threshold }
    const reference = new Contract(referenceSafe, SAFE_ABI, referenceProvider)
    const sorted = owners.map((a: string) => a.toLowerCase()).sort()
    const referenceOwners = (await reference.getOwners()).map((a: string) => a.toLowerCase()).sort()
    if (sorted.join(',') !== referenceOwners.join(',')) {
        throw new Error(`${label} ${safe} owners differ from reference Safe ${referenceSafe}`)
    }
    const referenceThreshold = await reference.getThreshold()
    if (!threshold.eq(referenceThreshold)) {
        throw new Error(
            `${label} ${safe} threshold ${threshold} differs from reference Safe threshold ${referenceThreshold}`
        )
    }
    return { owners, threshold }
}
