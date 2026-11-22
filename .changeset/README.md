# Changesets

Every change that users of the published packages should know about gets a changeset:
`pnpm changeset`, pick the bump, describe the change. `pnpm version-packages` applies them (versions
and CHANGELOG.md); the release workflow publishes. All `@eab/*` packages share one version.
