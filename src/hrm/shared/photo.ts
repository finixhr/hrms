"use client"
// ============ Client-side employee-photo pipeline ============
// Shared by the 360° profile avatar upload, the photo lightbox "Change Photo"
// button, and the FormDialog "photo" field type (employee create form).
//
// Returns TWO JPEG data URLs from ONE decoded file:
//   photoUrl  — 512×512 "full" view (lightbox, 360° profile, PDF embed)
//   photoThumb — 96×96 list thumbnail (directory rows, org-chart nodes —
//                keeps employees.list / orgChart.data payloads tiny)
//
// Crop algorithm (fixes the "zoomed-in photo" bug):
// The old pipeline cropped a tiny `size`-px square straight out of the
// ORIGINAL photo (a 200×200 sliver of a 3000×4000 phone photo = a 15×
// zoomed macro shot). The correct approach is the opposite order:
//   1. crop the LARGEST square that fits the image (min(w,h)),
//   2. then scale that square DOWN to the target size.
// For portrait photos (h > w) the square uses the full width and only part
// of the height — placed with a face bias: the crop window's centre sits at
// ~35% of the image height (between the rule-of-thirds line and centre), so
// head and eyes survive the crop instead of the old dead-centre crop that
// kept only nose/mouth. Landscape and square sources are centred (their
// full height already fits). Small sources are never upscaled.
export function processEmployeePhoto(
  file: File,
  opts: { fullSize?: number; thumbSize?: number; quality?: number } = {},
): Promise<{ photoUrl: string; photoThumb: string }> {
  const fullSize = opts.fullSize ?? 512
  const thumbSize = opts.thumbSize ?? 96
  const quality = opts.quality ?? 0.85
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file (PNG, JPEG or WebP)"))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("Could not read the selected file"))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error("Could not decode the selected image"))
      img.onload = () => {
        try {
          // ---- 1. largest inscribed square, face-biased for portraits ----
          const side = Math.min(img.width, img.height)
          const sx = (img.width - side) / 2 // landscape/square: horizontal centring is never adjusted
          let sy = (img.height - side) / 2
          if (img.height > img.width) {
            // Portrait: centre the crop window at 35% of image height —
            // where faces sit in typical ID / phone portraits. Clamp to the
            // image bounds (0 .. free space) so extreme shapes stay valid.
            const free = img.height - side
            const faceBias = 0.35 * img.height - side / 2
            sy = Math.max(0, Math.min(free, faceBias))
          }
          const draw = (outSize: number, q: number): string => {
            // never upscale: a 120×120 source stays 120×120
            const out = Math.max(1, Math.min(outSize, side))
            const canvas = document.createElement("canvas")
            canvas.width = out
            canvas.height = out
            const ctx = canvas.getContext("2d")
            if (!ctx) throw new Error("Canvas is not supported in this browser")
            // high-quality downscale (bilinear+ smoothing beats nearest)
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = "high"
            ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out)
            return canvas.toDataURL("image/jpeg", q)
          }
          resolve({
            photoUrl: draw(fullSize, quality),
            photoThumb: draw(thumbSize, 0.8),
          })
        } catch (e: any) {
          reject(new Error(e?.message || "Photo processing failed"))
        }
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

// Backward-compatible single-image helper (kept for any caller that only
// needs one size — the avatar crop geometry is identical).
export function resizeImageToDataUrl(file: File, size = 512, quality = 0.85): Promise<string> {
  return processEmployeePhoto(file, { fullSize: size, quality }).then((r) => r.photoUrl)
}
