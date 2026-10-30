# Web Awesome 3.14.0

Vendored MIT-licensed tab-group, tab, tab-panel and their unmodified transitive dist-cdn modules and default theme from @awesome.me/webawesome@3.14.0 (npm). No Pro components. Files are served locally and included by the existing public-directory installer. manifest.json records SHA-256 checksums.

Upstream: https://webawesome.com/docs/components/tab-group

To refresh deliberately: npm pack the pinned version into a temporary directory; copy only the above entrypoints and recursively referenced relative JS/CSS assets; regenerate the manifest and exact static allowlist; run the asset audit and browser settings checks. Do not import the autoloader or fetch assets from a runtime CDN.
