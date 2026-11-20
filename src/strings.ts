// All Burmese UI text in one place. Review the wording with Mom.
export const S = {
  nextButton: 'နောက်ဘာလဲ?',
  notesButton: 'မှတ်စု',
  weatherButton: 'ရာသီဥတု',
  welcome: 'မင်္ဂလာပါ။ အောက်က ခလုတ်တွေကို နှိပ်ပြီး သုံးပါ။\nရာသီဥတု နဲ့ ငလျင် သတိပေးချက် လိုချင်ရင် /alerts ကို နှိပ်ပါ။',
  notMember: (telegramId: number) =>
    `ဒီဘော့ကို မိသားစုဝင်များသာ သုံးနိုင်ပါသည်။\nID: ${telegramId}`,
  useButtons: 'အောက်က ခလုတ်တွေကို နှိပ်ပါ။',
  notAllowed: 'ဒါကို ပြင်ခွင့် မရှိပါ။',

  timePassed: 'ဒီအချိန် ကျော်သွားပြီ။ ပြန်ရွေးပါ။',
  today: 'ဒီနေ့',
  tomorrow: 'မနက်ဖြန်',
  invalidTitle: 'စာသား ၁ လုံးမှ ၂၀၀ အထိ ရိုက်ပါ။',

  next: (title: string, when: string) => `နောက်တစ်ခု: ${title}\n${when}`,
  nothingNext: 'လုပ်စရာ မရှိတော့ပါ။',
  lateHeader: 'မပြီးသေးတာ:',
  notesIntro: 'မှတ်စုတွေကို ဒီမှာ ဖွင့်ပါ။',
  openNotes: 'မှတ်စု ဖွင့်မယ်',
  notesUnavailable: 'မှတ်စု မဖွင့်နိုင်သေးပါ။',
  ping: (title: string) => `သတိပေးချက်: ${title}`,
  early: (minutes: number, title: string, time: string) => `${minutes} မိနစ်အကြာ (${time}): ${title}`,
  unanswered: (name: string, title: string, time: string) =>
    `${name} မပြီးသေးပါ (သတိပေးတာ မတုံ့ပြန်ပါ): ${title} - ${time}`,
  names: { Mom: 'မေမေ', Dad: 'ဖေဖေ', Brother: 'ညီလေး', Admin: 'Admin' } as Record<string, string>,
  done: 'ပြီးပြီ',
  marked: (title: string) => `ပြီးပြီ: ${title}`,

  timelineButton: 'အစီအစဉ်',
  web: {
    unauthorized: 'Telegram ထဲကနေ ပြန်ဖွင့်ပါ။',
    badDateTime: 'ရက်စွဲ သို့မဟုတ် အချိန် မှားနေပါတယ်။',
    notFound: 'မတွေ့ပါ။',
    error: 'တစ်ခုခု မှားသွားတယ်။ ပြန်ကြိုးစားပါ။',
  },
  notes: {
    badText: (max: number) => `စာသား ၁ လုံးမှ ${max} အထိ ရိုက်ပါ။`,
  },
  months: ['ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်', 'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ'],
  weekdays: ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'],

  periods: { morning: 'မနက်', noon: 'နေ့လယ်', evening: 'ညနေ', night: 'ည' },
} as const;
