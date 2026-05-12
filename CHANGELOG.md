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
