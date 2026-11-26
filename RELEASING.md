# Releasing

Releases are made from `main` by the release workflow, using Changesets.

1. Every user-visible change lands with a changeset (`npm run changeset`). The changelog is written from them, so write the changeset first.
2. The release workflow keeps a "Version packages" pull request open with the next version and changelog. Before merging it, check that CI passed on it, that `npm run build && npm run check:package` is clean, and that `npm pack --dry-run` lists only the intended files.
3. Merging that pull request runs the tests and package checks again, then stages the version on npm with trusted publishing (OIDC, no stored token). A staged version can't be installed yet.
4. A maintainer approves it on npmjs.com (the package's "Staged Packages" tab) or with `npm stage approve <stage-id>`, which asks for 2FA. Then they tag the merge commit `v<version>`, push the tag, and create a GitHub release from the changelog.

npm only lets a trusted publisher be added to a package that already exists, so the very first version is published once by hand by a maintainer (`npm publish --access public` from a clean checkout of the tagged commit, with 2FA). Then add the trusted publisher on npmjs.com (GitHub Actions, this repository, workflow `release.yml`, no allowed actions ticked, so it can only stage; it must be used within two days of being created) and use the workflow from the next release on. The package's publishing access is set to require 2FA and disallow tokens. `repository.url` in package.json must match the GitHub repository exactly.

If a version on `main` didn't get staged, for example because the run failed, run the Release workflow by hand from `main` (Actions, Release, Run workflow). It stages the version in package.json if npm doesn't have it.

Staging only happens when the repository variable `NPM_PUBLISH` is `true`, and nothing is released without a maintainer approving it with 2FA. The npm account that owns the package has 2FA turned on.

The workflow needs the repository setting "Allow GitHub Actions to create and approve pull requests" to open the version pull request.

A pull request opened by the workflow's own token doesn't start CI. Close and reopen it, or push an empty commit to it, to run the checks before merging.
