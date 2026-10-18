export async function prepareAvatarImage(file: File): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error("Choose a PNG, JPEG, or WebP image under 8 MB.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 192, 192);
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 192, 192);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const encoded = dataUrl.split(",")[1];
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (bytes.byteLength > 128 * 1024) throw new Error("This image is too large after resizing.");
    return { bytes, dataUrl };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
