"""Telegram bot that searches Myanmar books by title or author.

Works in:
- private chats: any text message is a search
- groups:      messages that mention @<bot_username> are searches
- inline mode: @<bot_username> <query> anywhere shows inline results
"""

import asyncio
import json
import logging
import os
import random
import re

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQueryResultPhoto,
    InputTextMessageContent,
    Update,
)
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    InlineQueryHandler,
    MessageHandler,
    ChatMemberHandler,
    filters,
)

from books import BookStore, ImageCache, canonical_publisher

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("bot")

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
OWNER_ID = os.environ.get("TELEGRAM_OWNER_ID", "")
REFRESH_HOURS = float(os.environ.get("REFRESH_HOURS", "6"))

store = BookStore()
images = ImageCache()

PAGE_SIZE = 10
RESULT_CAP = 100

IGNORED = object()  # message that should not trigger any bot reply

# Search state per list message, so that ANY member who taps a button
# gets the same list/back-button behaviour (not tied to one user).
SEARCH_STATES: dict[int, dict] = {}
# One lock per list message, so rapid taps can never show two cards at once.
SEARCH_LOCKS: dict[int, asyncio.Lock] = {}

# Full-description ("အညွှန်းဖတ်ရန်") views: card_message_id:book_id -> summary message id.
# Keyed by card message so each card has its own view, and taps on the same
# button replace the old summary instead of stacking duplicates.
SUMMARY_VIEWS: dict[str, int] = {}
SUMMARY_LOCKS: dict[str, asyncio.Lock] = {}

# Durable state directory (Railway volume /data). Falls back to /tmp, which is
# fine locally but is wiped on Railway deploys.
STATE_DIR = os.environ.get("STATE_DIR", "/tmp")
os.makedirs(STATE_DIR, exist_ok=True)

# Publisher name -> Telegram channel link. The "order this book" button opens
# this link. Loaded from the durable STATE_DIR copy (seeded from the repo file),
# and updated at runtime via /addpublisher.
REPO_PUBLISHER_CHANNELS_FILE = "publisher_channels.json"
PUBLISHER_CHANNELS_FILE = os.path.join(STATE_DIR, "publisher_channels.json")
publisher_channels: dict[str, str] = {}

# Telegram photo file_ids per cover, so repeat views need no download at all.
FILE_ID_STORE = os.path.join(STATE_DIR, "book_file_ids.json")
file_ids: dict[str, str] = {}

# Background cover prefetch, so the first tap on any book is already cached.
WARM_QUEUE: asyncio.Queue = asyncio.Queue()
WARM_SEEN: set[str] = set()


def load_file_ids() -> None:
    try:
        with open(FILE_ID_STORE, encoding="utf-8") as fh:
            file_ids.update(json.load(fh))
        log.info("Loaded %d cached file_ids", len(file_ids))
    except Exception:  # noqa: BLE001
        pass


def save_file_id(image_id: str, file_id: str) -> None:
    file_ids[image_id] = file_id
    try:
        with open(FILE_ID_STORE, "w", encoding="utf-8") as fh:
            json.dump(file_ids, fh)
    except Exception:  # noqa: BLE001
        pass


