"""Telegram bot that searches Myanmar books by title or author.

Works in:
- private chats: any text message is a search
- groups:      messages that mention @<bot_username> are searches
- inline mode: @<bot_username> <query> anywhere shows inline results
"""

import logging
import os
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
    filters,
)

from books import BookStore, ImageCache

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

RESULTS_LIMIT = 10


def build_caption(book: dict) -> str:
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
    if book.get("description"):
        desc = book["description"]
        if len(desc) > 280:
            desc = desc[:280] + "…"
        lines.append(f"\n📝 အညွှန်း: {desc}")
    return "\n".join(lines)


def cover_url(book: dict) -> str:
    return f"https://drive.google.com/uc?export=view&id={book['image_id']}"


async def refresh_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        await store.load()
        log.info("Data refreshed: %d books", len(store.books))
    except Exception as exc:  # noqa: BLE001
        log.error("Data refresh failed: %s", exc)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    bot = context.bot.username
    await update.effective_message.reply_text(
        "👋 မင်္ဂလာပါ!\n\n"
        "စာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ထည့်ပြီး ရှာနိုင်ပါတယ်။\n"
        "Space ပါပါ၊ မပါပါ ရှာလို့ရပါတယ်။\n\n"
        "🔸 Private chat: နာမည်ရိုက်ရုံပါပဲ\n"
        f"🔸 Group: `@{bot} နာမည်` ဆိုပြီး mention လုပ်ပါ\n"
        f"🔸 Inline: ဘယ် chat မှာမဆို `@{bot} နာမည်` ရိုက်ပါ\n\n"
        "ဥပမာ - `မြစ်ရိုင်း`၊ `bro code`၊ `တင်မောင်မြင့်`"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start(update, context)


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    loaded = store.loaded_at.strftime("%Y-%m-%d %H:%M:%S") if store.loaded_at else "—"
    await update.effective_message.reply_text(
        f"📚 စုစုပေါင်း စာအုပ်: {len(store.books)} ခု\n"
        f"🔄 နောက်ဆုံး data ပြန်ဆွဲချိန်: {loaded} (UTC)"
    )


def _extract_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> str | None:
    """Return the search query, or None if this message should be ignored."""
    msg = update.effective_message
    text = (msg.text or "").strip()
    if not text:
        return None
    if msg.chat.type not in ("group", "supergroup"):
        return text
    # In groups only respond when the bot is mentioned.
    bot_mention = re.compile(r"@?" + re.escape(context.bot.username), re.IGNORECASE)
    if not bot_mention.search(text):
        return None
    query = re.sub(r"@[\w]+", " ", text, flags=re.IGNORECASE)
    query = re.sub(r"\b" + re.escape(context.bot.username) + r"\b", " ", query, flags=re.IGNORECASE)
    query = re.sub(r"\s+", " ", query).strip()
    return query or None


async def send_book_card(target, book: dict) -> None:
    caption = build_caption(book)
    path = await images.get(book["image_id"])
    if path:
        with open(path, "rb") as fh:
            await target.reply_photo(photo=fh, caption=caption)
    else:
        await target.reply_text(caption)


async def send_search_results(target, query: str, bot_username: str | None = None) -> None:
    results = store.search(query, limit=RESULTS_LIMIT)
    if not results:
        await target.reply_text(
            "😕 ဒီစာအုပ် (သို့) စာရေးသူ မတွေ့ပါဘူး။\n"
            "နာမည် အနည်းငယ်ပဲ ရိုက်ကြည့်ပါ။"
        )
        return
    if len(results) == 1:
        await send_book_card(target, results[0])
        return
    buttons = [
        [InlineKeyboardButton(f"📖 {b['title']} — {b['author']}", callback_data=f"book:{b['id']}")]
        for b in results
    ]
    await target.reply_text(
        f"🔍 `{query}` အတွက် စာအုပ် {len(results)} ခု တွေ့ပါတယ်။\n"
        "အပြည့်အစုံ ကြည့်ချင်တဲ့ စာအုပ်ကို ရွေးပါ 👇",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def handle_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = _extract_query(update, context)
    log.info(
        "Query from %s (chat %s): %r",
        update.effective_user.username if update.effective_user else "?",
        update.effective_chat.type if update.effective_chat else "?",
        query,
    )
    if query is None:
        if update.effective_message.chat.type in ("group", "supergroup"):
            await update.effective_message.reply_text(
                f"🤖 စာအုပ်နာမည် (သို့) စာရေးသူနာမည် ရိုက်ပြီး ရှာပါ။\n"
                f"ဥပမာ: @{context.bot.username} မြစ်ရိုင်း"
            )
        return
    await send_search_results(update.effective_message, query)


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cb = update.callback_query
    await cb.answer()
    if not cb.data or not cb.data.startswith("book:"):
        return
    book_id = int(cb.data.split(":", 1)[1])
    book = next((b for b in store.books if b["id"] == book_id), None)
    if not book:
        await cb.message.reply_text("စာအုပ် အချက်အလက် မရှိတော့ပါ။ ထပ်ရှာကြည့်ပါ။")
        return
    await send_book_card(cb.message, book)


async def inline_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = (update.inline_query.query or "").strip()
    log.info("Inline query from user %s: %r", update.inline_query.from_user.username, query)
    if not query:
        await update.inline_query.answer([], cache_time=5, is_personal=True)
        return
    results = store.search(query, limit=RESULTS_LIMIT)
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


async def post_init(application: Application) -> None:
    me = await application.bot.get_me()
    log.info("Bot started: @%s (%s)", me.username, me.first_name)
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
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(InlineQueryHandler(inline_query))
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
