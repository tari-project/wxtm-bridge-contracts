import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { expect } from 'chai'

import {
    localDeploymentAddresses,
    packageDeploymentProblems,
    readManifest,
    updateManifestEntry,
    withFileLock,
} from '../../utils/deployments-manifest'

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

describe('package deployments.json against deployments/<network>', function () {
    const A = '0x' + '1'.repeat(40)
    const B = '0x' + '2'.repeat(40)
    const C = '0x' + '3'.repeat(40)
    let dir: string
    function network(name: string, chainId: string, records: { [name: string]: string }) {
        const networkDir = path.join(dir, name)
        fs.mkdirSync(path.join(networkDir, 'solcInputs'), { recursive: true })
        fs.writeFileSync(path.join(networkDir, '.chainId'), chainId)
        fs.writeFileSync(path.join(networkDir, 'notes.md'), 'not a record')
        for (const [record, address] of Object.entries(records)) {
            fs.writeFileSync(path.join(networkDir, `${record}.json`), JSON.stringify({ address, abi: [] }))
        }
    }
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtari-package-'))
        network('mainnet', '1', { DefaultProxyAdmin: A, wXTM: B })
        network('base-sepolia-testnet', '84532', { wXTM: B, wTARI: C })
        // A directory without .chainId (like a checklist folder) is not a chain.
        fs.mkdirSync(path.join(dir, 'docs'))
    })
    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('reads only the record files of a network directory', function () {
        expect(localDeploymentAddresses(path.join(dir, 'mainnet'))).to.deep.equal({ DefaultProxyAdmin: A, wXTM: B })
    })

    it('accepts an exact match plus wTARIBridgeStartBlock', function () {
        const manifest = {
            1: { DefaultProxyAdmin: A, wXTM: B },
            84532: { wXTM: B, wTARI: C, wTARIBridgeStartBlock: 5 },
        }
        expect(packageDeploymentProblems(manifest, dir)).to.deep.equal([])
    })

    it('reports a changed address, extra and missing keys, and missing or unknown chains', function () {
        const manifest = {
            // LayerZero's DefaultProxyAdmin overriding ours, and an external LayerZero record.
            1: { DefaultProxyAdmin: C, wXTM: B, EndpointV2: A },
            // A retired record whose deployment file is gone.
            84532: { wXTM: B, wXTMBridge: A },
            8453: { wXTM: B },
        }
        expect(packageDeploymentProblems(manifest, dir)).to.deep.equal([
            `chain 1: DefaultProxyAdmin is ${C}, deployments/mainnet has ${A}`,
            `chain 1: EndpointV2 has no deployments/mainnet/EndpointV2.json`,
            `chain 84532: missing wTARI`,
            `chain 84532: wXTMBridge has no deployments/base-sepolia-testnet/wXTMBridge.json`,
            `chain 8453: no deployments/<network> directory with this .chainId`,
        ])
        expect(packageDeploymentProblems({ 1: { DefaultProxyAdmin: A, wXTM: B } }, dir)).to.deep.equal([
            'chain 84532: missing from the package (deployments/base-sepolia-testnet exists)',
        ])
    })

    it('rejects two deployment directories for one chain', function () {
        network('mainnet-copy', '1', { wXTM: B })
        const problems = packageDeploymentProblems({ 1: { wXTM: B } }, dir)
        expect(problems).to.include('chain 1: several deployment directories (mainnet, mainnet-copy)')
    })

    it('holds for the committed package deployments.json', function () {
        const manifest = readManifest<{ [key: string]: string | number }>(
            path.join(ROOT, 'wxtm-bridge-contracts-typechain', 'deployments', 'deployments.json')
        )
        expect(packageDeploymentProblems(manifest, path.join(ROOT, 'deployments'))).to.deep.equal([])
    })
})
