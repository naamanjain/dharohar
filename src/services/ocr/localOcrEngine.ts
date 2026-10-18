/**
 * DHAROHAR - Local Tesseract.js OCR Engine
 * 
 * 100% Local / Offline in-browser OCR engine:
 * - Powered by Tesseract.js (WASM + Web Workers)
 * - Supports English ('eng') and Hindi / Devanagari ('hin')
 * - Generates full text, line-level and word-level bounding boxes mapped to BoundingBox schema
 * - Exposes real-time progress callbacks for UI telemetry
 * - Robust error handling that never crashes the host application
 * - Clean worker lifecycle management (initialization, reinitialization, termination)
 */

import { createWorker, Worker, OEM, PSM } from 'tesseract.js';
import type { BoundingBox } from '../../types';

export type SupportedLanguage = 'eng' | 'hin' | 'eng+hin';

/**
 * Self-hosted Tesseract asset locations — the app never reaches a CDN at runtime.
 *
 * `createWorker(langs, oem, options)` is the v7 hook: node_modules/tesseract.js
 * /src/createWorker.js routes workerPath/corePath/langPath through
 * src/utils/resolvePaths.js, which rewrites each one to an absolute URL against
 * `window.location.href` on the main thread before it is handed to the worker, so
 * root-relative paths below resolve to this origin. (`setUrl`/`setWorkerPath` were the
 * v4/v5 API and no longer exist in v7.)
 *
 * - workerPath -> src/worker/browser/spawnWorker.js constructs the Worker from it.
 * - corePath   -> src/worker-script/browser/getCore.js treats it as a *directory* and
 *                 picks tesseract-core-{relaxedsimd-,}lstm.wasm.js via wasm-feature-detect.
 * - langPath   -> src/worker-script/index.js `loadLanguage` fetches
 *                 `${langPath}/${lang}.traineddata.gz` (gzip defaults to true).
 *
 * The assets live in `public/tesseract/` (Vite copies `public/` verbatim into `dist/`).
 * Provenance, exact source URLs, sizes, SHA-256 digests and licence analysis are recorded
 * in public/tesseract/PROVENANCE.md.
 */
const TESSERACT_ASSET_BASE = `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/tesseract`;

const OCR_WORKER_PATH = `${TESSERACT_ASSET_BASE}/worker.min.js`;
/** Directory, not a single .js file: a file URL would disable SIMD selection. */
const OCR_CORE_PATH = `${TESSERACT_ASSET_BASE}/core`;
const OCR_LANG_PATH = `${TESSERACT_ASSET_BASE}/lang/`;

export interface OcrProgressUpdate {
  stage: string;
  status: string;
  progress: number; // 0 to 100
  workerId?: string;
}

export type OcrProgressCallback = (update: OcrProgressUpdate) => void;

export interface OcrWordItem {
  id: string;
  text: string;
  confidence: number;
  bbox: BoundingBox;
  rawBbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrLineItem {
  id: string;
  text: string;
  confidence: number;
  bbox: BoundingBox;
  words: OcrWordItem[];
}

export interface OcrEngineResult {
  success: boolean;
  fullText: string;
  confidence: number; // 0 to 100
  lines: OcrLineItem[];
  words: OcrWordItem[];
  boundingBoxes: BoundingBox[];
  processingTimeMs: number;
  languageUsed: SupportedLanguage;
  imageDimensions: { width: number; height: number };
  error?: string;
}

export interface OcrOptions {
  language?: SupportedLanguage;
  psm?: PSM;
  whitelist?: string;
  onProgress?: OcrProgressCallback;
}

/**
 * Singleton worker reference for memory conservation
 */
let activeWorker: Worker | null = null;
let activeWorkerLang: SupportedLanguage | null = null;

/**
 * Normalizes pixel coordinates (x0, y0, x1, y1) into percentage-based BoundingBox
 */
export function normalizeBbox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  imgWidth: number,
  imgHeight: number,
  id: string,
  fieldName: string,
  confidence: number
): BoundingBox {
  const safeW = imgWidth > 0 ? imgWidth : 1000;
  const safeH = imgHeight > 0 ? imgHeight : 1000;

  const left = Math.max(0, Math.min(x0, safeW));
  const top = Math.max(0, Math.min(y0, safeH));
  const right = Math.max(left, Math.min(x1, safeW));
  const bottom = Math.max(top, Math.min(y1, safeH));

  const xPct = Number(((left / safeW) * 100).toFixed(2));
  const yPct = Number(((top / safeH) * 100).toFixed(2));
  const widthPct = Number((((right - left) / safeW) * 100).toFixed(2));
  const heightPct = Number((((bottom - top) / safeH) * 100).toFixed(2));

  return {
    id,
    field: fieldName,
    x: xPct,
    y: yPct,
    width: Math.max(0.5, widthPct),
    height: Math.max(0.5, heightPct),
    confidence: Number(Math.min(100, Math.max(0, confidence)).toFixed(1)),
  };
}

