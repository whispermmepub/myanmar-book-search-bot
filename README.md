# Myanmar Book Search Bot (Telegram)

Telegram bot ဖြင့် စာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ရှာနိုင်ပါသည်။ Space ပါပါ၊ မပါပါ ရှာနိုင်သည်။
ရလဒ်များတွင် စာအုပ်ကာဗာပုံ၊ စာရေးသူ၊ စာအုပ်အမည်၊ ဈေးနှုန်း၊ ထုတ်ဝေသည့်အကြိမ်၊ စာအုပ်တိုက်တို့ကို ပြသသည်။

Data source: [Google Sheets (Form responses)](https://docs.google.com/spreadsheets/d/18gpNdDNHztbkQE9rRvw6Y0rPqtKjrROJdy4HnZXqTQw/export?format=csv)
— form အသစ်များတင်တိုင်း bot သည် CSV ကို ပုံမှန် refresh လုပ်၍ အလိုအလျောက် အသစ်များပါဝင်သည်။

## Commands
- `/start` — စတင်အသုံးပြုနည်း
- `/stats` — စာအုပ်အရေအတွက်နှင့် နောက်ဆုံး refresh အချိန်
- အခြား message မှန်သမျှ — စာအုပ်/စာရေးသူ ရှာဖွေမှု (တစ်မျက်နှာလျှင် ၁၀ အုပ်၊ `နောက်မျက်နှာ ➡️` ဖြင့် ဆက်ကြည့်နိုင်၊ နာမည်နှိပ်လျှင် ကာဗာပုံ + အသေးစိတ် ပြသည်)

## Group / Inline သုံးနည်း
- **Group:** bot ကို group ထဲထည့်ပြီး Admin တင်ပါ။ ပြီးရင် `@saroatsarpay_bot စာအုပ်နာမည်` (သို့) `@saroatsarpay_bot စာရေးသူနာမည်` ရိုက်ပါ — လူတိုင်း သုံးနိုင်ပါသည်။
- **Inline mode:** BotFather မှာ inline mode ဖွင့်ထားပါက ဘယ် chat မှာမဆို `@saroatsarpay_bot နာမည်` ရိုက်လိုက်ရုံဖြင့် ရလဒ်များ ပေါ်လာပါမည်။
  - BotFather setup: `/setinline` → `@saroatsarpay_bot` → placeholder: `စာအုပ်နာမည် (သို့) စာရေးသူနာမည် ရိုက်ပါ`
  - Group တွင် ပိုအဆင်ပြေစေရန် BotFather → `/setprivacy` → `Disable` လုပ်နိုင်သည် (bot ကို admin တင်ထားပါက မလိုအပ်ပါ)။

## Environment variables
| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Telegram bot token |
| `TELEGRAM_OWNER_ID` | ❌ | — | Bot စတင်ချိန်တွင် အကြောင်းကြားမည့် user id |
| `REFRESH_HOURS` | ❌ | `6` | CSV data refresh interval (hours) |
| `SHEET_CSV_URL` | ❌ | Google Sheets export URL | စာအုပ်စာရင်း CSV URL |

## Run locally
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN=...
.venv/bin/python bot.py
```

## Deploy on Railway
```bash
railway up --ci -y
railway variables --set TELEGRAM_BOT_TOKEN=... --set TELEGRAM_OWNER_ID=...
```

Search matching: case-insensitive၊ Unicode-normalized၊ space/punctuation ဖယ်၍ substring နှင့် token match လုပ်သည်။
အချက်အလက် ပြည့်စုံသော စာအုပ်များသာ (ကာဗာပုံ၊ စာရေးသူ၊ အမည်၊ ဈေး၊ အကြိမ်၊ တိုက်) ပြသသည်။
