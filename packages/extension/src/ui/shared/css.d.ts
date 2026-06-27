// esbuild bundles `import "...css"` side-effect imports into <entry>.css.
// This stub keeps tsc happy about those imports.
declare module "*.css";
