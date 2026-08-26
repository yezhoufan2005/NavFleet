# Changelog

## [0.2.0](https://github.com/yezhoufan2005/NavFleet/compare/v0.1.0...v0.2.0) (2026-08-26)


### Features

* **phase-1:** correctness fixes and legacy feature parity ([4aaf435](https://github.com/yezhoufan2005/NavFleet/commit/4aaf435e4f9c06344d2315ed5a536e0e49736c03))
* **phase-2:** authentication and RBAC (JWT + httpOnly cookies) ([5f30542](https://github.com/yezhoufan2005/NavFleet/commit/5f305422c41a6567228782ea8735acbe2bbc574e))
* **phase-3a:** resilient realtime + user-facing error feedback ([5800473](https://github.com/yezhoufan2005/NavFleet/commit/58004730324b3ba0696c01e6e3cca2a9202fcbfe))
* **phase-3b:** vue-router + Pinia foundation, split useDashboard ([e5ded9b](https://github.com/yezhoufan2005/NavFleet/commit/e5ded9bd0ff87059deadc63fa37f8debc3f1e908))
* **phase-3c:** history playback view ([6103718](https://github.com/yezhoufan2005/NavFleet/commit/6103718966405429370565be780b6d93b2710c96))
* **phase-3d:** alert center enhancements (filter, ack, pagination) ([b203aa8](https://github.com/yezhoufan2005/NavFleet/commit/b203aa83302ca867640974790484040311e136a4))
* **phase-3:** modern dual-theme design system (light + dark) ([da88eb4](https://github.com/yezhoufan2005/NavFleet/commit/da88eb4ab27c4b0d451cc0e50205a75e8963f6f5))
* **phase-4a:** observability — readiness probe, /metrics, request logging ([9b27298](https://github.com/yezhoufan2005/NavFleet/commit/9b272981432ce8a75e0370d95fc9ff0accd1fa85))
* **phase-4b:** docker + nginx hardening ([7855ab4](https://github.com/yezhoufan2005/NavFleet/commit/7855ab4d33366eceaa44666bf5eae4261ae1a0ae))
* **phase-4c:** MongoDB backup/restore scripts + ops docs ([e3b56b0](https://github.com/yezhoufan2005/NavFleet/commit/e3b56b0baa9bc8526a61897284aa981642f3e644))
* **phase-4d:** OpenAPI 3.1 spec served at /openapi.json ([458dead](https://github.com/yezhoufan2005/NavFleet/commit/458deadfb8162f05836d443b8d654a0aae3e86fb))


### Bug Fixes

* **backend:** production hardening, honor topic pattern, richer mock ([b511094](https://github.com/yezhoufan2005/NavFleet/commit/b5110940eed1bbf563b22f6db634dc53176dca41))
* **build:** commit complete cross-platform lockfile ([60764f8](https://github.com/yezhoufan2005/NavFleet/commit/60764f85fd0a057f0fe00c54aa6cfc1c707092df))
* **ci:** pin jsdom to ^26.1.0 for Node 20 compatibility ([fd93e3a](https://github.com/yezhoufan2005/NavFleet/commit/fd93e3a7192e24c3585ad319b473d6e55e52ecc9))
* containerized deployment closed-loop (Dockerfile + nginx observability) ([9c9d618](https://github.com/yezhoufan2005/NavFleet/commit/9c9d6182ab9e50c24157bced3ff0e57c09f60749))
* **frontend:** theme-aware map labels, remove path-editing, cleanup ([be3c24e](https://github.com/yezhoufan2005/NavFleet/commit/be3c24e42c3c8733eb088beaa9933967a3bc6a49))
* **frontend:** theme-aware ROS map, compact top bar, favicon, ROS label ([9215a2e](https://github.com/yezhoufan2005/NavFleet/commit/9215a2e1f4d3887985ce1d7b206a40620ce954d4))
* **sim+ui:** realistic deterministic simulation, stable sort, map focus ([73ffe00](https://github.com/yezhoufan2005/NavFleet/commit/73ffe007959ed3d2f8781d669d5af1ef9114e64b))
* **ui:** ROS map framing/theme, alert stats, history layout, collapsible fleet ([c553753](https://github.com/yezhoufan2005/NavFleet/commit/c5537532ff3b5174d9e6b53ce64b484082f8d9c5))
