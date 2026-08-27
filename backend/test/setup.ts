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
const disablePooling = (agent: http.Agent): void => {
  // `keepAlive` is a real, mutable property on the running Agent — Node reads it
  // when deciding whether to return a finished socket to the pool — but
  // @types/node models it as a constructor option only, hence the cast. Mutating
  // the existing agent rather than replacing `globalAgent` matters: Node's HTTP
  // client resolves the default agent through its own internal reference, which
  // a reassignment would not necessarily reach.
  (agent as http.Agent & { keepAlive: boolean }).keepAlive = false;
  agent.destroy();
};

disablePooling(http.globalAgent);
disablePooling(https.globalAgent);
