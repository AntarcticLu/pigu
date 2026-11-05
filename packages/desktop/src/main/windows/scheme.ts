import electron, { type BrowserWindow } from "electron"

export const rendererProtocol = "oc"

export const rendererHost = "renderer"

export function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const target = devUrl ? new URL(html, devUrl).toString() : `${rendererProtocol}://${rendererHost}/${html}`

  const attempt = (retries: number) => {
    if (win.isDestroyed()) return
    void win.loadURL(target).catch(() => {
      if (retries <= 0 || win.isDestroyed()) return
      setTimeout(() => attempt(retries - 1), 600)
    })
  }

  attempt(5)
}

export function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)

  if (html && !url.pathname.endsWith(".html")) return false

  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL

  if (!devUrl || !URL.canParse(devUrl)) return false

  return url.origin === new URL(devUrl).origin
}

// Scheme privileges can only be granted before the app is ready, so the entry module calls this
// before it loads anything else.
export function registerRendererScheme() {
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: rendererProtocol,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        // Plugin fonts and fetched assets are cross-origin to the renderer.
        corsEnabled: true,
        stream: true,
        // Let Chromium keep V8 bytecode for the renderer bundle between launches.
        codeCache: true,
      },
    },
  ])
}
