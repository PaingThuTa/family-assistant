// Mini App timeline. Plain DOM, no framework. All server text is set with textContent, never innerHTML.
import { monthOf, monthRange, renderCalendar, shiftMonth } from './calendar.js';
import { el, trashIcon } from './dom.js';
import { renderNotes } from './notes.js';

const tg = window.Telegram?.WebApp;

const T = {
  names: { Mom: 'မေမေ', Dad: 'ဖေဖေ', Brother: 'ညီလေး', Admin: 'Admin' },
  done: 'ပြီးပြီ',
  undo: 'ပြန်ဖွင့်',
  empty: 'ဘာမှ မရှိပါ',
  error: 'တစ်ခုခု မှားသွားတယ်။ ပြန်ကြိုးစားပါ။',
  openInTelegram: 'Telegram ထဲကနေ ဖွင့်ပါ။',
  addTitle: 'အသစ်ထည့်မယ်',
  editTitle: 'ပြင်မယ်',
  confirmDelete: 'ဒါကို ဖျက်မှာ သေချာလား?',
  delete: 'ဖျက်မယ်',
  pickHour: 'နာရီ ရွေးပါ',
  // Same words as the bot's times (strings.ts S.periods).
  periods: { morning: 'မနက်', noon: 'နေ့လယ်', evening: 'ညနေ', night: 'ည' },
};
const UNDO_MS = 5000;
const SKELETON_DELAY_MS = 200; // fast loads never flash the skeleton

const $ = (id) => document.getElementById(id);

let state = {
  me: null,
  members: [],
  ownerId: null,
  range: 'today', // today | tomorrow | week | calendar
  dates: {},
  justDone: null,
  month: null, // calendar: "YYYY-MM"
  selected: null, // calendar: "YYYY-MM-DD"
  monthItems: [],
  editing: null, // id of the item open in the form, or null when adding
  view: 'planner', // planner | notes
  notes: [],
  noteShared: true, // choice in the new-note form
};
const setState = (patch) => {
  state = { ...state, ...patch };
};

