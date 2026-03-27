const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

export function resolvePreviewUrl(previewUrl?: string | null): string {
  if (!previewUrl) {
    return '';
  }

  if (previewUrl.startsWith('http://') || previewUrl.startsWith('https://')) {
    return previewUrl;
  }

  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const path = previewUrl.startsWith('/') ? previewUrl : `/${previewUrl}`;
  return `${base}${path}`;
}
