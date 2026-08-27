import http from "node:http";
import https from "node:https";

/**
 * Turn off HTTP connection pooling for the whole test process.
 *
 * Node 19+ ships `http.globalAgent` with `keepAlive: true`, and supertest
 * starts a fresh server on an ephemeral port for *every* request, then closes it
 * as soon as the response arrives. Ports are therefore recycled constantly
 * while sockets from already-closed servers sit in the agent's pool. Reusing one
 * of those either hangs the request until the test times out, or — when the OS
 * has meanwhile handed that port to another test's server — delivers it to the
 * wrong listener: a REST assertion once got `426 Upgrade Required`, which only
 * the WebSocket harness can produce.
 *
 * The symptom was a suite that failed roughly one run in two, in a different
 * test each time. With pooling off, every request opens its own socket and no
 * stale connection can outlive its server.
 */
http.globalAgent.keepAlive = false;
http.globalAgent.destroy();
https.globalAgent.keepAlive = false;
https.globalAgent.destroy();