def load_publisher_channels() -> None:
    global publisher_channels
    if not os.path.exists(PUBLISHER_CHANNELS_FILE) and os.path.exists(REPO_PUBLISHER_CHANNELS_FILE):
        try:
            with open(REPO_PUBLISHER_CHANNELS_FILE, encoding="utf-8") as src:
                data = json.load(src)
            with open(PUBLISHER_CHANNELS_FILE, "w", encoding="utf-8") as dst:
                json.dump(data, dst, ensure_ascii=False, indent=2)
            log.info("Seeded publisher channels into %s", PUBLISHER_CHANNELS_FILE)
        except Exception:  # noqa: BLE001
            pass
    try:
        with open(PUBLISHER_CHANNELS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        publisher_channels = {k: v for k, v in data.items() if not k.startswith("_") and v}
        log.info("Loaded %d publisher channels", len(publisher_channels))
    except Exception:  # noqa: BLE001
        publisher_channels = {}


def save_publisher_channels() -> None:
    try:
        data = {
            "_comment": "Runtime-updated via /addpublisher. Deploy adds repo defaults if missing.",
            **publisher_channels,
        }
        with open(PUBLISHER_CHANNELS_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not save publisher channels: %s", exc)


def publisher_channel(book: dict) -> str | None:
    """Telegram channel link for the book's publisher, if configured."""
    name = (book.get("publisher") or "").strip()
    if not name:
        return None
    direct = publisher_channels.get(name)
    if direct:
        return _channel_link(direct)
    folded = name.replace("\u200b", "").casefold()
    for key, val in publisher_channels.items():
        if key.replace("\u200b", "").casefold() == folded:
            return _channel_link(val)
    canon = canonical_publisher(name)
    if canon != name:
        val = publisher_channels.get(canon)
        if val:
            return _channel_link(val)
    return None


def _channel_link(value: str) -> str:
    """Normalize a config value into a full https://t.me/... link."""
    value = value.strip()
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return "https://t.me/" + value.lstrip("@")


def _looks_like_link(value: str) -> bool:
    value = value.strip().lower()
    return value.startswith(("http://", "https://", "t.me/", "@"))


# Known books (dedupe keys) + notification subscribers, persisted to disk.
KNOWN_BOOKS_FILE = os.path.join(STATE_DIR, "known_books.json")
SUBSCRIBERS_FILE = os.path.join(STATE_DIR, "subscribers.json")
BOT_GROUPS_FILE = os.path.join(STATE_DIR, "bot_groups.json")
known_keys: set[tuple] = set()
subscribers: set[int] = set()
bot_groups: set[int] = set()
NOTIFY_GROUP_ID = os.environ.get("NOTIFY_GROUP_ID", "")
NOTIFY_MAX_PER_REFRESH = int(os.environ.get("NOTIFY_MAX_PER_REFRESH", "25"))

# chat_id -> last book id whose card was shown there (used by /addpublisher).
LAST_VIEWED: dict[int, int] = {}


def load_json_set(path: str) -> set:
    try:
        with open(path, encoding="utf-8") as fh:
            return {tuple(x) for x in json.load(fh)}
    except Exception:  # noqa: BLE001
        return set()


def save_json_set(path: str, items: set) -> None:
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump([list(x) for x in items], fh)
    except Exception:  # noqa: BLE001
        pass


def load_subscriber_ids() -> set[int]:
    try:
        with open(SUBSCRIBERS_FILE, encoding="utf-8") as fh:
            return {int(x) for x in json.load(fh)}
    except Exception:  # noqa: BLE001
        return set()


def save_subscriber_ids(items: set) -> None:
    try:
        with open(SUBSCRIBERS_FILE, "w", encoding="utf-8") as fh:
            json.dump(sorted(items), fh)
    except Exception:  # noqa: BLE001
        pass


def load_bot_groups() -> set[int]:
    try:
        with open(BOT_GROUPS_FILE, encoding="utf-8") as fh:
            return {int(x) for x in json.load(fh)}
    except Exception:  # noqa: BLE001
        return set()


def save_bot_groups(items: set) -> None:
    try:
        with open(BOT_GROUPS_FILE, "w", encoding="utf-8") as fh:
            json.dump(sorted(items), fh)
    except Exception:  # noqa: BLE001
        pass


def load_persisted_state() -> None:
    global known_keys, subscribers, bot_groups
    known_keys = load_json_set(KNOWN_BOOKS_FILE)
    subscribers = load_subscriber_ids()
    bot_groups = load_bot_groups()
    if NOTIFY_GROUP_ID:
        try:
            bot_groups.add(int(NOTIFY_GROUP_ID))
        except ValueError:
            pass
        save_bot_groups(bot_groups)
    log.info(
        "Known books: %d, subscribers: %d, groups: %d",
        len(known_keys),
        len(subscribers),
        len(bot_groups),
    )


def add_subscriber(chat_id: int) -> bool:
    if chat_id in subscribers:
        return False
    subscribers.add(chat_id)
    save_subscriber_ids(subscribers)
    return True


def remove_subscriber(chat_id: int) -> bool:
    if chat_id not in subscribers:
        return False
    subscribers.discard(chat_id)
    save_subscriber_ids(subscribers)
    return True


async def warm_worker() -> None:
    while True:
        image_id = await WARM_QUEUE.get()
        try:
            await images.get(image_id)
        except Exception:  # noqa: BLE001
            log.exception("Cover prefetch failed for %s", image_id)
        finally:
            WARM_QUEUE.task_done()


def enqueue_uncached_covers() -> None:
    for b in store.books:
        iid = b["image_id"]
        if iid in WARM_SEEN or images.exists(iid):
            continue
        WARM_SEEN.add(iid)
        WARM_QUEUE.put_nowait(iid)
    log.info("Cover prefetch queue size: %d", WARM_QUEUE.qsize())


def _caption_header(book: dict) -> list[str]:
    lines = [
        f"📖 စာအုပ်အမည်: {book['title']}",
        f"✍️ စာရေးသူ: {book['author']}",
        f"🏢 စာအုပ်တိုက်: {book['publisher']}",
        f"💰 ဈေးနှုန်း: {book['price']}",
        f"📚 ထုတ်ဝေသည့်အကြိမ်: {book['edition']}",
    ]
    if book.get("genre"):
        lines.append(f"🗂️ အမျိုးအစား: {book['genre']}")
    if book.get("month"):
        lines.append(f"📅 ထုတ်ဝေသည့်လ: {book['month']}")
    return lines


def build_caption(book: dict) -> str:
    """Caption shows only the essential book details; the description is shown
    on demand via the အညွှန်းဖတ်ရန် button so details stay prioritized."""
    return "\n".join(_caption_header(book))


def has_description(book: dict) -> bool:
    return bool((book.get("description") or "").strip())


def _card_keyboard(book: dict, back: bool = False) -> InlineKeyboardMarkup | None:
    """Buttons on a book card: full description (when available), order, back."""
    rows = []
    if has_description(book):
        rows.append([InlineKeyboardButton("📖 အညွှန်းဖတ်ရန်", callback_data=f"summary:{book['id']}")])
    channel = publisher_channel(book)
    if channel:
        rows.append([InlineKeyboardButton("🛒 စာအုပ်မှာရန်", url=channel)])
    if back:
        rows.append([InlineKeyboardButton("📚 စာရင်းပြန်ကြည့်မယ်", callback_data="page:back")])
    return InlineKeyboardMarkup(rows) if rows else None


def cover_url(book: dict) -> str:
    return f"https://drive.google.com/uc?export=view&id={book['image_id']}"


async def send_card_to_chat(
    bot,
    chat_id: int,
    book: dict,
    caption: str | None = None,
    reply_markup=None,
    context: ContextTypes.DEFAULT_TYPE | None = None,
):
    """Send a book card (photo + details) to an arbitrary chat id."""
    caption = caption or build_caption(book)
    markup = reply_markup if reply_markup is not None else _card_keyboard(book)
    image_id = book["image_id"]
    saved_file_id = file_ids.get(image_id)
    if saved_file_id:
        sent = await bot.send_photo(chat_id=chat_id, photo=saved_file_id, caption=caption, reply_markup=markup)
    else:
        path = await images.get(image_id)
        if path:
            with open(path, "rb") as fh:
                sent = await bot.send_photo(chat_id=chat_id, photo=fh, caption=caption, reply_markup=markup)
            if sent.photo:
                save_file_id(image_id, sent.photo[-1].file_id)
        else:
            sent = await bot.send_message(chat_id=chat_id, text=caption, reply_markup=markup)
    return sent


def new_book_caption(book: dict) -> str:
    return "🆕 စာအုပ်အသစ် ရောက်ရှိပါပြီ!\n\n" + build_caption(book)


async def announce_new_books(context: ContextTypes.DEFAULT_TYPE, books: list[dict]) -> None:
    for book in books[:NOTIFY_MAX_PER_REFRESH]:
        caption = new_book_caption(book)
        targets = []
        for gid in bot_groups:
            try:
                sent = await send_card_to_chat(context.bot, gid, book, caption=caption)
                schedule_auto_delete(context, sent.chat.id, sent.chat.type, sent.message_id)
                targets.append(f"group:{gid}")
            except Exception as exc:  # noqa: BLE001
                log.warning("Group announce to %s failed for %s: %s", gid, book["title"], exc)
        for uid in list(subscribers):
            try:
                await send_card_to_chat(context.bot, uid, book, caption=caption)
                targets.append(str(uid))
            except Exception as exc:  # noqa: BLE001
                log.warning("DM announce to %s failed for %s: %s", uid, book["title"], exc)
        log.info("Announced new book %r to %s", book["title"], ", ".join(targets) or "nobody")


async def _detect_and_announce_new_books(context: ContextTypes.DEFAULT_TYPE) -> list[dict]:
    """Find books not seen before, persist the seen set, and announce them."""
    new_books = []
    if known_keys:
        new_books = [b for b in store.books if (b["title_n"], b["author_n"]) not in known_keys]
    known_keys.update((b["title_n"], b["author_n"]) for b in store.books)
    save_json_set(KNOWN_BOOKS_FILE, known_keys)
    if new_books:
        log.info("New books detected: %d", len(new_books))
        await announce_new_books(context, new_books)
    return new_books


async def refresh_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        load_publisher_channels()
        await store.load()
        log.info("Data refreshed: %d books", len(store.books))
        enqueue_uncached_covers()
        await _detect_and_announce_new_books(context)
    except Exception as exc:  # noqa: BLE001
        log.error("Data refresh failed: %s", exc)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat and update.effective_chat.type == "private":
        add_subscriber(update.effective_chat.id)
    bot = context.bot.username
    await update.effective_message.reply_text(
        "👋 မင်္ဂလာပါ!\n\n"
        "စာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ထည့်ပြီး ရှာနိုင်ပါတယ်။\n"
        "Space ပါပါ၊ မပါပါ ရှာလို့ရပါတယ်။\n\n"
        "🔸 Private chat: နာမည်ရိုက်ရုံပါပဲ\n"
        f"🔸 Group: `@{bot} နာမည်` ဆိုပြီး mention လုပ်ပါ\n"
        f"🔸 Group (inline ဖွင့်ထားရင်): `/get နာမည်` ဆိုပြီး ရှာပါ\n"
        f"🔸 Inline: ဘယ် chat မှာမဆို `@{bot} နာမည်` ရိုက်ပါ\n\n"
        "📚 `/books` — စာအုပ်အားလုံး ကြည့်ရန်\n"
        "🏢 `/publishers` — စာအုပ်တိုက်အားလုံး ကြည့်ရန်\n"
        "🔄 `/refresh` — စာအုပ်အသစ် ချက်ချင်းစစ်ပြီး group/DM အသိပေးရန် (owner)\n"
        "🔗 `/addpublisher <တိုက်နာမည်> <လင့်>` — စာအုပ်တိုက်ရဲ့ မှာယူရန် link ထည့်/ပြင်ရန် (owner)\n\n"
        "ဥပမာ - `မြစ်ရိုင်း`၊ `bro code`၊ `တင်မောင်မြင့်`"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start(update, context)


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    loaded = store.loaded_at.strftime("%Y-%m-%d %H:%M:%S") if store.loaded_at else "—"
    sent = await update.effective_message.reply_text(
        f"📚 စုစုပေါင်း စာအုပ်: {len(store.books)} ခု\n"
        f"🔄 နောက်ဆုံး data ပြန်ဆွဲချိန်: {loaded} (UTC)\n"
        f"⏰ အလိုအလျောက် refresh: {REFRESH_HOURS:g} နာရီတစ်ခါ"
    )
    schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)


async def refresh_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if OWNER_ID and (not user or str(user.id) != str(OWNER_ID)):
        sent = await update.effective_message.reply_text("🔒 ဒီ command ကို bot ပိုင်ရှင်သာ သုံးနိုင်ပါတယ်။")
        schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)
        return
    sent = await update.effective_message.reply_text("🔄 စာအုပ်စာရင်း ပြန်ဆွဲနေပါတယ်…")
    schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)
    try:
        await store.load()
        loaded = store.loaded_at.strftime("%Y-%m-%d %H:%M:%S") if store.loaded_at else "—"
        new_books = await _detect_and_announce_new_books(context)
        result = f"✅ ပြီးပါပြီ — စာအုပ် {len(store.books)} ခု ရှိပါတယ်။ ({loaded} UTC)"
        if new_books:
            result += f"\n🆕 အသစ် {len(new_books)} အုပ် — group/DM မှာ အသိပေးလိုက်ပါပြီ။"
    except Exception as exc:  # noqa: BLE001
        result = f"❌ မအောင်မြင်ပါ: {exc}"
    try:
        await sent.edit_text(result)
    except Exception:  # noqa: BLE001
        await update.effective_message.reply_text(result)


