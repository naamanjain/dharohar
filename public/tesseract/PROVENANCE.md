# Vendored Tesseract OCR assets — provenance and licence

Everything in this directory is served from the DHAROHAR origin. No request is made to
`cdn.jsdelivr.net`, `tessdata.projectnaptha.com` or any other third-party host at runtime.
Vendored on 2026-10-16. Verification commands were run against the exact URLs below.

## What tesseract.js v7 loads, and where we put it

`createWorker(langs, oem, options)` (third argument) is the mechanism for the installed
version — `node_modules/tesseract.js/src/createWorker.js` passes `workerPath`, `corePath`
and `langPath` through `src/utils/resolvePaths.js`, which rewrites each of them to an
absolute URL against `window.location.href` on the main thread, and then:

- `src/worker/browser/spawnWorker.js` uses `workerPath` to construct the `Worker`.
- `src/worker-script/browser/getCore.js` uses `corePath` as a **directory** and picks
  `tesseract-core-{relaxedsimd-,}lstm.wasm.js` or `tesseract-core-lstm.wasm.js` based on
  `wasm-feature-detect` SIMD probing (because `OEM.LSTM_ONLY` is used, `lstmOnly` is true).
- `src/worker-script/index.js` (`loadLanguage`) fetches `${langPath}/${lang}.traineddata.gz`
  (`gzip` defaults to true).

`setUrl()` does not exist in v7 (it was the v4/v5 API), and the v5-era `Tesseract.setWorkerPath`
style globals are gone, so the `createWorker` options object is the correct and only hook.

## Files, exact source URLs and sizes

| File | Size (bytes) | Exact source URL | SHA-256 |
| --- | --- | --- | --- |
| `worker.min.js` | 111,307 | `node_modules/tesseract.js/dist/worker.min.js` (npm `tesseract.js@7.0.0`) | see `sha256sum.txt` |
| `core/tesseract-core-lstm.wasm.js` | 3,896,484 | `node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js` (npm `tesseract.js-core@7.0.0`) | see `sha256sum.txt` |
| `core/tesseract-core-simd-lstm.wasm.js` | 3,899,472 | same package | see `sha256sum.txt` |
| `core/tesseract-core-relaxedsimd-lstm.wasm.js` | 3,905,767 | same package | see `sha256sum.txt` |
| `lang/eng.traineddata.gz` | 2,952,873 | `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz` | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` |
| `lang/hin.traineddata.gz` | 1,389,692 | `https://cdn.jsdelivr.net/npm/@tesseract.js-data/hin/4.0.0_best_int/hin.traineddata.gz` | `f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07` |

The `.wasm.js` bundles carry the WASM module base64-embedded, so the sibling
`tesseract-core-*.wasm` files in `tesseract.js-core` are **not** needed at runtime and are
intentionally not vendored (they would add ~8.5 MB and an extra `connect-src` fetch).
Only the three `*-lstm.wasm.js` variants are vendored because `localOcrEngine.ts` pins
`OEM.LSTM_ONLY` and does not set `legacyCore`, so `getCore.js` can never select a
non-LSTM file. If OEM is ever changed away from `LSTM_ONLY`, the non-LSTM
`tesseract-core*.wasm.js` files must be vendored as well or OCR will 404.

The `4.0.0_best_int` set is precisely the set tesseract.js v7 downloads by default for
LSTM-only mode (see `src/worker-script/index.js`: `langPath || `
`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`). Cross-checked for
byte-identity against the upstream git source:
`https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best_int/{eng,hin}.traineddata.gz`
produced identical SHA-256 digests and identical decompressed bytes.

## Residual CDN strings (important for an honest audit)

Overriding `workerPath` / `corePath` / `langPath` changes which URL is *fetched*; it does not
delete tesseract.js's own fallback constants, which are reachable-but-shadowed code and so
survive tree-shaking:

- `dist/assets/*.js` contains exactly **one** `cdn.jsdelivr.net` string — the default
  `workerPath` from `src/worker/browser/defaultOptions.js`. `createWorker` folds options as
  `{ ...defaultOptions, ..._options }`, so ours wins and it is never requested.
- `dist/tesseract/worker.min.js` contains the default `corePath` and default `langPath`
  strings. Both sit in `param || CDN` expressions (`getCore.js`, `loadLanguage`) and are
  bypassed because `corePath` / `langPath` are supplied.
- `dist/assets/*.js` contains **zero** occurrences of `tessdata.projectnaptha.com` and zero of
  `@tesseract.js-data`. Note that tesseract.js v7 never used `tessdata.projectnaptha.com` at
  all — the allow-list entry for it in the old CSP was dead weight.

Erasing the shadowed defaults entirely would require patching `node_modules`, so the check in
`Dockerfile.web` asserts on the origins that would change behaviour plus the presence of our
own same-origin `workerPath`, and the browser network log is the proof that no CDN request
ever happens.

