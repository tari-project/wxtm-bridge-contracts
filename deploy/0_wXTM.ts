import assert from 'assert'
import verify from '../utils/verify'

import { type DeployFunction } from 'hardhat-deploy/types'
import { ethers, upgrades } from 'hardhat'
import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { getDeploymentAddressAndAbi } from '@layerzerolabs/lz-evm-sdk-v2'

const contractName = 'wXTM'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()

    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    // This is an external deployment pulled in from @layerzerolabs/lz-evm-sdk-v2
    //
    // @layerzerolabs/toolbox-hardhat takes care of plugging in the external deployments
    // from @layerzerolabs packages based on the configuration in your hardhat config
    //
    // For this to work correctly, your network config must define an eid property
    // set to `EndpointId` as defined in @layerzerolabs/lz-definitions
    //
    // For example:
    //
    // networks: {
    //   fuji: {
    //     ...
    //     eid: EndpointId.AVALANCHE_V2_TESTNET
    //   }
    // }

    const eid = hre.network.config.eid as EndpointId
    const lzNetworkName = endpointIdToNetwork(eid)

    const { address } = getDeploymentAddressAndAbi(lzNetworkName, 'EndpointV2')
    console.log('Lz Address: ', address)

    const salt = ethers.utils.id('wXTM-deployment_v0.0.2')

    const proxy = await deploy(contractName, {
        from: deployer,
        args: [address],
        deterministicDeployment: salt,
        log: true,
        waitConfirmations: 1,
        skipIfAlreadyDeployed: false,
        proxy: {
            proxyContract: 'OpenZeppelinTransparentProxy',
            owner: deployer,
            execute: {
                init: {
                    methodName: 'initialize',
                    args: ['WrappedXTM', 'wXTM', '1', deployer], // initializer args
                },
                onUpgrade: {
                    methodName: 'initialize',
                    args: ['WrappedXTM', 'wXTM', '2', deployer], // initializer args
                },
            },
        },
    })

    console.log(
        `Proxy contract deployed to network: ${hre.network.name}, address: ${proxy.address}, implementation: ${proxy.implementation}`
    )

    /** @dev Verify Implementation */
    if (proxy.implementation) {
        await verify(proxy.implementation, [address])
    }
}

deploy.tags = [contractName]

export default deploy
