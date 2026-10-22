import fs from 'fs'
import path from 'path'

import { Contract, ethers, providers } from 'ethers'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import ProxyAdmin from 'hardhat-deploy/extendedArtifacts/ProxyAdmin.json'

import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { getDeploymentAddressAndAbi } from '@layerzerolabs/lz-evm-sdk-v2'

export interface WtariChainConfig {
    // Hardhat network for this chain; hardhat.config.ts adds it unless defined there by hand.
    network: { name: string; rpcUrlEnv: string; defaultRpcUrl: string; eid: number }
    // Etherscan V2 explorer used by verify:wtari (apiURL includes ?chainid=<id>); key is ETHERSCAN_API_KEY.
    explorer?: { apiURL: string; browserURL: string }
    // Production chains must deploy with the KMS signer and an explicit RPC env var.
    production: boolean
    // Initial wTARIController low-tier budget per 24h window, in whole tokens.
    lowMintDailyLimit: number
    mintLowSafe: string
    mintHighSafe: string
    proxyAdminOwner: string
    confirmations: number
    referenceChainId: number
    referenceRpcUrlEnv: string
    referenceMintLowSafe: string
    referenceMintHighSafe: string
}

const SAFE_ABI = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]
// Canonical singletons (@safe-global/safe-deployments): v1.3.0, v1.3.0 L2, v1.4.1, v1.4.1 L2.
const SAFE_SINGLETONS = [
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
    '0x41675c099f32341bf84bfc5382af534df5c7461a',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762',
]
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001'
const SAFE_GUARD_SLOT = ethers.utils.id('guard_manager.guard.address')

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
])
// Many RPCs cap eth_getLogs ranges, so logs are fetched in chunks.
const LOG_BLOCK_RANGE = 10_000

const CONFIG_DIR = path.join(__dirname, '..', 'deploy', 'wtari')
const RPC_ENV_PATTERN = /^[A-Z0-9_]+_RPC_URL$/