async def get_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Search from a plain command so groups do not need @mention or inline."""
    query = " ".join(context.args or []).strip()
    if not query:
        sent = await update.effective_message.reply_text(
            "🔍 ဥပမာ: `/get မြစ်ရိုင်း` (သို့) `/get တင်မောင်မြင့်`"
        )
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    await send_search_results(update.effective_message, query, context)


async def addpublisher_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Owner-only: add/update a publisher order link by publisher name."""
    user = update.effective_user
    if OWNER_ID and (not user or str(user.id) != str(OWNER_ID)):
        sent = await update.effective_message.reply_text("🔒 ဒီ command ကို bot ပိုင်ရှင်သာ သုံးနိုင်ပါတယ်။")
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    args = context.args or []
    if not args:
        sent = await update.effective_message.reply_text(
            "ℹ️ ဥပမာ: `/addpublisher နှစ်ကာလများ https://t.me/theerasbookpublishing`\n"
            "စာအုပ်တိုက်နာမည် + လင့် ရိုက်ထည့်ပါ။ နာမည်ရှိပြီးသားဆိုရင် လင့်ကို update လုပ်ပေးပါမယ်။"
        )
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    name_parts: list[str] = []
    link = ""
    for part in args:
        if _looks_like_link(part):
            link = part
        else:
            name_parts.append(part)
    name = canonical_publisher(" ".join(name_parts).strip())
    if not link:
        sent = await update.effective_message.reply_text(
            "😕 လင့်မပါပါဘူး။\n"
            "ဥပမာ: `/addpublisher နှစ်ကာလများ https://t.me/theerasbookpublishing`"
        )
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    if not name:
        # Backwards-compat: link-only input uses the last card shown here.
        book_id = LAST_VIEWED.get(update.effective_chat.id)
        book = store.by_id(book_id) if book_id is not None else None
        if not book:
            sent = await update.effective_message.reply_text(
                "😕 စာအုပ်တိုက်နာမည် ပါအောင် ရိုက်ပါ။\n"
                "ဥပမာ: `/addpublisher နှစ်ကာလများ https://t.me/theerasbookpublishing`"
            )
            schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
            return
        name = canonical_publisher(book["publisher"])
    publisher_channels[name] = link
    save_publisher_channels()
    sent = await update.effective_message.reply_text(
        f"✅ `{name}` ရဲ့ မှာယူရန် link ထည့်/ပြင်ပြီးပါပြီ။\n"
        f"🔗 {_channel_link(link)}\n"
        "ဒီတိုက်ရဲ့ စာအုပ်ကဒ်တွေမှာ 🛒 စာအုပ်မှာရန် ခလုတ် ပေါ်ပါတော့မယ်။"
    )
    schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)


