# Changelog

## [1.0.1](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.0...v1.0.1) (2026-08-29)


### Bug Fixes

* **auth:** make the credential rate limit configurable, and stop the E2E 429 ([c590ce0](https://github.com/yezhoufan2005/NavFleet/commit/c590ce03c972af56428a4677a02da945e561072e))
* **ci:** actually publish release images, which has never once happened ([d8634ce](https://github.com/yezhoufan2005/NavFleet/commit/d8634ce3058085d230c93b879f36339898ff0479))

## [1.0.0](https://github.com/yezhoufan2005/NavFleet/compare/v0.3.0...v1.0.0) (2026-08-29)


### Features

* **a11y:** axe-core in E2E over both themes, and fix what it found ([adf29c8](https://github.com/yezhoufan2005/NavFleet/commit/adf29c8c6cb4589b30ef815774f7bfb517057c1d))
* **frontend:** accessibility pass, history playback composable, cheaper GPS watch ([c7c4b16](https://github.com/yezhoufan2005/NavFleet/commit/c7c4b16948722a71fc2143c548b5316931e5f707))
* **frontend:** loading skeletons, settings page, large-fleet measurement ([4ae6848](https://github.com/yezhoufan2005/NavFleet/commit/4ae6848c930742e7deaa017daf3ab221b93a2dbc))


### Bug Fixes

* **api:** report the real version in /openapi.json instead of a stale literal ([d8976eb](https://github.com/yezhoufan2005/NavFleet/commit/d8976eb803eed65a8365abdd0b55d9c59429b9f9))
* **frontend:** locate the vehicle on the ROS map, and let settings use the screen ([5f4f7f3](https://github.com/yezhoufan2005/NavFleet/commit/5f4f7f3a6ff9c97fa2386de9261adc6aa027b0e9))
* **frontend:** one spacing scale for every view, instead of four answers ([2324437](https://github.com/yezhoufan2005/NavFleet/commit/2324437aaaec522b4174667d5eb10edd8f35ba71))
* **test:** bind one port per test file, and tidy the repo for 1.0 ([ba1bbeb](https://github.com/yezhoufan2005/NavFleet/commit/ba1bbebc23c5f51f385c5795db702ab429e27b15))
* **test:** one long-lived server per test file, and pin the browser build ([30b9ea1](https://github.com/yezhoufan2005/NavFleet/commit/30b9ea11c8c74381ab5d97c3d7781ea3dd67d152))
* **test:** 根治 socket 串台（0/14）+ 锁定 chromium 构建版本 ([7c04f05](https://github.com/yezhoufan2005/NavFleet/commit/7c04f05d11dd50bc8af3b88c92c0d24678fbf223))


### Miscellaneous Chores

* release 1.0.0 ([31c56bb](https://github.com/yezhoufan2005/NavFleet/commit/31c56bb77dbca94bc74ca69324c419926e9bc881))

## [0.3.0](https://github.com/yezhoufan2005/NavFleet/compare/v0.2.0...v0.3.0) (2026-08-27)

### Features

- **api:** /api/v1 prefix, validator-generated schemas and self-hosted Swagger UI ([d66331a](https://github.com/yezhoufan2005/NavFleet/commit/d66331a5b5c45e37b26990893eee1bef8bd8b4d9))
- **backend:** prom-client metrics, per-route latency histogram, request ids ([d9d3b45](https://github.com/yezhoufan2005/NavFleet/commit/d9d3b45dd3dd728a4cfb0d50c73ca7227b04e511))
- **backend:** rate limiting, real client IPs, tight CSP, production config audit ([cc40150](https://github.com/yezhoufan2005/NavFleet/commit/cc40150d404d410522e3d966fec6bd0efad613a6))
- **deploy:** authenticated broker with ACLs, network segmentation, non-root nginx ([36bee99](https://github.com/yezhoufan2005/NavFleet/commit/36bee9956a9e5c82c9ae32141e4e6727e4b54443))
- **deploy:** Prometheus + Grafana and verified-restorable backups ([362121a](https://github.com/yezhoufan2005/NavFleet/commit/362121ae845ccfa6ad5199fcd884e3710818e2ef))
- **deploy:** TLS overlay with HSTS, 308 redirect and Secure cookies ([22270e9](https://github.com/yezhoufan2005/NavFleet/commit/22270e920cc9c3e9dc6553a84e15a79064b33e85))
- **frontend:** error boundary, global handlers, route guard and a real 404 ([ae2423b](https://github.com/yezhoufan2005/NavFleet/commit/ae2423bfc4d4ce13a46c163a623bed6c4fb2eaa9))
- **ingest:** validate MQTT payloads and route params before they reach the store ([34c9e44](https://github.com/yezhoufan2005/NavFleet/commit/34c9e448e147326fef391265a33874f096418102))

### Bug Fixes

- **dev:** give the dev stack the broker credentials it now needs ([52c5fb3](https://github.com/yezhoufan2005/NavFleet/commit/52c5fb392ea55cba59c6aed6523791d6b09d5808))
- **e2e:** dedicated ports and no server reuse ([70e348c](https://github.com/yezhoufan2005/NavFleet/commit/70e348c00b63760e7591509a370d2747e4190b81))
- **gps:** anchor vehicle markers to their coordinate, not to a pixel offset ([45dac28](https://github.com/yezhoufan2005/NavFleet/commit/45dac28517c54bbd243c7d124bf7f3dc71e7b534))
- **gps:** 车标锚定到真实坐标（缩放时不再漂移）+ 方向/标签/演示分布修正 ([ecfb690](https://github.com/yezhoufan2005/NavFleet/commit/ecfb690f588dd2ee3175253890fbf8ed3ffc231f))
- **mock:** single-instance guard so battery/SOC stops flipping ([8be3730](https://github.com/yezhoufan2005/NavFleet/commit/8be3730f83f6beba4d497a4091f3c69ea324f59a))
- **mock:** sustainable battery duty cycle instead of draining to 0% ([2a69534](https://github.com/yezhoufan2005/NavFleet/commit/2a69534e58bd8b6cf5fff468fd55cefa2e243ab7))
- **persistence:** reconnect to MongoDB and report real connectivity ([f47effa](https://github.com/yezhoufan2005/NavFleet/commit/f47effab82502d206d1b769b245cdea3e50bb629))
- **ros:** fit the scene by default and drive the real road network ([c50d5d9](https://github.com/yezhoufan2005/NavFleet/commit/c50d5d9e8b7504831075c19aee3b92020a42b036))
- **store:** serialize mutations to stop losing concurrent updates ([b6d0f1e](https://github.com/yezhoufan2005/NavFleet/commit/b6d0f1ed89fc29584b588221cfe408edca4046d6))
- **test:** stop supertest reusing pooled sockets across recycled ports ([59ecefc](https://github.com/yezhoufan2005/NavFleet/commit/59ecefcdca43665a8e38c435d68cc50ad6132b63))
- **test:** type-safe keep-alive disable ([15a1a27](https://github.com/yezhoufan2005/NavFleet/commit/15a1a277e323d6af2b15263f94d9c03a598f5f41))
- **test:** 修掉后端套件约 50% 概率的偶发失败（supertest 复用已失效的 keep-alive socket） ([f707728](https://github.com/yezhoufan2005/NavFleet/commit/f707728d6391d08241c765276deceb63bae4fcf9))

## [0.2.0](https://github.com/yezhoufan2005/NavFleet/compare/v0.1.0...v0.2.0) (2026-08-26)

### Features

- **phase-1:** correctness fixes and legacy feature parity ([4aaf435](https://github.com/yezhoufan2005/NavFleet/commit/4aaf435e4f9c06344d2315ed5a536e0e49736c03))
- **phase-2:** authentication and RBAC (JWT + httpOnly cookies) ([5f30542](https://github.com/yezhoufan2005/NavFleet/commit/5f305422c41a6567228782ea8735acbe2bbc574e))
- **phase-3a:** resilient realtime + user-facing error feedback ([5800473](https://github.com/yezhoufan2005/NavFleet/commit/58004730324b3ba0696c01e6e3cca2a9202fcbfe))
- **phase-3b:** vue-router + Pinia foundation, split useDashboard ([e5ded9b](https://github.com/yezhoufan2005/NavFleet/commit/e5ded9bd0ff87059deadc63fa37f8debc3f1e908))
- **phase-3c:** history playback view ([6103718](https://github.com/yezhoufan2005/NavFleet/commit/6103718966405429370565be780b6d93b2710c96))
- **phase-3d:** alert center enhancements (filter, ack, pagination) ([b203aa8](https://github.com/yezhoufan2005/NavFleet/commit/b203aa83302ca867640974790484040311e136a4))
- **phase-3:** modern dual-theme design system (light + dark) ([da88eb4](https://github.com/yezhoufan2005/NavFleet/commit/da88eb4ab27c4b0d451cc0e50205a75e8963f6f5))
- **phase-4a:** observability — readiness probe, /metrics, request logging ([9b27298](https://github.com/yezhoufan2005/NavFleet/commit/9b272981432ce8a75e0370d95fc9ff0accd1fa85))
- **phase-4b:** docker + nginx hardening ([7855ab4](https://github.com/yezhoufan2005/NavFleet/commit/7855ab4d33366eceaa44666bf5eae4261ae1a0ae))
- **phase-4c:** MongoDB backup/restore scripts + ops docs ([e3b56b0](https://github.com/yezhoufan2005/NavFleet/commit/e3b56b0baa9bc8526a61897284aa981642f3e644))
- **phase-4d:** OpenAPI 3.1 spec served at /openapi.json ([458dead](https://github.com/yezhoufan2005/NavFleet/commit/458deadfb8162f05836d443b8d654a0aae3e86fb))

### Bug Fixes

- **backend:** production hardening, honor topic pattern, richer mock ([b511094](https://github.com/yezhoufan2005/NavFleet/commit/b5110940eed1bbf563b22f6db634dc53176dca41))
- **build:** commit complete cross-platform lockfile ([60764f8](https://github.com/yezhoufan2005/NavFleet/commit/60764f85fd0a057f0fe00c54aa6cfc1c707092df))
- **ci:** pin jsdom to ^26.1.0 for Node 20 compatibility ([fd93e3a](https://github.com/yezhoufan2005/NavFleet/commit/fd93e3a7192e24c3585ad319b473d6e55e52ecc9))
- containerized deployment closed-loop (Dockerfile + nginx observability) ([9c9d618](https://github.com/yezhoufan2005/NavFleet/commit/9c9d6182ab9e50c24157bced3ff0e57c09f60749))
- **frontend:** theme-aware map labels, remove path-editing, cleanup ([be3c24e](https://github.com/yezhoufan2005/NavFleet/commit/be3c24e42c3c8733eb088beaa9933967a3bc6a49))
- **frontend:** theme-aware ROS map, compact top bar, favicon, ROS label ([9215a2e](https://github.com/yezhoufan2005/NavFleet/commit/9215a2e1f4d3887985ce1d7b206a40620ce954d4))
- **sim+ui:** realistic deterministic simulation, stable sort, map focus ([73ffe00](https://github.com/yezhoufan2005/NavFleet/commit/73ffe007959ed3d2f8781d669d5af1ef9114e64b))
- **ui:** ROS map framing/theme, alert stats, history layout, collapsible fleet ([c553753](https://github.com/yezhoufan2005/NavFleet/commit/c5537532ff3b5174d9e6b53ce64b484082f8d9c5))
