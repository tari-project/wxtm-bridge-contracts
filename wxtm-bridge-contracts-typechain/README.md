### Bridge events

`wXTMBridge` and `wTARIBridge` both emit `TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce)`, so the two bridges share one event topic. Each bridge counts nonces from 0, separately on every chain. Key bridge events by **(chainId, bridge address, nonce)**; never by nonce alone.

`getWtariChains()` lists the chain ids with a wTARI deployment; `getDeployments(chainId)` returns its `wTARI`, `wTARIController`, `wTARIBridge` and `wTARIBridgeStartBlock`.

### Publishing

`.github/workflows/npm-publish.yml` runs only for a tag named `@tari-project/wxtm-bridge-contracts@vX.Y.Z` (digits only; other tag names, such as `release/*`, never start it), and has no manual trigger. It has three jobs:

1. **build** (read-only, no publish credentials): checks that the tagged commit is on `development` and that the tag matches `package.json`'s version, runs `npm ci --ignore-scripts`, compiles, runs `npm run verify:wtari-package`, builds, and packs the tarball. The job log and summary show the tarball's SHA-256, but this job runs dependency code, so its log and summary are not evidence for approvers. The tarball is kept as an artifact for 30 days, so a late approval still finds it.
2. **check** (read-only, no install, no repository scripts other than the manifest check below): checks out only the committed package `package.json`, `deployments.json`, `README.md` and `CHANGELOG.md`, the `deployments/` records and `utils/deployments-manifest.ts`. It downloads the tarball and checks its SHA-256. It requires the file name to be exactly `tari-project-wxtm-bridge-contracts-<tag version>.tgz`. The packed `package.json` must be byte-identical to the committed one (`npm pack` does not change it), so the build cannot change scripts, dependencies or `bin` in it. The files allowlist below stops scripts npm would infer from files; its name must be `@tari-project/wxtm-bridge-contracts` and its version the tag's (read with `jq`). The packed `deployments.json`, `README.md` and `CHANGELOG.md` must be byte-identical to the committed files.
   - **Entry checks.** npm unpacks with node-tar, which differs from GNU tar: it strips any top-level directory, skips link entries, reads past a lone zero block and lets later duplicates win. So before extracting, the job lists the tarball with GNU tar `--ignore-zeros`, and fails if any tar call writes to stderr. It also fails unless:
     - every entry is a regular file or directory;
     - every path matches `package/[A-Za-z0-9._@/-]+`, with no `.` or `..` components;
     - every path is on an allowlist that is narrower than the package's `files` list: `package.json`, `README.md`, `CHANGELOG.md`, `index.(js|d.ts)`, `deployments/deployments.json`, `deployments/index.(js|d.ts)`, `utils/chain.(js|d.ts)` and `typechain/**.(js|d.ts)`, with no `node_modules` segment. **When adding a file to the package, add it to this allowlist in `npm-publish.yml` too; otherwise the release fails closed.** Anything else fails, for example a `binding.gyp` (from which npm would infer an install script), `server.js`, `npm-shrinkwrap.json` or `.npmrc`. `package.json` also sets `"gypfile": false`;
     - no path appears twice, compared ignoring case and repeated slashes.
   - **Plain ustar entries only.** The job accepts only plain ustar file and directory entries: no pax, GNU long-name or sparse headers, and nothing after a zero block. So GNU tar and node-tar (including older npm versions) read the same files. A second step checks this on the raw headers and with the node-tar bundled in npm (strict mode, nothing installed). That step parses size and other numeric header fields strictly. It requires node-tar's entry list and entry sizes to equal GNU tar's and the raw headers', in order, and every file node-tar reads to be byte-identical to GNU tar's extraction (with the same set of files). `package.json` and `deployments.json` must also equal the committed files.
   - With those rules, both tools see the same files. The step also logs the Node, npm and node-tar versions it used.
   - **Exact-match check.** The job runs `packageDeploymentProblems` and `wtariStartBlockProblems` from `utils/deployments-manifest.ts` (Node builtins only, run with Node's type stripping, nothing installed). So, checked outside the build job:
     - the packed `deployments.json` must hold exactly the committed `deployments/<network>/*.json` records;
     - every chain with wTARI keys must have exactly the wTARI record set, and a `wTARIBridgeStartBlock` equal to `deploy/wtari/<chainId>.json`'s `bridgeStartBlock`.

     **Residual:** the wTARI CREATE2 address recomputation needs hardhat, so it runs only in the build job and is advisory.

   - **Approver evidence.** Only once every check has passed does the last step print the verified SHA-256 and the GNU tar file listing to the log and the job summary.
3. **publish** (GitHub environment `npm-publish`, `id-token: write`; needs build and check): no checkout and no install. It downloads that tarball, checks its exact tag-derived name and SHA-256, and runs `npm publish <tarball> --provenance --ignore-scripts`.

The build job runs dependency code (hardhat plugins, typechain, `tsc`) after `verify:wtari-package`, so the check job verifies the packed name, version and `deployments.json` again. **Residual:** the compiled `.js` and `.d.ts` files cannot be checked without rebuilding them, so a compromised build dependency could still alter them.

`verify:wtari-package` fails unless `deployments/deployments.json` holds exactly the records in `deployments/<network>/*.json` for every network directory with a `.chainId` (only `wTARIBridgeStartBlock` may be added), and the wTARI entries match their recomputed CREATE2 addresses. CI cannot run `export-deployments-*` (it needs RPC access), so regenerate and commit `deployments.json` before tagging.

Until 0.2.1 the package was published by `.github/workflows/publish.yml`, a single job that installed and compiled with `id-token: write` and could also be started by hand. Every older release tag and commit still carries that file, and GitHub runs the workflow file from the tagged commit (or the dispatched ref). npm's trusted publisher matches only the workflow file name and the environment. Once the trusted-publisher entry names `npm-publish.yml`, an old `publish.yml` run can no longer publish through OIDC. It could still publish with an npm token, so publishing is restricted to the trusted publisher only once tokens are disallowed (see below). Cancel old `publish.yml` runs anyway, and reject their `npm-publish` approval.

#### Repository and npm settings

These cannot be enforced from the repository; maintainers must configure them:

The tag, `development` and version checks inside the workflow run from the tagged commit's own `npm-publish.yml`. Someone who can push a tag or branch carrying their own copy of that file could fake them, and npm's trusted publisher checks only the file name and the environment. These settings and the reviewer's own checks (release step 3) are what actually gate a publish:

- GitHub environment `npm-publish`:
  - **Deployment branches and tags** set to **Selected branches and tags**, with only the tag rule `@tari-project/wxtm-bridge-contracts@v*` and no branch rules;
  - **Required reviewers** with **Prevent self-review** enabled.
- A tag ruleset targeting `@tari-project/wxtm-bridge-contracts@v*` that restricts creations, updates and deletions to maintainers, with a minimal bypass list.
- A `CODEOWNERS` file that requires maintainer review for everything that shapes the package or its checks: `wxtm-bridge-contracts-typechain/**`, `deployments/**`, `deploy/wtari/**`, `utils/deployments-manifest.ts`, `tasks/wtari.ts`, `scripts/copy.sh`, `scripts/build/**`, the root `package.json`, `package-lock.json`, `hardhat.config.ts` and `.github/workflows/`.
- Branch protection on `development`: **Require review from Code Owners**, **Require approval of the most recent reviewable push**, and **Do not allow bypassing the above settings**.
- An npm trusted publisher for `@tari-project/wxtm-bridge-contracts` bound to this repository, the workflow `npm-publish.yml`, and the environment `npm-publish`. **Before merging the PR that adds `npm-publish.yml`, switch the existing entry from `publish.yml` to `npm-publish.yml`.** This switch stops the older `publish.yml` copies on old tags and commits from publishing through OIDC.
- On npm, the package's **Settings → Publishing access** set to **Require two-factor authentication and disallow tokens**, so only the trusted publisher can publish. Also revoke existing publish-capable granular or automation tokens, and keep the package's maintainer list minimal.
- Squash-merge this PR, and in general any release PR that changes `npm-publish.yml`. A merge commit would bring its intermediate commits onto `development`; they carry older or weaker workflows, and a tag on one of them would pass the ancestry check.

#### Release steps

1. In `wxtm-bridge-contracts-typechain`, bump the version without creating a tag, and add a `CHANGELOG.md` entry:

   ```sh
   npm version patch --no-git-tag-version # or minor/major
   ```

2. Merge to `development` (squash-merge if the PR changes `npm-publish.yml`). Then tag the merge commit, or the `development` head, with the matching name and push the tag:

   ```sh
   git tag -a "@tari-project/wxtm-bridge-contracts@v0.3.0" <development commit> -m "wxtm-bridge-contracts 0.3.0"
   git push origin "@tari-project/wxtm-bridge-contracts@v0.3.0"
   ```

3. Before approving the `npm-publish` environment, the reviewer checks the release independently. The checks inside the workflow are advisory, because the tagged commit supplies them.
   - The run is for a version tag (`@tari-project/wxtm-bridge-contracts@vX.Y.Z`), not a branch.
   - The tagged commit is on `development`, its `npm-publish.yml` equals `development`'s at approval time, and it is this release's version-bump (squash-merge) commit:

     ```sh
     git fetch origin --tags
     sha=$(git rev-parse "@tari-project/wxtm-bridge-contracts@v0.3.0^{commit}")
     git merge-base --is-ancestor "$sha" origin/development && echo on-development
     git diff --exit-code "$sha" origin/development -- .github/workflows/npm-publish.yml && echo same-workflow
     git log -1 --format='%H %s' "$sha"
     ```

   - The run's commit SHA (shown on the run page) equals that `$sha`.

   - The approver reviews everything that changed in the package and its checks since the previous release tag, not just the version bump:

     ```sh
     git diff "@tari-project/wxtm-bridge-contracts@v0.2.1" "$sha" -- wxtm-bridge-contracts-typechain deployments \
       deploy/wtari utils/deployments-manifest.ts tasks/wtari.ts .github/workflows/npm-publish.yml
     ```

   - The check job passed. Its log and summary show the verified SHA-256 and the packed file list, and the list is as expected. The build job's log and summary come from a job that runs dependency code, so they are not evidence.

4. After publishing 0.3.0 (once only), deprecate the earlier versions:

   ```sh
   npm deprecate '@tari-project/wxtm-bridge-contracts@<0.3.0' 'wrong DefaultProxyAdmin and LayerZero entries; upgrade to >=0.3.0'
   ```

### For consumers

Pin an exact version, and run `npm audit signatures`. That command does not fail when a package has no attestation, and it does not check the workflow or ref. So also confirm that the version has a provenance attestation, and that its SLSA predicate names this repository, `.github/workflows/npm-publish.yml` and a `refs/tags/@tari-project/wxtm-bridge-contracts@v*` ref. Check it on the npmjs.com provenance panel, or:

```sh
url=$(npm view @tari-project/wxtm-bridge-contracts@0.3.0 dist.attestations.url)
curl -s "$url" | jq -r '.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1")
  | .bundle.dsseEnvelope.payload' | base64 -d | jq '.predicate.buildDefinition.externalParameters.workflow'
```
