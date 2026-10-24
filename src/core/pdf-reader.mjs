import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url,
).href;

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_CONTEXT = 1500;
const assets = new URL('../../node_modules/pdfjs-dist/', import.meta.url);

/**
 * A single-page PDF view. Canvas and textLayer must share an unpadded,
 * position:relative parent. Importing never uploads the document.
 */
export function createPdfReader({ canvas, textLayer, onContext = () => {}, onStatus = () => {} }) {
  if (!canvas?.getContext || !textLayer?.replaceChildren) {
    throw new TypeError('A canvas and a text-layer element are required.');
  }

  let documentProxy = null;
  let documentTask = null;
  let operation = 0;
  let loadingTask = null;
  let renderTask = null;
  let layerTask = null;
  let destroyed = false;
  let hoverTimer = null;
  let highlighted = null;
  let contexts = new WeakMap();
  let state = { page: 0, pages: 0, name: '', loading: false, message: '' };
  const disposedTasks = new WeakSet();

  function disposeTask(task) {
    if (!task || disposedTasks.has(task)) return;
    disposedTasks.add(task);
    // PDF.js 6 exposes destruction on the loading task, not PDFDocumentProxy.
    // Keep the task for the entire lifetime of the successfully loaded paper.
    void Promise.resolve().then(() => task.destroy()).catch(() => {});
  }

  function report(update) {
    state = { ...state, ...update };
    onStatus({ ...state });
  }

  function clearHover() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    if (highlighted) highlighted.style.backgroundColor = '';
    highlighted = null;
  }

  function cancelPending() {
    clearHover();
    renderTask?.cancel();
    layerTask?.cancel();
    renderTask = layerTask = null;
    if (loadingTask) {
      const task = loadingTask;
      loadingTask = null;
      disposeTask(task);
    }
  }

  function begin() {
    if (destroyed) throw new Error('This PDF reader has been closed.');
    operation += 1;
    cancelPending();
    report({ loading: true, error: undefined, message: 'Opening the page…' });
    return operation;
  }

  function current(id) { return !destroyed && operation === id; }

  function emit(span, selectedText = '') {
    const text = (selectedText || contexts.get(span) || '').trim().slice(0, MAX_CONTEXT);
    if (!text || !documentProxy || state.loading) return;
    if (highlighted && highlighted !== span) highlighted.style.backgroundColor = '';
    highlighted = span;
    if (span) span.style.backgroundColor = 'rgba(196, 155, 84, 0.18)';
    onContext({ paper: state.name, page: state.page, text, kind: 'pdf' });
  }

  function targetOf(event) {
    const span = event.target?.closest?.('[data-pdf-text]');
    return span && textLayer.contains(span) ? span : null;
  }

  function pointerOver(event) {
    const span = targetOf(event);
    if (!span || span === targetOf({ target: event.relatedTarget })) return;
    clearTimeout(hoverTimer);
    const id = operation;
    hoverTimer = setTimeout(() => { if (current(id)) emit(span); }, 400);
  }

  function pointerOut(event) {
    const span = targetOf(event);
    if (span && span !== targetOf({ target: event.relatedTarget })) clearTimeout(hoverTimer);
  }

  function click(event) {
    clearTimeout(hoverTimer);
    const span = targetOf(event);
    const selection = window.getSelection();
    const selectionIsHere = selection && !selection.isCollapsed &&
      textLayer.contains(selection.anchorNode) && textLayer.contains(selection.focusNode);
    if (selectionIsHere) emit(span, selection.toString());
    else if (span) emit(span);
  }

  textLayer.addEventListener('pointerover', pointerOver);
  textLayer.addEventListener('pointerout', pointerOut);
  textLayer.addEventListener('pointerleave', clearHover);
  textLayer.addEventListener('click', click);

  async function preparePage(pdf, number, id) {
    const page = await pdf.getPage(number);
    if (!current(id)) return null;
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(740, Math.max(160, availableWidth(canvas)));
    const scale = Math.min(width / base.width, 4096 / base.height);
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const stagingCanvas = document.createElement('canvas');
    stagingCanvas.width = Math.ceil(viewport.width * ratio);
    stagingCanvas.height = Math.ceil(viewport.height * ratio);
    const stagedLayer = document.createElement('div');
    setLayerStyle(stagedLayer, viewport);

    const task = page.render({
      canvasContext: stagingCanvas.getContext('2d', { alpha: false }),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      background: '#ffffff',
    });
    renderTask = task;
    await task.promise;
    if (!current(id)) return null;
    if (renderTask === task) renderTask = null;

    const content = await page.getTextContent();
    if (!current(id)) return null;
    const textItems = content.items.filter(item => typeof item.str === 'string');
    // Only the display library's text runs are used; annotations, PDF actions,
    // links, attachments and embedded JavaScript are never executed.
    const layer = new pdfjs.TextLayer({ textContentSource: content, container: stagedLayer, viewport });
    // The v6 layer normally gets CSS rounding variables from PDFViewer. This
    // standalone view supplies exact unrotated dimensions instead.
    stagedLayer.style.width = `${viewport.rotation % 180 ? viewport.height : viewport.width}px`;
    stagedLayer.style.height = `${viewport.rotation % 180 ? viewport.width : viewport.height}px`;
    layerTask = layer;
    await layer.render();
    if (!current(id)) return null;
    if (layerTask === layer) layerTask = null;
    styleTextRuns(layer.textDivs);
    for (const lineBreak of stagedLayer.querySelectorAll('br')) {
      Object.assign(lineBreak.style, { position: 'absolute', color: 'transparent', whiteSpace: 'pre' });
    }
    const snippets = makeSnippets(textItems);
    const nextContexts = new WeakMap();
    layer.textDivs.forEach((span, index) => {
      if (!span.textContent.trim()) return;
      span.dataset.pdfText = '';
      nextContexts.set(span, snippets[index] || span.textContent);
    });
    return { stagingCanvas, stagedLayer, nextContexts, viewport, hasText: textItems.some(item => item.str.trim()) };
  }

  function commitPage(prepared, pdf, name, number) {
    canvas.width = prepared.stagingCanvas.width;
    canvas.height = prepared.stagingCanvas.height;
    canvas.style.width = `${prepared.viewport.width}px`;
    canvas.style.height = `${prepared.viewport.height}px`;
    canvas.style.display = 'block';
    // Shrinking only the canvas would separate the selectable text from ink.
    // The containing reader scrolls when the window becomes narrower.
    canvas.style.maxWidth = 'none';
    canvas.getContext('2d', { alpha: false }).drawImage(prepared.stagingCanvas, 0, 0);
    textLayer.style.cssText = prepared.stagedLayer.style.cssText;
    textLayer.replaceChildren(...prepared.stagedLayer.childNodes);
    contexts = prepared.nextContexts;
    documentProxy = pdf;
    report({
      page: number, pages: pdf.numPages, name, loading: false, error: undefined,
      message: prepared.hasText
        ? 'Point at a line, or select a passage to ask about it.'
        : 'This page has no selectable text. Scanned pages need OCR, which this prototype does not include.',
    });
    onContext({ paper: name, page: number, text: '', kind: 'pdf' });
  }

  async function load(file) {
    if (destroyed) throw new Error('This PDF reader has been closed.');
    // Validate before interrupting the currently displayed document.
    if (!file || typeof file.arrayBuffer !== 'function' || !/\.pdf$/i.test(file.name || '')) {
      const error = 'Choose a PDF file.';
      report({ error });
      return false;
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_BYTES) {
      const error = 'Choose a PDF smaller than 10 MB.';
      report({ error });
      return false;
    }
    const id = begin();
    let candidate = null;
    let task = null;
    let timeout = null;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (!current(id)) return false;
      task = pdfjs.getDocument({
        data,
        isEvalSupported: false,
        enableXfa: false,
        maxImageSize: 16_000_000,
        cMapUrl: new URL('cmaps/', assets).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', assets).href,
        wasmUrl: new URL('wasm/', assets).href,
      });
      loadingTask = task;
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The PDF took too long to open. Try a smaller file.')), 30_000);
      });
      candidate = await Promise.race([task.promise, timedOut]);
      clearTimeout(timeout);
      if (!current(id)) return false;
      if (candidate.numPages > MAX_PAGES) {
        throw new Error('This prototype supports PDFs with up to 20 pages. Choose a shorter paper or an excerpt.');
      }
      const prepared = await preparePage(candidate, 1, id);
      if (!prepared || !current(id)) return false;
      const previousTask = documentTask;
      documentTask = task;
      loadingTask = null;
      commitPage(prepared, candidate, file.name, 1);
      disposeTask(previousTask);
      return true;
    } catch (error) {
      if (current(id)) {
        report({ loading: false, error: readableError(error), message: state.pages ? 'Your previous paper is still open.' : '' });
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (task && task !== documentTask) disposeTask(task);
      if (loadingTask === task) loadingTask = null;
    }
  }

  async function goToPage(number) {
    if (!documentProxy || destroyed) return false;
    if (!Number.isInteger(number) || number < 1 || number > documentProxy.numPages) return false;
    const id = begin();
    const pdf = documentProxy;
    const name = state.name;
    try {
      const prepared = await preparePage(pdf, number, id);
      if (!prepared || !current(id)) return false;
      commitPage(prepared, pdf, name, number);
      return true;
    } catch (error) {
      if (current(id)) report({ loading: false, error: readableError(error), message: 'The previous page is still visible.' });
      return false;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    operation += 1;
    cancelPending();
    disposeTask(documentTask);
    documentTask = null;
    documentProxy = null;
    textLayer.removeEventListener('pointerover', pointerOver);
    textLayer.removeEventListener('pointerout', pointerOut);
    textLayer.removeEventListener('pointerleave', clearHover);
    textLayer.removeEventListener('click', click);
    textLayer.replaceChildren();
  }

  return {
    load, goToPage, destroy,
    next: () => goToPage(state.page + 1),
    previous: () => goToPage(state.page - 1),
    getState: () => ({ ...state }),
  };
}

