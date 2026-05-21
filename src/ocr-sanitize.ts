import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const MAGICK_BIN = 'magick';
const TESSERACT_BIN = 'tesseract';
const MONO_FONT = '/System/Library/Fonts/Courier.ttc';

function checkPrerequisites(): void {
  const magick = spawnSync(MAGICK_BIN, ['--version'], { encoding: 'utf-8', timeout: 5000 });
  if (magick.error || magick.status !== 0) {
    throw new Error('ocr-sanitize: ImageMagick (magick) not found. Install: brew install imagemagick');
  }

  const tess = spawnSync(TESSERACT_BIN, ['--version'], { encoding: 'utf-8', timeout: 5000 });
  if (tess.error || tess.status !== 0) {
    throw new Error('ocr-sanitize: Tesseract not found. Install: brew install tesseract');
  }
}

let _prerequisitesChecked = false;

export function ocrSanitize(text: string): string {
  if (!_prerequisitesChecked) {
    checkPrerequisites();
    _prerequisitesChecked = true;
  }

  if (!text || text.trim().length === 0) {
    throw new Error('ocr-sanitize: empty input');
  }

  const id = randomBytes(8).toString('hex');
  const tmpText = join(tmpdir(), `wevibe-ocr-${id}.txt`);
  const tmpImg = join(tmpdir(), `wevibe-ocr-${id}.png`);

  try {
    writeFileSync(tmpText, text, 'utf-8');

    const renderResult = spawnSync(MAGICK_BIN, [
      'convert',
      '-size', '1200x1600',
      '-density', '300',
      '-font', MONO_FONT,
      '-pointsize', '16',
      '+antialias',
      '-background', 'white',
      '-fill', 'black',
      '-bordercolor', 'white',
      '-border', '20x20',
      `caption:@${tmpText}`,
      tmpImg,
    ], { encoding: 'utf-8', timeout: 30000 });

    if (renderResult.error || renderResult.status !== 0) {
      throw new Error(`ocr-sanitize: ImageMagick render failed: ${renderResult.stderr || renderResult.error?.message}`);
    }

    if (!existsSync(tmpImg)) {
      throw new Error('ocr-sanitize: ImageMagick produced no output image');
    }

    const ocrResult = spawnSync(TESSERACT_BIN, [
      tmpImg,
      'stdout',
      '--psm', '6',
      '--oem', '3',
      '--dpi', '300',
      '-l', 'eng',
    ], { encoding: 'utf-8', timeout: 30000 });

    if (ocrResult.error || ocrResult.status !== 0) {
      throw new Error(`ocr-sanitize: Tesseract OCR failed: ${ocrResult.stderr || ocrResult.error?.message}`);
    }

    let sanitized = ocrResult.stdout;

    sanitized = sanitized.replace(/\r\n/g, '\n');
    sanitized = sanitized.replace(/[ \t]+\n/g, '\n');
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
    sanitized = sanitized.trim();

    const underscoreRestores: [RegExp, string][] = [
      [/client_max_body_size|client _max body size|client max body size/gi, 'client_max_body_size'],
      [/proxy_read_timeout|proxy _read_ timeout|proxy _read timeout|proxy read_ timeout|proxy read timeout/gi, 'proxy_read_timeout'],
      [/proxy_request_buffering|proxy _request buffering|proxy request buffering/gi, 'proxy_request_buffering'],
      [/proxy_buffering|proxy buffering/gi, 'proxy_buffering'],
      [/proxy_http_version|proxy _http version|proxy http version/gi, 'proxy_http_version'],
      [/proxy_pass|proxy pass/gi, 'proxy_pass'],
      [/mime_type|mime type/gi, 'mime_type'],
      [/file_type|file type/gi, 'file_type'],
      [/payload_too_large|payload too large/gi, 'payload_too_large'],
      [/LIMIT_FILE_SIZE|limit file size/gi, 'LIMIT_FILE_SIZE'],
    ];

    for (const [pattern, replacement] of underscoreRestores) {
      sanitized = sanitized.replace(pattern, replacement);
    }

    if (sanitized.length === 0) {
      throw new Error('ocr-sanitize: Tesseract produced empty output — text may be unrenderable');
    }

    return sanitized;
  } finally {
    try { unlinkSync(tmpText); } catch {}
    try { unlinkSync(tmpImg); } catch {}
  }
}