/**
 * Helper to inspect image dimensions from various inputs
 */
async function getImageDimensions(
  imageSource: string | Blob | File | HTMLImageElement | HTMLCanvasElement
): Promise<{ width: number; height: number }> {
  if (typeof HTMLCanvasElement !== 'undefined' && imageSource instanceof HTMLCanvasElement) {
    return { width: imageSource.width, height: imageSource.height };
  }
  if (typeof HTMLImageElement !== 'undefined' && imageSource instanceof HTMLImageElement) {
    return { width: imageSource.naturalWidth || imageSource.width, height: imageSource.naturalHeight || imageSource.height };
  }
  if (typeof window !== 'undefined') {
    return new Promise((resolve) => {
      const img = new Image();
      let url = '';
      let revoke = false;
      if (typeof imageSource === 'string') {
        url = imageSource;
      } else if (typeof Blob !== 'undefined' && imageSource instanceof Blob) {
        url = URL.createObjectURL(imageSource);
        revoke = true;
      }
      img.onload = () => {
        const dim = { width: img.naturalWidth || 800, height: img.naturalHeight || 1100 };
        if (revoke) URL.revokeObjectURL(url);
        resolve(dim);
      };
      img.onerror = () => {
        if (revoke) URL.revokeObjectURL(url);
        resolve({ width: 800, height: 1100 });
      };
      img.src = url;
    });
  }
  return { width: 800, height: 1100 };
}

/**
 * Initializes or reuses the local Tesseract.js worker
 */
export async function getOrInitializeOcrWorker(
  language: SupportedLanguage = 'eng+hin',
  onProgress?: OcrProgressCallback
): Promise<Worker> {
  // If worker is already active with the requested language, reuse it
  if (activeWorker && activeWorkerLang === language) {
    return activeWorker;
  }

  // If language changed or worker needs creation, terminate previous if any
  if (activeWorker) {
    try {
      await activeWorker.terminate();
    } catch {
      // ignore
    }
    activeWorker = null;
    activeWorkerLang = null;
  }

  onProgress?.({
    stage: 'OCR Initialization',
    status: `Allocating local Tesseract WASM worker (${language})...`,
    progress: 10,
  });

  try {
    const langs = language.split('+');
    const worker = await createWorker(langs, OEM.LSTM_ONLY, {
      // Load worker script, WASM core and traineddata from our own origin.
      workerPath: OCR_WORKER_PATH,
      corePath: OCR_CORE_PATH,
      langPath: OCR_LANG_PATH,
      // tesseract.js defaults workerBlobURL to true and wraps workerPath in a
      // `importScripts(...)` blob URL. Spawning the same-origin script directly lets the
      // nginx CSP pin `worker-src 'self'` with no `blob:` allowance.
      workerBlobURL: false,
      // Vendored files are gzip-compressed `.traineddata.gz`, matching v7's default
      // `${langPath}/${lang}.traineddata.gz` request shape.
      gzip: true,
      logger: (m) => {
        if (m && typeof m.progress === 'number') {
          const pct = Math.round(m.progress * 100);
          onProgress?.({
            stage: 'Worker Execution',
            status: m.status || 'Processing text recognition...',
            progress: Math.min(95, Math.max(10, pct)),
          });
        }
      },
    });

    activeWorker = worker;
    activeWorkerLang = language;

    onProgress?.({
      stage: 'OCR Ready',
      status: `Local worker ready (${language}).`,
      progress: 20,
    });

    return worker;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.({
      stage: 'Initialization Error',
      status: `Worker init failed: ${msg}`,
      progress: 0,
    });
    throw new Error(`Failed to initialize local Tesseract OCR worker: ${msg}`);
  }
}

/**
 * Cleanly terminates the active worker instance
 */
export async function terminateOcrWorker(): Promise<void> {
  if (activeWorker) {
    try {
      await activeWorker.terminate();
    } catch (e) {
      console.warn('Error during OCR worker termination:', e);
    } finally {
      activeWorker = null;
      activeWorkerLang = null;
    }
  }
}

/**
 * Main OCR recognition entry point
 */
