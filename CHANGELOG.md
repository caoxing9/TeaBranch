# [0.10.0](https://github.com/caoxing9/TeaBranch/compare/v0.9.0...v0.10.0) (2026-08-23)


### Bug Fixes

* **cask:** use the non-deprecated depends_on spelling, and document brew trust ([e6b1d77](https://github.com/caoxing9/TeaBranch/commit/e6b1d7744f03ce4711db8efa41e3311cba2779b0))


### Features

* **cask:** install with Homebrew ([7ba2ded](https://github.com/caoxing9/TeaBranch/commit/7ba2ded935b5b2dae952c72d97a1967506786cfb))

# [0.9.0](https://github.com/caoxing9/TeaBranch/compare/v0.8.1...v0.9.0) (2026-08-23)


### Features

* rebuild on macOS 26 with Liquid Glass, and fix what made it feel slow ([fa6fc24](https://github.com/caoxing9/TeaBranch/commit/fa6fc24483419ed1c91b3952da4dcf639b30c49e)), closes [#5](https://github.com/caoxing9/TeaBranch/issues/5) [#5](https://github.com/caoxing9/TeaBranch/issues/5) [#2](https://github.com/caoxing9/TeaBranch/issues/2)

## [0.8.1](https://github.com/caoxing9/TeaBranch/compare/v0.8.0...v0.8.1) (2026-08-10)


### Bug Fixes

* **ui:** stop the detail pane wasting space, and size type for the window it grew into ([#4](https://github.com/caoxing9/TeaBranch/issues/4)) ([b115f38](https://github.com/caoxing9/TeaBranch/commit/b115f38af780ffd373e32ebc2d51339ee0f9e182)), closes [#3](https://github.com/caoxing9/TeaBranch/issues/3)

# [0.8.0](https://github.com/caoxing9/TeaBranch/compare/v0.7.0...v0.8.0) (2026-08-10)


### Features

* **ui:** rebuild the interface on system-native design foundations ([#3](https://github.com/caoxing9/TeaBranch/issues/3)) ([0651ca5](https://github.com/caoxing9/TeaBranch/commit/0651ca5e28d30fd0d12f161b24afa44ff8968ba4))

# [0.7.0](https://github.com/caoxing9/TeaBranch/compare/v0.6.2...v0.7.0) (2026-08-10)


### Features

* replace the Tauri build with a native Swift app ([341626a](https://github.com/caoxing9/TeaBranch/commit/341626ae1a1de37b60b5023896503b87ea625e4d)), closes [#2](https://github.com/caoxing9/TeaBranch/issues/2)

## [0.6.2](https://github.com/caoxing9/TeaBranch/compare/v0.6.1...v0.6.2) (2026-06-11)


### Bug Fixes

* raise glass material opacity for readable contrast ([c324c05](https://github.com/caoxing9/TeaBranch/commit/c324c05ccc0c1576051c610a165f6bdfcb84b52b))

## [0.6.1](https://github.com/caoxing9/TeaBranch/compare/v0.6.0...v0.6.1) (2026-06-11)


### Bug Fixes

* enable macos-private-api so the transparent window actually renders ([45d2cde](https://github.com/caoxing9/TeaBranch/commit/45d2cdec5d2b45c0f0f03bd747a8b4eff01e4b6f))

# [0.6.0](https://github.com/caoxing9/TeaBranch/compare/v0.5.2...v0.6.0) (2026-06-11)


### Features

* frosted-glass UI with native macOS vibrancy ([f78fd29](https://github.com/caoxing9/TeaBranch/commit/f78fd2983d365539b03384309e49634a1f596f0d))
* port-health watchdog auto-restarts dev servers whose port dies ([85788f1](https://github.com/caoxing9/TeaBranch/commit/85788f1184fba4356311b93650a7adaba8639fbd))

## [0.5.2](https://github.com/caoxing9/TeaBranch/compare/v0.5.1...v0.5.2) (2026-06-11)


### Bug Fixes

* detach child stdin so next dev doesn't exit on stdin EOF ([5b803dd](https://github.com/caoxing9/TeaBranch/commit/5b803ddf4d475ccff35e4332f7cfd19fc406649f))

## [0.5.1](https://github.com/caoxing9/TeaBranch/compare/v0.5.0...v0.5.1) (2026-05-29)


### Bug Fixes

* cap dev logs per source so a chatty backend can't evict frontend logs ([cc2620b](https://github.com/caoxing9/TeaBranch/commit/cc2620bacb70c487d6df9bd2d7e7c7e4536dc36c))

# [0.5.0](https://github.com/caoxing9/TeaBranch/compare/v0.4.0...v0.5.0) (2026-05-29)


### Bug Fixes

* prevent duplicate port assignment across worktrees ([bb3e2b8](https://github.com/caoxing9/TeaBranch/commit/bb3e2b887e03d29ffbdb550d5a90b3ee3b2dd615))


### Features

* recover running dev servers / ngrok on startup by probing ports ([f514348](https://github.com/caoxing9/TeaBranch/commit/f514348b0f566ea691b505b6399c132c9afb8c3e))

# [0.4.0](https://github.com/caoxing9/TeaBranch/compare/v0.3.2...v0.4.0) (2026-05-29)


### Features

* split dev logs into per-source tabs and surface process crashes ([63a1ff6](https://github.com/caoxing9/TeaBranch/commit/63a1ff6b0d2c9f27b87ab968f3aa11eec046d1db))

## [0.3.2](https://github.com/caoxing9/TeaBranch/compare/v0.3.1...v0.3.2) (2026-05-27)


### Bug Fixes

* **process:** raise RLIMIT_NOFILE for spawned dev processes ([d9bf85c](https://github.com/caoxing9/TeaBranch/commit/d9bf85c38fb3ab777574344e746de1fd6497488b))

## [0.3.1](https://github.com/caoxing9/TeaBranch/compare/v0.3.0...v0.3.1) (2026-05-12)


### Bug Fixes

* **ngrok:** bind web-addr to a free port so we always read our own tunnel ([dc98b71](https://github.com/caoxing9/TeaBranch/commit/dc98b717adc5ea87804f3a00db92a2036551fd67))
* **ngrok:** read tunnel URL from stdout instead of polling port 4040 ([01263f9](https://github.com/caoxing9/TeaBranch/commit/01263f9b3a6579a99e2f5f521c6251ae87231fc3))

# [0.3.0](https://github.com/caoxing9/TeaBranch/compare/v0.2.3...v0.3.0) (2026-05-11)


### Bug Fixes

* **terminal:** reuse the running Ghostty window instead of opening a new one ([2ab7c0f](https://github.com/caoxing9/TeaBranch/commit/2ab7c0f0d06f99c4985d34996e03090498a23deb))
* wait for ports to actually free before spawning dev servers ([536a9f5](https://github.com/caoxing9/TeaBranch/commit/536a9f5d69dddeeb83d968e5da45eef7de629ac1))


### Features

* **ngrok:** stream tunnel logs into a dedicated Ngrok tab ([6337ce3](https://github.com/caoxing9/TeaBranch/commit/6337ce36623360dc199c1757699c581f8ac034ac))

## [0.2.3](https://github.com/caoxing9/TeaBranch/compare/v0.2.2...v0.2.3) (2026-05-11)


### Bug Fixes

* pass user PATH to ngrok spawn so GUI-launched app can find binary ([e19b66c](https://github.com/caoxing9/TeaBranch/commit/e19b66c45f29975a7afdf27fe585e978849862d6))
