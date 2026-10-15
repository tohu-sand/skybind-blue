// Leave 3% headroom below Bluesky's 2,000,000-byte blob limit.
const TARGET_BYTES = 1_940_000
// The CDN serves fullsize images at up to 4000x4000.
const MAX_DIM = 4000
const Q_WEBP = 0.9
const Q_JPEG = 0.85
const ALPHA_PRIOR = 0.8
const ALPHA_MIN = 0.5
const ALPHA_MAX = 1.1
// Leave room for prediction error.
const PREDICT_BYTES = Math.round(TARGET_BYTES * 0.95)
const ACCEPT_BYTES = Math.round(TARGET_BYTES * 0.87)
const MAX_ATTEMPTS = 5
const OVERSHOOT_BACKOFF = 0.97
const MIN_GAIN = 1.02
// Conservative passthrough limit for the CDN's undocumented source-pixel cap.
const MAX_PASSTHROUGH_PIXELS = 26_000_000

type CompressionCapabilities = {
  supportsWebP: boolean
  supportsBitmapResize: boolean
  supportsOffscreenCanvas: boolean
}

export type CompressionStrategy =
  | 'full-resolution'
  | 'max-dimension'
  | 'scale-search'
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
  attempts: number
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
  const passthroughCandidate =
    options?.skipCompression || (file.size <= TARGET_BYTES && isDirectUploadType(file))
  if (passthroughCandidate) {
    const decoded = await decodeImage(file)
    decoded.close()
    const allowPassthrough =
      options?.skipCompression ||
      decoded.width * decoded.height <= MAX_PASSTHROUGH_PIXELS
    if (allowPassthrough) {
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
        attempts: 0,
      }
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
  // Probe the encoding canvas: unsupported MIME types silently fall back to PNG.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      canvas.getContext('2d')?.fillRect(0, 0, 1, 1)
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
      return blob.type === 'image/webp'
    } catch {
      return false
    }
  }
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

// Search for the largest image under TARGET_BYTES at fixed quality.
// Predict scale from bytes ≈ C·pixels^alpha, fitted to the latest samples.
const compressImage = async (
  file: File,
  caps: CompressionCapabilities,
): Promise<CompressedImage> => {
  const decoded = await decodeImage(file)
  try {
    const { width: sourceWidth, height: sourceHeight } = decoded
    const originalBytes = file.size
    let format = caps.supportsWebP ? 'image/webp' : 'image/jpeg'
    let quality = format === 'image/webp' ? Q_WEBP : Q_JPEG

    const maxScale = Math.min(1, MAX_DIM / sourceWidth, MAX_DIM / sourceHeight)

    type Sample = { scale: number; pixels: number; bytes: number }
    type Fit = { blob: Blob; width: number; height: number; scale: number }

    const samples: Sample[] = []
    let best: Fit | null = null
    let smallestOvershoot = Infinity
    let scale = maxScale
    let attempts = 0

    const encodeAt = async (s: number) => {
      const width = Math.max(1, Math.min(MAX_DIM, Math.round(sourceWidth * s)))
      const height = Math.max(1, Math.min(MAX_DIM, Math.round(sourceHeight * s)))
      const canvas = await downscaleToCanvas(decoded.source, width, height, caps)
      let blob = await canvasToBlob(canvas, format, quality)
      if (blob.type && blob.type !== format && format === 'image/webp') {
        // Use JPEG when the WebP encoder silently falls back to another format.
        format = 'image/jpeg'
        quality = Q_JPEG
        blob = await canvasToBlob(canvas, format, quality)
      }
      attempts += 1
      samples.push({ scale: s, pixels: width * height, bytes: blob.size })
      return { blob, width, height }
    }

    while (attempts < MAX_ATTEMPTS) {
      let encoded: Awaited<ReturnType<typeof encodeAt>>
      try {
        encoded = await encodeAt(scale)
      } catch (err) {
        // A later encode may fail under memory pressure; keep any result that fits.
        if (best) {
          break
        }
        throw err
      }
      const { blob, width, height } = encoded

      if (blob.size <= TARGET_BYTES) {
        if (!best || scale > best.scale) {
          best = { blob, width, height, scale }
        }
        if (blob.size >= ACCEPT_BYTES || scale >= maxScale * 0.999) {
          break
        }
      } else {
        smallestOvershoot = Math.min(smallestOvershoot, scale)
      }

      let alpha = ALPHA_PRIOR
      if (samples.length >= 2) {
        const a = samples[samples.length - 2]
        const b = samples[samples.length - 1]
        const estimated =
          Math.log(a.bytes / b.bytes) / Math.log(a.pixels / b.pixels)
        if (Number.isFinite(estimated)) {
          alpha = Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, estimated))
        }
      }

      const last = samples[samples.length - 1]
      let next =
        last.scale * Math.pow(PREDICT_BYTES / last.bytes, 1 / (2 * alpha))
      next = Math.min(next, maxScale)
      if (smallestOvershoot < Infinity) {
        next = Math.min(next, smallestOvershoot * OVERSHOOT_BACKOFF)
      }
      if (best) {
        if (next <= best.scale * MIN_GAIN) {
          break
        }
      }
      scale = next
    }

    // The size model may miss; keep shrinking until the upload limit is met.
    while (!best) {
      scale *= 0.7
      if (scale < maxScale * 0.05) {
        throw new Error('画像を2MB以下に圧縮できませんでした。')
      }
      const { blob, width, height } = await encodeAt(scale)
      if (blob.size <= TARGET_BYTES) {
        best = { blob, width, height, scale }
      }
    }

    const strategy: CompressionStrategy =
      attempts === 1
        ? maxScale >= 1
          ? 'full-resolution'
          : 'max-dimension'
        : 'scale-search'

    return {
      blob: best.blob,
      width: best.width,
      height: best.height,
      mime: format,
      originalWidth: sourceWidth,
      originalHeight: sourceHeight,
      originalBytes,
      outputBytes: best.blob.size,
      strategy,
      quality,
      attempts,
    }
  } finally {
    decoded.close()
  }
}

type DecodedImage = {
  source: ImageBitmap | HTMLImageElement
  width: number
  height: number
  close: () => void
}

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
      // Some browsers reject files or options supported by the image decoder.
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
  // Narrow the overlapping HTMLCanvasElement and OffscreenCanvas overloads.
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    throw new Error('Canvas context is not available.')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Flatten transparency to white before JPEG encoding or CDN conversion.
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
      // A Blob resize probe does not guarantee support for ImageBitmap sources.
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
