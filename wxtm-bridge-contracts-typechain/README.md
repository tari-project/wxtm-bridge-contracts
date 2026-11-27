### Bridge events

`wXTMBridge` and `wTARIBridge` both emit `TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce)`, so the two bridges share one event topic. Each bridge counts nonces from 0, separately on every chain. Key bridge events by **(chainId, bridge address, nonce)**; never by nonce alone.

`getWtariChains()` lists the chain ids with a wTARI deployment; `getDeployments(chainId)` returns its `wTARI`, `wTARIController`, `wTARIBridge` and `wTARIBridgeStartBlock`.

### Publishing

`.github/workflows/npm-publish.yml` runs only for a tag named `@tari-project/wxtm-bridge-contracts@vX.Y.Z` (digits only; other tag names, such as `release/*`, never start it), and has no manual trigger. It has three jobs:

1. **build** (read-only, no publish credentials): checks that the tagged commit is on `development` and that the tag matches `package.json`'s version, runs `npm ci --ignore-scripts`, compiles, runs `npm run verify:wtari-package`, builds, and packs the tarball. The job log and summary show the tarball's SHA-256. The tarball is kept as an artifact for 30 days, so a late approval still finds it.
2. **check** (read-only, no install, no repository scripts): checks out only the committed `package.json` and `deployments.json` of the package, downloads the tarball and checks its SHA-256. It requires the file name to be exactly `tari-project-wxtm-bridge-contracts-<tag version>.tgz`. The packed `package.json` must be byte-identical to the committed one (`npm pack` does not change it), so the build cannot add install scripts, dependencies or `bin`; its name must be `@tari-project/wxtm-bridge-contracts` and its version the tag's (read with `jq`). The packed `deployments.json` must be byte-identical to the committed file.
   - **Entry checks.** npm unpacks with node-tar, which differs from GNU tar: it strips any top-level directory, skips link entries, reads past a lone zero block and lets later duplicates win. So before extracting, the job lists the tarball with GNU tar `--ignore-zeros`, and fails if any tar call writes to stderr. It also fails unless:
     - every entry is a regular file or directory;
     - every path matches `package/[A-Za-z0-9._@/-]+`, with no `.` or `..` components;
     - no path appears twice, compared ignoring case and repeated slashes.
   - **Plain ustar entries only.** The job accepts only plain ustar file and directory entries: no pax, GNU long-name or sparse headers, and nothing after a zero block. So GNU tar and node-tar (including older npm versions) read the same files. A second step checks this on the raw headers and with the node-tar bundled in npm (strict mode, nothing installed). That step requires node-tar's entry list to equal GNU tar's, in order, and its `package.json` and `deployments.json` bytes to equal the committed files.
   - With those rules, both tools see the same files.
3. **publish** (GitHub environment `npm-publish`, `id-token: write`; needs build and check): no checkout and no install. It downloads that tarball, checks its exact tag-derived name and SHA-256, and runs `npm publish <tarball> --provenance --ignore-scripts`.

The build job runs dependency code (hardhat plugins, typechain, `tsc`) after `verify:wtari-package`, so the check job verifies the packed name, version and `deployments.json` again. **Residual:** the compiled `.js` and `.d.ts` files cannot be checked without rebuilding them, so a compromised build dependency could still alter them.

`verify:wtari-package` fails unless `deployments/deployments.json` holds exactly the records in `deployments/<network>/*.json` for every network directory with a `.chainId` (only `wTARIBridgeStartBlock` may be added), and the wTARI entries match their recomputed CREATE2 addresses. CI cannot run `export-deployments-*` (it needs RPC access), so regenerate and commit `deployments.json` before tagging.

Until 0.2.1 the package was published by `.github/workflows/publish.yml`, a single job that installed and compiled with `id-token: write` and could also be started by hand. Every older release tag and commit still carries that file, and GitHub runs the workflow file from the tagged commit (or the dispatched ref). npm's trusted publisher matches only the workflow file name and the environment. So once the trusted-publisher entry names `npm-publish.yml`, npm no longer accepts a publish from any old `publish.yml` run. Cancel such runs anyway, and reject their `npm-publish` approval.

#### Repository and npm settings

These cannot be enforced from the repository; maintainers must configure them:

The tag, `development` and version checks inside the workflow run from the tagged commit's own `npm-publish.yml`. Someone who can push a tag or branch carrying their own copy of that file could fake them, and npm's trusted publisher checks only the file name and the environment. These settings and the reviewer's own checks (release step 3) are what actually gate a publish:

- GitHub environment `npm-publish`:
  - **Deployment branches and tags** set to **Selected branches and tags**, with only the tag rule `@tari-project/wxtm-bridge-contracts@v*` and no branch rules;
  - **Required reviewers** with **Prevent self-review** enabled.
- A tag ruleset targeting `@tari-project/wxtm-bridge-contracts@v*` that restricts creations, updates and deletions to maintainers, with a minimal bypass list.
- A `CODEOWNERS` file that requires maintainer review for `deployments/**`, `wxtm-bridge-contracts-typechain/deployments/deployments.json` and `.github/workflows/`, enforced by branch protection on `development`.
- An npm trusted publisher for `@tari-project/wxtm-bridge-contracts` bound to this repository, the workflow `npm-publish.yml`, and the environment `npm-publish`. **Before tagging 0.3.0, switch the existing entry from `publish.yml` to `npm-publish.yml`.** This switch is what stops the older `publish.yml` copies on old tags and commits from publishing.

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

3. Before approving the `npm-publish` environment, the reviewer checks the release independently. The checks inside the workflow are advisory, because the tagged commit supplies them.
   - The run is for a version tag (`@tari-project/wxtm-bridge-contracts@vX.Y.Z`), not a branch.
   - The tagged commit is on `development`, so its workflow file is reviewed code:

     ```sh
     git fetch origin --tags
     sha=$(git rev-parse "@tari-project/wxtm-bridge-contracts@v0.3.0^{commit}")
     git merge-base --is-ancestor "$sha" origin/development && echo on-development
     ```

   - The run's commit SHA (shown on the run page) equals that `$sha`.

   - The build and check jobs passed, and the packed file list in the build log is as expected.

4. After publishing 0.3.0 (once only), deprecate the earlier versions:

   ```sh
   npm deprecate '@tari-project/wxtm-bridge-contracts@<0.3.0' 'wrong DefaultProxyAdmin and LayerZero entries; upgrade to >=0.3.0'
   ```
