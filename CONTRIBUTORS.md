# Contributors

Thank you to everyone who helps make CutVii better.

## Maintainer

- [@zidniryi](https://github.com/zidniryi): creator and maintainer

## Contributors

The up-to-date list is on GitHub: <https://github.com/zidniryi/cutvii/graphs/contributors>

<a href="https://github.com/zidniryi/cutvii/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=zidniryi/cutvii" alt="CutVii contributors">
</a>

## How to contribute

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Fork the repository and create a branch from `main`.
3. Run the checks before you open a pull request: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`,
   and in `src-tauri`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
4. Describe what changed and how you tried it. Do not copy code, logos, assets or branding from other products.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
When your pull request is merged, feel free to add yourself to the list above.
