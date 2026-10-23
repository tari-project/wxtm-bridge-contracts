// Usage: ts-node scripts/wtari.ts <task> --chain <chainId> [more hardhat args]
// Runs `hardhat --network <name> <task> --chain <chainId> ...` with the network named in deploy/wtari/<chainId>.json.
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export function networkForChain(chainId: string): string {
    const file = path.join(__dirname, '..', 'deploy', 'wtari', `${chainId}.json`)
    if (!fs.existsSync(file)) {
        throw new Error(`No wTARI config for chain ${chainId}: ${file} does not exist`)
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')).network.name
}

if (require.main === module) {
    const [taskName, ...args] = process.argv.slice(2)
    const chainId = args[args.indexOf('--chain') + 1]
    if (!taskName || !args.includes('--chain') || !chainId) {
        console.error('Usage: npm run <deploy|check|verify>:wtari -- --chain <chainId>')
        process.exit(1)
    }
    const result = spawnSync('hardhat', ['--network', networkForChain(chainId), taskName, ...args], {
        stdio: 'inherit',
    })
    process.exit(result.status ?? 1)
}
