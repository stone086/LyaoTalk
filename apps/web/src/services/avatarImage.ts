const MAX_AVATAR_SIDE = 512;
const MAX_AVATAR_BYTES = 160 * 1024;

export async function prepareAvatarImage(file: File): Promise<{ bytes: Uint8Array; dataUrl: string; width: number; height: number }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error("Choose a PNG, JPEG, or WebP image under 8 MB.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    const sourceSide = Math.min(image.naturalWidth, image.naturalHeight);
    const outputSide = Math.min(sourceSide, MAX_AVATAR_SIDE);
    canvas.width = outputSide;
    canvas.height = outputSide;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, outputSide, outputSide);
    context.drawImage(image, (image.naturalWidth - sourceSide) / 2, (image.naturalHeight - sourceSide) / 2, sourceSide, sourceSide, 0, 0, outputSide, outputSide);
    for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const encoded = dataUrl.split(",")[1];
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      if (bytes.byteLength <= MAX_AVATAR_BYTES) {
        return { bytes, dataUrl, width: outputSide, height: outputSide };
      }
    }
    throw new Error("This image is too large after resizing.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
