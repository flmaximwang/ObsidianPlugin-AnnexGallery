// The bundled .gitattributes / .gitignore defaults are loaded as raw text by
// esbuild (see esbuild.config.mjs, the `defaults-text` plugin).
declare module "*/gitattributes" {
  const content: string;
  export default content;
}

declare module "*/gitignore" {
  const content: string;
  export default content;
}

// Built-in metadata (.md) and gallery (.base) templates under src/defaults/,
// inlined as raw text by the same esbuild `defaults-text` plugin.
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.base" {
  const content: string;
  export default content;
}
