import fs from 'fs'
import path from 'path'

import { getSafeL2SingletonDeployments, getSafeSingletonDeployments } from '@safe-global/safe-deployments'
import { Contract, ethers, providers } from 'ethers'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import ProxyAdmin from 'hardhat-deploy/extendedArtifacts/ProxyAdmin.json'
import TransparentUpgradeableProxy from 'hardhat-deploy/extendedArtifacts/TransparentUpgradeableProxy.json'

import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { getDeploymentAddressAndAbi } from '@layerzerolabs/lz-evm-sdk-v2'

export interface WtariChainConfig {
    // Hardhat network for this chain; hardhat.config.ts adds it unless defined there by hand.
    network: { name: string; rpcUrlEnv: string; defaultRpcUrl: string; eid: number }
    // Etherscan V2 explorer used by verify:wtari (apiURL includes ?chainid=<id>); key is ETHERSCAN_API_KEY.
    explorer?: { apiURL: string; browserURL: string }
    // Production chains must deploy with the KMS signer and an explicit RPC env var.
    production: boolean
    // Initial wTARIController low-tier budget per fixed 24h window, in whole tokens.
    lowMintDailyLimit: number
    mintLowSafe: string
    mintHighSafe: string
    proxyAdminOwner: string
    confirmations: number
    // Ethereum chain whose mint Safes (REFERENCE_SAFES) the mint Safes must match.
    referenceChainId: number
    referenceRpcUrlEnv: string
}

export interface SafeTransaction {
    to: string
    value: string
    data: string
    description: string
}

// The wXTM mint Safes each chain's mint Safes must mirror (owners and threshold), by reference chain id.
export const REFERENCE_SAFES: { [chainId: number]: { mintLowSafe: string; mintHighSafe: string } } = {
    1: {
        mintLowSafe: '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
        mintHighSafe: '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
    },
    11155111: {
        mintLowSafe: '0x4b731EF14788f7371fAC837860Ed7bF2030344d2',
        mintHighSafe: '0x8aead919E7716a0840cB84495fA1AC76e04f7845',
    },
}

// Chains that are always production, whatever the config says.
const MAINNET_CHAIN_IDS = [1, 8453, 10, 42161, 137, 56, 43114]

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
const SAFE_GUARD_SLOT = ethers.utils.id('guard_manager.guard.address')
// v1.5.0 only; always zero on older versions.
const SAFE_MODULE_GUARD_SLOT = ethers.utils.id('module_manager.module_guard.address')

const PROXY_ADMIN_NAME = 'wTARIProxyAdmin'
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero
const MINTER_ROLE = ethers.utils.id('MINTER_ROLE')
const LOW_MINTER_ROLE = ethers.utils.id('LOW_MINTER_ROLE')
const HIGH_MINTER_ROLE = ethers.utils.id('HIGH_MINTER_ROLE')
const ROLE_NAMES: { [role: string]: string } = {
    [DEFAULT_ADMIN_ROLE]: 'DEFAULT_ADMIN_ROLE',
    [MINTER_ROLE]: 'MINTER_ROLE',
    [LOW_MINTER_ROLE]: 'LOW_MINTER_ROLE',
    [HIGH_MINTER_ROLE]: 'HIGH_MINTER_ROLE',
}
// EIP-1967 storage slots
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

const EVENTS = new ethers.utils.Interface([
    'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
    'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
    'event PeerSet(uint32 eid, bytes32 peer)',
    'event EnforcedOptionSet(tuple(uint32 eid, uint16 msgType, bytes options)[] _enforcedOptions)',
])
// Many RPCs cap eth_getLogs ranges, so logs are fetched in chunks.
const LOG_BLOCK_RANGE = 10_000

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

const CONFIG_DIR = path.join(__dirname, '..', 'deploy', 'wtari')
const RPC_ENV_PATTERN = /^[A-Z0-9_]+_RPC_URL$/

