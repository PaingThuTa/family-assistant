// Notes screen: cards with a title and tick-able lines. Rendering only; app.js does the API calls.
import { el, trashIcon } from './dom.js';

const T = {
  newNote: '+ မှတ်စုအသစ်',
  empty: 'မှတ်စု မရှိသေးပါ',
  shared: 'မိသားစု',
  private: 'ကိုယ်ပိုင်',
  addLine: 'ထည့်မယ်...',
  deleteNote: 'မှတ်စု ဖျက်မယ်',
  deleteLine: 'ဖျက်',
  tick: 'ပြီးပြီ',
};

function line(item, actions) {
  return el('li', { className: item.checked ? 'line checked' : 'line' }, [
    el('button', {
      type: 'button',
      className: 'tick',
      ariaLabel: T.tick,
      ariaPressed: String(item.checked),
      onclick: () => actions.onToggle(item.id),
    }),
    el('span', { className: 'line-text', textContent: item.text }),
    el('button', {
      type: 'button',
      className: 'line-x',
      textContent: '×',
      ariaLabel: T.deleteLine,
      onclick: () => actions.onDeleteLine(item.id),
    }),
  ]);
}

function addLineForm(note, actions) {
  const input = el('input', { placeholder: T.addLine, maxLength: 200, autocomplete: 'off' });
  input.dataset.note = String(note.id);
  return el(
    'form',
    {
      className: 'add-line',
      onsubmit: async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const text = input.value.trim();
        if (!text || form.dataset.busy) return; // a quick double Enter adds the line once
        form.dataset.busy = '1';
        try {
          await actions.onAddLine(note.id, text);
        } finally {
          delete form.dataset.busy;
        }
      },
    },
    [input, el('button', { type: 'submit', textContent: '+', ariaLabel: T.addLine })],
  );
}

function noteCard(note, actions) {
  const head = el('div', { className: 'note-head' }, [
    el('strong', { textContent: note.title }),
    el('span', { className: note.shared ? 'badge' : 'badge private', textContent: note.shared ? T.shared : T.private }),
    ...(note.canDelete
      ? [el('button', { type: 'button', className: 'trash', ariaLabel: T.deleteNote, onclick: () => actions.onDeleteNote(note.id) }, [trashIcon()])]
      : []),
  ]);
  return el('article', { className: 'note' }, [
    head,
    el('ul', { className: 'lines' }, note.items.map((item) => line(item, actions))),
    addLineForm(note, actions),
  ]);
}

// focusNoteId: put the cursor back in that note's "add" box, so a list can be typed line after line.
export function renderNotes(container, notes, actions, focusNoteId = null) {
  container.replaceChildren(
    el('button', { type: 'button', className: 'new-note', textContent: T.newNote, onclick: actions.onNew }),
    ...(notes.length === 0 ? [el('p', { className: 'empty', textContent: T.empty })] : notes.map((n) => noteCard(n, actions))),
  );
  if (focusNoteId !== null) container.querySelector(`input[data-note="${focusNoteId}"]`)?.focus();
}
