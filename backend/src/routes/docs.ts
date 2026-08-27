import express from "express";
import path from "node:path";
import helmet from "helmet";
import { openApiDocument } from "../openapi";

/** Where the browser can reach the interactive docs. */
export const DOCS_PATH = "/docs";

/**
 * Swagger UI's static assets on disk.
 *
 * Resolved from the package's manifest rather than by importing the package:
 * `swagger-ui-dist` ships no type declarations, and this avoids pulling in
 * `@types/swagger-ui-dist` purely to learn one directory path.
 */
const swaggerAssetsPath = path.dirname(require.resolve("swagger-ui-dist/package.json"));

/**
 * The one HTML page Swagger UI needs. `swagger-ui-dist` ships its own
 * `index.html`, but that one points at petstore.swagger.io and pulls in a
 * `swagger-initializer.js` we would have to overwrite — serving our own three
 * lines of bootstrap is less machinery than patching theirs.
 *
 * Everything it loads is same-origin from the mounted dist directory: no CDN, so
 * the docs work on an air-gapped deployment and no third party gets a request.
 */
const page = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NavFleet API</title>
    <link rel="stylesheet" href="${DOCS_PATH}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${DOCS_PATH}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "${DOCS_PATH}/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        // The session cookie is httpOnly, so "try it out" works only because the
        // browser attaches it to same-origin requests for us.
        withCredentials: true,
      });
    </script>
  </body>
</html>
`;

/**
 * Interactive API docs, mounted behind the auth gate alongside the raw document.
 *
 * The app-wide CSP is `default-src 'none'` — correct for a JSON API, and fatal
 * for a page that has to load a script and a stylesheet. Rather than loosening
 * the global policy, this router sets its own on just these routes: same-origin
 * scripts and styles, plus the inline bootstrap above and the inline styles
 * Swagger UI writes at runtime.
 */
export const buildDocsRouter = (): express.Router => {
  const router = express.Router();

  router.use(
    DOCS_PATH,
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:"],
          "font-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        },
      },
    }),
  );

  // Served from this router rather than reusing /openapi.json so the page has a
  // relative URL that survives being mounted behind a path prefix.
  router.get(`${DOCS_PATH}/openapi.json`, (_request, response) => {
    response.json(openApiDocument);
  });

  router.get(DOCS_PATH, (_request, response) => {
    response.type("html").send(page);
  });

  // The dist directory ships its own index.html plus the swagger-initializer.js
  // that points it at petstore.swagger.io. `index: false` only stops a directory
  // request from resolving to it — an explicit path still would — so both are
  // refused outright rather than left as a route advertising a third party.
  router.get([`${DOCS_PATH}/index.html`, `${DOCS_PATH}/swagger-initializer.js`], (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  router.use(DOCS_PATH, express.static(swaggerAssetsPath, { index: false, fallthrough: true }));

  return router;
};
