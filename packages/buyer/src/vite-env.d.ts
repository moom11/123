/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute URL of the API Worker, baked in at build time. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
