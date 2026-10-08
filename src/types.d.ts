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
