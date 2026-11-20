import { InlineKeyboard, Keyboard } from 'grammy';
import { S } from './strings.ts';

export const mainKeyboard = () => new Keyboard().text(S.nextButton).text(S.notesButton).resized().persistent();

export const doneKeyboard = (itemId: number) => new InlineKeyboard().text(S.done, `done:${itemId}`);

// Inline web_app buttons (unlike reply-keyboard ones) give the Mini App signed initData.
export const openNotesKeyboard = (webAppUrl: string) =>
  new InlineKeyboard().webApp(S.openNotes, `${webAppUrl}?view=notes`);
