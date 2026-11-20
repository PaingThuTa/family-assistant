// Month grid for the calendar tab. Dates are "YYYY-MM-DD" strings in Yangon time, as the server sends them.
import { el } from './dom.js';

const MONTHS = ['ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်', 'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ'];
const WEEKDAYS = ['နွေ', 'လာ', 'ဂါ', 'ဟူး', 'တေး', 'ကြာ', 'နေ']; // Sunday first
const pad = (n) => String(n).padStart(2, '0');

export const monthOf = (date) => date.slice(0, 7);

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const monthRange = (month) => ({ from: `${month}-01`, to: `${shiftMonth(month, 1)}-01` });

// Days with unfinished tasks get a dot; days with only finished tasks get a faint one.
function dayStatus(items) {
  const status = new Map();
  for (const i of items) status.set(i.date, status.get(i.date) === 'open' || !i.done ? 'open' : 'done');
  return status;
}

export function renderCalendar(container, { month, selected, today, items, onSelect, onMonth }) {
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const status = dayStatus(items);

  const blanks = Array.from({ length: firstWeekday }, () => el('span'));
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${month}-${pad(i + 1)}`;
    const classes = ['day', date === today && 'today', date === selected && 'selected'].filter(Boolean).join(' ');
    const dot = status.get(date);
    return el('button', { type: 'button', className: classes, onclick: () => onSelect(date) }, [
      el('span', { textContent: String(i + 1) }),
      el('i', { className: dot ? `dot ${dot}` : 'dot' }),
    ]);
  });

  container.replaceChildren(
    el('div', { className: 'cal-head' }, [
      el('button', { type: 'button', className: 'cal-nav', textContent: '‹', ariaLabel: 'ယခင်လ', onclick: () => onMonth(-1) }),
      el('strong', { textContent: `${MONTHS[m - 1]} ${y}` }),
      el('button', { type: 'button', className: 'cal-nav', textContent: '›', ariaLabel: 'နောက်လ', onclick: () => onMonth(1) }),
    ]),
    el('div', { className: 'cal-grid' }, [
      ...WEEKDAYS.map((w) => el('span', { className: 'weekday', textContent: w })),
      ...blanks,
      ...days,
    ]),
  );
}
