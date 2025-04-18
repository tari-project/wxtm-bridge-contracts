import assert from 'assert'
import verify from '../utils/verify'

import { type DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'
import { getDeployments } from '../wxtm-bridge-contracts-typechain/deployments/'

const contractName = 'wXTMBridge'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    if (hre.network.name !== 'sepolia-testnet') {
        console.log(`Deployment script can only run on the Sepolia network. Current network: ${hre.network.name}`)
        return
    }

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const deployedContracts = getDeployments(11155111)

    assert(deployer, 'Missing named deployer account')

    console.log(`wXTM: ${deployedContracts.wXTM}`)
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    /** @dev Consider removing 'salt' here as we deploy wXTMBridge to one network only */
    const salt = ethers.utils.id('wXTM-deployment_v0.0.1')

    const wXTMBridge = await deploy(contractName, {
        from: deployer,
        args: [deployedContracts.wXTM, deployer],
        deterministicDeployment: salt,
        log: true,
        waitConfirmations: 1,
        skipIfAlreadyDeployed: false,
    })

    console.log(`wXTMBridge contract deployed to network: ${hre.network.name}, address: ${wXTMBridge.address}`)

    await verify(wXTMBridge.address, [deployedContracts.wXTM, deployer])
}

deploy.tags = [contractName]

export default deploy
