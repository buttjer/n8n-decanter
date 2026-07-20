// BASE_URL is "/n8n-decanter" (or "/" for a custom-domain deploy).
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Prefix a root-relative path with the deploy base. */
export const href = (path: string): string => base + path;
