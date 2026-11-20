// All Burmese UI text in one place. Review the wording with Mom.
export const S = {
  timerButton: '+ အချိန်မှတ်',
  reminderButton: '+ သတိပေးချက်',
  welcome: 'မင်္ဂလာပါ။ အောက်က ခလုတ်တွေကို နှိပ်ပြီး သုံးပါ။',
  notMember: (telegramId: number) =>
    `ဒီဘော့ကို မိသားစုဝင်များသာ သုံးနိုင်ပါသည်။\nID: ${telegramId}`,
  useButtons: 'အောက်က ခလုတ်တွေကို နှိပ်ပါ။',
  expired: 'ပြန်စပါ။',
  notAllowed: 'ဒါကို ပြင်ခွင့် မရှိပါ။',

  pickTimer: 'ဘာအတွက် အချိန်မှတ်မလဲ?',
  presets: { rice: 'ထမင်း', curry: 'ဟင်း', laundry: 'အဝတ်လျှော်' },
  other: 'အခြား',
  askTimerName: 'ဘာအတွက်လဲ? ရိုက်ထည့်ပါ။',
  pickMinutes: (title: string) => `${title} - ဘယ်နှမိနစ်လဲ?`,
  minutes: (n: number) => `${n} မိနစ်`,

  askReminderText: 'ဘာကို သတိပေးရမလဲ? ရိုက်ထည့်ပါ။',
  pickDay: (title: string) => `${title} - ဘယ်နေ့လဲ?`,
  today: 'ဒီနေ့',
  tomorrow: 'မနက်ဖြန်',
  pickHour: 'ဘယ်အချိန်လဲ?',
  pickMinute: 'မိနစ် ရွေးပါ။',
  timePassed: 'ဒီအချိန် ကျော်သွားပြီ။ ပြန်ရွေးပါ။',
  askImportant: 'အရေးကြီးလား? (ပြီးတဲ့အထိ ထပ်ခါထပ်ခါ သတိပေးမယ်)',
  yes: 'ဟုတ်',
  no: 'မဟုတ်',
  invalidTitle: 'စာသား ၁ လုံးမှ ၂၀၀ အထိ ရိုက်ပါ။',

  saved: (title: string, when: string) => `မှတ်ထားပြီ: ${title}\n${when}`,
  ping: (title: string) => `သတိပေးချက်: ${title}`,
  early: (minutes: number, title: string, time: string) => `${minutes} မိနစ်အကြာ (${time}): ${title}`,
  unanswered: (name: string, title: string, time: string) =>
    `${name} မပြီးသေးပါ (သတိပေးတာ မတုံ့ပြန်ပါ): ${title} - ${time}`,
  names: { Mom: 'အမေ', Dad: 'အဖေ', Admin: 'Admin' } as Record<string, string>,
  done: 'ပြီးပြီ',
  marked: (title: string) => `ပြီးပြီ: ${title}`,

  timelineButton: 'အစီအစဉ်',
  web: {
    unauthorized: 'Telegram ထဲကနေ ပြန်ဖွင့်ပါ။',
    badDateTime: 'ရက်စွဲ သို့မဟုတ် အချိန် မှားနေပါတယ်။',
    notFound: 'မတွေ့ပါ။',
    error: 'တစ်ခုခု မှားသွားတယ်။ ပြန်ကြိုးစားပါ။',
  },
  weekdays: ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'],

  periods: { morning: 'မနက်', noon: 'နေ့လယ်', evening: 'ညနေ', night: 'ည' },
} as const;
