import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

// Import the real reader with only the PDF.js rendering dependency mocked.
// Node 22.15 introduced synchronous module hooks; older supported Node builds
// can still run the other tests and exercise this path in the browser.
if (typeof nodeModule.registerHooks !== 'function') {
  test('PDF reader lifecycle', { skip: 'Lifecycle mocks require Node 22.15+ or Node 24.' }, () => {});
} else {
  const hooks = nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('/node_modules/pdfjs-dist/build/pdf.mjs')) {
        return {
          format: 'module', shortCircuit: true,
          source: `
            export const GlobalWorkerOptions = {};
            export function getDocument() { return globalThis.__pdfLifecycleTasks.shift(); }
            export class TextLayer {
              constructor({container}) { this.textDivs = []; this.container = container; }
              async render() {}
              cancel() {}
            }
          `,
        };
      }
      return nextLoad(url, context);
    },
  });
  const { createPdfReader } = await import('../src/core/pdf-reader.mjs');
  after(() => {
    hooks.deregister();
    delete globalThis.__pdfLifecycleTasks;
    delete globalThis.document;
    delete globalThis.window;
  });

  function element(canvas = false) {
    const listeners = new Map();
    const node = {
      listeners, childNodes: [], clientWidth: 600,
      style: { setProperty(name, value) { this[name] = String(value); } },
      replaceChildren(...children) { this.childNodes = children; },
      querySelectorAll() { return []; },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name) { listeners.delete(name); },
    };
    if (canvas) node.getContext = () => ({ drawImage() {} });
    return node;
  }

  function setup(tasks) {
    globalThis.__pdfLifecycleTasks = tasks;
    globalThis.document = { body: element(), createElement: tag => element(tag === 'canvas') };
    globalThis.window = { devicePixelRatio: 1, innerWidth: 1200, getComputedStyle: () => ({}) };
    const canvas = element(true);
    canvas.parentElement = { parentElement: element() };
    const textLayer = element();
    return { reader: createPdfReader({ canvas, textLayer }), textLayer };
  }

  function makeTask({ pages = 2, pending = false } = {}) {
    let rejectLoad;
    // Deliberately has no destroy(): this matches PDF.js 6's document proxy.
    const proxy = {
      numPages: pages,
      async getPage() {
        return {
          getViewport({ scale }) {
            return { width: 612 * scale, height: 792 * scale, scale, userUnit: 1, rotation: 0 };
          },
          render() { return { promise: Promise.resolve(), cancel() {} }; },
          async getTextContent() { return { items: [], styles: {} }; },
        };
      },
    };
    return {
      proxy, destroys: 0,
      promise: pending ? new Promise((_, reject) => { rejectLoad = reject; }) : Promise.resolve(proxy),
      async destroy() {
        this.destroys += 1;
        rejectLoad?.(new Error('Loading task destroyed'));
      },
    };
  }

  const file = name => ({ name, size: 100, arrayBuffer: async () => new ArrayBuffer(100) });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

  test('loaded PDF task survives page navigation and is destroyed once on close', async () => {
    const task = makeTask();
    const { reader, textLayer } = setup([task]);
    assert.equal(await reader.load(file('first.pdf')), true);
    assert.equal(await reader.next(), true);
    assert.equal(task.destroys, 0);
    assert.equal(reader.getState().page, 2);
    assert.doesNotThrow(() => reader.destroy());
    reader.destroy();
    await flush();
    assert.equal(task.destroys, 1);
    assert.equal(textLayer.listeners.size, 0);
  });

  test('failed replacement disposes candidate and preserves working original PDF', async () => {
    const original = makeTask();
    const rejected = makeTask({ pages: 21 });
    const { reader } = setup([original, rejected]);
    assert.equal(await reader.load(file('original.pdf')), true);
    assert.equal(await reader.load(file('long.pdf')), false);
    await flush();
    assert.equal(rejected.destroys, 1);
    assert.equal(original.destroys, 0);
    assert.equal(reader.getState().name, 'original.pdf');
    assert.equal(await reader.next(), true);
    reader.destroy();
    await flush();
    assert.equal(original.destroys, 1);
  });

  test('successful replacement releases original loading task and retains new task', async () => {
    const original = makeTask();
    const replacement = makeTask();
    const { reader } = setup([original, replacement]);
    assert.equal(await reader.load(file('original.pdf')), true);
    assert.equal(await reader.load(file('replacement.pdf')), true);
    await flush();
    assert.equal(original.destroys, 1);
    assert.equal(replacement.destroys, 0);
    assert.equal(reader.getState().name, 'replacement.pdf');
    reader.destroy();
    await flush();
    assert.equal(replacement.destroys, 1);
  });

  test('superseded pending import cannot replace newer paper or double-dispose its task', async () => {
    const pending = makeTask({ pending: true });
    const replacement = makeTask();
    const { reader } = setup([pending, replacement]);
    const obsolete = reader.load(file('slow.pdf'));
    await flush();
    assert.equal(await reader.load(file('latest.pdf')), true);
    assert.equal(await obsolete, false);
    await flush();
    assert.equal(pending.destroys, 1);
    assert.equal(replacement.destroys, 0);
    assert.equal(reader.getState().name, 'latest.pdf');
    reader.destroy();
    await flush();
    assert.equal(replacement.destroys, 1);
  });
}
