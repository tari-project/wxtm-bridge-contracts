import assert from 'assert'
import verify from '../utils/verify'

import { type DeployFunction } from 'hardhat-deploy/types'
import { getDeployments } from '../wxtm-bridge-contracts-typechain/deployments'

const contractName = 'wXTMBridge'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    // if (hre.network.name !== 'sepolia-testnet') {
    //     console.log(`Deployment script can only run on the Sepolia network. Current network: ${hre.network.name}`)
    //     return
    // }

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    /** @TODO Change chain after testing */
    const deployedContracts = getDeployments(11155111)

    console.log('wXTM: ', deployedContracts.wXTM)

    assert(deployer, 'Missing named deployer account')

    console.log(`wXTM: ${deployedContracts.wXTM}`)
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const wXTMBridge = await deploy(contractName, {
        from: deployer,
        args: [deployedContracts.wXTM],
        log: true,
        waitConfirmations: 5,
        skipIfAlreadyDeployed: false,
    })

    console.log(
        `wXTMBridge contract deployed to network: ${hre.network.name}, address: ${wXTMBridge.address}, wXTM: ${deployedContracts.wXTM}`
    )

    await verify(hre, wXTMBridge.address, [deployedContracts.wXTM])
}

deploy.tags = [contractName]

export default deploy
