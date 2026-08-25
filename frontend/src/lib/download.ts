export function downloadText(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadFile(
  url: string,
  filename: string
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export function annotatedMusicXmlFilename(sourceName: string): string {
  const basename = sourceName.replace(/\.(musicxml|xml|mxl)$/i, "");
  return `${basename}-annotated.musicxml`;
}

export function annotatedPdfFilename(sourceName: string): string {
  const basename = sourceName.replace(/\.[^.]+$/i, "");
  return `${basename}-CDEFGAB标注版.pdf`;
}
