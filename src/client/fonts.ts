// The @font-face rules (one per unicode-range subset) are many times larger than the
// rest of the CSS, so they load on demand instead of blocking the first paint.
let requested = false

export const loadFonts = () => {
  if (requested) {
    return
  }
  requested = true
  import('./fontFaces').catch(() => {
    // Text stays in the fallback font; allow a later caller to retry.
    requested = false
  })
}

// Reader pages are almost all image, so they request fonts only after the first page.
export const isReaderPath = (pathname: string) => /^\/(v|embed)\//.test(pathname)