def _extract_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> str | None | object:
    """Return the search query.

    - IGNORED: message the bot should not react to at all (no mention in groups)
    - None:    the bot was addressed, but no query text was given
    - str:     the query to search for
    """
    msg = update.effective_message
    text = (msg.text or "").strip()
    if not text:
        return IGNORED
    if msg.chat.type not in ("group", "supergroup"):
        return text
    # In groups only respond when the bot is mentioned.
    bot_mention = re.compile(r"@?" + re.escape(context.bot.username), re.IGNORECASE)
    if not bot_mention.search(text):
        return IGNORED
    query = re.sub(r"@[\w]+", " ", text, flags=re.IGNORECASE)
    query = re.sub(r"\b" + re.escape(context.bot.username) + r"\b", " ", query, flags=re.IGNORECASE)
    query = re.sub(r"\s+", " ", query).strip()
    return query or None


async def delete_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id, message_id = context.job.data
    SEARCH_STATES.pop(message_id, None)
    SEARCH_LOCKS.pop(message_id, None)
    for s in list(SEARCH_STATES.values()):
        if s.get("card_message_id") == message_id:
            s["card_message_id"] = None
    prefix = f"{chat_id}:{message_id}:"
    for key in [k for k in SUMMARY_VIEWS if k.startswith(prefix) or SUMMARY_VIEWS.get(k) == message_id]:
        SUMMARY_VIEWS.pop(key, None)
        SUMMARY_LOCKS.pop(key, None)
    try:
        await context.bot.delete_message(chat_id=chat_id, message_id=message_id)
        log.info("Auto-deleted message %s in chat %s", message_id, chat_id)
    except Exception:  # noqa: BLE001
        pass  # already deleted or cannot be deleted