export async function recognizeDocumentText(
  imageSource: string | Blob | File | HTMLImageElement | HTMLCanvasElement,
  options: OcrOptions = {}
): Promise<OcrEngineResult> {
  const startTime = Date.now();
  const language = options.language || 'eng+hin';
  const { onProgress } = options;

  onProgress?.({
    stage: 'Preprocessing & Dimension Check',
    status: 'Measuring image dimensions and raster buffers...',
    progress: 5,
  });

  const dimensions = await getImageDimensions(imageSource);

  try {
    const worker = await getOrInitializeOcrWorker(language, onProgress);

    if (options.psm) {
      await worker.setParameters({
        tessedit_pageseg_mode: options.psm,
      });
    }

    if (options.whitelist) {
      await worker.setParameters({
        tessedit_char_whitelist: options.whitelist,
      });
    }

    onProgress?.({
      stage: 'Local Recognition',
      status: 'Executing Devanagari & English LSTM neural network...',
      progress: 30,
    });

    // tesseract.js v7 ships defaultOutput with `blocks: false`, so `data.blocks` was null and
    // every line/word/bounding-box below came back empty — the bbox overlay and the reported line
    // count had no data behind them. Request the format the code actually consumes.
    const result = await worker.recognize(imageSource as any, {}, { blocks: true });
    const data = result.data;

    onProgress?.({
      stage: 'Post-Processing',
      status: 'Synthesizing line and word bounding boxes...',
      progress: 90,
    });

    const words: OcrWordItem[] = [];
    const lines: OcrLineItem[] = [];
    const boundingBoxes: BoundingBox[] = [];

    // Extract lines and words from blocks / paragraphs
    const extractedLines: Array<{
      text: string;
      confidence: number;
      bbox: { x0: number; y0: number; x1: number; y1: number };
      words: Array<{
        text: string;
        confidence: number;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      }>;
    }> = [];

    if (Array.isArray(data.blocks)) {
      for (const block of data.blocks) {
        if (Array.isArray(block.paragraphs)) {
          for (const para of block.paragraphs) {
            if (Array.isArray(para.lines)) {
              for (const l of para.lines) {
                extractedLines.push(l);
              }
            }
          }
        }
      }
    }

    let lIdx = 0;
    for (const line of extractedLines) {
      lIdx++;
      const lineText = line.text?.trim() || '';
      if (!lineText) continue;

      const lineId = `ocr-line-${lIdx}`;
      const lineConfidence = typeof line.confidence === 'number' ? line.confidence : 85;
      const lineBbox = normalizeBbox(
        line.bbox?.x0 || 0,
        line.bbox?.y0 || 0,
        line.bbox?.x1 || dimensions.width,
        line.bbox?.y1 || dimensions.height,
        dimensions.width,
        dimensions.height,
        lineId,
        `line_${lIdx}`,
        lineConfidence
      );

      const lineWords: OcrWordItem[] = [];

      if (Array.isArray(line.words)) {
        let wIdx = 0;
        for (const w of line.words) {
          wIdx++;
          const wordText = w.text?.trim() || '';
          if (!wordText) continue;

          const wordId = `ocr-w-${lIdx}-${wIdx}`;
          const wordConf = typeof w.confidence === 'number' ? w.confidence : lineConfidence;
          const wordBbox = normalizeBbox(
            w.bbox?.x0 || 0,
            w.bbox?.y0 || 0,
            w.bbox?.x1 || 100,
            w.bbox?.y1 || 30,
            dimensions.width,
            dimensions.height,
            wordId,
            wordText,
            wordConf
          );

          const wordItem: OcrWordItem = {
            id: wordId,
            text: wordText,
            confidence: wordConf,
            bbox: wordBbox,
            rawBbox: {
              x0: w.bbox?.x0 || 0,
              y0: w.bbox?.y0 || 0,
              x1: w.bbox?.x1 || 0,
              y1: w.bbox?.y1 || 0,
            },
          };

          words.push(wordItem);
          lineWords.push(wordItem);
          boundingBoxes.push(wordBbox);
        }
      }

      lines.push({
        id: lineId,
        text: lineText,
        confidence: lineConfidence,
        bbox: lineBbox,
        words: lineWords,
      });
    }

    const processingTimeMs = Date.now() - startTime;
    const overallConfidence = typeof data.confidence === 'number' ? Number(data.confidence.toFixed(1)) : 90.0;

    onProgress?.({
      stage: 'Complete',
      status: `OCR complete (${overallConfidence}% avg confidence in ${processingTimeMs}ms).`,
      progress: 100,
    });

    return {
      success: true,
      fullText: data.text || '',
      confidence: overallConfidence,
      lines,
      words,
      boundingBoxes,
      processingTimeMs,
      languageUsed: language,
      imageDimensions: dimensions,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const processingTimeMs = Date.now() - startTime;

    onProgress?.({
      stage: 'Failed',
      status: `OCR Error: ${errorMsg}`,
      progress: 0,
    });

    return {
      success: false,
      fullText: '',
      confidence: 0,
      lines: [],
      words: [],
      boundingBoxes: [],
      processingTimeMs,
      languageUsed: language,
      imageDimensions: dimensions,
      error: errorMsg,
    };
  }
}