export function readWtariConfig(chainId: number): WtariChainConfig {
    const config: WtariChainConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${chainId}.json`), 'utf8'))
    const file = `deploy/wtari/${chainId}.json`
    // The config picks env var names and URLs, so keep it from routing secrets anywhere else.
    for (const name of [config.network.rpcUrlEnv, config.referenceRpcUrlEnv]) {
        if (!RPC_ENV_PATTERN.test(name)) {
            throw new Error(`${file}: RPC env var ${name} must match ${RPC_ENV_PATTERN}`)
        }
    }
    // Production protections (KMS, explicit RPC) must not be lost to a missing field, and only
    // mainnet chains compare against the Ethereum mainnet Safes.
    if (typeof config.production !== 'boolean') {
        throw new Error(`${file}: "production" must be true or false`)
    }
    if (MAINNET_CHAIN_IDS.includes(chainId) && !config.production) {
        throw new Error(`${file}: chain ${chainId} is a mainnet, so "production" must be true`)
    }
    if (config.production !== (config.referenceChainId === 1)) {
        throw new Error(`${file}: "production" must be true exactly when referenceChainId is 1 (Ethereum mainnet)`)
    }
    if (config.explorer) {
        const url = new URL(config.explorer.apiURL)
        if (url.protocol !== 'https:' || url.host !== 'api.etherscan.io') {
            throw new Error(`${file}: explorer.apiURL must be https://api.etherscan.io/...`)
        }
        if (url.searchParams.get('chainid') !== String(chainId)) {
            throw new Error(`${file}: explorer.apiURL must have chainid=${chainId}`)
        }
    }
    return config
}

/** Every deploy/wtari/<chainId>.json, as [chainId, config] pairs. */
export function listWtariConfigs(): [number, WtariChainConfig][] {
    const configs: [number, WtariChainConfig][] = []
    for (const file of fs.readdirSync(CONFIG_DIR)) {
        if (file.endsWith('.json')) {
            const chainId = Number(path.basename(file, '.json'))
            configs.push([chainId, readWtariConfig(chainId)])
        }
    }
    return configs
}

async function checkHasCode(provider: providers.Provider, label: string, address: string) {
    if ((await provider.getCode(address)) === '0x') {
        throw new Error(`${label} ${address} has no code on the target chain`)
    }
}

/**
 * Official SafeProxy code, official singleton, no modules, no guards; owners/threshold equal to the
 * reference Safe if given. Returns the threshold.
 */
async function checkSafe(
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

    const threshold = await target.getThreshold()
    if (!referenceProvider || !referenceSafe) return threshold
    const reference = new Contract(referenceSafe, SAFE_ABI, referenceProvider)
    const owners = (await target.getOwners()).map((a: string) => a.toLowerCase()).sort()
    const referenceOwners = (await reference.getOwners()).map((a: string) => a.toLowerCase()).sort()
    if (owners.join(',') !== referenceOwners.join(',')) {
        throw new Error(`${label} ${safe} owners differ from reference Safe ${referenceSafe}`)
    }
    const referenceThreshold = await reference.getThreshold()
    if (!threshold.eq(referenceThreshold)) {
        throw new Error(
            `${label} ${safe} threshold ${threshold} differs from reference Safe threshold ${referenceThreshold}`
        )
    }
    return threshold
}

async function checkSafes(
    provider: providers.Provider,
    referenceProvider: providers.Provider,
    config: WtariChainConfig
) {
    const reference = REFERENCE_SAFES[config.referenceChainId]
    if (!reference) throw new Error(`No reference Safes for referenceChainId ${config.referenceChainId}`)
    if ((await referenceProvider.getNetwork()).chainId !== config.referenceChainId) {
        throw new Error(`Reference provider is not on chain ${config.referenceChainId}`)
    }
    await checkSafe(provider, 'mintLowSafe', config.mintLowSafe, referenceProvider, reference.mintLowSafe)
    await checkSafe(provider, 'mintHighSafe', config.mintHighSafe, referenceProvider, reference.mintHighSafe)
    const adminThreshold = await checkSafe(provider, 'proxyAdminOwner', config.proxyAdminOwner)

    const low = config.mintLowSafe.toLowerCase()
    const high = config.mintHighSafe.toLowerCase()
    const admin = config.proxyAdminOwner.toLowerCase()
    if (low === high) throw new Error('mintLowSafe and mintHighSafe must be different Safes')
    if (admin === low || admin === high) throw new Error('proxyAdminOwner must differ from both mint Safes')
    if (adminThreshold.lt(2)) throw new Error(`proxyAdminOwner threshold ${adminThreshold} must be at least 2`)
}

