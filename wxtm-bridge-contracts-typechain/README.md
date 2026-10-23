### Bridge events

`wXTMBridge` and `wTARIBridge` both emit `TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce)`, so the two bridges share one event topic. Each bridge counts nonces from 0, separately on every chain. Key bridge events by **(chainId, bridge address, nonce)**; never by nonce alone.

`getWtariChains()` lists the chain ids with a wTARI deployment; `getDeployments(chainId)` returns its `wTARI`, `wTARIController`, `wTARIBridge` and `wTARIBridgeStartBlock`.

### Publishing safeguards (repository and npm settings)

`.github/workflows/publish.yml` publishes only from a `@tari-project/wxtm-bridge-contracts@v*` tag, runs `npm run verify:wtari-package` before building, and runs in the GitHub environment `npm-publish`. That alone does not stop someone who can push a tag. Maintainers must configure these settings, which cannot be enforced from the repository:

- GitHub environment `npm-publish` with required reviewers, and deployments restricted to protected tags.
- A tag protection rule or ruleset for `@tari-project/wxtm-bridge-contracts@v*`, so only maintainers can create those tags.
- An npm trusted publisher for `@tari-project/wxtm-bridge-contracts` bound to this repository, the workflow `publish.yml`, and the environment `npm-publish`.

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
