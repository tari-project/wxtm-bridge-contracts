import { run, network } from 'hardhat'
import verify from '../utils/verify'

const main = async () => {
    const contractAddress = '0x0774838a6Bf49D1125b3426d87D8F831607B1e0A'

    /** @dev wXTM args */
    // LayerZero Sepolia Address: 0x6EDCE65403992e310A62460808c4b910D972f10f
    //const constructorArgs = ['0x6EDCE65403992e310A62460808c4b910D972f10f']

    /** @dev wXTMBridge args */
    const constructorArgs = ['0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374', '0xB3f8CbaE6D645E235C2Bd7eE3bbfa9125294C5c2']

    await verify({ run, network } as any, contractAddress, constructorArgs)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
