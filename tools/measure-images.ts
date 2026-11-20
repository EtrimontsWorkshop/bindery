/**
 * Measures the image analysis on real PDFs, so that a change to its rules can be judged by numbers instead of by eye.
 *
 *   npm run measure:images -- run <folder or PDFs...>     analyse the PDFs, record what was offered and what was hidden
 *   npm run measure:images -- label                       write label.html: mark each picture as wanted, wanted but
 *                                                          taken wrongly, or not wanted
 *   npm run measure:images -- report                      precision and recall against the labels, and what changed
 *                                                          since the previous run
 *
 * Everything it writes goes to ONE folder (`--out`, by default `test/reference/measure`, which git ignores): the
 * results of each run, thumbnails of the pictures, the page to label them on and the labels. That folder holds crops
 * of the PDFs' own pictures and the PDFs' file names, so it must never be committed; this file names no book and
 * carries no content of one. Documents are known by a hash of their bytes, not by their names.
 *
 * It runs the same pipeline as the module (`buildInventory` -> text layout -> `buildImageExtraction`) with the Node
 * canvas in place of the browser's, each PDF in its own process (a book can take a gigabyte or two).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildImageExtraction } from '../packages/core/src/images/buildImageExtraction.js';
import { nodeCanvasImageEncoder } from '../packages/core/src/images/nodeCanvasImageEncoder.js';
import { nodeCanvasRegionRenderer } from '../packages/core/src/images/nodeCanvasRenderer.js';
import { planExtraction } from '../packages/core/src/images/planExtraction.js';
import { ruleTrace } from '../packages/core/src/images/ruleTrace.js';
import { groupBlockBoxesByPage } from '../packages/core/src/images/textBlockBoxes.js';
import { buildInventory } from '../packages/core/src/inventory/inventory.js';
import { buildPageLayouts } from '../packages/core/src/layout/buildPageLayout.js';
import { PDF_OPEN_OPTIONS } from '../packages/core/src/pdfDocument.js';
import { createTextLayoutCollector } from '../packages/core/src/text/buildTextLayout.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const PDFJS_DIR = join(REPO_ROOT, 'node_modules', 'pdfjs-dist');
const DEFAULT_OUT = join(REPO_ROOT, 'test', 'reference', 'measure');
const THUMB_PX = 220;
/** A label and a result on the same page are the same picture when their boxes overlap this much (intersection over union). */
const SAME_PICTURE_MIN_IOU = 0.6;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** What the analysis did with a picture: `offered` in the review's list, `text` in its "images with text" tab, `hidden` not shown at all. */
type Verdict = 'offered' | 'text' | 'hidden';

interface MeasuredImage {
  page: number;
  bbox: Box;
  hash: string;
  verdict: Verdict;
  classification: string;
  /** The classification rule of the image's own resource, when it has one (see `ClassifiedImage.reason`). */
  rule: string | null;
  source: string;
  width: number;
  height: number;
  thumb: string;
  /** The rules that cut, split, turned or trimmed this picture (see `ruleTrace.ts`); absent when none did. */
  madeBy?: string[];
}

interface DocResult {
  docId: string;
  pages: number;
  sizeMB: number;
  seconds: { inventory: number; extraction: number };
  images: MeasuredImage[];
  error?: string;
}

interface Label {
  page: number;
  bbox: Box;
  hash: string;
  want: boolean;
  /** The picture is wanted, but what was taken is not right: a wrong crop, the page's text or paper in it, two things joined. */
  bad?: boolean;
  /** What is wrong with it, in the labeller's words. */
  note?: string;
}

interface Labels {
  version: 1;
  docs: Record<string, { images: Label[]; /** Wanted pictures the analysis gave no candidate for at all (counted by hand). */ missed?: number }>;
}

// ---------------------------------------------------------------------------------------------------------- arguments

function parseArgs(argv: readonly string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) options.set(arg.slice(2), argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true');
    else positional.push(arg);
  }
  return { positional, options };
}

function findPdfs(path: string): string[] {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  if (statSync(path).isFile()) return path.toLowerCase().endsWith('.pdf') ? [path] : [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => (name.startsWith('.') ? [] : findPdfs(join(path, name))));
}

/** A document's id: a hash of its size and its first megabyte. The same file gets the same id wherever it lies. */
function docIdOf(file: string): string {
  const size = statSync(file).size;
  const head = readFileSync(file).subarray(0, 1024 * 1024);
  return createHash('sha1').update(String(size)).update(head).digest('hex').slice(0, 10);
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}

