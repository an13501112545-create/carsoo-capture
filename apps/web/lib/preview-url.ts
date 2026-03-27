const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

export function resolvePreviewUrl(previewUrl?: string | null): string {
  if (!previewUrl) return '';
  if (previewUrl.startsWith('http://') || previewUrl.startsWith('https://')) {
    return previewUrl;
  }
  return `${API_BASE}${previewUrl}`;
}