function readableError(error) {
  if (error?.name === 'PasswordException') return 'Password-protected PDFs are not supported yet.';
  if (error?.name === 'InvalidPDFException') return 'This file could not be read as a PDF.';
  return String(error?.message || 'The PDF could not be opened.').slice(0, 250);
}

function setLayerStyle(element, viewport) {
  Object.assign(element.style, {
    position: 'absolute', left: '0', top: '0', overflow: 'hidden',
    width: `${viewport.width}px`, height: `${viewport.height}px`,
    textAlign: 'initial', lineHeight: '1', transformOrigin: '0 0',
    textSizeAdjust: 'none', forcedColorAdjust: 'none', letterSpacing: 'normal',
    wordSpacing: 'normal', fontWeight: 'normal', fontStyle: 'normal',
  });
  element.style.setProperty('--total-scale-factor', viewport.scale * (viewport.userUnit || 1));
  element.style.setProperty('--scale-factor', viewport.scale);
  element.style.setProperty('--user-unit', viewport.userUnit || 1);
  element.style.setProperty('--min-font-size', '1');
  element.style.setProperty('--text-scale-factor', 'calc(var(--total-scale-factor) * var(--min-font-size))');
  element.style.setProperty('--min-font-size-inv', 'calc(1 / var(--min-font-size))');
  // TextLayer uses unrotated page coordinates. Mirror the display layer's
  // page rotation while leaving the canvas at its already rotated dimensions.
  if (viewport.rotation === 90) element.style.transform = 'rotate(90deg) translateY(-100%)';
  if (viewport.rotation === 180) element.style.transform = 'rotate(180deg) translate(-100%, -100%)';
  if (viewport.rotation === 270) element.style.transform = 'rotate(270deg) translateX(-100%)';
}