/** The runs, oldest first (by when each was first made: "v9" comes before "v12", whatever the names). */
function runsOf(out: string): string[] {
  const dir = join(out, 'runs');
  if (!existsSync(dir)) return [];
  const runs = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  const made = new Map(runs.map((name) => [name, statSync(join(dir, name)).birthtimeMs]));
  return runs.sort((a, b) => made.get(a)! - made.get(b)! || a.localeCompare(b, undefined, { numeric: true }));
}

function readRun(out: string, name: string): DocResult[] {
  const dir = join(out, 'runs', name);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as DocResult);
}

// ------------------------------------------------------------------------------------------------ one PDF, one process

async function measureOne(file: string, docId: string, runDir: string, thumbDir: string): Promise<void> {
  const bytes = readFileSync(file);
  const result: DocResult = { docId, pages: 0, sizeMB: Math.round(bytes.length / 1048576), seconds: { inventory: 0, extraction: 0 }, images: [] };
  const open = () =>
    pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(bytes), standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`, wasmUrl: `${PDFJS_DIR}/wasm/`, verbosity: 0 }).promise;
  try {
    let started = Date.now();
    const inventoryDoc = await open();
    const text = createTextLayoutCollector();
    const inventory = await buildInventory(inventoryDoc as never, { onPageText: text.addPage });
    await inventoryDoc.loadingTask.destroy();
    result.pages = inventory.pageCount;
    result.seconds.inventory = (Date.now() - started) / 1000;

    started = Date.now();
    const layout = text.finish(new Map(inventory.fonts.map((f) => [f.key, f.size])));
    const { blocks } = buildPageLayouts(layout, { fontRoles: inventory.fontRoles, vectors: inventory.vectors, images: inventory.images, perPage: inventory.perPage });
    const forImages = { images: inventory.images, vectors: inventory.vectors, shapes: inventory.shapes, lines: inventory.lines, perPage: inventory.perPage };
    const options = {
      bodyBlockBoxesByPage: groupBlockBoxesByPage(blocks, new Set(['body', 'caption'])),
      textBlockBoxesByPage: groupBlockBoxesByPage(blocks),
      headingBlockBoxesByPage: groupBlockBoxesByPage(blocks, new Set(['heading'])),
      wordBoxesByPage: inventory.wordBoxesByPage,
    };
    // The rule that classified each resource, read from the same plan the extraction makes (it is not part of the result).
    const ruleByEntry = new Map(planExtraction(forImages, options).classified.map((c) => [c.entry, `${c.classification}:${c.reason}`]));

    const madeBy = new Map<string, Set<string>>();
    ruleTrace.hook = (rule, _page, hash) => {
      const rules = madeBy.get(hash) ?? new Set<string>();
      rules.add(rule);
      madeBy.set(hash, rules);
    };
    const extractionDoc = await open();
    const extraction = await buildImageExtraction(extractionDoc as never, forImages, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, options);
    await extractionDoc.loadingTask.destroy();
    result.seconds.extraction = (Date.now() - started) / 1000;

    mkdirSync(join(thumbDir, docId), { recursive: true });
    for (const image of extraction.images) {
      const first = image.entry.occurrences[0];
      if (!first) continue;
      const verdict: Verdict = image.classification === 'content' || image.classification === 'undecided' ? 'offered' : image.holdsText === true ? 'text' : 'hidden';
      const thumb = `${docId}/${image.contentHash.slice(0, 16)}-p${first.page}.jpg`;
      const thumbFile = join(thumbDir, thumb);
      if (!existsSync(thumbFile)) {
        const picture = await loadImage(Buffer.from(image.payload.bytes));
        const scale = Math.min(1, THUMB_PX / Math.max(picture.width, picture.height));
        const canvas = createCanvas(Math.max(1, Math.round(picture.width * scale)), Math.max(1, Math.round(picture.height * scale)));
        const ctx = canvas.getContext('2d');
        // A transparent picture on white would hide a white drawing, on black a dark one: a mid grey shows both.
        ctx.fillStyle = '#888';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
        writeFileSync(thumbFile, canvas.toBuffer('image/jpeg', 70));
      }
      result.images.push({
        page: first.page,
        bbox: first.bbox,
        hash: image.contentHash,
        verdict,
        classification: image.classification,
        rule: ruleByEntry.get(image.entry) ?? null,
        source: image.extractSource,
        width: image.width,
        height: image.height,
        thumb,
        ...(madeBy.has(image.contentHash) ? { madeBy: [...madeBy.get(image.contentHash)!].sort() } : {}),
      });
    }
  } catch (err) {
    result.error = String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 800);
  }
  writeFileSync(join(runDir, `${docId}.json`), JSON.stringify(result, null, 1));
}

// ------------------------------------------------------------------------------------------------------------- `run`

async function commandRun(inputs: readonly string[], options: ReadonlyMap<string, string>): Promise<void> {
  const out = resolve(options.get('out') ?? DEFAULT_OUT);
  const minBytes = Number(options.get('min-mb') ?? 0) * 1048576;
  const limit = Number(options.get('limit') ?? Infinity);
  const jobs = Math.max(1, Number(options.get('jobs') ?? 3));
  const name = options.get('name') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const files = inputs
    .flatMap((input) => findPdfs(resolve(input)))
    .filter((f) => statSync(f).size >= minBytes)
    .slice(0, limit);
  if (files.length === 0) throw new Error('no PDF to analyse: give a folder or PDF files');

  const runDir = join(out, 'runs', name);
  const thumbDir = join(out, 'thumbs');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(thumbDir, { recursive: true });
  // Which file each id stands for. It stays in the output folder, which is never committed.
  const index = readJson<Record<string, { path: string; sizeMB: number }>>(join(out, 'index.json'), {});
  const queue = files.map((file) => ({ file, docId: docIdOf(file) }));
  for (const { file, docId } of queue) index[docId] = { path: file, sizeMB: Math.round(statSync(file).size / 1048576) };
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));

  console.log(`measure-images: run "${name}", ${queue.length} PDF(s), ${jobs} at a time -> ${runDir}`);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const { file, docId } = queue[next++]!;
      await new Promise<void>((settle) => {
        // Its own process: the memory of one book is returned before the next starts, and a crash stops one PDF only.
        const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, 'one', file, docId, runDir, thumbDir], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('close', (code) => {
          const result = readJson<DocResult | null>(join(runDir, `${docId}.json`), null);
          if (!result) writeFileSync(join(runDir, `${docId}.json`), JSON.stringify({ docId, pages: 0, sizeMB: 0, seconds: { inventory: 0, extraction: 0 }, images: [], error: `process ended with code ${code}` }));
          const offered = result?.images.filter((i) => i.verdict === 'offered').length ?? 0;
          console.log(`  [${++done}/${queue.length}] ${docId} ${result?.error ? `FAILED: ${result.error.split('\n')[0]}` : `${result?.pages} pages, ${offered} offered of ${result?.images.length}, ${Math.round((result?.seconds.inventory ?? 0) + (result?.seconds.extraction ?? 0))} s`}`);
          settle();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  console.log(`measure-images: done. Next: "label" to mark the pictures, "report" for the numbers.`);
}

// ------------------------------------------------------------------------------------------------- labels and matching

function iou(a: Box, b: Box): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (w <= 0 || h <= 0) return 0;
  const shared = w * h;
  return shared / ((a.maxX - a.minX) * (a.maxY - a.minY) + (b.maxX - b.minX) * (b.maxY - b.minY) - shared);
}

/**
 * The label of each result image, or `undefined`. By content first; a change to how a picture is taken (a tighter
 * crop, another resolution) changes its hash, so a label also holds for a picture in the same place on the same page.
 * Returns the labels that found no image too: a wanted picture that is gone from the results is a miss. A label found
 * by place only is reported as `changed`: the picture differs from the one that was judged (two pages no longer joined,
 * a different crop), so the judgement has to be looked at again before it counts.
 */
function matchLabels(images: readonly MeasuredImage[], labels: readonly Label[]): { labelOf: Map<MeasuredImage, Label>; unmatched: Label[]; changed: Set<MeasuredImage> } {
  const labelOf = new Map<MeasuredImage, Label>();
  /** Images whose label was found by place only: the picture there is no longer the one that was labelled. */
  const changed = new Set<MeasuredImage>();
  const used = new Set<Label>();
  for (const image of images) {
    const byHash = labels.find((l) => !used.has(l) && l.hash === image.hash && l.page === image.page);
    if (byHash) {
      labelOf.set(image, byHash);
      used.add(byHash);
    }
  }
  for (const image of images) {
    if (labelOf.has(image)) continue;
    let best: Label | undefined;
    let bestIou = SAME_PICTURE_MIN_IOU;
    for (const l of labels) {
      if (used.has(l) || l.page !== image.page) continue;
      const overlap = iou(l.bbox, image.bbox);
      if (overlap >= bestIou) {
        best = l;
        bestIou = overlap;
      }
    }
    if (best) {
      labelOf.set(image, best);
      used.add(best);
      changed.add(image);
    }
  }
  return { labelOf, unmatched: labels.filter((l) => !used.has(l)), changed };
}

function pickRun(out: string, options: ReadonlyMap<string, string>): string {
  const runs = runsOf(out);
  const name = options.get('run') ?? runs.at(-1);
  if (!name || !runs.includes(name)) throw new Error(`no such run in ${out} (have: ${runs.join(', ') || 'none'}); use "run" first`);
  return name;
}

// ----------------------------------------------------------------------------------------------------------- `label`

function commandLabel(options: ReadonlyMap<string, string>): void {
  const out = resolve(options.get('out') ?? DEFAULT_OUT);
  const run = pickRun(out, options);
  const labels = readJson<Labels>(join(out, 'labels.json'), { version: 1, docs: {} });
  const index = readJson<Record<string, { path: string }>>(join(out, 'index.json'), {});
  // With --traced: only the pictures one of the rules that cut, split, turn or trim made (to review those rules on books never labelled);
  // --skip-rules a,b leaves out those made by these rules alone.
  const skipped = new Set((options.get('skip-rules') ?? '').split(',').filter(Boolean));
  const traced = (image: MeasuredImage): boolean => (image.madeBy ?? []).some((rule) => !skipped.has(rule));
  const docs = readRun(out, run)
    .filter((doc) => !doc.error && (!options.has('traced') || doc.images.some(traced)))
    .map((doc) => {
      const known = labels.docs[doc.docId] ?? { images: [] };
      const { labelOf, unmatched, changed } = matchLabels(doc.images, known.images);
      const shown = options.has('traced') ? doc.images.filter(traced) : doc.images;
      return {
        docId: doc.docId,
        name: index[doc.docId] ? basename(index[doc.docId]!.path) : doc.docId,
        pages: doc.pages,
        missed: known.missed ?? 0,
        // Labels of pictures this run did not produce are kept as they are, so that labelling one run loses nothing of another;
        // but not one whose place a picture of this run takes that is labelled itself (the same thing, taken another way since).
        carried: unmatched.filter((l) => !doc.images.some((image) => image.page === l.page && image.verdict !== 'hidden' && labelOf.has(image) && !changed.has(image) && iou(image.bbox, l.bbox) >= STALE_MIN_IOU)),
        // A picture that changed since it was labelled comes back without a label, with the old one shown as a hint.
        images: [...shown]
          .sort((a, b) => a.page - b.page)
          .map((image) => {
            const label = labelOf.get(image);
            const stale = changed.has(image);
            return { ...image, want: stale ? null : (label?.want ?? null), bad: !stale && label?.bad === true, note: stale ? '' : (label?.note ?? ''), was: stale ? (label?.want ?? null) : null, wasBad: stale && label?.bad === true };
          }),
      };
    });
  const file = join(out, 'label.html');
  writeFileSync(file, LABEL_PAGE.replace('/*DATA*/null', JSON.stringify({ run, docs }).replace(/</g, '\\u003c')));
  console.log(`measure-images: open ${file} in a browser, mark the pictures, press "Save labels" and put the downloaded labels.json into ${out}`);
}

const LABEL_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Bindery — label pictures</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; background: #f4f4f4; color: #222; }
  header { position: sticky; top: 0; z-index: 2; background: #222; color: #fff; padding: 8px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header button, .doc button { font: inherit; padding: 4px 10px; cursor: pointer; }
  .doc { margin: 16px; background: #fff; border: 1px solid #ccc; }
  .doc h2 { font-size: 15px; margin: 0; padding: 8px 12px; background: #eee; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .doc h2 span { font-weight: normal; color: #555; }
  .grid { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; }
  .card { width: 232px; border: 4px solid #bbb; background: #fafafa; cursor: pointer; user-select: none; }
  .card img { display: block; margin: 0 auto; max-width: 220px; max-height: 220px; }
  .card div { padding: 2px 6px; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card.want { border-color: #1a9c2d; }
  .card.dont { border-color: #d03030; }
  .card.bad { border-color: #e08a00; }
  .card input { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; }
  .card .verdict { font-weight: 600; }
  .v-offered { color: #1a6d9c; } .v-hidden { color: #888; } .v-text { color: #8a5a00; }
  .wrong .verdict::after { content: "  ← disagrees with the label"; color: #d03030; }
  .legend b { padding: 0 6px; border: 3px solid; margin-right: 4px; }
</style>
<header>
  <strong>Label pictures</strong>
  <span id="count"></span>
  <span class="legend" title="The colour says where the picture belongs, not whether the analysis was right: a hidden logo the analysis rightly hid is red."><b style="border-color:#1a9c2d">belongs in the import</b><b style="border-color:#e08a00">belongs in the import, taken wrongly</b><b style="border-color:#d03030">does not belong in the import (also: rightly hidden)</b><b style="border-color:#bbb">not labelled</b> click a picture to change</span>
  <label><input type="checkbox" id="todo"> show only pictures that need a label (<span id="todoCount"></span>)</label>
  <button id="keep" title="For a picture taken another way since it was labelled (trimmed, turned): its earlier label again. Not for one labelled as taken wrongly: that is what may have changed.">Keep earlier labels of changed pictures (<span id="keepCount"></span>)</button>
  <button id="save">Save labels</button>
</header>
<main id="docs"></main>
<script>
const DATA = /*DATA*/null;
// unlabelled -> wanted -> wanted but taken wrongly -> not wanted -> unlabelled
function advance(image) {
  if (image.want === null) { image.want = true; image.bad = false; }
  else if (image.want === true && !image.bad) image.bad = true;
  else if (image.want === true) { image.want = false; image.bad = false; }
  else image.want = null;
}
const main = document.getElementById('docs');
const allCards = [];
const keepable = (image) => image.was !== null && image.want === null && !image.wasBad;
function refreshCount() {
  const all = DATA.docs.flatMap((d) => d.images);
  document.getElementById('count').textContent = all.filter((i) => i.want !== null).length + ' of ' + all.length + ' labelled, ' + all.filter((i) => i.want && i.bad).length + ' taken wrongly — run ' + DATA.run;
}
const needsLabel = (image) => image.want === null;
function applyFilter() {
  const only = document.getElementById('todo').checked;
  for (const section of document.querySelectorAll('.doc')) {
    let shown = 0;
    for (const card of section.querySelectorAll('.card')) {
      // A picture labelled while the filter is on stays in view until the filter is applied again.
      const show = !only || card.dataset.todo === '1';
      card.style.display = show ? '' : 'none';
      if (show) shown++;
    }
    section.style.display = shown > 0 ? '' : 'none';
  }
}
function paint(card, image) {
  card.className = 'card' + (image.want === true ? (image.bad ? ' bad' : ' want') : image.want === false ? ' dont' : '') + (image.want !== null && (image.want !== (image.verdict !== 'hidden')) ? ' wrong' : '');
  const note = card.querySelector('input');
  if (note) note.style.display = image.want === true && image.bad ? '' : 'none';
}
for (const doc of DATA.docs) {
  const section = document.createElement('section');
  section.className = 'doc';
  const head = document.createElement('h2');
  head.append(doc.name + ' ');
  const info = document.createElement('span');
  info.textContent = doc.pages + ' pages, ' + doc.images.length + ' pictures';
  head.append(info);
  const accept = document.createElement('button');
  accept.textContent = 'Agree with the analysis for the unlabelled (offered: green, hidden: red)';
  const missedLabel = document.createElement('label');
  missedLabel.textContent = 'Wanted pictures with no candidate at all: ';
  const missed = document.createElement('input');
  missed.type = 'number'; missed.min = '0'; missed.value = doc.missed; missed.style.width = '4em';
  missed.addEventListener('change', () => { doc.missed = Math.max(0, Number(missed.value) || 0); });
  missedLabel.append(missed);
  head.append(accept, missedLabel);
  const grid = document.createElement('div');
  grid.className = 'grid';
  const cards = [];
  for (const image of doc.images) {
    const card = document.createElement('div');
    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = 'thumbs/' + image.thumb;
    const verdict = document.createElement('div');
    verdict.className = 'verdict v-' + image.verdict;
    verdict.textContent = 'p. ' + image.page + ' — ' + image.verdict;
    const detail = document.createElement('div');
    detail.textContent = image.width + '×' + image.height + ' ' + (image.madeBy ? image.madeBy.join(', ') : image.rule || image.classification);
    detail.title = detail.textContent;
    if (image.was !== null) { verdict.textContent += ' — CHANGED (was ' + (image.was ? 'wanted' : 'not wanted') + ')'; card.style.background = '#fff3c4'; }
    const note = document.createElement('input');
    note.placeholder = 'what is wrong with it?'; note.value = image.note || '';
    note.addEventListener('click', (ev) => ev.stopPropagation());
    note.addEventListener('input', () => { image.note = note.value; });
    card.append(img, verdict, detail, note);
    card.addEventListener('click', () => { advance(image); paint(card, image); refreshCount(); });
    paint(card, image);
    card.dataset.todo = needsLabel(image) ? '1' : '';
    grid.append(card);
    cards.push([card, image]);
    allCards.push([card, image]);
  }
  accept.addEventListener('click', () => {
    for (const [card, image] of cards) if (image.want === null) { image.want = image.verdict !== 'hidden'; paint(card, image); }
    refreshCount();
  });
  section.append(head, grid);
  main.append(section);
}
refreshCount();
document.getElementById('todoCount').textContent = DATA.docs.flatMap((d) => d.images).filter(needsLabel).length + ' now';
document.getElementById('todo').addEventListener('change', applyFilter);
const keepCount = () => { document.getElementById('keepCount').textContent = allCards.filter(([, image]) => keepable(image)).length; };
keepCount();
document.getElementById('keep').addEventListener('click', () => {
  for (const [card, image] of allCards) if (keepable(image)) { image.want = image.was; image.bad = false; paint(card, image); }
  refreshCount();
  keepCount();
});
document.getElementById('save').addEventListener('click', () => {
  const stale = DATA.docs.flatMap((d) => d.images).filter((i) => i.was !== null && i.want === null).length;
  if (stale > 0 && !confirm(stale + ' picture(s) changed since they were labelled (yellow) and have no new label. Saving drops their old label. Save anyway?')) return;
  const docs = {};
  for (const doc of DATA.docs) {
    const images = doc.images.filter((i) => i.want !== null).map((i) => Object.assign({ page: i.page, bbox: i.bbox, hash: i.hash, want: i.want }, i.want && i.bad ? { bad: true, note: i.note || undefined } : {})).concat(doc.carried);
    if (images.length > 0 || doc.missed > 0) docs[doc.docId] = { images, missed: doc.missed };
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, docs }, null, 1)], { type: 'application/json' }));
  link.download = 'labels.json';
  link.click();
});
</script>
</html>
`;

// ---------------------------------------------------------------------------------------------------------- `report`

interface Score {
  labelled: number;
  /** Wanted and reachable in the review (offered, or in the tab of images with text). */
  found: number;
  /** Wanted and not reachable: hidden, gone from the results, or never a candidate. */
  lost: number;
  /** Not wanted, yet in the review's main list. */
  noise: number;
  /** Offered pictures that have a label (the base of precision). */
  offeredLabelled: number;
  unlabelled: number;
  /** Pictures that are no longer the ones that were labelled there: counted in neither figure until labelled again. */
  changed: number;
  /** Wanted and reachable, but taken wrongly (a wrong crop, the page's text in it, two things joined). */
  wrong: number;
  /** Wanted pictures now hidden because wanted pictures cut out of them are offered instead: neither found nor lost. */
  replaced: number;
  /** Wanted labels that match no picture now, while a picture lies in their place (taken another way since): to be judged again. */
  stale: number;
}

/** The figures of one document, and its pictures that are wanted but taken wrongly (with their labels). */
/** A wanted label that matches no picture is stale when a picture now overlaps its place this much (IoU) at least. */
const STALE_MIN_IOU = 0.3;

function scoreOf(doc: DocResult, labels: Labels): { score: Score; wronglyTaken: { image: MeasuredImage; label: Label }[] } {
  const known = labels.docs[doc.docId] ?? { images: [] };
  const { labelOf, unmatched, changed } = matchLabels(doc.images, known.images);
  // A wanted label that matches nothing now is lost, unless a picture lies in its place (the same thing taken another way).
  const inPlace = (l: Label): boolean => doc.images.some((image) => image.page === l.page && image.verdict !== 'hidden' && iou(image.bbox, l.bbox) >= STALE_MIN_IOU);
  const unmatchedWanted = unmatched.filter((l) => l.want);
  const stale = unmatchedWanted.filter(inPlace).length;
  const score: Score = { labelled: 0, found: 0, lost: (known.missed ?? 0) + unmatchedWanted.length - stale, noise: 0, offeredLabelled: 0, unlabelled: 0, changed: 0, wrong: 0, replaced: 0, stale };
  const wronglyTaken: { image: MeasuredImage; label: Label }[] = [];
  // Mostly within: half of the piece at least lies over the whole (a sheet's box is that of one of its pieces, not of all of it).
  const inside = (inner: Box, outer: Box): boolean => {
    const w = Math.min(inner.maxX, outer.maxX) - Math.max(inner.minX, outer.minX);
    const h = Math.min(inner.maxY, outer.maxY) - Math.max(inner.minY, outer.minY);
    const area = (inner.maxX - inner.minX) * (inner.maxY - inner.minY);
    return w > 0 && h > 0 && area > 0 && (w * h) / area >= 0.5;
  };
  const replacedByCuts = (whole: MeasuredImage, takenWell = false): boolean =>
    doc.images.some((other) => {
      const label = labelOf.get(other);
      return other !== whole && other.page === whole.page && other.verdict === (takenWell ? 'offered' : other.verdict) && other.verdict !== 'hidden' && !changed.has(other) && label?.want === true && (!takenWell || label.bad !== true) && inside(other.bbox, whole.bbox);
    });
  for (const image of doc.images) {
    if (changed.has(image)) {
      score.changed++;
      continue;
    }
    const label = labelOf.get(image);
    if (!label) {
      score.unlabelled++;
      continue;
    }
    score.labelled++;
    if (image.verdict === 'offered') score.offeredLabelled++;
    // Taken wrongly, but what was wanted of it is offered by itself, cut out of it and taken well (a map without the page's
    // frame, while the page stays among the images with text): replaced, like a hidden page whose pictures are cut out.
    if (label.want && label.bad === true && image.verdict === 'text' && replacedByCuts(image, true)) {
      score.replaced++;
      continue;
    }
    if (label.want && image.verdict !== 'hidden') score.found++;
    if (label.want && label.bad === true && image.verdict !== 'hidden') {
      score.wrong++;
      wronglyTaken.push({ image, label });
    }
    if (label.want && image.verdict === 'hidden') {
      if (replacedByCuts(image)) score.replaced++;
      else score.lost++;
    }
    if (!label.want && image.verdict === 'offered') score.noise++;
  }
  return { score, wronglyTaken };
}

const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '—');

