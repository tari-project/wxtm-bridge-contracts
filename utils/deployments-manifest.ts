import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Serialized, atomic updates of the package's deployments.json, shared by concurrent export-deployments runs
 * (one per chain). Without this, two runs that read the file before either wrote it each write back their own
 * stale snapshot plus one chain, silently dropping the other run's chain.
 */

export type Manifest<T> = { [chainId: string]: T }

export interface LockOptions {
    /** Give up acquiring the lock after this long. */
    timeoutMs?: number
    /** A lock older than this is stale even if its holder looks alive (the critical section takes milliseconds). */
    staleMs?: number
    pollMs?: number
}

const DEFAULTS: Required<LockOptions> = { timeoutMs: 60_000, staleMs: 30_000, pollMs: 50 }

export function readManifest<T>(file: string): Manifest<T> {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

/** Writes `file` via a temp file in the same directory, fsync and rename, so readers never see a partial file. */
export function writeFileAtomic(file: string, contents: string) {
    const tmp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    )
    const fd = fs.openSync(tmp, 'wx', 0o644)
    try {
        fs.writeFileSync(fd, contents)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    try {
        fs.renameSync(tmp, file)
    } catch (e) {
        fs.rmSync(tmp, { force: true })
        throw e
    }
    try {
        const dir = fs.openSync(path.dirname(file), 'r')
        try {
            fs.fsyncSync(dir)
        } finally {
            fs.closeSync(dir)
        }
    } catch {
        // Directory fsync is best effort (not supported on every platform).
    }
}

function processAlive(pid: number) {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function isStale(lockFile: string, contents: string, staleMs: number) {
    let mtimeMs: number
    try {
        mtimeMs = fs.statSync(lockFile).mtimeMs
    } catch {
        return false // gone already; just retry
    }
    if (Date.now() - mtimeMs > staleMs) return true
    const [pid, host] = contents.split(':')
    // A holder on this host that no longer exists left the lock behind (crash or kill -9).
    return host === os.hostname() && Number(pid) > 0 && !processAlive(Number(pid))
}

/**
 * Runs `fn` while holding `<file>.lock`, created with O_EXCL ('wx'). A stale lock (holder process gone, or
 * older than staleMs) is moved aside atomically and removed; if what was moved aside turns out to be a fresh
 * lock taken in between, it is put back.
 */
export async function withFileLock<R>(file: string, fn: () => R | Promise<R>, options: LockOptions = {}): Promise<R> {
    const { timeoutMs, staleMs, pollMs } = { ...DEFAULTS, ...options }
    const lockFile = `${file}.lock`
    const token = `${process.pid}:${os.hostname()}:${randomBytes(8).toString('hex')}`
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            fs.writeFileSync(lockFile, token, { flag: 'wx' })
            break
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
        let holder = ''
        try {
            holder = fs.readFileSync(lockFile, 'utf8')
        } catch {
            continue // released between our attempts
        }
        if (isStale(lockFile, holder, staleMs)) {
            const aside = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
            try {
                fs.renameSync(lockFile, aside)
                if (fs.readFileSync(aside, 'utf8') !== holder) {
                    // Someone else replaced the stale lock first; restore theirs (fails if a third took it).
                    try {
                        fs.linkSync(aside, lockFile)
                    } catch {
                        // ignore
                    }
                }
                fs.rmSync(aside, { force: true })
            } catch {
                // Another process handled the stale lock; retry.
            }
            continue
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${lockFile} (held by ${holder}); remove it if no export is running`)
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    try {
        return await fn()
    } finally {
        try {
            if (fs.readFileSync(lockFile, 'utf8') === token) fs.rmSync(lockFile)
        } catch {
            // already removed
        }
    }
}

/**
 * Sets `manifest[chainId] = entry` under the lock, re-reading the file first so other chains written since
 * `previous` was read are kept. Fails if this chain's entry itself changed since `previous` (a concurrent export
 * of the same chain), instead of overwriting the other run's result.
 */
export async function updateManifestEntry<T>(
    file: string,
    chainId: string,
    previous: T | undefined,
    entry: T,
    options?: LockOptions
) {
    await withFileLock(
        file,
        () => {
            const current = readManifest<T>(file)
            if (JSON.stringify(current[chainId]) !== JSON.stringify(previous)) {
                throw new Error(
                    `${file}: the entry for chain ${chainId} changed while this export ran (concurrent export of the same chain); re-run the export`
                )
            }
            current[chainId] = entry
            writeFileAtomic(file, JSON.stringify(current, null, 2))
        },
        options
    )
}

export const WTARI_PROXY_ADMIN_NAME = 'wTARIProxyAdmin'

// The hardhat-deploy records deploy:wtari creates; exactly these are exported to the package.
export const WTARI_RECORD_NAMES = [
    WTARI_PROXY_ADMIN_NAME,
    'wTARI',
    'wTARI_Proxy',
    'wTARI_Implementation',
    'wTARIController',
    'wTARIController_Proxy',
    'wTARIController_Implementation',
    'wTARIBridge',
    'wTARIBridge_Proxy',
    'wTARIBridge_Implementation',
] as const

/** The only key a package entry may carry beyond the committed deployment records (written by export-deployments). */
export const PACKAGE_EXTRA_KEYS = ['wTARIBridgeStartBlock']

// Own keys only: `in` also sees inherited keys such as constructor, toString or __proto__.
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

/**
 * Addresses of the committed hardhat-deploy records in one network directory (`deployments/<network>/*.json`),
 * by record name. Only these records belong in the package: hardhat-deploy's `deployments.all()` also returns
 * external (LayerZero) deployments, whose DefaultProxyAdmin overrides ours.
 */
export function localDeploymentAddresses(networkDir: string): { [name: string]: string } {
    const addresses: { [name: string]: string } = {}
    for (const file of fs.readdirSync(networkDir).sort()) {
        if (!file.endsWith('.json') || !fs.statSync(path.join(networkDir, file)).isFile()) continue
        const { address } = JSON.parse(fs.readFileSync(path.join(networkDir, file), 'utf8'))
        if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
            throw new Error(`${path.join(networkDir, file)} has no valid address`)
        }
        const name = path.basename(file, '.json')
        if (name === '__proto__') throw new Error(`${path.join(networkDir, file)}: invalid record name`)
        addresses[name] = address
    }
    return addresses
}

/** Network directories under `deploymentsDir` that have a hardhat-deploy `.chainId` file, by chain id. */
export function localDeploymentChains(deploymentsDir: string) {
    const chains: { [chainId: string]: string[] } = {}
    for (const network of fs.readdirSync(deploymentsDir).sort()) {
        const chainIdFile = path.join(deploymentsDir, network, '.chainId')
        if (!fs.existsSync(chainIdFile)) continue
        const chainId = fs.readFileSync(chainIdFile, 'utf8').trim()
        if (!/^\d+$/.test(chainId)) throw new Error(`${chainIdFile}: ${chainId} is not a decimal chain id`)
        ;(chains[chainId] ??= []).push(network)
    }
    return chains
}

/**
 * Offline check that the package's deployments.json holds exactly the committed deployment records: for every
 * `deployments/<network>` with a `.chainId`, the chain's entry has the same record names and addresses, plus at
 * most PACKAGE_EXTRA_KEYS; and every chain in the manifest has such a directory. Returns the problems found.
 */
export function packageDeploymentProblems(
    manifest: Manifest<{ [key: string]: string | number }>,
    deploymentsDir: string
) {
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        return ['deployments.json is not an object of chain entries']
    }
    const problems: string[] = []
    const chains = localDeploymentChains(deploymentsDir)
    for (const [chainId, networks] of Object.entries(chains)) {
        if (networks.length > 1) {
            problems.push(`chain ${chainId}: several deployment directories (${networks.join(', ')})`)
            continue
        }
        if (!hasOwn(manifest, chainId)) {
            problems.push(`chain ${chainId}: missing from the package (deployments/${networks[0]} exists)`)
            continue
        }
        const entry: unknown = manifest[chainId]
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            problems.push(`chain ${chainId}: entry is not an object`)
            continue
        }
        const values = entry as { [key: string]: unknown }
        const local = localDeploymentAddresses(path.join(deploymentsDir, networks[0]))
        for (const [name, address] of Object.entries(local)) {
            if (!hasOwn(values, name)) problems.push(`chain ${chainId}: missing ${name}`)
            else if (values[name] !== address) {
                problems.push(`chain ${chainId}: ${name} is ${values[name]}, deployments/${networks[0]} has ${address}`)
            }
        }
        for (const key of Object.keys(values)) {
            if (PACKAGE_EXTRA_KEYS.includes(key)) {
                if (typeof values[key] !== 'number') problems.push(`chain ${chainId}: ${key} is not a number`)
            } else if (!hasOwn(local, key)) {
                problems.push(`chain ${chainId}: ${key} has no deployments/${networks[0]}/${key}.json`)
            }
        }
    }
    for (const chainId of Object.keys(manifest)) {
        if (!/^\d+$/.test(chainId)) problems.push(`chain ${chainId}: not a decimal chain id`)
        else if (!hasOwn(chains, chainId)) {
            problems.push(`chain ${chainId}: no deployments/<network> directory with this .chainId`)
        }
    }
    return problems
}

/**
 * Offline check of the wTARI keys in the package's deployments.json against deploy/wtari/<chainId>.json (Node
 * builtins only, so the publish workflow's check job can run it): every chain with wTARI* keys has exactly
 * WTARI_RECORD_NAMES plus wTARIBridgeStartBlock, a config file, and a config bridgeStartBlock equal to
 * wTARIBridgeStartBlock. The CREATE2 address recomputation is in wtariPackageProblems (tasks/wtari.ts).
 */
export function wtariStartBlockProblems(manifest: unknown, wtariConfigDir: string) {
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        return ['deployments.json is not an object of chain entries']
    }
    const problems: string[] = []
    const wanted = [...WTARI_RECORD_NAMES, 'wTARIBridgeStartBlock'].sort()
    for (const [chainId, entry] of Object.entries(manifest)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
        const values = entry as { [key: string]: unknown }
        const keys = Object.keys(values)
            .filter((key) => key.startsWith('wTARI'))
            .sort()
        if (keys.length === 0) continue
        if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
            problems.push(`chain ${chainId}: wTARI keys ${keys.join(', ')} are not exactly ${wanted.join(', ')}`)
        }
        const configFile = path.join(wtariConfigDir, `${chainId}.json`)
        if (!/^\d+$/.test(chainId) || !fs.existsSync(configFile)) {
            problems.push(`chain ${chainId}: has wTARI keys but no deploy/wtari/${chainId}.json`)
            continue
        }
        const { bridgeStartBlock } = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        if (!Number.isInteger(bridgeStartBlock) || bridgeStartBlock <= 0) {
            problems.push(`chain ${chainId}: deploy/wtari/${chainId}.json has no positive integer bridgeStartBlock`)
        } else if (values.wTARIBridgeStartBlock !== bridgeStartBlock) {
            problems.push(
                `chain ${chainId}: wTARIBridgeStartBlock ${values.wTARIBridgeStartBlock} is not deploy/wtari/${chainId}.json's ${bridgeStartBlock}`
            )
        }
    }
    return problems
}
