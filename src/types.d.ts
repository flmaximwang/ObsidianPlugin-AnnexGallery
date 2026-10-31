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

// `electron` is provided by the Obsidian desktop app at runtime (esbuild keeps it
// external, see esbuild.config.mjs). The plugin does not depend on the `electron`
// package, so the two APIs it uses are declared here — that keeps
// `await import("electron")` type-checked without pulling in electron's typings.
//
// `shell` is main-process only: in the renderer (where Obsidian loads plugins) the
// module exists but has no `shell`, hence the explicit `undefined`.
declare module "electron" {
  export const shell:
    | {
        /** Opens `path` with the OS default app; resolves to "" on success, else the reason. */
        openPath(path: string): Promise<string>;
      }
    | undefined;
}