function commandReport(options: ReadonlyMap<string, string>): void {
  const out = resolve(options.get('out') ?? DEFAULT_OUT);
  const run = pickRun(out, options);
  const runs = runsOf(out);
  const baseline = options.get('baseline') ?? runs[runs.indexOf(run) - 1];
  const labels = readJson<Labels>(join(out, 'labels.json'), { version: 1, docs: {} });
  const docs = readRun(out, run);

  console.log(`measure-images: run "${run}" — ${docs.length} document(s), labels for ${Object.keys(labels.docs).length}`);
  console.log('');
  console.log('doc         pages  offered  text  hidden   recall  precision   lost  noise  wrong  unlabelled  changed   s/page');
  const total: Score = { labelled: 0, found: 0, lost: 0, noise: 0, offeredLabelled: 0, unlabelled: 0, changed: 0, wrong: 0, replaced: 0, stale: 0 };
  let failures = 0;
  for (const doc of docs) {
    if (doc.error) {
      failures++;
      console.log(`${doc.docId}  FAILED: ${doc.error.split('\n')[0]}`);
      continue;
    }
    const s = scoreOf(doc, labels).score;
    for (const key of Object.keys(total) as (keyof Score)[]) total[key] += s[key];
    const count = (v: Verdict): number => doc.images.filter((i) => i.verdict === v).length;
    const perPage = doc.pages > 0 ? ((doc.seconds.inventory + doc.seconds.extraction) / doc.pages).toFixed(2) : '—';
    console.log(
      `${doc.docId}  ${String(doc.pages).padStart(5)}  ${String(count('offered')).padStart(7)}  ${String(count('text')).padStart(4)}  ${String(count('hidden')).padStart(6)}  ${percent(s.found, s.found + s.lost).padStart(7)}  ${percent(s.offeredLabelled - s.noise, s.offeredLabelled).padStart(9)}  ${String(s.lost).padStart(5)}  ${String(s.noise).padStart(5)}  ${String(s.wrong).padStart(5)}  ${String(s.unlabelled).padStart(10)}  ${String(s.changed).padStart(7)}  ${perPage.padStart(7)}`,
    );
  }
  console.log('');
  console.log(`recall     ${percent(total.found, total.found + total.lost)}  (${total.found} wanted pictures reachable in the review, ${total.lost} lost${total.replaced > 0 ? `, ${total.replaced} replaced by pictures cut out of them` : ''})`);
  console.log(`precision  ${percent(total.offeredLabelled - total.noise, total.offeredLabelled)}  (${total.noise} unwanted among ${total.offeredLabelled} labelled pictures of the main list)`);
  console.log(`taken well ${percent(total.found - total.wrong, total.found)}  (${total.wrong} of the ${total.found} wanted pictures found are marked as taken wrongly)`);
  if (total.wrong > 0) {
    console.log('');
    console.log('taken wrongly:');
    for (const doc of docs) {
      if (doc.error) continue;
      for (const { image, label } of scoreOf(doc, labels).wronglyTaken) console.log(`  ${doc.docId} p.${image.page}  ${image.width}x${image.height} ${image.source}  ${image.rule ?? ''}${label.note ? `  — ${label.note}` : ''}`);
    }
    console.log('');
  }
  if (total.unlabelled > 0) console.log(`not labelled: ${total.unlabelled} picture(s) — they count in neither figure; run "label"`);
  if (total.stale > 0) console.log(`stale: ${total.stale} wanted label(s) match no picture now, but a picture lies in their place — they count in neither figure; run "label" and judge it`);
  if (total.changed > 0) console.log(`changed: ${total.changed} picture(s) are no longer the ones that were labelled in their place — they count in neither figure; run "label" and judge them again`);
  if (failures > 0) console.log(`failed: ${failures} document(s)`);

  if (baseline && runs.includes(baseline) && baseline !== run) {
    const before = new Map(readRun(out, baseline).map((d) => [d.docId, d]));
    const changes: string[] = [];
    for (const doc of docs) {
      const old = before.get(doc.docId);
      if (!old || old.error || doc.error) continue;
      // The earlier run's pictures stand in for labels here: the same matching, by content and then by place.
      const { labelOf, unmatched } = matchLabels(
        doc.images,
        old.images.map((i) => ({ page: i.page, bbox: i.bbox, hash: i.hash, want: i.verdict !== 'hidden' })),
      );
      const oldByKey = new Map(old.images.map((i) => [`${i.page}:${i.hash}:${i.bbox.minX}`, i]));
      for (const image of doc.images) {
        const match = labelOf.get(image);
        if (!match) changes.push(`${doc.docId} p.${image.page}  new: ${image.verdict}  ${image.rule ?? ''}`);
        else {
          const was = oldByKey.get(`${match.page}:${match.hash}:${match.bbox.minX}`);
          if (was && was.verdict !== image.verdict) changes.push(`${doc.docId} p.${image.page}  ${was.verdict} -> ${image.verdict}  ${image.rule ?? ''}`);
        }
      }
      for (const gone of unmatched) changes.push(`${doc.docId} p.${gone.page}  gone (was ${gone.want ? 'reachable' : 'hidden'})`);
    }
    console.log('');
    console.log(`changes since run "${baseline}": ${changes.length}`);
    for (const line of changes.slice(0, 60)) console.log(`  ${line}`);
    if (changes.length > 60) console.log(`  ... and ${changes.length - 60} more`);
  }
}

// ---------------------------------------------------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
const { positional, options } = parseArgs(rest);
try {
  if (command === 'one') await measureOne(positional[0]!, positional[1]!, positional[2]!, positional[3]!);
  else if (command === 'run') await commandRun(positional, options);
  else if (command === 'label') commandLabel(options);
  else if (command === 'report') commandReport(options);
  else {
    console.log('usage: measure-images run <folder or PDFs...> [--out DIR] [--name NAME] [--jobs N] [--limit N] [--min-mb N]');
    console.log('       measure-images label  [--out DIR] [--run NAME]');
    console.log('       measure-images report [--out DIR] [--run NAME] [--baseline NAME]');
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`measure-images: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
// pdf.js keeps handles open after a document is destroyed; the work is done, so the process ends here.
process.exit(process.exitCode ?? 0);