// Server error messages are Burmese; anything else (offline, timeouts) becomes T.error.
async function api(path, options = {}) {
  let body = null;
  try {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${tg?.initData ?? ''}` },
    });
    body = await res.json();
  } catch {
    throw new Error(T.error);
  }
  if (!body?.success) throw new Error(body?.error || T.error);
  return body.data;
}

const canAdd = () => state.me.role === 'admin' || state.me.id === state.ownerId;

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

// ---------- header ----------

function renderPeople() {
  $('people').hidden = state.members.length < 2;
  $('people').replaceChildren(
    ...state.members.map((m) =>
      el('button', {
        type: 'button',
        textContent: T.names[m.name] ?? m.name,
        className: m.id === state.ownerId ? 'active' : '',
        onclick: () => {
          setState({ ownerId: m.id });
          load();
        },
      }),
    ),
  );
}

function renderTabs() {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.range === state.range);
}

function renderHeader() {
  renderPeople();
  renderTabs();
  $('add').hidden = !canAdd();
  $('calendar').hidden = state.range !== 'calendar';
}

// ---------- list ----------

function actionButton(item) {
  if (!item.canEdit) return [];
  const button = (className, textContent, done) =>
    el('button', {
      type: 'button',
      className,
      textContent,
      onclick: (e) => {
        e.stopPropagation(); // don't also open the edit form
        setDone(item.id, done);
      },
    });
  const trash = el(
    'button',
    {
      type: 'button',
      className: 'trash',
      ariaLabel: T.delete,
      onclick: (e) => {
        e.stopPropagation();
        removeItem(item.id);
      },
    },
    [trashIcon()],
  );
  if (!item.done) return [button('done', T.done, true), trash];
  if (item.id === state.justDone) return [button('undo', T.undo, false), trash];
  return [trash];
}

function card(item) {
  const text = el('div', { className: 'text' }, [
    el('div', { className: 'time', textContent: item.fromEarlierDay ? `${item.day} ${item.time}` : item.time }),
    el('div', { className: 'title', textContent: item.title }),
  ]);
  const classes = ['card', item.important && 'important', item.done && 'is-done', item.late && 'late'];
  // Tapping an unfinished card opens it for editing.
  const editable = item.canEdit && !item.done ? { role: 'button', tabIndex: 0, onclick: () => openForm(item) } : {};
  return el('div', { className: classes.filter(Boolean).join(' '), ...editable }, [text, ...actionButton(item)]);
}

function skeleton() {
  const bar = (extra = '') => el('div', { className: `bar ${extra}` });
  const one = () => el('div', { className: 'card skeleton' }, [el('div', { className: 'text' }, [bar('short'), bar()])]);
  $('list').setAttribute('aria-busy', 'true');
  $('list').replaceChildren(one(), one(), one());
}

function renderList(items) {
  $('list').removeAttribute('aria-busy');
  if (items.length === 0) return $('list').replaceChildren(el('p', { className: 'empty', textContent: T.empty }));
  if (state.range !== 'week') return $('list').replaceChildren(...items.map(card));
  const days = [...new Set(items.map((i) => i.day))];
  $('list').replaceChildren(
    ...days.flatMap((day) => [el('h3', { textContent: day }), ...items.filter((i) => i.day === day).map(card)]),
  );
}

// ---------- calendar ----------

function goToMonth(month) {
  const selected = month === monthOf(state.dates.today) ? state.dates.today : `${month}-01`;
  setState({ month, selected, monthItems: [] });
  renderGrid();
  load();
}

function renderGrid() {
  renderCalendar($('calendar'), {
    month: state.month,
    selected: state.selected,
    today: state.dates.today,
    items: state.monthItems,
    onSelect: (date) => {
      setState({ selected: date });
      renderCalendarView();
    },
    onMonth: (delta) => goToMonth(shiftMonth(state.month, delta)),
  });
}

function renderCalendarView() {
  renderGrid();
  renderList(state.monthItems.filter((i) => i.date === state.selected));
}

// ---------- loading ----------

function itemsPath() {
  if (state.range !== 'calendar') return `/api/items?owner=${state.ownerId}&range=${state.range}`;
  const { from, to } = monthRange(state.month);
  return `/api/items?owner=${state.ownerId}&from=${from}&to=${to}`;
}

// Only the newest request may draw the list, so a slow reply for an old tab can't overwrite it.
let latestLoad = 0;
async function load() {
  const requestId = ++latestLoad;
  renderHeader();
  const slow = setTimeout(() => requestId === latestLoad && skeleton(), SKELETON_DELAY_MS);
  try {
    const items = await api(itemsPath());
    if (requestId !== latestLoad) return;
    if (state.range === 'calendar') {
      setState({ monthItems: items });
      renderCalendarView();
    } else {
      renderList(items);
    }
    showMessage('');
  } catch (err) {
    if (requestId !== latestLoad) return;
    $('list').replaceChildren();
    showMessage(err.message);
  } finally {
    clearTimeout(slow);
  }
}

// Done keeps an undo button on the card for a few seconds, in case of an accidental tap.
async function setDone(id, done) {
  try {
    await api(`/api/items/${id}/${done ? 'done' : 'reopen'}`, { method: 'POST' });
    if (done) tg?.HapticFeedback?.notificationOccurred('success');
    setState({ justDone: done ? id : null });
    if (done) {
      setTimeout(() => {
        if (state.justDone !== id) return;
        setState({ justDone: null });
        load();
      }, UNDO_MS);
    }
    await load();
  } catch (err) {
    showMessage(err.message);
  }
}

// ---------- add / edit form ----------

// Hour is a short list ("ညနေ 5 နာရီ"); minutes are four buttons, so nobody scrolls through 60 minutes.
const pad = (n) => String(n).padStart(2, '0');
const period = (h) => (h < 12 ? T.periods.morning : h < 16 ? T.periods.noon : h < 19 ? T.periods.evening : T.periods.night);
const hourLabel = (h) => `${period(h)} ${h % 12 || 12} နာရီ`;

function fillHours() {
  const options = Array.from({ length: 24 }, (_, h) => el('option', { value: pad(h), textContent: hourLabel(h) }));
  $('form').elements.hour.append(el('option', { value: '', textContent: T.pickHour }), ...options);
}

// An edited task can have any minute (e.g. :10); it gets its own button so editing keeps it.
function chooseMinute(minute) {
  const chips = $('minute-chips');
  chips.querySelector('[data-extra]')?.remove();
  if (!chips.querySelector(`[data-minute="${minute}"]`)) {
    const extra = el('button', { type: 'button', textContent: `:${minute}` });
    Object.assign(extra.dataset, { minute, extra: '' });
    chips.append(extra);
  }
  for (const b of chips.querySelectorAll('button')) b.classList.toggle('active', b.dataset.minute === minute);
  $('form').elements.minute.value = minute;
}

function chooseDay(day) {
  for (const b of $('day-chips').querySelectorAll('button')) b.classList.toggle('active', b.dataset.day === day);
  $('date-field').hidden = day !== 'pick';
  if (day !== 'pick') $('form').elements.date.value = state.dates[day];
}

function setFormDate(date) {
  const chip = date === state.dates.today ? 'today' : date === state.dates.tomorrow ? 'tomorrow' : 'pick';
  chooseDay(chip);
  $('form').elements.date.value = date;
}

// item = null to add; an item to edit it.
function openForm(item = null) {
  const f = $('form').elements;
  $('form').reset();
  setState({ editing: item?.id ?? null });
  $('form-title').textContent = item ? T.editTitle : T.addTitle;
  $('delete').hidden = !item;
  setFormDate(item?.date ?? (state.range === 'calendar' ? state.selected : state.dates.today));
  const [hour, minute] = item ? item.clock.split(':') : ['', '00'];
  f.hour.value = hour;
  chooseMinute(minute);
  if (item) {
    f.title.value = item.title;
    f.important.checked = item.important;
  }
  $('form-error').hidden = true;
  $('save').disabled = false;
  $('form-dialog').showModal();
  tg?.BackButton?.show();
}

const closeForm = () => $('form-dialog').close();

function showFormError(err) {
  $('form-error').textContent = err.message;
  $('form-error').hidden = false;
}

async function submitForm(event) {
  event.preventDefault();
  if ($('save').disabled) return;
  const f = $('form').elements;
  if (!f.hour.value) return showFormError(new Error(T.pickHour));
  $('save').disabled = true; // one tap, one task, even on a slow network
  const fields = { title: f.title.value, date: f.date.value, time: `${f.hour.value}:${f.minute.value}`, important: f.important.checked };
  try {
    if (state.editing) {
      await api(`/api/items/${state.editing}`, { method: 'PUT', body: JSON.stringify(fields) });
    } else {
      await api('/api/items', { method: 'POST', body: JSON.stringify({ ...fields, ownerId: state.ownerId }) });
    }
    closeForm();
    tg?.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (err) {
    showFormError(err);
    $('save').disabled = false;
  }
}

// Telegram's own confirm popup when available, the browser's otherwise.
const confirmDelete = () =>
  new Promise((resolve) => (tg?.showConfirm ? tg.showConfirm(T.confirmDelete, resolve) : resolve(window.confirm(T.confirmDelete))));

// Used by the trash button on a card and the Delete button in the edit form. Returns true if deleted.
async function removeItem(id) {
  if (!(await confirmDelete())) return false;
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    tg?.HapticFeedback?.notificationOccurred('success');
    await load();
    return true;
  } catch (err) {
    showMessage(err.message);
    return false;
  }
}

async function deleteEditing() {
  if (await removeItem(state.editing)) closeForm();
}

// ---------- notes ----------

const noteActions = {
  onNew: () => openNoteForm(),
  onAddLine: (noteId, text) => notesCall(`/api/notes/${noteId}/items`, 'POST', { text }, noteId),
  onToggle: (itemId) => notesCall(`/api/note-items/${itemId}/toggle`, 'POST'),
  onDeleteLine: (itemId) => notesCall(`/api/note-items/${itemId}`, 'DELETE'),
  onDeleteNote: async (noteId) => {
    if (await confirmDelete()) notesCall(`/api/notes/${noteId}`, 'DELETE');
  },
};

const drawNotes = (focusNoteId = null) => renderNotes($('notes'), state.notes, noteActions, focusNoteId);

// Every notes endpoint answers with the full, fresh list.
async function notesCall(path, method, body, focusNoteId = null) {
  try {
    const notes = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    setState({ notes });
    drawNotes(focusNoteId);
    showMessage('');
  } catch (err) {
    showMessage(err.message);
  }
}

const loadNotes = () => notesCall('/api/notes', 'GET');

function chooseShared(shared) {
  setState({ noteShared: shared });
  for (const b of $('share-chips').querySelectorAll('button')) b.classList.toggle('active', b.dataset.shared === String(shared));
}

function openNoteForm() {
  $('note-form').reset();
  chooseShared(true);
  $('note-error').hidden = true;
  $('note-save').disabled = false;
  $('note-dialog').showModal();
  tg?.BackButton?.show();
}

async function submitNote(event) {
  event.preventDefault();
  if ($('note-save').disabled) return;
  $('note-save').disabled = true;
  try {
    const notes = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: $('note-form').elements.title.value, shared: state.noteShared }),
    });
    setState({ notes });
    $('note-dialog').close();
    drawNotes(notes[0]?.id ?? null); // newest first: start typing its first line
  } catch (err) {
    $('note-error').textContent = err.message;
    $('note-error').hidden = false;
    $('note-save').disabled = false;
  }
}

function setView(view) {
  setState({ view });
  $('planner').hidden = view !== 'planner';
  $('notes').hidden = view !== 'notes';
  for (const b of $('nav').querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === view);
  showMessage('');
  if (view === 'notes') loadNotes();
  else load();
}

// ---------- startup ----------

// Fetches who I am and today's date. Re-run when the app returns, so "today" is right after midnight.
async function refreshMe() {
  const data = await api('/api/me');
  setState({ me: data.me, members: data.members, dates: { today: data.today, tomorrow: data.tomorrow } });
  return data;
}

function selectTab(range) {
  if (range === 'calendar') {
    const selected = state.selected ?? state.dates.today;
    setState({ range, selected, month: monthOf(selected), monthItems: [] });
    renderGrid();
  } else {
    setState({ range });
  }
  load();
}

function wireEvents() {
  $('tabs').addEventListener('click', (e) => {
    const range = e.target.closest('button')?.dataset.range;
    if (range) selectTab(range);
  });
  $('day-chips').addEventListener('click', (e) => {
    const day = e.target.closest('button')?.dataset.day;
    if (day) chooseDay(day);
  });
  $('minute-chips').addEventListener('click', (e) => {
    const minute = e.target.closest('button')?.dataset.minute;
    if (minute) chooseMinute(minute);
  });
  $('add').addEventListener('click', () => openForm());
  $('cancel').addEventListener('click', closeForm);
  $('delete').addEventListener('click', deleteEditing);
  $('form').addEventListener('submit', submitForm);
  $('form-dialog').addEventListener('close', () => tg?.BackButton?.hide());
  $('note-dialog').addEventListener('close', () => tg?.BackButton?.hide());
  // Android back closes whichever form is open instead of the whole app.
  tg?.BackButton?.onClick(() => {
    closeForm();
    $('note-dialog').close();
  });
  $('nav').addEventListener('click', (e) => {
    const view = e.target.closest('button')?.dataset.view;
    if (view && view !== state.view) setView(view);
  });
  $('share-chips').addEventListener('click', (e) => {
    const shared = e.target.closest('button')?.dataset.shared;
    if (shared) chooseShared(shared === 'true');
  });
  $('note-cancel').addEventListener('click', () => $('note-dialog').close());
  $('note-form').addEventListener('submit', submitNote);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.me) return;
    try {
      await refreshMe();
    } catch (err) {
      return showMessage(err.message);
    }
    if (state.view === 'notes') {
      // Reloading redraws the notes, which would wipe a line someone is still typing.
      const typing = [...$('notes').querySelectorAll('.add-line input')].some((i) => i.value.trim());
      if (!typing) loadNotes();
    } else {
      load();
    }
  });
}

async function init() {
  tg?.ready();
  tg?.expand();
  const fail = (text) => {
    $('list').replaceChildren();
    showMessage(text);
  };
  if (!tg?.initData) return fail(T.openInTelegram);
  try {
    // One request brings everything for the first screen, including today's list.
    const data = await refreshMe();
    setState({ ownerId: data.ownerId });
    renderHeader();
    renderList(data.items);
  } catch (err) {
    return fail(err.message);
  }
  fillHours();
  wireEvents();
  // The bot's "မှတ်စု" button opens the app with ?view=notes.
  if (new URLSearchParams(location.search).get('view') === 'notes') setView('notes');
}

init();
