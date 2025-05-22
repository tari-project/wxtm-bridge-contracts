## Commands Examples

### **Scripts:**

#### **Deploy**

`npx hardhat lz:deploy`
`yarn hardhat lz:deploy --tags wXTMController`

#### **Verify**

`npx hardhat run scripts/verify.ts --network sepolia-testnet`

#### **Set Peers - Create Connections Between Contracts**

`npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts`
Setup info: https://docs.layerzero.network/v2/developers/evm/technical-reference/simple-config

#### **Ineract With Smartcontract**

`make call ARGS="--network sepolia"`

#### **Tests**

`npm run test:forge` || `forge test`

#### **Export Fresh Deployments**

`npm run export-deployments-mainnet`
`npm run export-deployments-sepolia`
`npm run export-deployments-base-sepolia`

### **LzEndpointId:**

SEPOLIA_V2_TESTNET = 40161
BASESEP_V2_TESTNET = 40245

### **ChainIds**

Sepolia: 11155111
Base Sepolia: 84532

### **Deployments**

Proxy (wXTM): 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374
Bridge: 0x52610316B50238d0f6259691762179A3d8E87908
