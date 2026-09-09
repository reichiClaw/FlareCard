import type { PhotoField } from "./api";

export const MAX_PHOTO_BYTES = 512 * 1024;
const MAX_DIMENSION = 512;

/**
 * Downscales an image file to at most 512x512 and re-encodes it as JPEG so the
 * resulting base64 comfortably fits under the server-side size cap.
 */
export async function fileToPhoto(file: File): Promise<PhotoField> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file");
  const bitmap = await loadImage(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  let quality = 0.9;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (base64Bytes(dataUrl) > MAX_PHOTO_BYTES && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (base64Bytes(dataUrl) > MAX_PHOTO_BYTES) throw new Error("Photo is too large even after compression");
  return { mediaType: "image/jpeg", base64: dataUrl.split(",")[1] };
}

function base64Bytes(dataUrl: string): number {
  const b64 = dataUrl.split(",")[1] ?? "";
  return Math.floor((b64.length * 3) / 4);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image"));
    };
    img.src = url;
  });
}

export function photoDataUrl(photo: PhotoField | null | undefined): string | undefined {
  return photo ? `data:${photo.mediaType};base64,${photo.base64}` : undefined;
}
