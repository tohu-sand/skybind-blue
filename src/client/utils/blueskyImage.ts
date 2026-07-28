// Bluesky's app.bsky.embed.images lexicon allows blobs up to 2,000,000 bytes
// (raised from 1MB in April 2026); keep ~3% headroom under that ceiling.
const TARGET_BYTES = 1_940_000
const TARGET_MP = 5_000_000
const Q_START_WEBP = 0.9
const Q_START_JPEG = 0.85
const Q_MIN = 0.75
const POWER_K = 0.75
const SAFETY_F = 0.95
const RESIZE_SAFETY = 0.98

type CompressionCapabilities = {
  supportsWebP: boolean
  supportsBitmapResize: boolean
  supportsOffscreenCanvas: boolean
}

export type CompressionStrategy =
  | 'pass1'
  | 'pass1-original'
  | 'pass2-quality'
  | 'pass2-resize'
  | 'passthrough'

export type CompressedImage = {
  blob: Blob
  width: number
  height: number
  mime: string
  originalWidth: number
  originalHeight: number
  originalBytes: number
  outputBytes: number
  strategy: CompressionStrategy
  quality: number
}

const defaultCapabilities: CompressionCapabilities = {
  supportsWebP: false,
  supportsBitmapResize: false,
  supportsOffscreenCanvas: false,
}

const detectCapabilities = async (): Promise<CompressionCapabilities> => {
  const supportsOffscreenCanvas = typeof OffscreenCanvas !== 'undefined'
  const supportsBitmapResize = await testBitmapResize()
  const supportsWebP = await testWebP()
  return {
    supportsWebP,
    supportsBitmapResize,
    supportsOffscreenCanvas,
  }
}

const capabilitiesPromise: Promise<CompressionCapabilities> =
  typeof window === 'undefined'
    ? Promise.resolve(defaultCapabilities)
    : detectCapabilities().catch(() => defaultCapabilities)

export const compressForBluesky = async (
  file: File,
  options?: { skipCompression?: boolean },
): Promise<CompressedImage> => {
  const allowPassthrough =
    options?.skipCompression || (file.size <= TARGET_BYTES && isDirectUploadType(file))
  if (allowPassthrough) {
    const decoded = await decodeImage(file)
    decoded.close()
    const mime = getFileMime(file)
    return {
      blob: file,
      width: decoded.width,
      height: decoded.height,
      mime,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      originalBytes: file.size,
      outputBytes: file.size,
      strategy: 'passthrough',
      quality: 1,
    }
  }
  const caps = await capabilitiesPromise
  return compressImage(file, caps)
}

const testBitmapResize = async () => {
  if (typeof createImageBitmap !== 'function') {
    return false
  }
  try {
    const blob = createTestPngBlob()
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: 2,
      resizeHeight: 2,
      resizeQuality: 'high',
    })
    const ok = bitmap.width === 2 && bitmap.height === 2
    bitmap.close?.()
    return ok
  } catch {
    return false
  }
}

const testWebP = async () => {
  if (typeof document === 'undefined') {
    return false
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 1, 1)
  }
  if (!canvas.toBlob) {
    return false
  }
  return await new Promise<boolean>((resolve) => {
    canvas.toBlob(
      (blob) => resolve(Boolean(blob && blob.type === 'image/webp')),
      'image/webp',
      0.8,
    )
  })
}

const createTestPngBlob = () => {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WJHcWQAAAAASUVORK5CYII='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: 'image/png' })
}

const isDirectUploadType = (file: File) => {
  const type = file.type.toLowerCase()
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp') {
    return true
  }
  const name = file.name.toLowerCase()
  return (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp')
  )
}

const getFileMime = (file: File) => {
  if (file.type) {
    return file.type
  }
  const name = file.name.toLowerCase()
  if (name.endsWith('.png')) {
    return 'image/png'
  }
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (name.endsWith('.webp')) {
    return 'image/webp'
  }
  return 'image/png'
}

