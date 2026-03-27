const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

export function resolvePreviewUrl(previewUrl?: string | null): string {
  if (!previewUrl) return '';
  if (/^https?:\/\//i.test(previewUrl)) return previewUrl;
  return `${API_BASE}${previewUrl.startsWith('/') ? previewUrl : `/${previewUrl}`}`;
}
