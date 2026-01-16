export const FRONTEND_DEFAULTS = {
  MAX_PDF_BYTES: 10 * 1024 * 1024,
  MAX_PDF_LABEL: '10MB',
  PDF_MIME: 'application/pdf',
};

export const API_DEFAULTS = {
  BASE_URL: import.meta.env.VITE_API_URL || 'http://localhost:8080',
};
