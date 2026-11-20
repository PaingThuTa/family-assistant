import { InlineKeyboard, Keyboard } from 'grammy';
import { S } from './strings.ts';

export const mainKeyboard = () =>
  new Keyboard().text(S.nextButton).text(S.notesButton).row().text(S.weatherButton).resized().persistent();

export const doneKeyboard = (itemId: number) => new InlineKeyboard().text(S.done, `done:${itemId}`);

// Inline web_app buttons (unlike reply-keyboard ones) give the Mini App signed initData.
export function openNotesKeyboard(webAppUrl: string): InlineKeyboard {
  const url = new URL(webAppUrl); // safe even if the URL already has a query string
  url.searchParams.set('view', 'notes');
  return new InlineKeyboard().webApp(S.openNotes, url.toString());
}