function availableWidth(canvas) {
  // A max-content surface initially has the canvas's default 300 px width.
  // Measure its containing reader instead. If hidden during import, use the
  // first visible ancestor's content box, allowing the sample page to stay put.
  let element = canvas.parentElement?.parentElement;
  while (element && element !== document.body) {
    if (element.clientWidth > 0) {
      const style = window.getComputedStyle(element);
      return element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    }
    element = element.parentElement;
  }
  return Math.max(160, window.innerWidth - 48);
}

function styleTextRuns(spans) {
  for (const span of spans) {
    Object.assign(span.style, {
      position: 'absolute', whiteSpace: 'pre', color: 'transparent', cursor: 'text',
      transformOrigin: '0 0', userSelect: 'text', lineHeight: '1',
      fontSize: 'calc(var(--text-scale-factor) * var(--font-height))',
      transform: 'rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv))',
    });
  }
}

/** Best-effort local lines, never a claim of semantic PDF structure. */
function makeSnippets(items) {
  const lines = [];
  const lineFor = [];
  let line = null;
  items.forEach((item, index) => {
    const [a, b, c, d, x, y] = item.transform;
    const height = Math.max(Math.hypot(c, d), Math.hypot(a, b), 1);
    const gap = line ? x - line.right : 0;
    if (!line || Math.abs(y - line.y) > height * 0.7 || gap > height * 3.5 || line.ended) {
      line = { text: '', x, y, right: x, height, ended: false, index: lines.length };
      lines.push(line);
    }
    if (line.text && !/\s$/.test(line.text) && !/^\s/.test(item.str) && gap > height * 0.08) line.text += ' ';
    line.text += item.str;
    line.right = Math.max(line.right, x + item.width);
    line.ended = item.hasEOL;
    lineFor[index] = line;
  });
  return lineFor.map(center => {
    const nearby = [center];
    for (const direction of [-1, 1]) {
      let previous = center;
      for (let distance = 1; distance <= 2; distance += 1) {
        const candidate = lines[center.index + direction * distance];
        if (!candidate || Math.abs(candidate.y - previous.y) > Math.max(candidate.height, previous.height) * 2.3) break;
        if (candidate.right < center.x || candidate.x > center.right) break;
        if (direction === -1) nearby.unshift(candidate); else nearby.push(candidate);
        previous = candidate;
      }
    }
    return nearby.map(entry => entry.text.trim()).filter(Boolean).join('\n').slice(0, MAX_CONTEXT);
  });
}