/** Roles and ownership `account` holds on wTARI / wTARIController / wTARIProxyAdmin. */
async function heldControl(hre: HardhatRuntimeEnvironment, account: string): Promise<string[]> {
    const held: string[] = []
    for (const name of ['wTARI', 'wTARIController']) {
        for (const role of Object.keys(ROLE_NAMES)) {
            if (await hre.deployments.read(name, 'hasRole', role, account)) {
                held.push(`${name} ${ROLE_NAMES[role]}`)
            }
        }
    }
    for (const name of ['wTARI', PROXY_ADMIN_NAME]) {
        if ((await hre.deployments.read(name, 'owner')).toLowerCase() === account.toLowerCase()) {
            held.push(`${name} owner`)
        }
    }
    return held
}

/**
 * Deploys the three proxies with the proxyAdminOwner Safe as owner, LZ delegate and admin from the first
 * block. Returns the Safe transaction still needed to grant the controller MINTER_ROLE, if any.
 */
export async function deployWtari(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    lzEndpoint: string,
    referenceProvider: providers.Provider
): Promise<SafeTransaction | undefined> {
    const { deploy, read } = hre.deployments
    const provider = hre.ethers.provider

    await checkSafes(provider, referenceProvider, config)
    await checkHasCode(provider, 'LayerZero endpoint', lzEndpoint)

    const { deployer } = await hre.getNamedAccounts()
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    // All three proxies share one wTARI-specific admin owned by the proxyAdminOwner Safe.
    // The token deploy creates it; the controller and bridge reuse that deployment.
    const proxy = {
        proxyContract: 'OpenZeppelinTransparentProxy',
        owner: config.proxyAdminOwner,
        viaAdminContract: { name: PROXY_ADMIN_NAME },
    }

    const token = await deploy('wTARI', {
        from: deployer,
        args: [lzEndpoint],
        deterministicDeployment: ethers.utils.id('wTARI-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            viaAdminContract: { name: PROXY_ADMIN_NAME, artifact: ProxyAdmin },
            execute: {
                init: { methodName: 'initialize', args: ['WrappedTARI', 'wTARI', '1', config.proxyAdminOwner] },
            },
        },
    })

    const controller = await deploy('wTARIController', {
        from: deployer,
        args: [],
        deterministicDeployment: ethers.utils.id('wTARIController-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [
                        token.address,
                        config.mintLowSafe,
                        config.mintHighSafe,
                        config.proxyAdminOwner,
                        ethers.utils.parseEther(String(config.lowMintDailyLimit)),
                    ],
                },
            },
        },
    })

    const bridge = await deploy('wTARIBridge', {
        from: deployer,
        args: [],
        deterministicDeployment: ethers.utils.id('wTARIBridge-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: { init: { methodName: 'initialize', args: [token.address] } },
        },
    })

    console.log(`wTARI: ${token.address} (implementation ${token.implementation})`)
    console.log(`wTARIController: ${controller.address} (implementation ${controller.implementation})`)
    console.log(`wTARIBridge: ${bridge.address} (implementation ${bridge.implementation})`)

    // Only the Safe holds wTARI admin, so only the Safe can let the controller mint.
    if (await read('wTARI', 'hasRole', MINTER_ROLE, controller.address)) return undefined
    const pending: SafeTransaction = {
        to: token.address,
        value: '0',
        data: new ethers.utils.Interface(['function grantRole(bytes32 role, address account)']).encodeFunctionData(
            'grantRole',
            [MINTER_ROLE, controller.address]
        ),
        description: `wTARI(${token.address}).grantRole(MINTER_ROLE ${MINTER_ROLE}, wTARIController ${controller.address})`,
    }
    console.log(`Pending Safe transaction for proxyAdminOwner ${config.proxyAdminOwner}:`)
    console.log(`  to:    ${pending.to}`)
    console.log(`  value: ${pending.value}`)
    console.log(`  data:  ${pending.data}`)
    console.log(`  what:  ${pending.description}`)
    return pending
}

/** Events of interest emitted by `address` since `fromBlock`, oldest first. */
async function replayEvents(provider: providers.Provider, address: string, fromBlock: number) {
    const topics = [EVENTS.fragments.map((fragment) => EVENTS.getEventTopic(fragment.name))]
    const latest = await provider.getBlockNumber()
    const events: ethers.utils.LogDescription[] = []
    for (let start = fromBlock; start <= latest; start += LOG_BLOCK_RANGE) {
        const toBlock = Math.min(start + LOG_BLOCK_RANGE - 1, latest)
        for (const log of await provider.getLogs({ address, topics, fromBlock: start, toBlock })) {
            events.push(EVENTS.parseLog(log))
        }
    }
    return events
}

