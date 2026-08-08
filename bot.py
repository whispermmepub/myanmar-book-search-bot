"""Telegram bot that searches Myanmar books by title or author."""

import asyncio
import logging
import os

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
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


async def refresh_loop() -> None:
    while True:
        try:
            await store.load()
            log.info("Data refreshed: %d books", len(store.books))
        except Exception as exc:  # noqa: BLE001
            log.error("Data refresh failed: %s", exc)
        await asyncio.sleep(REFRESH_HOURS * 3600)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        "👋 မင်္ဂလာပါ!\n\n"
        "စာအုပ်အမည် (သို့) စာရေးသူအမည် ရိုက်ထည့်ပြီး ရှာနိုင်ပါတယ်။\n"
        "Space ပါပါ၊ မပါပါ ရှာလို့ရပါတယ်။\n\n"
        "ဥပမာ - `မြစ်ရိုင်း`၊ `nyan lin`၊ `တင်မောင်မြင့်`"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start(update, context)


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    loaded = store.loaded_at.strftime("%Y-%m-%d %H:%M:%S") if store.loaded_at else "—"
    await update.effective_message.reply_text(
        f"📚 စုစုပေါင်း စာအုပ်: {len(store.books)} ခု\n"
        f"🔄 နောက်ဆုံး data ပြန်ဆွဲချိန်: {loaded} (UTC)"
    )


async def send_book_card(target, book: dict) -> None:
    caption = build_caption(book)
    path = await images.get(book["image_id"])
    if path:
        with open(path, "rb") as fh:
            await target.reply_photo(photo=fh, caption=caption)
    else:
        await target.reply_text(caption)


async def handle_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = (update.effective_message.text or "").strip()
    if not query:
        return
    results = store.search(query, limit=RESULTS_LIMIT)
    if not results:
        await update.effective_message.reply_text(
            "😕 ဒီစာအုပ် (သို့) စာရေးသူ မတွေ့ပါဘူး။\n"
            "နာမည် အနည်းငယ်ပဲ ရိုက်ကြည့်ပါ၊ ဥပမာ - `nyan lin`"
        )
        return
    if len(results) == 1:
        await send_book_card(update.effective_message, results[0])
        return
    buttons = [
        [InlineKeyboardButton(f"📖 {b['title']} — {b['author']}", callback_data=f"book:{b['id']}")]
        for b in results
    ]
    reply = await update.effective_message.reply_text(
        f"🔍 `{query}` အတွက် စာအုပ် {len(results)} ခု တွေ့ပါတယ်။\n"
        "အပြည့်အစုံ ကြည့်ချင်တဲ့ စာအုပ်ကို ရွေးပါ 👇",
        reply_markup=InlineKeyboardMarkup(buttons),
    )
    context.chat_data.setdefault("last_pick_message", []).append(reply.message_id)


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


async def post_init(application: Application) -> None:
    me = await application.bot.get_me()
    log.info("Bot started: @%s (%s)", me.username, me.first_name)
    if OWNER_ID:
        try:
            await application.bot.send_message(
                OWNER_ID, "✅ စာအုပ်ရှာဖွေရေး ဘော့စတင်ပါပြီ။ /start နဲ့ စတင်သုံးနိုင်ပါတယ်။"
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
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_query))
    return app

async def run() -> None:
    app = _build_app()
    asyncio.get_running_loop().create_task(refresh_loop())
    await app.run_polling(allowed_updates=Update.ALL_TYPES)


def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("TELEGRAM_BOT_TOKEN is required")
    asyncio.run(run())


if __name__ == "__main__":
    main()
