import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { expect } from 'chai'

import { readManifest, updateManifestEntry, withFileLock } from '../../utils/deployments-manifest'

const ROOT = path.join(__dirname, '..', '..')
const MODULE = path.join(ROOT, 'utils', 'deployments-manifest.ts')

// One export-deployments writer: snapshot this chain's entry, wait at a barrier until every writer has read
// the file (the slow check:wtari window), then merge and write.
const WRITER = `
const fs = require('fs')
const { readManifest, updateManifestEntry } = require(process.env.MODULE)
const [file, chainId, barrier] = process.argv.slice(1)
const previous = readManifest(file)[chainId]
fs.writeFileSync(barrier + '.' + chainId, '')
const wait = () => fs.existsSync(barrier) ? updateManifestEntry(file, chainId, previous, { chainId })
    .catch((e) => { console.error(e); process.exitCode = 1 }) : setTimeout(wait, 5)
wait()
`

function runWriter(file: string, chainId: string, barrier: string) {
    return new Promise<number>((resolve) => {
        const child = spawn(
            process.execPath,
            ['-r', 'ts-node/register/transpile-only', '-e', WRITER, file, chainId, barrier],
            {
                cwd: ROOT,
                env: { ...process.env, MODULE },
                stdio: ['ignore', 'inherit', 'inherit'],
            }
        )
        child.on('exit', (code) => resolve(code ?? 1))
    })
}

describe('export-deployments manifest writes', function () {
    let dir: string
    let file: string
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtari-manifest-'))
        file = path.join(dir, 'deployments.json')
    })
    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('keeps every chain when exports for different chains run concurrently', async function () {
        this.timeout(120_000)
        fs.writeFileSync(file, JSON.stringify({ 1: { chainId: '1' } }))
        const chains = ['8453', '84532', '11155111', '10', '42161', '137']
        const barrier = path.join(dir, 'go')
        const exits = chains.map((chainId) => runWriter(file, chainId, barrier))
        // Release the writers only once all of them have read the original file.
        while (!chains.every((chainId) => fs.existsSync(`${barrier}.${chainId}`))) {
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        fs.writeFileSync(barrier, '')
        expect(await Promise.all(exits)).to.deep.equal(chains.map(() => 0))
        const manifest = readManifest<{ chainId: string }>(file)
        expect(Object.keys(manifest).sort()).to.deep.equal(['1', ...chains].sort())
        for (const [chainId, entry] of Object.entries(manifest)) expect(entry.chainId).to.equal(chainId)
        // No lock or temp file is left behind.
        expect(fs.readdirSync(dir).filter((name) => name.includes('deployments.json'))).to.deep.equal([
            'deployments.json',
        ])
    })

    it('rejects a concurrent update of the same chain instead of overwriting it', async function () {
        fs.writeFileSync(file, JSON.stringify({ 8453: { a: 1 } }))
        const previous = readManifest<{ a: number }>(file)['8453']
        // Another export of 8453 finishes first.
        await updateManifestEntry(file, '8453', previous, { a: 2 })
        let error: Error | undefined
        try {
            await updateManifestEntry(file, '8453', previous, { a: 3 })
        } catch (e) {
            error = e as Error
        }
        expect(error?.message).to.include('changed while this export ran')
        expect(readManifest(file)).to.deep.equal({ 8453: { a: 2 } })
    })

    it('takes over a stale lock but waits for a live one', async function () {
        const lock = `${file}.lock`
        // Holder process on this host that has exited.
        const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
        fs.writeFileSync(lock, `${dead.stdout.trim()}:${os.hostname()}:dead`)
        expect(await withFileLock(file, () => 'acquired', { timeoutMs: 1000 })).to.equal('acquired')
        expect(fs.existsSync(lock)).to.equal(false)

        // A lock older than staleMs, even from a live holder.
        fs.writeFileSync(lock, `${process.pid}:${os.hostname()}:old`)
        const old = new Date(Date.now() - 60_000)
        fs.utimesSync(lock, old, old)
        expect(await withFileLock(file, () => 'acquired', { timeoutMs: 1000, staleMs: 30_000 })).to.equal('acquired')

        // A fresh lock from a live process is respected.
        fs.writeFileSync(lock, `${process.pid}:${os.hostname()}:live`)
        let error: Error | undefined
        try {
            await withFileLock(file, () => 'acquired', { timeoutMs: 200 })
        } catch (e) {
            error = e as Error
        }
        expect(error?.message).to.include('Timed out waiting for')
        expect(fs.readFileSync(lock, 'utf8')).to.equal(`${process.pid}:${os.hostname()}:live`)
    })
})
