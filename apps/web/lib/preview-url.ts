const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

export function resolvePreviewUrl(previewUrl?: string | null): string {
  if (!previewUrl) {
    return '';
  }

  const trimmed = previewUrl.trim();
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const base = API_BASE.replace(/\/+$/, '');
  const path = trimmed.replace(/^\/+/, '');
  return `${base}/${path}`;
}
