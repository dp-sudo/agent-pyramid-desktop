import { session } from "electron";

export function installContentSecurityPolicy(): void {
  // CSP is installed from the main process session so renderer code cannot
  // relax script, style, or connection policy at runtime.
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const policy = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
      ].join("; ")
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
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
