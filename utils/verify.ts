import type { HardhatRuntimeEnvironment } from 'hardhat/types'

const verify = async (hre: HardhatRuntimeEnvironment, contractAddress: string, args: any[]) => {
    console.log('Verifying contract...')
    try {
        await hre.run('verify:verify', {
            address: contractAddress,
            constructorArguments: args,
        })
    } catch (e: any) {
        if (e.message.toLowerCase().includes('already verified')) {
            console.log('Already verified!')
        } else {
            console.error(e)
        }
    }
}

export default verify