/** Compares the role holders rebuilt from events against `expected` ([role, account] pairs). */
function compareRoleHolders(name: string, events: ethers.utils.LogDescription[], expected: [string, string][]) {
    const holders = new Set<string>()
    for (const event of events) {
        const key = `${event.args.role}:${event.args.account?.toLowerCase()}`
        if (event.name === 'RoleGranted') holders.add(key)
        if (event.name === 'RoleRevoked') holders.delete(key)
    }
    const wanted = new Set(expected.map(([role, account]) => `${role}:${account.toLowerCase()}`))

    const failures: string[] = []
    for (const key of holders) {
        const [role, account] = key.split(':')
        if (!wanted.has(key)) failures.push(`${name}: unexpected ${ROLE_NAMES[role] ?? role} holder ${account}`)
    }
    for (const key of wanted) {
        const [role, account] = key.split(':')
        if (!holders.has(key)) failures.push(`${name}: no RoleGranted event for ${ROLE_NAMES[role]} to ${account}`)
    }
    return failures
}

/** The creation transaction of a deployment record, read from the chain (not from the record). */
async function creationTransaction(provider: providers.Provider, name: string, transactionHash?: string) {
    const tx = transactionHash ? await provider.getTransaction(transactionHash) : null
    if (!tx || tx.blockNumber == null) {
        throw new Error(`${name}: creation transaction ${transactionHash} not found on chain`)
    }
    return { from: tx.from, blockNumber: tx.blockNumber }
}

/** Zeroes the immutable ranges of a runtime bytecode so it can be compared with the compiled one. */
function maskImmutables(code: string, immutableReferences: { [id: string]: { start: number; length: number }[] }) {
    const bytes = ethers.utils.arrayify(code)
    for (const ranges of Object.values(immutableReferences)) {
        for (const { start, length } of ranges) bytes.fill(0, start, start + length)
    }
    return ethers.utils.hexlify(bytes)
}

