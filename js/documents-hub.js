// DOCUMENTS: everything that leaves Tiksi.
//   DRAWINGS AND FILES  drawing sets, sheets and saved files (documentcenter.js)
//   PROJECT DOCUMENTS   the trim package book and the proposal, from a project (job-documents.js)
//   CUT SHEETS          printable specification sheets for scope items and products (cutsheets.js)
//   SEND                the one-pager, the proposal and the client page, each with where it stands
// Addresses: #/documents, #/documents?job[=<project id>], #/documents?sheets and #/sheets
// (#/sheets?item=<id> opens that item's sheet), #/documents?send.

import { hub } from './hub.js';

const view = hub({
  label: 'Documents',
  parts: [
    { id: 'drawings', label: 'DRAWINGS AND FILES', icon: 'file', load: () => import('./documentcenter.js'), addr: '#/documents' },
    { id: 'job', label: 'PROJECT DOCUMENTS', icon: 'print', load: () => import('./job-documents.js'), addr: '#/documents?job' },
    { id: 'sheets', label: 'CUT SHEETS', icon: 'sheets', load: () => import('./cutsheets.js'), addr: '#/documents?sheets' },
    { id: 'send', label: 'SEND', icon: 'export', load: () => import('./send-view.js'), addr: '#/documents?send' },
  ],
  partOf(hash) {
    if (/^#\/sheets/.test(hash)) return 'sheets';
    const q = new URLSearchParams(hash.split('?')[1] || '');
    if (q.has('send')) return 'send';
    if (q.has('job')) return 'job';
    if (q.has('sheets') || q.has('item')) return 'sheets';
    return 'drawings';
  },
});
export const { mount, unmount, undo, redo, sharedChange } = view;
