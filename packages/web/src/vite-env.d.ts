/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute URL of the API, baked in at build time. Empty = same origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
