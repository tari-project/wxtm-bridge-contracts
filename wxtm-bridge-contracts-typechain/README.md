### Bridge events

`wXTMBridge` and `wTARIBridge` both emit `TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce)`, so the two bridges share one event topic. Each bridge counts nonces from 0, separately on every chain. Key bridge events by **(chainId, bridge address, nonce)**; never by nonce alone.

`getWtariChains()` lists the chain ids with a wTARI deployment; `getDeployments(chainId)` returns its `wTARI`, `wTARIController`, `wTARIBridge` and `wTARIBridgeStartBlock`.

### To update package

1. **Change directory**

   ```sh
    cd wxtm-bridge-contracts-typechain
   ```

2. **Change version of the package**

   ```sh
    npm version patch # or minor/major
   ```

3. **Make a matching tag**

   ```sh
    git tag "@tari-project/wxtm-bridge-contracts@v0.1.10"
   ```

4. **Push to github with tags**

   ```sh
    git push origin "@tari-project/wxtm-bridge-contracts@v0.1.10"
   ```