/** Compiled runtime bytecode and immutable references for each deployed wTARI contract record. */
async function compiledRuntimes(hre: HardhatRuntimeEnvironment) {
    const compiled: [string, string, { [id: string]: { start: number; length: number }[] }][] = []
    for (const [record, sourceName, contractName] of [
        ['wTARI_Implementation', 'contracts/wTARI.sol', 'wTARI'],
        ['wTARIController_Implementation', 'contracts/wTARIController.sol', 'wTARIController'],
        ['wTARIBridge_Implementation', 'contracts/wTARIBridge.sol', 'wTARIBridge'],
    ]) {
        const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:${contractName}`)
        const deployed = buildInfo?.output.contracts[sourceName][contractName].evm.deployedBytecode
        if (!deployed) throw new Error(`No build info for ${sourceName}:${contractName}; run hardhat compile`)
        compiled.push([record, `0x${deployed.object}`, deployed.immutableReferences ?? {}])
    }
    for (const record of ['wTARI_Proxy', 'wTARIController_Proxy', 'wTARIBridge_Proxy']) {
        const proxyRefs = TransparentUpgradeableProxy.evm.deployedBytecode.immutableReferences
        compiled.push([record, TransparentUpgradeableProxy.deployedBytecode, proxyRefs])
    }
    compiled.push([PROXY_ADMIN_NAME, ProxyAdmin.deployedBytecode, ProxyAdmin.evm.deployedBytecode.immutableReferences])
    return compiled
}

/** Post-deploy review of Safes, roles, ownership, LZ config, bytecode and proxy slots. */
export async function checkWtariDeployment(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    referenceProvider: providers.Provider
) {
    const { get, read } = hre.deployments
    const provider = hre.ethers.provider
    const failures: string[] = []

    await checkSafes(provider, referenceProvider, config)

    const token = await get('wTARI')
    const controller = await get('wTARIController')
    const bridge = await get('wTARIBridge')
    const proxyAdmin = await get(PROXY_ADMIN_NAME)

    const expectedRoles: [string, string, string][] = [
        ['wTARI', MINTER_ROLE, controller.address],
        ['wTARI', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
        ['wTARIController', LOW_MINTER_ROLE, config.mintLowSafe],
        ['wTARIController', HIGH_MINTER_ROLE, config.mintHighSafe],
        ['wTARIController', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
    ]
    for (const [name, role, account] of expectedRoles) {
        if (!(await read(name, 'hasRole', role, account))) {
            failures.push(
                role === MINTER_ROLE
                    ? `wTARI: the controller does not have MINTER_ROLE yet; execute the pending Safe transaction printed by deploy:wtari`
                    : `${name}: ${account} is missing ${ROLE_NAMES[role]}`
            )
        }
        if ((await provider.getCode(account)) === '0x') {
            failures.push(`${name}: ${ROLE_NAMES[role]} holder ${account} has no code`)
        }
    }

    // The deployer and start blocks come from the creation transactions on chain, not from the record.
    const tokenCreation = await creationTransaction(provider, 'wTARI', token.transactionHash)
    const controllerCreation = await creationTransaction(provider, 'wTARIController', controller.transactionHash)
    const accounts = [tokenCreation.from]
    try {
        accounts.push((await hre.getNamedAccounts()).deployer)
    } catch {
        console.log('No signer available; checking only the deployer from the creation transaction')
    }
    for (const account of accounts) {
        if (!account) continue
        for (const held of await heldControl(hre, account)) {
            failures.push(`deployer ${account} holds ${held}`)
        }
    }

    const owner = await read('wTARI', 'owner')
    if (owner.toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`wTARI: owner ${owner} is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    if ((await read(PROXY_ADMIN_NAME, 'owner')).toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`${PROXY_ADMIN_NAME}: owner is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    const lzEndpoint = (await get('wTARI_Implementation')).args?.[0]
    const endpoint = new Contract(lzEndpoint, ['function delegates(address) view returns (address)'], provider)
    const delegate = await endpoint.delegates(token.address)
    if (delegate.toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`wTARI: LayerZero delegate ${delegate} is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    for (const getter of ['msgInspector', 'preCrime']) {
        const value = await read('wTARI', getter)
        if (value !== ethers.constants.AddressZero) failures.push(`wTARI: ${getter} is set to ${value}`)
    }

    const tokenEvents = await replayEvents(provider, token.address, tokenCreation.blockNumber)
    const controllerEvents = await replayEvents(provider, controller.address, controllerCreation.blockNumber)
    failures.push(
        ...compareRoleHolders(
            'wTARI',
            tokenEvents,
            expectedRoles.filter(([name]) => name === 'wTARI').map(([, role, account]) => [role, account])
        ),
        ...compareRoleHolders(
            'wTARIController',
            controllerEvents,
            expectedRoles.filter(([name]) => name === 'wTARIController').map(([, role, account]) => [role, account])
        )
    )
    for (const event of [...tokenEvents, ...controllerEvents]) {
        if (event.name === 'RoleGranted' && event.args.account.toLowerCase() === tokenCreation.from.toLowerCase()) {
            failures.push(
                `deployer ${tokenCreation.from} was granted ${ROLE_NAMES[event.args.role] ?? event.args.role}`
            )
        }
    }
    for (const event of tokenEvents) {
        if (event.name === 'PeerSet') failures.push(`wTARI: PeerSet emitted for eid ${event.args.eid}`)
        if (event.name === 'EnforcedOptionSet') failures.push('wTARI: EnforcedOptionSet emitted')
    }

    for (const [record, compiledCode, immutableReferences] of await compiledRuntimes(hre)) {
        const { address } = await get(record)
        const onChain = await provider.getCode(address)
        if (maskImmutables(onChain, immutableReferences) !== maskImmutables(compiledCode, immutableReferences)) {
            failures.push(`${record} ${address}: runtime bytecode differs from the compiled artifact`)
        }
    }

    for (const deployment of [token, controller, bridge]) {
        const admin = ethers.utils.hexDataSlice(await provider.getStorageAt(deployment.address, ADMIN_SLOT), 12)
        const implementation = ethers.utils.hexDataSlice(
            await provider.getStorageAt(deployment.address, IMPLEMENTATION_SLOT),
            12
        )
        console.log(`proxy ${deployment.address}: admin ${admin}, implementation ${implementation}`)
        if (admin.toLowerCase() !== proxyAdmin.address.toLowerCase()) {
            failures.push(
                `proxy ${deployment.address}: admin ${admin} is not ${PROXY_ADMIN_NAME} ${proxyAdmin.address}`
            )
        }
        if (implementation.toLowerCase() !== deployment.implementation?.toLowerCase()) {
            failures.push(`proxy ${deployment.address}: implementation ${implementation} differs from the record`)
        }
    }

    const limit = await read('wTARIController', 'lowMintDailyLimit')
    if (!limit.eq(ethers.utils.parseEther(String(config.lowMintDailyLimit)))) {
        failures.push(
            `wTARIController: lowMintDailyLimit ${ethers.utils.formatEther(limit)} is not ${config.lowMintDailyLimit}`
        )
    }

    if (failures.length > 0) {
        throw new Error(`wTARI deployment check failed:\n${failures.join('\n')}`)
    }
    console.log('wTARI deployment check passed')
}

// Every contract deploy:wtari creates, by hardhat-deploy record name.
const VERIFY_NAMES = [
    'wTARI_Implementation',
    'wTARIController_Implementation',
    'wTARIBridge_Implementation',
    'wTARI_Proxy',
    'wTARIController_Proxy',
    'wTARIBridge_Proxy',
    PROXY_ADMIN_NAME,
]

/** An "already verified" contract counts only if its published compiler and contract name match ours. */
async function checkPublishedSource(apiURL: string, apiKey: string, form: { [key: string]: string }) {
    const url = new URL(apiURL)
    url.searchParams.set('apikey', apiKey)
    url.searchParams.set('module', 'contract')
    url.searchParams.set('action', 'getsourcecode')
    url.searchParams.set('address', form.contractaddress)
    const published = (await (await fetch(url)).json()).result?.[0]
    const contractName = form.contractname.split(':')[1]
    if (published?.CompilerVersion !== form.compilerversion || published?.ContractName !== contractName) {
        throw new Error(
            `already verified with different source: ${published?.ContractName} ${published?.CompilerVersion}`
        )
    }
}

/** Submit one standard-JSON verification to an Etherscan V2 endpoint and wait for the result. */
export async function etherscanVerify(apiURL: string, apiKey: string, form: { [key: string]: string }) {
    const body = new URLSearchParams({ apikey: apiKey, module: 'contract', action: 'verifysourcecode', ...form })
    const submitted = await (await fetch(apiURL, { method: 'POST', body })).json()
    if (String(submitted.result).toLowerCase().includes('already verified')) {
        return checkPublishedSource(apiURL, apiKey, form)
    }
    if (submitted.status !== '1') {
        throw new Error(`submit failed: ${submitted.message} ${submitted.result}`)
    }

    const statusUrl = new URL(apiURL)
    statusUrl.searchParams.set('apikey', apiKey)
    statusUrl.searchParams.set('module', 'contract')
    statusUrl.searchParams.set('action', 'checkverifystatus')
    statusUrl.searchParams.set('guid', submitted.result)
    const deadline = Date.now() + 10 * 60 * 1000
    for (;;) {
        if (Date.now() > deadline) throw new Error('verification still pending after 10 minutes')
        const status = await (await fetch(statusUrl)).json()
        if (String(status.result).toLowerCase().includes('already verified')) {
            return checkPublishedSource(apiURL, apiKey, form)
        }
        if (status.result !== 'Pending in queue') {
            if (status.status === '1') return
            throw new Error(`verification failed: ${status.result}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
    }
}

/** Verify all wTARI contracts; throws listing every contract that is not verified. */
export async function verifyWtariContracts(hre: HardhatRuntimeEnvironment, config: WtariChainConfig) {
    if (!config.explorer) throw new Error('No explorer configured for this chain')
    const apiKey = process.env.ETHERSCAN_API_KEY
    if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not set')

    const unverified: string[] = []
    for (const name of VERIFY_NAMES) {
        const deployment = await hre.deployments.get(name)
        try {
            const metadata = JSON.parse(deployment.metadata as string)
            const [sourceName, contractName] = Object.entries(metadata.settings.compilationTarget)[0] as [
                string,
                string,
            ]
            const solcInputFile = path.join(
                hre.config.paths.deployments,
                hre.network.name,
                'solcInputs',
                `${deployment.solcInputHash}.json`
            )
            const constructor = deployment.abi.find((item) => item.type === 'constructor')
            const constructorArgs = constructor
                ? ethers.utils.defaultAbiCoder.encode(constructor.inputs, deployment.args ?? []).slice(2)
                : ''

            await etherscanVerify(config.explorer.apiURL, apiKey, {
                contractaddress: deployment.address,
                sourceCode: fs.readFileSync(solcInputFile, 'utf8'),
                codeformat: 'solidity-standard-json-input',
                contractname: `${sourceName}:${contractName}`,
                compilerversion: `v${metadata.compiler.version}`,
                constructorArguements: constructorArgs,
            })
            console.log(`verified ${name} ${config.explorer.browserURL}/address/${deployment.address}`)
        } catch (e) {
            unverified.push(`${name} ${deployment.address}: ${(e as Error).message}`)
        }
    }

    if (unverified.length > 0) {
        throw new Error(
            `Deployment is complete but these contracts are not verified (re-run verify:wtari):\n${unverified.join('\n')}`
        )
    }
}

async function assertChain(hre: HardhatRuntimeEnvironment, chain: number) {
    const chainId = Number(await hre.getChainId())
    if (chainId !== chain) {
        throw new Error(`--chain ${chain} does not match network ${hre.network.name} (chain ${chainId})`)
    }
}

/** Production chains must not fall back to a public default RPC. */
function assertProductionRpc(config: WtariChainConfig) {
    if (config.production && !process.env[config.network.rpcUrlEnv]) {
        throw new Error(`${config.network.rpcUrlEnv} must be set for a production chain`)
    }
}

function referenceProviderFor(config: WtariChainConfig) {
    const rpcUrl = process.env[config.referenceRpcUrlEnv]
    if (!rpcUrl) throw new Error(`${config.referenceRpcUrlEnv} is not set`)
    return new providers.JsonRpcProvider(rpcUrl)
}

/** Runs `action`, replacing any RPC URL (which may embed an API key) in its error with the env var name. */
export async function withRedactedRpcUrls(config: WtariChainConfig, action: () => Promise<void>) {
    try {
        await action()
    } catch (e) {
        let message = e instanceof Error ? e.message : String(e)
        for (const name of [config.network.rpcUrlEnv, config.referenceRpcUrlEnv]) {
            const url = process.env[name]
            if (url) message = message.split(url).join(`<${name}>`)
        }
        throw new Error(message)
    }
}

task('deploy:wtari', 'Deploy wTARI, wTARIController and wTARIBridge using deploy/wtari/<chain>.json')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        const config = readWtariConfig(chain)
        await withRedactedRpcUrls(config, async () => {
            await assertChain(hre, chain)
            assertProductionRpc(config)
            if (config.production && !(hre.network.config as { kmsKeyId?: string }).kmsKeyId) {
                throw new Error('A production chain must be deployed with the KMS signer: set KMS_KEY_ID')
            }
            const referenceProvider = referenceProviderFor(config)

            const lzNetwork = endpointIdToNetwork(config.network.eid as EndpointId)
            const { address: lzEndpoint } = getDeploymentAddressAndAbi(lzNetwork, 'EndpointV2')

            const pending = await deployWtari(hre, config, lzEndpoint, referenceProvider)
            if (!pending) await checkWtariDeployment(hre, config, referenceProvider)
            if (hre.network.name !== 'hardhat') await verifyWtariContracts(hre, config)
            if (pending) {
                console.log(
                    'deploy:wtari done, with one pending Safe transaction (above). Run check:wtari after it executes.'
                )
            }
        })
    })

task('verify:wtari', 'Verify all wTARI contracts on the chain explorer (Etherscan V2)')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        const config = readWtariConfig(chain)
        await withRedactedRpcUrls(config, async () => {
            await assertChain(hre, chain)
            await verifyWtariContracts(hre, config)
        })
    })

task('check:wtari', 'Check wTARI Safes, roles, ownership, LZ config, bytecode and proxies on the --network chain')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        const config = readWtariConfig(chain)
        await withRedactedRpcUrls(config, async () => {
            await assertChain(hre, chain)
            assertProductionRpc(config)
            await checkWtariDeployment(hre, config, referenceProviderFor(config))
        })
    })
