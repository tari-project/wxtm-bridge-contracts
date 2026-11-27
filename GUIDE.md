## Commands Examples

### **Scripts:**

#### **Deploy**

`npx hardhat lz:deploy`
`yarn hardhat lz:deploy --tags wXTMController`

#### **Upgrade wXTMBridge or wXTMController**

The deploy scripts only deploy new proxies. For a proxy that is already recorded they deploy nothing: wXTM is left
alone, and wXTMBridge/wXTMController are only checked (upgraded and set up). Upgrades go through this task:

1. `npx hardhat --network mainnet upgrade-calldata:wxtm --contract wXTMController --deploy-implementation` deploys the
   CREATE2 implementation (same salt as the deploy scripts) from the deployer and prints the `upgradeAndCall`
   transaction for the ProxyAdmin owner to sign.
2. After it is executed, `npx hardhat --network mainnet upgrade-calldata:wxtm --contract wXTMController --check`
   verifies the upgrade and records it in `deployments/mainnet`.

**Before signing**, a second person checks out the printed commit (ideally in the SEC-06 reproducible build image),
runs `npx hardhat compile` and the task in print mode (no flags, read-only) against the same network, and confirms the
same commit, init-code hash, CREATE2 factory/salt and implementation address, and calldata; that the implementation
has the compiled code (the task refuses otherwise); and that the admin and the guardian Safe (its owners, threshold, no
modules, no guard) match the published addresses. Only then sign.

#### **Verify**

`npx hardhat run scripts/verify.ts --network sepolia-testnet`

#### **Set Peers - Create Connections Between Contracts**

`npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts`
Setup info: https://docs.layerzero.network/v2/developers/evm/technical-reference/simple-config

#### **Ineract With Smartcontract**

`make call ARGS="--network sepolia"`

#### **Tests**

`npm run test:hardhat`
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

### **Using Interactions Scripts**

#### **Prerequisites**

Ensure your `.env` file contains the required variables -> check `.env.example`.

#### **Simulation (dry-run, no on-chain execution)**

```bash
make simulateBridgeWithAuth
```

This runs the script against the network without broadcasting transactions. Useful for testing script logic and estimating gas costs.

In Makefile you can modify the RPC URL to target different blockchains:

```bash
# Simulate on Sepolia network
simulateBridgeWithAuth:
	@forge script scripts/solidity/Interactions.s.sol:ExecWithAuth --rpc-url $(SEPOLIA_RPC_URL) -vvvv

# Simulate on Mainnet
simulateBridgeWithAuth:
	@forge script scripts/solidity/Interactions.s.sol:ExecWithAuth --rpc-url $(MAINNET_RPC_URL) -vvvv
```

**Verbosity levels:**

- `-vvvv` - Full logs including stack traces
- `-vvv` - Detailed execution traces
- `-vv` - Function calls only
- `-v` - Basic output

#### **Broadcast (actual on-chain execution)**

```bash
# Local anvil
make bridgeWithAuth

# Sepolia testnet
make bridgeWithAuth ARGS="--network sepolia"

# Base Sepolia testnet
make bridgeWithAuth ARGS="--network base_sepolia"
```

Network configuration is determined by the RPC URL in your `.env` file. No changes to `hardhat.config.ts` are required for Makefile scripts.

#### **Available Commands**

| Command                       | Description                    | Script         |
| ----------------------------- | ------------------------------ | -------------- |
| `make call`                   | Call proxy contract            | `CallProxy`    |
| `make setPeer`                | Set peer configuration         | `SetPeer`      |
| `make setMinter`              | Set minter role                | `SetMinter`    |
| `make bridge`                 | Send tokens (standard)         | `SendTokens`   |
| `make bridgeWithAuth`         | Send tokens with EIP-3009 auth | `ExecWithAuth` |
| `make simulateBridgeWithAuth` | Dry-run bridge with auth       | `ExecWithAuth` |

#### **Creating Custom Simulation Targets**

To add a new simulation target, add to Makefile:

Write your script in `scripts/solidity/Interactions.s.sol` as:

```solidity
contract YourScript is Script {...}
```

```bash
simulateYourScript:
	@forge script scripts/solidity/Interactions.s.sol:YourScript --rpc-url $(YOUR_RPC_URL) -vvvv
```

To convert any broadcast command to simulation, remove `--broadcast` and `--verify` flags from `NETWORK_ARGS`.
