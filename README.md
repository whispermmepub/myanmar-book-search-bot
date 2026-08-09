# Myanmar Book Search Bot (Telegram)

Telegram bot ဖြင့် စာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ရှာနိုင်ပါသည်။ Space ပါပါ၊ မပါပါ ရှာနိုင်သည်။
ရလဒ်များတွင် စာအုပ်ကာဗာပုံ၊ စာရေးသူ၊ စာအုပ်အမည်၊ ဈေးနှုန်း၊ ထုတ်ဝေသည့်အကြိမ်၊ စာအုပ်တိုက်တို့ကို ပြသသည်။

Data source: [Google Sheets (Form responses)](https://docs.google.com/spreadsheets/d/18gpNdDNHztbkQE9rRvw6Y0rPqtKjrROJdy4HnZXqTQw/export?format=csv)
— form အသစ်များတင်တိုင်း bot သည် CSV ကို ပုံမှန် refresh လုပ်၍ အလိုအလျောက် အသစ်များပါဝင်သည်။

## Commands
- `/start` — စတင်အသုံးပြုနည်း
- `/stats` — စာအုပ်အရေအတွက်နှင့် နောက်ဆုံး refresh အချိန်
- `/usage` — သုံးစွဲသူအရေအတွက် (start လုပ်ထားသူ၊ ဒီနေ့/၇ရက် active၊ ရှာဖွေမှုအရေအတွက်) (owner)
- `/get <စာအုပ်နာမည် သို့မဟုတ် စာရေးသူ>` — group ထဲမှာ `@mention` မလိုဘဲ ရှာနိုင် (inline mode ဖွင့်ထားလို့ စာရိုက်မရတဲ့ group တွေအတွက်)
- `/refresh` — Google Sheet ကို ချက်ချင်းပြန်ဆွဲပြီး စာအုပ်အသစ်ရှိလျှင် group/DM အားလုံးကို အသိပေးရန် (owner)
- `/addpublisher <စာအုပ်တိုက်နာမည်> <link>` — စာအုပ်တိုက်ရဲ့ မှာယူရန် link ထည့်/ပြင်ရန် (owner) — ဥပမာ `/addpublisher နှစ်ကာလများ https://t.me/theerasbookpublishing`
- `/books` — စာအုပ်အားလုံး (စာမျက်နှာလိုက်) ကြည့်ရန်
- `/publishers` — စာအုပ်တိုက်အားလုံး (စာမျက်နှာလိုက်) ကြည့်ရန် — တိုက်နှိပ်လျှင် ထိုတိုက်၏ စာအုပ်များ ပြသည်
- အခြား message မှန်သမျှ — စာအုပ်/စာရေးသူ ရှာဖွေမှု (တစ်မျက်နှာလျှင် ၁၀ အုပ်၊ `နောက်မျက်နှာ ➡️` ဖြင့် ဆက်ကြည့်နိုင်၊ နာမည်နှိပ်လျှင် ကာဗာပုံ + အသေးစိတ် ပြသည်)
- Sheet ထဲတွင် စာလုံးပေါင်းကွဲနေသော စာအုပ်တိုက်အမည်များကို တစ်ခုတည်းအဖြစ် ပေါင်းပြသည် (ဥပမာ `ဆုပြည့်စုံထွန်း` → `ဆုပြည့်စုံထွန်းစာပေ`)
- စာအုပ်ကဒ် caption တွင် အညွှန်းကို မပြဘဲ အချက်အလက်များသာ ပြသည်။ အညွှန်းရှိသော စာအုပ်တိုင်းတွင် `📖 အညွှန်းဖတ်ရန်` ခလုတ်ပါပြီး နှိပ်မှသာ အညွှန်း (အပြည့်အစုံ) ကို သီးခြား message ဖြင့် ပြသည် (Group တွင် ၅ မိနစ်အကြာ auto-delete)။
- စာအုပ်ကဒ်ပေါ်က `🛒 စာအုပ်မှာရန်` ခလုတ်ကို နှိပ်လျှင် စာအုပ်တိုက်၏ မှာယူရန် link (Telegram Channel / Facebook Page စသည်) ကို တိုက်ရိုက်ဖွင့်ပေးပြီး ဝယ်သူက သူ့ဘာသာ မှာယူနိုင်သည်။

## Publisher channels (စာအုပ်မှာရန်)
- `publisher_channels.json` ထဲတွင် စာအုပ်တိုက်အမည် (sheet ထဲကအတိုင်း) နှင့် မှာယူရန် link (Telegram/Facebook မဆို) ကို ထည့်ပါ:
  ```json
  {
    "ဆုပြည့်စုံထွန်းစာပေ": "https://t.me/su_publisher",
    "Quality Publishing House": "quality_pub"
  }
  ```
- Full link (`https://t.me/...` သို့မဟုတ် invite link `https://t.me/+...`) ဖြစ်စေ၊ username (`channelname` သို့ `@channelname`) ဖြစ်စေ ထည့်နိုင်သည် — bot က link ပြန်ဖြောင့်ပေးပါသည်။
- Channel link မထည့်ရသေးသော စာအုပ်တိုက်များတွင် ခလုတ် မပေါ်ပါ။
- Owner သည် bot ထဲမှာပင် `/addpublisher <တိုက်နာမည်> <link>` ဖြင့် တိုက်၏ link ကို ချက်ချင်းထည့်/ပြင်နိုင်သည် (နာမည်ရှိပြီးသားဆိုရင် link update ဖြစ်သည်) — ဥပမာ `/addpublisher စာရိပ်မြိုင် စာပေ https://www.facebook.com/share/19MApsWDbJ/`။ ထည့်ပြီးသား link များကို Railway volume (`STATE_DIR/publisher_channels.json`) တွင် သိမ်းထားသောကြောင့် redeploy ပြုလုပ်ပါက မပျောက်ပါ။

## New-book notifications
- Bot သည် Google Sheet တွင် စာအုပ်အသစ်ပေါ်လာတိုင်း bot ပါဝင်နေသော group အားလုံး နှင့် subscriber DM များအားလုံးကို ကာဗာပုံ + အချက်အလက်များဖြင့် အလိုအလျောက် အသိပေးသည် (group များတွင် 5 မိနစ်အကြာတွင် ဖျက်သည်၊ DM တွင် မဖျက်ပါ)။
- DM အသိပေးချက်: bot ကို private chat တွင် `/start` သို့မဟုတ် စာတစ်စောင်ပို့လိုက်ပါက subscriber အဖြစ် အလိုအလျောက်ပါဝင်ပြီး စာအုပ်အသစ်တိုင်း DM ရောက်သည်။ `/unsubscribe` ဖြင့် ရပ်နိုင်သည်။
- Refresh: `REFRESH_HOURS` (Railway တွင် `1` = ၁ နာရီခြား auto refresh)။ Owner က `/refresh` ဖြင့် ချက်ချင်းလည်း စေနိုင်သည်။
- Env vars: `NOTIFY_GROUP_ID` (group chat id, optional), `NOTIFY_MAX_PER_REFRESH` (default 25).
- Owner test: `/demo` command ဖြင့် ရှိပြီးသားစာအုပ်တစ်အုပ်ကို "စာအုပ်အသစ်" ပုံစံဖြင့် စမ်းပို့ကြည့်နိုင်သည်။

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
| `STATE_DIR` | ❌ | `/tmp` | Durable state folder (Railway volume `/data`) — known books, subscribers, groups, publisher links, cover cache |
| `NOTIFY_GROUP_ID` | ❌ | — | ရှိပြီးသား group တစ်ခုအား အမြဲအသိပေးရန် ထည့်နိုင်သည် |
| `SHEET_CSV_URL` | ❌ | Google Sheets export URL | စာအုပ်စာရင်း CSV URL |

## Durable state (Railway volume)
- Railway ပေါ်တွင် volume `book-search-bot-volume` ကို `/data` တွင် mount ထားပြီး `STATE_DIR=/data`၊ `IMAGE_CACHE_DIR=/data/covers` ဟု သတ်မှတ်ထားသည်။
- သိမ်းဆည်းသည့်အရာများ: မြင်ဖူးပြီးသား စာအုပ်များ (`known_books.json` — new-book detection အတွက်)၊ subscribers (`subscribers.json`)၊ group စာရင်း (`bot_groups.json`)၊ publisher links (`publisher_channels.json` — `/addpublisher` ဖြင့် ထည့်သည်)၊ cover photo `file_id` cache (`book_file_ids.json`)။
- ဒါကြောင့် redeploy လုပ်ပါက စာအုပ်အသစ်များကို ထပ်မံ "အသစ်" ဟု မသတ်မှတ်တော့ပါ။

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
Group များတွင် bot ၏ reply message များကို ပြသပြီး ၅ မိနစ်အကြာတွင် auto-delete လုပ်သည် (DM တွင် မဖျက်ပါ)။
အချက်အလက် ပြည့်စုံသော စာအုပ်များသာ (ကာဗာပုံ၊ စာရေးသူ၊ အမည်၊ ဈေး၊ အကြိမ်၊ တိုက်) ပြသသည်။

## Fresh deploy on a new Railway account
Code, data source and cover images are all public — only the Telegram token is a secret.
1. In the new Railway account: **New Project → Deploy from GitHub repo** → `whispermmepub/myanmar-book-search-bot`.
2. Set service variables:
   - `TELEGRAM_BOT_TOKEN` = the same bot token (e.g. `8982557611:...`)
   - `TELEGRAM_OWNER_ID` = `7930855703` (optional, startup notification)
   - `REFRESH_HOURS` = `1` (optional; default 6)
3. Deploy and check logs for `Bot started: @saroatsarpay_bot` and `Loaded 547 books`.
4. **Stop/delete the old service or account first** — running two instances with the same bot token causes a `getUpdates` conflict.
5. After deploy the cover cache re-warms in ~5 minutes (ephemeral disk), then everything is fast again.
