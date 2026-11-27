### Bridge events

`wXTMBridge` and `wTARIBridge` both emit `TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce)`, so the two bridges share one event topic. Each bridge counts nonces from 0, separately on every chain. Key bridge events by **(chainId, bridge address, nonce)**; never by nonce alone.

`getWtariChains()` lists the chain ids with a wTARI deployment; `getDeployments(chainId)` returns its `wTARI`, `wTARIController`, `wTARIBridge` and `wTARIBridgeStartBlock`.

### Publishing

`.github/workflows/publish.yml` runs only for a tag named `@tari-project/wxtm-bridge-contracts@vX.Y.Z` (digits only; other tag names, such as `release/*`, never start it), and has no manual trigger. It has two jobs:

1. **build** (read-only, no publish credentials): checks that the tagged commit is on `development` and that the tag matches `package.json`'s version, runs `npm ci --ignore-scripts`, compiles, runs `npm run verify:wtari-package`, builds, and packs the tarball. The job log and summary show the tarball's SHA-256.
2. **publish** (GitHub environment `npm-publish`, `id-token: write`): no checkout and no install. It downloads that tarball, checks its SHA-256 and runs `npm publish <tarball> --provenance --ignore-scripts`.

`verify:wtari-package` fails unless `deployments/deployments.json` holds exactly the records in `deployments/<network>/*.json` for every network directory with a `.chainId` (only `wTARIBridgeStartBlock` may be added), and the wTARI entries match their recomputed CREATE2 addresses. CI cannot run `export-deployments-*` (it needs RPC access), so regenerate and commit `deployments.json` before tagging.

GitHub runs the workflow file from the tagged commit. A tag on an old commit therefore runs that commit's older `publish.yml`: reject its `npm-publish` approval.

#### Repository and npm settings

These cannot be enforced from the repository; maintainers must configure them:

- GitHub environment `npm-publish` with required reviewers, and deployments restricted to protected tags.
- A tag protection rule or ruleset for `@tari-project/wxtm-bridge-contracts@v*`, so only maintainers can create those tags.
- An npm trusted publisher for `@tari-project/wxtm-bridge-contracts` bound to this repository, the workflow `publish.yml`, and the environment `npm-publish`.

#### Release steps

1. In `wxtm-bridge-contracts-typechain`, bump the version without creating a tag, and add a `CHANGELOG.md` entry:

   ```sh
   npm version patch --no-git-tag-version # or minor/major
   ```

2. Merge to `development`, then tag the merged commit with the matching name and push the tag:

   ```sh
   git tag -a "@tari-project/wxtm-bridge-contracts@v0.3.0" <development commit> -m "wxtm-bridge-contracts 0.3.0"
   git push origin "@tari-project/wxtm-bridge-contracts@v0.3.0"
   ```

3. Before approving the `npm-publish` environment, check the build job's log: the tag and `development` checks passed, and the packed file list is as expected.
