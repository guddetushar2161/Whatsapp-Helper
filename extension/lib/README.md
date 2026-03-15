# lib/ — Vendored Third-Party Libraries

This directory holds locally bundled JavaScript libraries required by the extension.

## SheetJS (XLSX) — Required

Chrome Extension Manifest V3 does **not** allow loading scripts from remote CDNs.
You must download SheetJS and place it here before loading the extension.

### Steps

1. Download the minified build from the official CDN:

   ```
   curl -o xlsx.full.min.js \
     https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
   ```

   Or download it from the [SheetJS GitHub releases](https://github.com/SheetJS/sheetjs/releases/tag/v0.18.5).

2. Verify the SHA-512 integrity of the downloaded file against the hash published
   on cdnjs.cloudflare.com before placing it here.

3. The file is referenced by `popup.html` as:
   ```html
   <script src="lib/xlsx.full.min.js"></script>
   ```

> **Never load untrusted scripts in a browser extension.**
> Always verify the file hash before committing.