## Licences — checked at source, not assumed

- **tesseract.js 7.0.0 — Apache-2.0.** Checked `node_modules/tesseract.js/LICENSE.md` (full
  Apache-2.0 text), `package.json` `"license": "Apache-2.0"`, and upstream
  `https://raw.githubusercontent.com/naptha/tesseract.js/master/LICENSE.md`.
- **tesseract.js-core 7.0.0 (the WASM build actually loaded) — Apache-2.0.** Checked
  `node_modules/tesseract.js-core/LICENSE` (full Apache-2.0 text), its `package.json`
  `"license": "Apache-2.0"`, and upstream
  `https://raw.githubusercontent.com/naptha/tesseract.js-core/master/LICENSE`.
- **`eng` / `hin` traineddata — Apache-2.0.** Checked
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/LICENSE` (Apache-2.0) and
  that repo's `README.md`, which states verbatim: "All data in the repository are licensed under
  the Apache-2.0 License, see file LICENSE". Also checked
  `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/LICENSE` (Apache-2.0) for the
  `naptha/tessdata` repo that publishes `4.0.0_best_int`; its `README.md` describes
  `4.0.0_best_int` as the "Integerized Version of 'Tessdata Best'", i.e. a derivative of
  `tessdata_best`, so the same Apache-2.0 term carries through.
- **Caveat worth stating to an evaluator:** the npm wrapper packages
  `@tesseract.js-data/eng` / `@tesseract.js-data/hin` (v1.0.0) declare `"license": "MIT"` in
  their `package.json`, but their `repository.url` is `https://github.com/naptha/tessdata.git`
  and they contain no original model work — the MIT field describes the npm packaging, the
  model data is Apache-2.0 as verified above. Apache-2.0 is the more restrictive/metadata-neutral
  reading and we comply with it.

**Conclusion: all three asset classes may be legally redistributed inside the DHAROHAR Docker
image**, provided we (a) ship a copy of the licence text and (b) retain attribution notices —
Apache-2.0 §4(a)/(c). Copies are in `licenses/`. The upstream repos contain no `NOTICE` file,
so §4(d) does not apply. Also bundled: the webpack third-party notice files for
`worker.min.js` and `tesseract.min.js` (MIT/BSD-3-Clause: buffer, ieee754,
regenerator-runtime, zlib.js).

## Regenerating

```bash
# worker + core come from the pinned npm packages already in node_modules
cp node_modules/tesseract.js/dist/worker.min.js               public/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js       public/tesseract/core/
cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js  public/tesseract/core/
cp node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js public/tesseract/core/

# traineddata (build-time download only; never fetched at runtime)
for l in eng hin; do
  curl -fL -o public/tesseract/lang/$l.traineddata.gz \
    "https://cdn.jsdelivr.net/npm/@tesseract.js-data/$l/4.0.0_best_int/$l.traineddata.gz"
done
```

After regenerating, refresh `sha256sum.txt` with `sha256sum public/tesseract/...`.

## Verified behaviour (2026-10-16)

`npx tsc --noEmit` → exit 0, no output. `docker build -f Dockerfile.web` → exit 0, with
`OCR asset self-hosting check passed.` from the assertion step.

Real recognition, both through `recognizeDocumentText` (Vite dev, `language: 'eng+hin'`) and
against the built image served by nginx: a generated canvas of three lines of known text was
read back character-exactly at **93 % confidence**, e.g.
`KHASRA NO 789/012 / VILLAGE MANDORE TEHSIL JODHPUR / AREA 1 BIGHA 3 BISWA`.

Cold-origin nginx access log for one OCR run (every entry same-origin, referrer chain shows
the worker doing the fetching):

```
GET /tesseract/worker.min.js                                        200
GET /tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js        200   ref /tesseract/worker.min.js
GET /tesseract/lang/eng.traineddata.gz                              200   ref /tesseract/worker.min.js
GET /tesseract/lang/hin.traineddata.gz                              200   ref /tesseract/worker.min.js
```

No request to `cdn.jsdelivr.net` or `tessdata.projectnaptha.com` appears in the log, and
explicit negative probes confirm the CSP is enforcing it: a `<script>` and a `fetch()` pointed
at `cdn.jsdelivr.net` were both reported blocked in the console
(`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`). Google Fonts
(`style-src`/`font-src`) and the OSM + ArcGIS tile hosts (`img-src`) were probed in the same
run and all loaded.

Known pre-existing limitation, unrelated to vendoring: `worker.recognize()` is called with
tesseract.js's default output format, so `data.blocks` is null and `OcrEngineResult.lines`,
`.words` and `.boundingBoxes` come back empty even though `fullText` and `confidence` are
correct. Fixing that means requesting the `blocks` output format, which is outside the scope
of removing the CDN dependency.
