// The guide is read-only: its examples never replace the open property.
import { escapeHtml as esc } from './store.js';
import { chapters, viewMap } from './guide-content.js';

const assets = './js/guide-assets/';
let root = null;
let selected = 'start';
let imageDialog = null;

const searchable = chapter => JSON.stringify(chapter).toLocaleLowerCase();

export function chapterHtml(chapter, { print = false } = {}) {
  const media = chapter.image ? `<figure class="guide-figure">${print ? '' : `<button type="button" class="guide-image" data-enlarge="${esc(chapter.id)}" aria-label="Enlarge screenshot: ${esc(chapter.title)}">`}<img src="${assets}${esc(chapter.image)}" alt="${esc(chapter.alt || chapter.caption)}" ${print ? '' : 'loading="lazy"'} width="1440" height="960">${print ? '' : '</button>'}<figcaption>${esc(chapter.caption)}${print ? '' : ' Select the image to enlarge it.'}</figcaption></figure>` : '';
  return `<article class="guide-chapter" data-chapter="${esc(chapter.id)}">
    <p class="guide-kicker">${esc(chapter.group)}${chapter.path ? ' / ' + esc(chapter.path) : ''}</p>
    <h2 tabindex="-1">${esc(chapter.title)}</h2><p class="guide-deck">${esc(chapter.intro)}</p>
    ${chapter.route && !print ? `<a class="btn guide-open" href="#/${esc(chapter.route)}">OPEN ${esc(chapter.workspace || chapter.route.toUpperCase())} <span aria-hidden="true">↗</span></a>` : ''}
    ${media}
    ${chapter.id === 'start' ? `<h3>Where everything lives</h3><div class="guide-view-map">${viewMap.map(view => `<div><${print ? 'strong' : `a href="#/${esc(view.route)}"`}>${esc(view.label)}</${print ? 'strong' : 'a'}><p>${esc(view.purpose)}</p></div>`).join('')}</div>` : ''}
    ${chapter.steps?.length ? `<h3>${esc(chapter.stepsTitle || 'Try it')}</h3><ol class="guide-steps">${chapter.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
    ${chapter.clip && !print ? `<figure class="guide-demo"><video controls loop muted playsinline preload="none" poster="${assets}${esc(chapter.image)}" aria-label="${esc(chapter.clipTitle)}"><source src="${assets}${esc(chapter.clip)}" type="video/mp4"></video><figcaption>${esc(chapter.clipTitle)}. This is a recording of the app using synthetic data. <a href="${assets}${esc(chapter.gif)}" download>Download GIF</a></figcaption><details><summary>Demo steps in text</summary><p>${esc(chapter.transcript)}</p></details></figure>` : ''}
    ${chapter.features?.length ? `<h3>Other features here</h3><dl class="guide-features">${chapter.features.map(([name, description]) => `<div><dt>${esc(name)}</dt><dd>${esc(description)}</dd></div>`).join('')}</dl>` : ''}
    ${chapter.note ? `<aside class="guide-note"><strong>${esc(chapter.noteTitle || 'Good to know')}</strong><p>${esc(chapter.note)}</p></aside>` : ''}
    ${chapter.related?.length && !print ? `<nav class="guide-related" aria-label="Related chapters">${chapter.related.map(id => { const item = chapters.find(c => c.id === id); return item ? `<button type="button" class="btn" data-topic="${esc(id)}">${esc(item.title)} →</button>` : ''; }).join('')}</nav>` : ''}
  </article>`;
}

export function printableHtml() {
  return `<div class="guide-print"><header><p>TIKSI / USER GUIDE</p><h1>From a room to a renovation project.</h1><p>A screenshot guide to capture, design, materials and project work.</p><p>Synthetic demonstration project. Prices are examples, not supplier quotes.</p></header>${chapters.map(chapter => chapterHtml(chapter, { print: true })).join('')}</div>`;
}

export function mount(element) {
  root = element;
  const requested = new URLSearchParams(location.hash.split('?')[1] || '').get('topic');
  selected = chapters.some(c => c.id === requested) ? requested : 'start';
  root.innerHTML = `<section class="guide-shell" aria-label="Tiksi user guide">
    <header class="guide-heading"><div><p class="guide-kicker">TIKSI / USER GUIDE</p><h1>Find your next step.</h1><p>Screenshots, short demos and the features you might have missed.</p></div><a class="btn" href="${assets}tiksi-user-guide.pdf" download>DOWNLOAD PDF</a></header>
    <div class="guide-search"><label for="guide-search">Find a feature</label><input id="guide-search" type="search" placeholder="Try photo pins, save, wall, estimate…" autocomplete="off"><p class="guide-search-count" role="status" aria-live="polite"></p></div>
    <div class="guide-layout"><aside class="guide-contents"><label class="guide-mobile-label" for="guide-chapter-select">Jump to a chapter</label><select id="guide-chapter-select" class="guide-mobile-select">${chapters.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select><nav aria-label="Guide chapters">${chapters.map((chapter, i) => `<button type="button" data-topic="${esc(chapter.id)}"><span>${String(i + 1).padStart(2, '0')}</span>${esc(chapter.title)}</button>`).join('')}</nav><p>Every example uses a synthetic property. Opening a workspace keeps your property selected.</p></aside><div class="guide-reading"><div data-guide-results hidden></div><div data-guide-article></div></div></div>
  </section>`;
  root.addEventListener('click', onClick);
  root.querySelector('#guide-search').addEventListener('input', search);
  root.querySelector('#guide-chapter-select').onchange = event => selectChapter(event.target.value, true);
  selectChapter(selected);
}

function selectChapter(id, focus = false) {
  const chapter = chapters.find(c => c.id === id);
  if (!root || !chapter) return;
  root.querySelectorAll('video').forEach(video => video.pause());
  selected = id;
  history.replaceState(null, '', '#/guide?topic=' + encodeURIComponent(id));
  root.querySelector('#guide-search').value = '';
  root.querySelector('[data-guide-results]').hidden = true;
  const article = root.querySelector('[data-guide-article]');
  article.hidden = false;
  article.innerHTML = chapterHtml(chapter);
  root.querySelector('.guide-search-count').textContent = '';
  root.querySelector('#guide-chapter-select').value = id;
  root.querySelectorAll('.guide-contents [data-topic]').forEach(button => {
    if (button.dataset.topic === id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (focus) {
    root.querySelector('.guide-reading').scrollIntoView({ block: 'start' });
    article.querySelector('h2').focus({ preventScroll: true });
  }
}

function search(event) {
  const query = event.target.value.trim().toLocaleLowerCase();
  if (!query) { selectChapter(selected); return; }
  const results = chapters.filter(chapter => query.split(/\s+/).every(term => searchable(chapter).includes(term)));
  root.querySelectorAll('video').forEach(video => video.pause());
  root.querySelector('[data-guide-article]').hidden = true;
  const host = root.querySelector('[data-guide-results]');
  host.hidden = false;
  host.innerHTML = `<h2>Find a feature</h2>${results.length ? results.map(chapter => `<button type="button" class="guide-result" data-topic="${esc(chapter.id)}"><strong>${esc(chapter.title)}</strong><span>${esc(chapter.path || chapter.group)}</span><p>${esc(chapter.intro)}</p></button>`).join('') : '<p class="guide-no-results">No matching chapters. Try a shorter phrase, or choose a chapter from the contents.</p>'}`;
  root.querySelector('.guide-search-count').textContent = `${results.length} matching chapter${results.length === 1 ? '' : 's'}`;
}

function onClick(event) {
  const topic = event.target.closest('[data-topic]');
  if (topic) { selectChapter(topic.dataset.topic, true); return; }
  const button = event.target.closest('[data-enlarge]');
  if (!button) return;
  const chapter = chapters.find(c => c.id === button.dataset.enlarge);
  if (!chapter) return;
  imageDialog = document.createElement('dialog');
  imageDialog.className = 'guide-lightbox';
  imageDialog.setAttribute('aria-label', chapter.title + ' screenshot');
  imageDialog.innerHTML = `<button type="button" class="btn" autofocus>CLOSE IMAGE</button><figure><img src="${assets}${esc(chapter.image)}" alt="${esc(chapter.alt || chapter.caption)}"><figcaption>${esc(chapter.caption)}</figcaption></figure>`;
  imageDialog.querySelector('button').onclick = () => imageDialog.close();
  imageDialog.addEventListener('close', () => { imageDialog?.remove(); imageDialog = null; button.focus(); }, { once: true });
  document.body.append(imageDialog);
  imageDialog.showModal();
}

export function unmount() {
  root?.querySelectorAll('video').forEach(video => video.pause());
  root?.removeEventListener('click', onClick);
  imageDialog?.remove(); imageDialog = null;
  root = null;
}
