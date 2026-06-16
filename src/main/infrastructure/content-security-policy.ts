import { session } from "electron";

export function installContentSecurityPolicy(): void {
  // CSP is installed from the main process session so renderer code cannot
  // relax script, style, or connection policy at runtime. The `<meta>` CSP in
  // src/renderer/index.html mirrors the production policy as a defense-in-depth
  // fallback: onHeadersReceived may not fire for the main `file://` document in
  // a packaged build, and the meta tag still applies script/style/connect rules
  // (note: meta-CSP cannot express frame-ancestors/sandbox, so the header is
  // the authoritative source for those).
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const policy = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}