def schedule_auto_delete(context: ContextTypes.DEFAULT_TYPE, chat_id: int, chat_type: str, message_id: int, delay: float = 300) -> None:
    """Delete a bot message after `delay` seconds, only in groups (not in DMs)."""
    if chat_type not in ("group", "supergroup"):
        return
    name = f"del:{chat_id}:{message_id}"
    for job in context.job_queue.get_jobs_by_name(name):
        job.schedule_removal()
    context.job_queue.run_once(delete_job, delay, data=(chat_id, message_id), name=name)


async def send_book_card(target, book: dict, context: ContextTypes.DEFAULT_TYPE | None = None, include_back: bool = False):
    LAST_VIEWED[target.chat.id] = book["id"]
    caption = build_caption(book)
    markup = _card_keyboard(book, back=include_back)
    image_id = book["image_id"]
    saved_file_id = file_ids.get(image_id)
    if saved_file_id:
        sent = await target.reply_photo(photo=saved_file_id, caption=caption, reply_markup=markup)
    else:
        path = await images.get(image_id)
        if path:
            with open(path, "rb") as fh:
                sent = await target.reply_photo(photo=fh, caption=caption, reply_markup=markup)
            if sent.photo:
                save_file_id(image_id, sent.photo[-1].file_id)
        else:
            sent = await target.reply_text(caption, reply_markup=markup)
    if context:
        schedule_auto_delete(context, target.chat.id, target.chat.type, sent.message_id)
    return sent


def _page_count(total: int) -> int:
    return max(1, -(-total // PAGE_SIZE))


def _list_text(state: dict) -> str:
    total = len(state["results"])
    pages = _page_count(total)
    mode = state.get("mode")
    if mode == "allbooks":
        head = f"📚 စာအုပ်အားလုံး — စုစုပေါင်း {total} ခု"
    elif mode == "pubbooks":
        head = f"🏢 `{state['query']}` တိုက်ရဲ့ စာအုပ် {total} ခု"
    else:
        head = f"🔍 `{state['query']}` အတွက် စာအုပ် {total} ခု တွေ့ပါတယ်။"
    lines = [head]
    if pages > 1:
        lines.append(f"📄 မျက်နှာ {state['page'] + 1}/{pages}")
    lines.append("\nကြည့်ချင်တဲ့ စာအုပ်ကို ရွေးပါ 👇")
    return "\n".join(lines)


def _list_keyboard(state: dict) -> InlineKeyboardMarkup:
    ids = state["results"]
    total = len(ids)
    pages = _page_count(total)
    start = state["page"] * PAGE_SIZE
    chunk = ids[start : start + PAGE_SIZE]
    books = [b for i in chunk if (b := store.by_id(i))]
    buttons = [
        [InlineKeyboardButton(f"📖 {b['title']} — {b['author']}", callback_data=f"book:{b['id']}")]
        for b in books
    ]
    nav = []
    if state["page"] > 0:
        nav.append(InlineKeyboardButton("⬅️ ရှေ့မျက်နှာ", callback_data="page:prev"))
    nav.append(InlineKeyboardButton(f"📄 {state['page'] + 1}/{pages}", callback_data="page:none"))
    if state["page"] < pages - 1:
        nav.append(InlineKeyboardButton("နောက်မျက်နှာ ➡️", callback_data="page:next"))
    if nav:
        buttons.append(nav)
    return InlineKeyboardMarkup(buttons)


async def send_search_results(target, query: str, context: ContextTypes.DEFAULT_TYPE) -> None:
    results = store.search(query, limit=RESULT_CAP)
    if not results:
        sent = await target.reply_text(
            "😕 ဒီစာအုပ် (သို့) စာရေးသူ မတွေ့ပါဘူး။\n"
            "နာမည် အနည်းငယ်ပဲ ရိုက်ကြည့်ပါ။"
        )
        schedule_auto_delete(context, target.chat.id, target.chat.type, sent.message_id)
        return
    state = {
        "query": query,
        "results": [b["id"] for b in results],
        "page": 0,
        "list_message_id": None,
    }
    msg = await target.reply_text(_list_text(state), reply_markup=_list_keyboard(state))
    state["list_message_id"] = msg.message_id
    SEARCH_STATES[msg.message_id] = state
    if len(SEARCH_STATES) > 500:
        for mid in list(SEARCH_STATES)[: len(SEARCH_STATES) - 500]:
            SEARCH_STATES.pop(mid, None)
            SEARCH_LOCKS.pop(mid, None)
    schedule_auto_delete(context, target.chat.id, target.chat.type, msg.message_id)


def _publisher_list() -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for b in store.books:
        p = b["publisher"]
        counts[p] = counts.get(p, 0) + 1
    return sorted(counts.items(), key=lambda x: (-x[1], x[0].casefold()))


def _publisher_list_text(state: dict) -> str:
    total = len(state["publishers"])
    pages = _page_count(total)
    lines = [f"🏢 စာအုပ်တိုက် စုစုပေါင်း {total} ခု"]
    if pages > 1:
        lines.append(f"📄 မျက်နှာ {state['page'] + 1}/{pages}")
    lines.append("\nကြည့်ချင်တဲ့ တိုက်ကို ရွေးပါ 👇")
    return "\n".join(lines)


def _publisher_list_keyboard(state: dict) -> InlineKeyboardMarkup:
    total = len(state["publishers"])
    pages = _page_count(total)
    start = state["page"] * PAGE_SIZE
    chunk = state["publishers"][start : start + PAGE_SIZE]
    buttons = [
        [InlineKeyboardButton(f"🏢 {name} ({count})", callback_data=f"pub:{start + i}")]
        for i, (name, count) in enumerate(chunk)
    ]
    nav = []
    if state["page"] > 0:
        nav.append(InlineKeyboardButton("⬅️ ရှေ့မျက်နှာ", callback_data="page:prev"))
    nav.append(InlineKeyboardButton(f"📄 {state['page'] + 1}/{pages}", callback_data="page:none"))
    if state["page"] < pages - 1:
        nav.append(InlineKeyboardButton("နောက်မျက်နှာ ➡️", callback_data="page:next"))
    if nav:
        buttons.append(nav)
    return InlineKeyboardMarkup(buttons)


def _store_state(state: dict, msg) -> None:
    state["list_message_id"] = msg.message_id
    SEARCH_STATES[msg.message_id] = state
    if len(SEARCH_STATES) > 500:
        for mid in list(SEARCH_STATES)[: len(SEARCH_STATES) - 500]:
            SEARCH_STATES.pop(mid, None)
            SEARCH_LOCKS.pop(mid, None)


async def all_books_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not store.books:
        sent = await update.effective_message.reply_text("📭 စာအုပ် အချက်အလက် မရသေးပါ။")
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    state = {
        "mode": "allbooks",
        "query": "စာအုပ်အားလုံး",
        "results": [b["id"] for b in store.books],
        "page": 0,
        "list_message_id": None,
    }
    msg = await update.effective_message.reply_text(_list_text(state), reply_markup=_list_keyboard(state))
    _store_state(state, msg)
    schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, msg.message_id)


async def publishers_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    pubs = _publisher_list()
    if not pubs:
        sent = await update.effective_message.reply_text("📭 စာအုပ် အချက်အလက် မရသေးပါ။")
        schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, sent.message_id)
        return
    state = {"mode": "publishers", "publishers": pubs, "page": 0, "list_message_id": None}
    msg = await update.effective_message.reply_text(_publisher_list_text(state), reply_markup=_publisher_list_keyboard(state))
    _store_state(state, msg)
    schedule_auto_delete(context, update.effective_chat.id, update.effective_chat.type, msg.message_id)


