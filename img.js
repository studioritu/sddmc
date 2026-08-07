// SDDMC — client-side image compression.
//
// This is load-bearing, not an optimisation. Members upload straight from a
// phone, where a single photo is 4-8 MB. At 25 members x ~20 pieces that is
// roughly 2 GB, well past the 1 GB free storage allowance. Resizing here
// brings the same 500 images to roughly 137 MB.
//
// Every upload produces two files: a display image for the lightbox and a
// much smaller thumbnail for grids. Grids are most of the traffic, so serving
// thumbs there is what keeps monthly egress inside the free allowance.

const DISPLAY_MAX_PX = 1600;
const THUMB_MAX_PX = 400;
const DISPLAY_QUALITY = 0.82;
const THUMB_QUALITY = 0.72;

// Guard against someone picking a RAW file or a video by mistake. Decoding a
// 200 MB file will hang or crash the tab rather than fail cleanly.
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

/** Raised for anything the member can fix by choosing a different file. */
export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

let webpSupported = null;

/**
 * Safari only gained canvas WebP encoding in 14. Older browsers silently hand
 * back a PNG from toBlob, which would be far larger than the original JPEG —
 * so detect properly and fall back to JPEG rather than assuming.
 * @returns {boolean}
 */
function supportsWebp() {
  if (webpSupported === null) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    webpSupported = probe.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpSupported;
}

/**
 * @param {File} file
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function decode(file) {
  // `from-image` applies EXIF rotation. Without it, photos taken in portrait
  // on a phone come out sideways.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the <img> path below rather than failing the upload.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new ImageError('That file could not be read as an image.'));
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {ImageBitmap|HTMLImageElement} source
 * @param {number} maxPx Longest edge of the output, in pixels.
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
async function render(source, maxPx, quality) {
  const w = source.width;
  const h = source.height;
  // Never upscale — enlarging a small image only wastes bytes.
  const scale = Math.min(1, maxPx / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('This browser could not process the image.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  const type = supportsWebp() ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new ImageError('This browser could not compress the image.');
  return blob;
}

/**
 * Turn a picked file into the two blobs that get uploaded.
 *
 * @param {File} file
 * @returns {Promise<{display: Blob, thumb: Blob, ext: string, width: number, height: number}>}
 * @throws {ImageError} When the file is not a usable image.
 */
export async function prepareImage(file) {
  if (!file) throw new ImageError('Choose an image first.');
  if (!file.type.startsWith('image/')) {
    throw new ImageError('That is not an image. Use a JPG, PNG or WebP.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    const mb = Math.round(file.size / 1024 / 1024);
    throw new ImageError(`That image is ${mb} MB. Use one under 40 MB.`);
  }

  const source = await decode(file);
  try {
    const [display, thumb] = await Promise.all([
      render(source, DISPLAY_MAX_PX, DISPLAY_QUALITY),
      render(source, THUMB_MAX_PX, THUMB_QUALITY),
    ]);

    return {
      display,
      thumb,
      ext: supportsWebp() ? 'webp' : 'jpg',
      width: source.width,
      height: source.height,
    };
  } finally {
    // ImageBitmaps hold decoded pixels off-heap; without this, uploading a
    // batch in one sitting steadily eats memory until the tab is reloaded.
    if (typeof source.close === 'function') source.close();
  }
}

/**
 * Local preview without a round trip to storage. The caller must revoke the
 * URL when the preview is torn down.
 * @param {Blob} blob
 * @returns {string}
 */
export function previewUrl(blob) {
  return URL.createObjectURL(blob);
}
