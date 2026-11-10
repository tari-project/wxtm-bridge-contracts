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
