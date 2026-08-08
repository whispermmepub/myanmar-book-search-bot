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

PAGE_SIZE = 10
RESULT_CAP = 100

IGNORED = object()  # message that should not trigger any bot reply


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
    sent = await update.effective_message.reply_text(
        f"📚 စုစုပေါင်း စာအုပ်: {len(store.books)} ခု\n"
        f"🔄 နောက်ဆုံး data ပြန်ဆွဲချိန်: {loaded} (UTC)\n"
        f"⏰ အလိုအလျောက် refresh: {REFRESH_HOURS:g} နာရီတစ်ခါ"
    )
    schedule_auto_delete(context, update.effective_message.chat, sent.message_id)


async def refresh_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if OWNER_ID and (not user or str(user.id) != str(OWNER_ID)):
        sent = await update.effective_message.reply_text("🔒 ဒီ command ကို bot ပိုင်ရှင်သာ သုံးနိုင်ပါတယ်။")
        schedule_auto_delete(context, update.effective_message.chat, sent.message_id)
        return
    sent = await update.effective_message.reply_text("🔄 စာအုပ်စာရင်း ပြန်ဆွဲနေပါတယ်…")
    schedule_auto_delete(context, update.effective_message.chat, sent.message_id)
    try:
        await store.load()
        loaded = store.loaded_at.strftime("%Y-%m-%d %H:%M:%S") if store.loaded_at else "—"
        result = f"✅ ပြီးပါပြီ — စာအုပ် {len(store.books)} ခု ရှိပါတယ်။ ({loaded} UTC)"
    except Exception as exc:  # noqa: BLE001
        result = f"❌ မအောင်မြင်ပါ: {exc}"
    try:
        await sent.edit_text(result)
    except Exception:  # noqa: BLE001
        await update.effective_message.reply_text(result)


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
    try:
        await context.bot.delete_message(chat_id=chat_id, message_id=message_id)
        log.info("Auto-deleted message %s in chat %s", message_id, chat_id)
    except Exception:  # noqa: BLE001
        pass  # already deleted or cannot be deleted


def schedule_auto_delete(context: ContextTypes.DEFAULT_TYPE, chat, message_id: int, delay: float = 300) -> None:
    """Delete a bot message after `delay` seconds, only in groups (not in DMs)."""
    if chat.type not in ("group", "supergroup"):
        return
    name = f"del:{chat.id}:{message_id}"
    for job in context.job_queue.get_jobs_by_name(name):
        job.schedule_removal()
    context.job_queue.run_once(delete_job, delay, data=(chat.id, message_id), name=name)


async def send_book_card(target, book: dict, context: ContextTypes.DEFAULT_TYPE | None = None, reply_markup=None):
    caption = build_caption(book)
    path = await images.get(book["image_id"])
    if path:
        with open(path, "rb") as fh:
            sent = await target.reply_photo(photo=fh, caption=caption, reply_markup=reply_markup)
    else:
        sent = await target.reply_text(caption, reply_markup=reply_markup)
    if context:
        schedule_auto_delete(context, target.chat, sent.message_id)
    return sent


def _page_count(total: int) -> int:
    return max(1, -(-total // PAGE_SIZE))


def _list_text(state: dict) -> str:
    total = len(state["results"])
    pages = _page_count(total)
    lines = [f"🔍 `{state['query']}` အတွက် စာအုပ် {total} ခု တွေ့ပါတယ်။"]
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
        schedule_auto_delete(context, target.chat, sent.message_id)
        return
    if len(results) == 1:
        await send_book_card(target, results[0], context=context)
        return
    state = {
        "query": query,
        "results": [b["id"] for b in results],
        "page": 0,
        "list_message_id": None,
    }
    context.user_data["search_state"] = state
    msg = await target.reply_text(_list_text(state), reply_markup=_list_keyboard(state))
    state["list_message_id"] = msg.message_id
    schedule_auto_delete(context, target.chat, msg.message_id)


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
    if query is None:
        sent = await update.effective_message.reply_text(
            f"🤖 စာအုပ်နာမည် (သို့) စာရေးသူနာမည် ရိုက်ပြီး ရှာပါ။\n"
            f"ဥပမာ: @{context.bot.username} မြစ်ရိုင်း"
        )
        schedule_auto_delete(context, update.effective_message.chat, sent.message_id)
        return
    await send_search_results(update.effective_message, query, context)


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cb = update.callback_query
    await cb.answer()
    data = cb.data or ""
    state = context.user_data.get("search_state")
    if data == "page:none":
        return
    if data in ("page:next", "page:prev"):
        if not state:
            sent = await cb.message.reply_text("🔍 ရှာဖွေမှု ပြန်လုပ်ပါ။")
            schedule_auto_delete(context, cb.message.chat, sent.message_id)
            return
        pages = _page_count(len(state["results"]))
        page = state["page"] + (1 if data == "page:next" else -1)
        state["page"] = max(0, min(pages - 1, page))
        await cb.message.edit_text(_list_text(state), reply_markup=_list_keyboard(state))
        schedule_auto_delete(context, cb.message.chat, cb.message.message_id)
        return
    if data == "page:back":
        if not state:
            sent = await cb.message.reply_text("🔍 ရှာဖွေမှု ပြန်လုပ်ပါ။")
            schedule_auto_delete(context, cb.message.chat, sent.message_id)
            return
        # remove the detail card so only the list remains visible
        card_id = state.get("card_message_id") or cb.message.message_id
        try:
            await context.bot.delete_message(chat_id=cb.message.chat_id, message_id=card_id)
        except Exception:  # noqa: BLE001
            pass
        state["card_message_id"] = None
        try:
            await context.bot.edit_message_text(
                _list_text(state),
                chat_id=cb.message.chat_id,
                message_id=state["list_message_id"],
                reply_markup=_list_keyboard(state),
            )
        except Exception:  # noqa: BLE001
            sent = await cb.message.reply_text(_list_text(state), reply_markup=_list_keyboard(state))
            schedule_auto_delete(context, cb.message.chat, sent.message_id)
            return
        schedule_auto_delete(context, cb.message.chat, state["list_message_id"])
        return
    if data.startswith("book:"):
        book_id = int(data.split(":", 1)[1])
        book = store.by_id(book_id)
        if not book:
            sent = await cb.message.reply_text("စာအုပ် အချက်အလက် မရှိတော့ပါ။ ထပ်ရှာကြည့်ပါ။")
            schedule_auto_delete(context, cb.message.chat, sent.message_id)
            return
        if state:
            old_card = state.get("card_message_id")
            if old_card:
                try:
                    await context.bot.delete_message(chat_id=cb.message.chat_id, message_id=old_card)
                except Exception:  # noqa: BLE001
                    pass
        back_kb = None
        if state:
            back_kb = InlineKeyboardMarkup(
                [[InlineKeyboardButton("📚 စာရင်းပြန်ကြည့်မယ်", callback_data="page:back")]]
            )
        sent = await send_book_card(cb.message, book, context=context, reply_markup=back_kb)
        if state:
            state["card_message_id"] = sent.message_id


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
    app.add_handler(CommandHandler("refresh", refresh_command))
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