async def handle_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = _extract_query(update, context)
    if query is IGNORED:
        return
    log.info(
        "Query from %s (chat %s): %r",
        update.effective_user.username if update.effective_user else "?",
        update.effective_chat.type if update.effective_chat else "?",
        query,
    )
    if update.effective_chat and update.effective_chat.type == "private":
        add_subscriber(update.effective_chat.id)
    if query is None:
        sent = await update.effective_message.reply_text(
            f"🤖 စာအုပ်နာမည် (သို့) စာရေးသူနာမည် ရိုက်ပြီး ရှာပါ။\n"
            f"ဥပမာ: @{context.bot.username} မြစ်ရိုင်း"
        )
        schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)
        return
    await send_search_results(update.effective_message, query, context)


async def handle_my_chat_member(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Remember every group the bot is a member of, so new books can be
    announced there. Group ids persist in the durable state dir."""
    mc = update.my_chat_member
    if not mc or mc.chat.type not in ("group", "supergroup"):
        return
    status = mc.new_chat_member.status
    if status in ("member", "administrator"):
        bot_groups.add(mc.chat.id)
        save_bot_groups(bot_groups)
        log.info("Added bot to group %s", mc.chat.id)
    elif status in ("left", "kicked"):
        bot_groups.discard(mc.chat.id)
        save_bot_groups(bot_groups)
        log.info("Bot removed from group %s", mc.chat.id)


async def _delete_card_summaries(context: ContextTypes.DEFAULT_TYPE, chat_id: int, card_message_id: int) -> None:
    """Delete any full-description messages tied to a card that is being removed."""
    prefix = f"{chat_id}:{card_message_id}:"
    for key in [k for k in SUMMARY_VIEWS if k.startswith(prefix)]:
        mid = SUMMARY_VIEWS.pop(key, None)
        SUMMARY_LOCKS.pop(key, None)
        if mid:
            try:
                await context.bot.delete_message(chat_id=chat_id, message_id=mid)
            except Exception:  # noqa: BLE001
                pass


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cb = update.callback_query
    await cb.answer()
    data = cb.data or ""
    state = SEARCH_STATES.get(cb.message.message_id if cb.message else None) or next(
        (s for s in SEARCH_STATES.values() if s.get("card_message_id") == cb.message.message_id),
        None,
    )
    if data == "page:none":
        return
    if data in ("page:next", "page:prev"):
        if not state:
            sent = await cb.message.reply_text("🔍 ရှာဖွေမှု ပြန်လုပ်ပါ။")
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            return
        page = state["page"] + (1 if data == "page:next" else -1)
        if state.get("mode") == "publishers":
            pages = _page_count(len(state["publishers"]))
            state["page"] = max(0, min(pages - 1, page))
            await cb.message.edit_text(_publisher_list_text(state), reply_markup=_publisher_list_keyboard(state))
        else:
            pages = _page_count(len(state["results"]))
            state["page"] = max(0, min(pages - 1, page))
            await cb.message.edit_text(_list_text(state), reply_markup=_list_keyboard(state))
        schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, cb.message.message_id)
        return
    if data.startswith("pub:"):
        state = SEARCH_STATES.get(cb.message.message_id if cb.message else None)
        if not state or state.get("mode") != "publishers":
            sent = await cb.message.reply_text("🔍 ပြန်လုပ်ပါ — /publishers")
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            return
        idx = int(data.split(":", 1)[1])
        if idx < 0 or idx >= len(state["publishers"]):
            return
        name, _ = state["publishers"][idx]
        books = [b for b in store.books if b["publisher"] == name]
        if not books:
            await cb.answer("😕 စာအုပ် မရှိပါ။")
            return
        book_state = {
            "mode": "pubbooks",
            "query": name,
            "results": [b["id"] for b in books],
            "page": 0,
            "list_message_id": None,
        }
        msg = await cb.message.reply_text(_list_text(book_state), reply_markup=_list_keyboard(book_state))
        _store_state(book_state, msg)
        schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, msg.message_id)
        return
    if data == "page:back":
        if not state:
            # The tap may come from a summary message tied to a card of a list.
            for key, value in SUMMARY_VIEWS.items():
                if value == cb.message.message_id:
                    card_id = int(key.split(":")[1])
                    state = next(
                        (s for s in SEARCH_STATES.values() if s.get("card_message_id") == card_id),
                        None,
                    )
                    break
        if not state:
            sent = await cb.message.reply_text("🔍 ရှာဖွေမှု ပြန်လုပ်ပါ။")
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            return
        # remove the detail card so only the list remains visible
        card_id = state.get("card_message_id") or cb.message.message_id
        await _delete_card_summaries(context, cb.message.chat_id, card_id)
        try:
            await context.bot.delete_message(chat_id=cb.message.chat_id, message_id=card_id)
        except Exception:  # noqa: BLE001
            pass
        state["card_message_id"] = None
        state["current_book_id"] = None
        try:
            await context.bot.edit_message_text(
                _list_text(state),
                chat_id=cb.message.chat_id,
                message_id=state["list_message_id"],
                reply_markup=_list_keyboard(state),
            )
        except Exception as exc:  # noqa: BLE001
            if "not modified" not in str(exc).lower():
                sent = await cb.message.reply_text(_list_text(state), reply_markup=_list_keyboard(state))
                schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
                return
        schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, state["list_message_id"])
        return
    if data.startswith("book:"):
        book_id = int(data.split(":", 1)[1])
        book = store.by_id(book_id)
        if not book:
            sent = await cb.message.reply_text("စာအုပ် အချက်အလက် မရှိတော့ပါ။ ထပ်ရှာကြည့်ပါ။")
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            return
        if not state:
            await send_book_card(cb.message, book, context=context)
            return
        # Serialize taps on this list so a double-tap can never show two cards.
        lock = SEARCH_LOCKS.setdefault(cb.message.message_id, asyncio.Lock())
        async with lock:
            state = SEARCH_STATES.get(cb.message.message_id) or state
            if not state:
                await send_book_card(cb.message, book, context=context)
                return
            # Already showing this exact book? Nothing to do (avoids duplicates).
            if state.get("current_book_id") == book_id:
                return
            # Remove the previously shown card right away.
            old_card = state.get("card_message_id")
            if old_card:
                await _delete_card_summaries(context, cb.message.chat_id, old_card)
                try:
                    await context.bot.delete_message(chat_id=cb.message.chat_id, message_id=old_card)
                except Exception:  # noqa: BLE001
                    pass
                state["card_message_id"] = None
            sent = await send_book_card(cb.message, book, context=context, include_back=True)
            state["card_message_id"] = sent.message_id
            state["current_book_id"] = book_id
        return
    if data.startswith("summary:"):
        book_id = int(data.split(":", 1)[1])
        book = store.by_id(book_id)
        if not book:
            sent = await cb.message.reply_text("စာအုပ် အချက်အလက် မရှိတော့ပါ။")
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            return
        desc = (book.get("description") or "").strip()
        if not desc:
            await cb.answer("📖 ဒီစာအုပ်မှာ အညွှန်း မရှိပါ။")
            return
        key = f"{cb.message.chat_id}:{cb.message.message_id}:{book_id}"
        lock = SUMMARY_LOCKS.setdefault(key, asyncio.Lock())
        async with lock:
            # A repeated tap replaces the old summary instead of stacking duplicates.
            old = SUMMARY_VIEWS.pop(key, None)
            if old:
                try:
                    await context.bot.delete_message(chat_id=cb.message.chat_id, message_id=old)
                except Exception:  # noqa: BLE001
                    pass
            text = (
                f"📖 စာအုပ်အမည်: {book['title']}\n"
                f"✍️ စာရေးသူ: {book['author']}\n\n"
                f"📝 အညွှန်း (အပြည့်အစုံ):\n\n{desc}"
            )
            markup = None
            if any(s.get("card_message_id") == cb.message.message_id for s in SEARCH_STATES.values()):
                markup = InlineKeyboardMarkup(
                    [[InlineKeyboardButton("📚 စာရင်းပြန်ကြည့်မယ်", callback_data="page:back")]]
                )
            sent = await cb.message.reply_text(text, reply_markup=markup)
            SUMMARY_VIEWS[key] = sent.message_id
            schedule_auto_delete(context, cb.message.chat.id, cb.message.chat.type, sent.message_id)
            if len(SUMMARY_VIEWS) > 1000:
                for old_key in list(SUMMARY_VIEWS)[: len(SUMMARY_VIEWS) - 1000]:
                    SUMMARY_VIEWS.pop(old_key, None)
                    SUMMARY_LOCKS.pop(old_key, None)
        return


async def inline_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = (update.inline_query.query or "").strip()
    log.info("Inline query from user %s: %r", update.inline_query.from_user.username, query)
    if not query:
        await update.inline_query.answer([], cache_time=5, is_personal=True)
        return
    results = store.search(query, limit=RESULT_CAP)
    items = []
    for b in results:
        url = cover_url(b)
        caption = build_caption(b)
        items.append(
            InlineQueryResultPhoto(
                id=str(b["id"]),
                photo_url=url,
                thumbnail_url=url,
                title=b["title"],
                description=f"{b['author']} • {b['publisher']} • {b['price']}",
                caption=caption,
                input_message_content=InputTextMessageContent(caption),
            )
        )
    await update.inline_query.answer(items, cache_time=300, is_personal=True)


async def subscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    if chat and chat.type == "private":
        added = add_subscriber(chat.id)
        sent = await update.effective_message.reply_text(
            "✅ စာအုပ်အသစ် ရောက်လာတိုင်း ဒီ DM ထဲ အသိပေးပါမယ်။\n"
            "ရပ်ချင်ရင် /unsubscribe ရိုက်ပါ။"
            if added
            else "🔔 အသိပေးချက် ရပြီးသား ဖြစ်နေပါပြီ။"
        )
    else:
        sent = await update.effective_message.reply_text("ℹ️ ဒီ command ကို bot ရဲ့ DM မှာသာ သုံးလို့ရပါတယ်။")
    schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)


async def unsubscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    if chat and chat.type == "private":
        removed = remove_subscriber(chat.id)
        sent = await update.effective_message.reply_text(
            "🔕 အသိပေးချက် ရပ်လိုက်ပါပြီ။"
            if removed
            else "ℹ️ သင်က အသိပေးချက် မရထားပါဘူး။"
        )
    else:
        sent = await update.effective_message.reply_text("ℹ️ ဒီ command ကို bot ရဲ့ DM မှာသာ သုံးလို့ရပါတယ်။")
    schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)


async def demo_notify(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Owner-only: send one existing book formatted like a new-book announcement."""
    user = update.effective_user
    if OWNER_ID and (not user or str(user.id) != str(OWNER_ID)):
        sent = await update.effective_message.reply_text("🔒 ဒီ command ကို bot ပိုင်ရှင်သာ သုံးနိုင်ပါတယ်။")
        schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)
        return
    if not store.books:
        sent = await update.effective_message.reply_text("📭 စာအုပ် အချက်အလက် မရသေးပါ။")
        schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, sent.message_id)
        return
    book = random.choice(store.books)
    caption = new_book_caption(book)
    done = []
    for gid in bot_groups:
        try:
            sent = await send_card_to_chat(context.bot, gid, book, caption=caption)
            schedule_auto_delete(context, sent.chat.id, sent.chat.type, sent.message_id)
            done.append(f"group:{gid}")
        except Exception as exc:  # noqa: BLE001
            log.warning("Demo group send to %s failed: %s", gid, exc)
    sent = await send_card_to_chat(context.bot, update.effective_chat.id, book, caption=caption)
    done.append("DM")
    reply = await update.effective_message.reply_text(
        f"✅ Demo ပို့ပြီးပါပြီ → {', '.join(done)}\n"
        f"စာအုပ်: {book['title']} ({book['author']})"
    )
    schedule_auto_delete(context, update.effective_message.chat.id, update.effective_message.chat.type, reply.message_id)


