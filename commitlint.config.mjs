// Conventional commits (feat:, fix:, docs:, test:, …), checked by the commit-msg hook (`pnpm hooks`).
export default { extends: ['@commitlint/config-conventional'], rules: { 'body-max-line-length': [0] } };