const compressImage = async (
  file: File,
  caps: CompressionCapabilities,
): Promise<CompressedImage> => {
  const decoded = await decodeImage(file)
  try {
    const { width: sourceWidth, height: sourceHeight } = decoded
    const originalBytes = file.size

    const fullCanvas = renderToCanvas(decoded.source, sourceWidth, sourceHeight, caps)
    const initialBlob = await canvasToBlob(fullCanvas, 'image/jpeg', Q_START_JPEG)
    if (initialBlob.size <= TARGET_BYTES) {
      return {
        blob: initialBlob,
        width: sourceWidth,
        height: sourceHeight,
        mime: 'image/jpeg',
        originalWidth: sourceWidth,
        originalHeight: sourceHeight,
        originalBytes,
        outputBytes: initialBlob.size,
        strategy: 'pass1-original',
        quality: Q_START_JPEG,
      }
    }

    const { width, height } = calculateTargetSize(sourceWidth, sourceHeight)
    const canvas =
      width === sourceWidth && height === sourceHeight
        ? fullCanvas
        : await downscaleToCanvas(decoded.source, width, height, caps)

    const format = caps.supportsWebP ? 'image/webp' : 'image/jpeg'
    const q1 = format === 'image/webp' ? Q_START_WEBP : Q_START_JPEG
    const blob1 = await canvasToBlob(canvas, format, q1)

    if (blob1.size <= TARGET_BYTES) {
      return {
        blob: blob1,
        width,
        height,
        mime: format,
        originalWidth: sourceWidth,
        originalHeight: sourceHeight,
        originalBytes,
        outputBytes: blob1.size,
        strategy: 'pass1',
        quality: q1,
      }
    }

    const ratio = TARGET_BYTES / blob1.size
    const q2 = q1 * Math.pow(ratio, POWER_K) * SAFETY_F

    if (q2 >= Q_MIN) {
      const blob2 = await canvasToBlob(canvas, format, q2)
      return {
        blob: blob2,
        width,
        height,
        mime: format,
        originalWidth: sourceWidth,
        originalHeight: sourceHeight,
        originalBytes,
        outputBytes: blob2.size,
        strategy: 'pass2-quality',
        quality: q2,
      }
    }

    const scale = Math.sqrt(ratio) * RESIZE_SAFETY
    const newWidth = Math.max(1, Math.floor(width * scale))
    const newHeight = Math.max(1, Math.floor(height * scale))
    const smallCanvas = createCanvas(newWidth, newHeight, caps.supportsOffscreenCanvas)
    const smallCtx = smallCanvas.getContext('2d')
    if (!smallCtx) {
      throw new Error('Canvas context is not available.')
    }
    smallCtx.imageSmoothingEnabled = true
    smallCtx.imageSmoothingQuality = 'high'
    smallCtx.drawImage(canvas as CanvasImageSource, 0, 0, newWidth, newHeight)
    const blob2 = await canvasToBlob(smallCanvas, format, q1)

    return {
      blob: blob2,
      width: newWidth,
      height: newHeight,
      mime: format,
      originalWidth: sourceWidth,
      originalHeight: sourceHeight,
      originalBytes,
      outputBytes: blob2.size,
      strategy: 'pass2-resize',
      quality: q1,
    }
  } finally {
    decoded.close()
  }
}

const calculateTargetSize = (width: number, height: number) => {
  const pixelCount = width * height
  if (pixelCount <= TARGET_MP) {
    return { width, height }
  }
  const scale = Math.sqrt(TARGET_MP / pixelCount)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

type DecodedImage = {
  source: ImageBitmap | HTMLImageElement
  width: number
  height: number
  close: () => void
}

// Decode the file exactly once; every later canvas draw reuses this source
// instead of re-decoding the file.
const decodeImage = async (file: File): Promise<DecodedImage> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.(),
      }
    } catch {
      // Some browsers expose createImageBitmap but reject supported files or
      // the orientation option. The regular image decoder can still handle them.
    }
  }
  const img = await loadImage(file)
  return {
    source: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    close: () => {},
  }
}

const loadImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      resolve(img)
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像の読み込みに失敗しました。'))
    }
    img.src = url
  })

const renderToCanvas = (
  source: CanvasImageSource,
  width: number,
  height: number,
  caps: CompressionCapabilities,
) => {
  const canvas = createCanvas(width, height, caps.supportsOffscreenCanvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas context is not available.')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Flatten transparency onto white: JPEG output (and Bluesky's CDN, which
  // re-serves fullsize as JPEG) would otherwise render transparent areas black.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

const downscaleToCanvas = async (
  source: ImageBitmap | HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
  caps: CompressionCapabilities,
) => {
  if (caps.supportsBitmapResize && typeof createImageBitmap === 'function') {
    try {
      const resized = await createImageBitmap(source, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'high',
      })
      const canvas = renderToCanvas(resized, targetWidth, targetHeight, caps)
      resized.close?.()
      return canvas
    } catch {
      // The capability probe used a Blob source; if a bitmap source is
      // rejected, fall through to the plain canvas downscale.
    }
  }
  return renderToCanvas(source, targetWidth, targetHeight, caps)
}

const createCanvas = (
  width: number,
  height: number,
  supportsOffscreenCanvas: boolean,
) => {
  if (supportsOffscreenCanvas && typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const canvasToBlob = async (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
) => {
  if ('convertToBlob' in canvas) {
    return await canvas.convertToBlob({ type, quality })
  }
  return await new Promise<Blob>((resolve, reject) => {
    const htmlCanvas = canvas as HTMLCanvasElement
    htmlCanvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('画像のエンコードに失敗しました。'))
          return
        }
        resolve(blob)
      },
      type,
      quality,
    )
  })
}
