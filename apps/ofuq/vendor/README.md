# vendored

Third-party code that ships as-is because the app is plain ES modules with no bundler.

| File | Version | Licence | Why vendored |
| --- | --- | --- | --- |
| `three.module.min.js` | three.js **r150.1** | MIT (`three.js` authors) | The 3D city view. A CDN import would break the offline shell and add a third-party at runtime; a bundler would add a build step the repository does not have. |

`three.module.min.js` was produced from the npm tarball of `three@0.150.1`:

```
npm pack three@0.150.1
terser package/build/three.module.js --module --compress --mangle -o three.module.min.js
```

614 KB raw, 154 KB over the wire (gzip). It is loaded with a dynamic `import()` only when the
browser can create a WebGL context (`supportsWebGL()` in `src/scene.js`), so devices that
cannot render the city never download it.

**Do not edit the file.** To upgrade: repeat the steps above, keep the `/*! three.js … */`
licence banner, bump the version in this table, and re-run `npm run verify`.