async def post_init(application: Application) -> None:
    me = await application.bot.get_me()
    log.info("Bot started: @%s (%s)", me.username, me.first_name)
    load_persisted_state()
    load_file_ids()
    load_publisher_channels()
    for _ in range(4):
        application.create_task(warm_worker())
    if OWNER_ID:
        try:
            await application.bot.send_message(
                OWNER_ID,
                "✅ စာအုပ်ရှာဖွေရေး ဘော့စတင်ပါပြီ။ /start နဲ့ စတင်သုံးနိုင်ပါတယ်။\n"
                "Group မှာ သုံးရန် bot ကို admin တင်ပြီး `@botusername နာမည်` ရိုက်ပါ။",
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not notify owner: %s", exc)


def _build_app() -> Application:
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .concurrent_updates(True)
        .build()
    )
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("stats", stats))
    app.add_handler(CommandHandler("refresh", refresh_command))
    app.add_handler(CommandHandler("subscribe", subscribe))
    app.add_handler(CommandHandler("unsubscribe", unsubscribe))
    app.add_handler(CommandHandler("demo", demo_notify))
    app.add_handler(CommandHandler("books", all_books_command))
    app.add_handler(CommandHandler("publishers", publishers_command))
    app.add_handler(CommandHandler("get", get_command))
    app.add_handler(CommandHandler("addpublisher", addpublisher_command))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(InlineQueryHandler(inline_query))
    app.add_handler(ChatMemberHandler(handle_my_chat_member, chat_member_types=ChatMemberHandler.MY_CHAT_MEMBER))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_query))
    return app


def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("TELEGRAM_BOT_TOKEN is required")
    app = _build_app()
    app.job_queue.run_repeating(refresh_job, interval=REFRESH_HOURS * 3600, first=5)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