export function readWtariConfig(chainId: number): WtariChainConfig {
    const config: WtariChainConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${chainId}.json`), 'utf8'))
    // The config picks env var names and URLs, so keep it from routing secrets anywhere else.
    for (const name of [config.network.rpcUrlEnv, config.referenceRpcUrlEnv]) {
        if (!RPC_ENV_PATTERN.test(name)) {
            throw new Error(`deploy/wtari/${chainId}.json: RPC env var ${name} must match ${RPC_ENV_PATTERN}`)
        }
    }
    if (config.explorer && new URL(config.explorer.apiURL).host !== 'api.etherscan.io') {
        throw new Error(`deploy/wtari/${chainId}.json: explorer.apiURL must be on api.etherscan.io`)
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

/** Code, canonical singleton, no modules, no guard; and owners/threshold equal to the reference Safe if given. */
async function checkSafe(
    provider: providers.Provider,
    label: string,
    safe: string,
    referenceProvider?: providers.Provider,
    referenceSafe?: string
) {
    await checkHasCode(provider, label, safe)
    const target = new Contract(safe, SAFE_ABI, provider)

    const singleton = ethers.utils.hexDataSlice(await provider.getStorageAt(safe, 0), 12)
    if (!SAFE_SINGLETONS.includes(singleton.toLowerCase())) {
        throw new Error(`${label} ${safe} singleton ${singleton} is not a canonical Safe singleton`)
    }
    const [modules] = await target.getModulesPaginated(SAFE_SENTINEL, 10)
    if (modules.length > 0) {
        throw new Error(`${label} ${safe} has modules enabled: ${modules.join(', ')}`)
    }
    if (!ethers.BigNumber.from(await provider.getStorageAt(safe, SAFE_GUARD_SLOT)).isZero()) {
        throw new Error(`${label} ${safe} has a transaction guard set`)
    }

    if (!referenceProvider || !referenceSafe) return
    const reference = new Contract(referenceSafe, SAFE_ABI, referenceProvider)
    const owners = (await target.getOwners()).map((a: string) => a.toLowerCase()).sort()
    const referenceOwners = (await reference.getOwners()).map((a: string) => a.toLowerCase()).sort()
    if (owners.join(',') !== referenceOwners.join(',')) {
        throw new Error(`${label} ${safe} owners differ from reference Safe ${referenceSafe}`)
    }
    const threshold = await target.getThreshold()
    const referenceThreshold = await reference.getThreshold()
    if (!threshold.eq(referenceThreshold)) {
        throw new Error(
            `${label} ${safe} threshold ${threshold} differs from reference Safe threshold ${referenceThreshold}`
        )
    }
}

async function checkSafes(
    provider: providers.Provider,
    referenceProvider: providers.Provider,
    config: WtariChainConfig
) {
    if ((await referenceProvider.getNetwork()).chainId !== config.referenceChainId) {
        throw new Error(`Reference provider is not on chain ${config.referenceChainId}`)
    }
    await checkSafe(provider, 'mintLowSafe', config.mintLowSafe, referenceProvider, config.referenceMintLowSafe)
    await checkSafe(provider, 'mintHighSafe', config.mintHighSafe, referenceProvider, config.referenceMintHighSafe)
    if (config.mintLowSafe.toLowerCase() === config.mintHighSafe.toLowerCase()) {
        throw new Error('mintLowSafe and mintHighSafe must be different Safes')
    }
    await checkSafe(provider, 'proxyAdminOwner', config.proxyAdminOwner)
}

/** Roles and ownership `account` still holds on wTARI / wTARIController. */
async function heldControl(hre: HardhatRuntimeEnvironment, account: string): Promise<string[]> {
    const held: string[] = []
    for (const name of ['wTARI', 'wTARIController']) {
        for (const role of Object.keys(ROLE_NAMES)) {
            if (await hre.deployments.read(name, 'hasRole', role, account)) {
                held.push(`${name} ${ROLE_NAMES[role]}`)
            }
        }
    }
    if ((await hre.deployments.read('wTARI', 'owner')).toLowerCase() === account.toLowerCase()) {
        held.push('wTARI owner')
    }
    return held
}

/** The account that sent the wTARI proxy deployment, from the deployment record. */
async function recordedDeployer(hre: HardhatRuntimeEnvironment): Promise<string | undefined> {
    return (await hre.deployments.getOrNull('wTARI'))?.receipt?.from
}

export async function deployWtari(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    lzEndpoint: string,
    referenceProvider: providers.Provider
) {
    const { deploy, execute, read } = hre.deployments
    const provider = hre.ethers.provider

    await checkSafes(provider, referenceProvider, config)
    await checkHasCode(provider, 'LayerZero endpoint', lzEndpoint)

    const { deployer } = await hre.getNamedAccounts()
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    // A re-run with another key could not renounce the original deployer's leftover control.
    const original = await recordedDeployer(hre)
    if (original && original.toLowerCase() !== deployer.toLowerCase()) {
        const held = await heldControl(hre, original)
        if (held.length > 0) {
            throw new Error(
                `wTARI was deployed by ${original}, which still holds ${held.join(', ')}. ` +
                    `Re-run deploy:wtari with that signer to finish the handover.`
            )
        }
    }

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
            execute: { init: { methodName: 'initialize', args: ['WrappedTARI', 'wTARI', '1', deployer] } },
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

    // Hand the token over to proxyAdminOwner. Each step is skipped when already done, so a re-run
    // finishes an interrupted handover.
    const opts = { from: deployer, log: true, waitConfirmations: config.confirmations }
    if (!(await read('wTARI', 'hasRole', MINTER_ROLE, controller.address))) {
        await execute('wTARI', opts, 'grantRole', MINTER_ROLE, controller.address)
    }
    if (!(await read('wTARI', 'hasRole', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner))) {
        await execute('wTARI', opts, 'grantRole', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner)
    }
    // setDelegate is safe to repeat; both need the deployer to still be owner.
    if ((await read('wTARI', 'owner')).toLowerCase() === deployer.toLowerCase()) {
        await execute('wTARI', opts, 'setDelegate', config.proxyAdminOwner)
        await execute('wTARI', opts, 'transferOwnership', config.proxyAdminOwner)
    }
    if (await read('wTARI', 'hasRole', DEFAULT_ADMIN_ROLE, deployer)) {
        await execute('wTARI', opts, 'renounceRole', DEFAULT_ADMIN_ROLE, deployer)
    }

    console.log(`wTARI: ${token.address} (implementation ${token.implementation})`)
    console.log(`wTARIController: ${controller.address} (implementation ${controller.implementation})`)
    console.log(`wTARIBridge: ${bridge.address} (implementation ${bridge.implementation})`)
}

/** RoleGranted / RoleRevoked / PeerSet events emitted by `address` since `fromBlock`, oldest first. */
async function replayEvents(provider: providers.Provider, address: string, fromBlock: number) {
    const topics = [['RoleGranted', 'RoleRevoked', 'PeerSet'].map((name) => EVENTS.getEventTopic(name))]
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
        if (event.name === 'PeerSet') continue
        const key = `${event.args.role}:${event.args.account.toLowerCase()}`
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

/** Post-deploy review of Safes, role grants, ownership, LZ delegate/peers and proxy slots. */
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
            failures.push(`${name}: ${account} is missing ${ROLE_NAMES[role]}`)
        }
        if ((await provider.getCode(account)) === '0x') {
            failures.push(`${name}: ${ROLE_NAMES[role]} holder ${account} has no code`)
        }
    }

    // Both the recorded deployer and whoever runs this check must hold nothing.
    const accounts = [await recordedDeployer(hre)]
    try {
        accounts.push((await hre.getNamedAccounts()).deployer)
    } catch {
        console.log('No signer available; checking only the recorded deployer')
    }
    for (const account of accounts) {
        if (!account) continue
        for (const held of await heldControl(hre, account)) {
            failures.push(`deployer ${account} still holds ${held}`)
        }
    }

    if ((await read('wTARI', 'owner')).toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`wTARI: owner is not proxyAdminOwner ${config.proxyAdminOwner}`)
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

    const tokenEvents = await replayEvents(provider, token.address, token.receipt?.blockNumber ?? 0)
    const controllerEvents = await replayEvents(provider, controller.address, controller.receipt?.blockNumber ?? 0)
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
    const peers = new Map<number, string>()
    for (const event of tokenEvents) {
        if (event.name === 'PeerSet') peers.set(event.args.eid, event.args.peer)
    }
    for (const [eid, peer] of peers) {
        if (peer !== ethers.constants.HashZero) failures.push(`wTARI: OFT peer set for eid ${eid}: ${peer}`)
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
    console.log(
        `wTARIController lowMintDailyLimit: ${ethers.utils.formatEther(await read('wTARIController', 'lowMintDailyLimit'))}`
    )

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

/** Submit one standard-JSON verification to an Etherscan V2 endpoint and wait for the result. */
export async function etherscanVerify(apiURL: string, apiKey: string, form: { [key: string]: string }) {
    const body = new URLSearchParams({ apikey: apiKey, module: 'contract', action: 'verifysourcecode', ...form })
    const submitted = await (await fetch(apiURL, { method: 'POST', body })).json()
    if (String(submitted.result).toLowerCase().includes('already verified')) return
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
        if (String(status.result).toLowerCase().includes('already verified')) return
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

task('deploy:wtari', 'Deploy wTARI, wTARIController and wTARIBridge using deploy/wtari/<chain>.json')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        await assertChain(hre, chain)
        const config = readWtariConfig(chain)
        assertProductionRpc(config)
        if (config.production && !(hre.network.config as { kmsKeyId?: string }).kmsKeyId) {
            throw new Error('A production chain must be deployed with the KMS signer: set KMS_KEY_ID')
        }
        const referenceProvider = referenceProviderFor(config)

        const lzNetwork = endpointIdToNetwork(config.network.eid as EndpointId)
        const { address: lzEndpoint } = getDeploymentAddressAndAbi(lzNetwork, 'EndpointV2')

        await deployWtari(hre, config, lzEndpoint, referenceProvider)
        await checkWtariDeployment(hre, config, referenceProvider)
        if (hre.network.name !== 'hardhat') {
            await verifyWtariContracts(hre, config)
        }
    })

task('verify:wtari', 'Verify all wTARI contracts on the chain explorer (Etherscan V2)')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        await assertChain(hre, chain)
        await verifyWtariContracts(hre, readWtariConfig(chain))
    })

task('check:wtari', 'Check wTARI Safes, roles, ownership, LZ delegate/peers and proxies on the --network chain')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        await assertChain(hre, chain)
        const config = readWtariConfig(chain)
        assertProductionRpc(config)
        await checkWtariDeployment(hre, config, referenceProviderFor(config))
    })
