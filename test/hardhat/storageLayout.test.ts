import * as fs from 'fs'
import * as path from 'path'

import { StorageLayout, getStorageUpgradeErrors } from '@openzeppelin/upgrades-core'
import { expect } from 'chai'
import { artifacts } from 'hardhat'

// hardhat-deploy upgrades without checking storage: compare the current layouts with every deployed implementation.
describe('storage layout against deployed implementations', function () {
    const deploymentsDir = path.join(__dirname, '../../deployments')

    for (const name of ['wXTMBridge', 'wXTMController']) {
        for (const network of fs.readdirSync(deploymentsDir)) {
            const file = path.join(deploymentsDir, network, `${name}_Implementation.json`)
            if (!fs.existsSync(file)) continue

            it(`${name} can upgrade the ${network} implementation`, async function () {
                const deployed: StorageLayout = JSON.parse(fs.readFileSync(file, 'utf8')).storageLayout
                const source = `contracts/${name}.sol`
                const buildInfo = await artifacts.getBuildInfo(`${source}:${name}`)
                // solc's storageLayout output; hardhat's types leave it out.
                const { storageLayout } = buildInfo?.output.contracts[source][name] as unknown as {
                    storageLayout: StorageLayout
                }

                expect(deployed.storage).to.not.be.empty
                expect(getStorageUpgradeErrors(deployed, storageLayout)).to.deep.equal([])
            })
        }
    }
})
