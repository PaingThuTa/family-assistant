import { InlineKeyboard, Keyboard } from 'grammy';
import { S } from './strings.ts';
import { formatHour } from './time.ts';

export const TIMER_MINUTES = [10, 20, 30, 45, 60];
export const REMINDER_MINUTES = [0, 15, 30, 45];

export const mainKeyboard = () =>
  new Keyboard().text(S.timerButton).text(S.reminderButton).resized().persistent();

export const doneKeyboard = (itemId: number) => new InlineKeyboard().text(S.done, `done:${itemId}`);

export const timerPresetKeyboard = () =>
  new InlineKeyboard()
    .text(S.presets.rice, 'tp:rice')
    .text(S.presets.curry, 'tp:curry')
    .row()
    .text(S.presets.laundry, 'tp:laundry')
    .text(S.other, 'tp:other');

export const minutesKeyboard = () =>
  InlineKeyboard.from([TIMER_MINUTES.map((n) => InlineKeyboard.text(S.minutes(n), `tm:${n}`))]);

export const dayKeyboard = () => new InlineKeyboard().text(S.today, 'rd:0').text(S.tomorrow, 'rd:1');

const chunk = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export const hourKeyboard = (hours: number[]) =>
  InlineKeyboard.from(chunk(hours.map((h) => InlineKeyboard.text(formatHour(h), `rh:${h}`)), 3));

export const minuteKeyboard = (hour: number) =>
  InlineKeyboard.from(
    chunk(
      REMINDER_MINUTES.map((m) =>
        InlineKeyboard.text(`${formatHour(hour)}:${String(m).padStart(2, '0')}`, `rm:${m}`),
      ),
      2,
    ),
  );

export const importantKeyboard = () => new InlineKeyboard().text(S.yes, 'ri:1').text(S.no, 'ri:0');
