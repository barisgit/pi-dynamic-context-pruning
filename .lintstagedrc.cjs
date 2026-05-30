module.exports = {
  "*.{ts,md,json,jsonc,cjs,mjs}": "prettier --write",
  "*.ts": ["eslint --max-warnings 0 --no-warn-ignored", () => "tsc --noEmit"],
};
