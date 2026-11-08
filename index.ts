import { Bot, InlineKeyboard } from "grammy";
import { createClient } from "redis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const token = process.env.BOT_TOKEN;

if (!token) {
    throw new Error("BOT_TOKEN is not set");
}

export const bot = new Bot(token);

const OWNER_ID = Number(process.env.OWNER_ID) || 6669591153;

const disabledWelcomeChats = new Set<number>();
const prefixes = new Map<number, string>();

const RATE_REQUEST = {
    pCurr: "NPR",
    pCountryName: "Nepal",
    deliveryMethod: "2"
};

const DEFAULT_AMOUNT = "100000";

const RATE_INTERVAL_MS = 60 * 60 * 1000;

type ExchangeRate = {
    errorCode: string;
    msg: string;
    collAmt: string;
    pAmt: string;
    exRateDisplay: string;
    scCharge: string;
    collCurncy: string;
    pCurr: string;
};

async function fetchExchangeRate(
    amount: string = DEFAULT_AMOUNT,
    currency: "npr" | "krw" = "npr"
): Promise<ExchangeRate> {
    const byKrw = currency === "krw";

    const res = await fetch("https://www.gmeremit.com/api/exchange-rate", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: "https://www.gmeremit.com",
            referer: `https://www.gmeremit.com/country/${RATE_REQUEST.pCountryName}`,
            "user-agent": "Mozilla/5.0"
        },
        body: JSON.stringify(
            byKrw
                ? { ...RATE_REQUEST, calBy: "c", cAmt: amount }
                : { ...RATE_REQUEST, calBy: "p", pAmt: amount }
        )
    });

    if (!res.ok) {
        throw new Error(`GME rate API responded ${res.status}`);
    }

    const data = (await res.json()) as ExchangeRate;

    if (data.errorCode !== "0") {
        throw new Error(
            data.msg || `GME rate API error (${data.errorCode})`
        );
    }

    return data;
}

const redis = process.env.REDIS_URL
    ? createClient({ url: process.env.REDIS_URL })
    : null;

if (redis) {
    redis.on("error", (error) => {
        console.error("Redis error:", error);
    });
}

let redisConnecting: Promise<unknown> | null = null;

async function storeExchangeRate(rate: ExchangeRate): Promise<void> {
    if (!redis) {
        return;
    }

    try {
        if (!redis.isOpen) {
            redisConnecting ??= redis.connect().finally(() => {
                redisConnecting = null;
            });
        }

        await redisConnecting;

        await redis.lPush(
            "gme:rate:history",
            JSON.stringify({
                ...rate,
                storedAt: new Date().toISOString()
            })
        );
        await redis.lTrim("gme:rate:history", 0, 999);
    } catch (error) {
        console.error("Failed to store exchange rate:", error);
    }
}

function formatExchangeRate(rate: ExchangeRate): string {
    return (
        `💱 <b>GME Remit rate</b>\n\n` +
        `🎯 To receive: <b>${rate.pCurr} ${rate.pAmt}</b>\n` +
        `💸 You send: <b>${rate.collCurncy} ${rate.collAmt}</b>\n` +
        `📈 Rate: 1 ${rate.collCurncy} = ${rate.exRateDisplay} ${rate.pCurr}\n` +
        `🧾 Fee: ${rate.collCurncy} ${rate.scCharge}\n` +
        `📨 API: ${rate.msg}\n\n` +
        `🕒 <i>${new Date().toLocaleString()}</i>`
    );
}

async function sendHourlyRate(): Promise<void> {
    try {
        const rate = await fetchExchangeRate();

        await storeExchangeRate(rate);

        await bot.api.sendMessage(
            OWNER_ID,
            formatExchangeRate(rate),
            { parse_mode: "HTML" }
        );
    } catch (error) {
        console.error("Hourly rate update failed:", error);

        const message =
            error instanceof Error ? error.message : "Unknown error";

        await bot.api
            .sendMessage(OWNER_ID, `⚠️ Hourly rate failed: ${message}`)
            .catch(() => {});

        if (
            error instanceof Error &&
            error.message.includes("chat not found")
        ) {
            console.error(
                `Hint: ${OWNER_ID} has not started the bot yet ` +
                `(or OWNER_ID is wrong). Open the bot, press Start, ` +
                `and check your ID with /myid.`
            );
        }
    }
}

function getPrefix(chatId: number): string {
    return prefixes.get(chatId) ?? "/";
}

function isOwner(ctx: any): boolean {
    return ctx.from?.id === OWNER_ID;
}

function getHelpMessage(prefix: string): string {
    return (
        `🤖 <b>Welcomer Bot</b>\n\n` +
        `Current prefix: <code>${prefix}</code>\n\n` +
        `<b>Commands</b>\n` +
        `<code>${prefix}start</code> - Show this message\n` +
        `<code>${prefix}myid</code> - Show your Telegram ID\n` +
        `<code>${prefix}rate</code> - Show the current exchange rate\n` +
        `<code>${prefix}ex 50000</code> - NPR amount → KRW\n` +
        `<code>${prefix}ex krw 100000</code> - KRW amount → NPR\n` +
        `<code>${prefix}welcome on/off</code> - Enable or disable welcomes\n` +
        `<code>${prefix}setprefix !</code> - Change the command prefix`
    );
}

function getOrdinal(number: number): string {
    const rules = new Intl.PluralRules("en-US", {
        type: "ordinal"
    });

    const suffixes: Record<string, string> = {
        one: "st",
        two: "nd",
        few: "rd",
        other: "th"
    };

    return `${number}${suffixes[rules.select(number)]}`;
}

function sendUserId(ctx: any) {
    const id = ctx.from?.id;
    const name = ctx.from?.first_name ?? "there";

    return ctx.reply(
        `🪪 Hey <b>${name}</b>, your Telegram User ID is:\n\n` +
        `<code>${id}</code>\n\n` +
        `Tap the number above to copy it.`,
        { parse_mode: "HTML" }
    );
}

bot.command("start", (ctx) => {
    return ctx.reply(getHelpMessage(getPrefix(ctx.chat.id)), {
        parse_mode: "HTML"
    });
});

bot.command("myid", (ctx) => {
    return sendUserId(ctx);
});

async function replyExchangeRate(
    ctx: any,
    amount?: string,
    currency: "npr" | "krw" = "npr"
) {
    try {
        const rate = await fetchExchangeRate(amount, currency);

        return ctx.reply(formatExchangeRate(rate), {
            parse_mode: "HTML"
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";

        return ctx.reply(`⚠️ ${message}`);
    }
}

function parseAmount(input: string): number | null {
    const amount = Number(input.replace(/,/g, ""));

    return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function replyExchangeForAmount(ctx: any, input: string) {
    const prefix = getPrefix(ctx.chat.id);

    const parts = input.split(/\s+/).filter(Boolean);
    const first = parts[0]?.toLowerCase();
    const byKrw = first === "krw";
    const hasCurrency = byKrw || first === "npr";
    const amountInput = hasCurrency ? parts.slice(1).join("") : input;

    if (!amountInput) {
        return ctx.reply(
            `Usage:\n` +
            `<code>${prefix}ex 50000</code> - NPR amount → KRW\n` +
            `<code>${prefix}ex krw 100000</code> - KRW amount → NPR`,
            { parse_mode: "HTML" }
        );
    }

    const amount = parseAmount(amountInput);

    if (amount === null) {
        return ctx.reply(
            "⚠️ Please provide a valid positive amount.\n" +
            `Example: <code>${prefix}ex krw 100000</code>`,
            { parse_mode: "HTML" }
        );
    }

    return replyExchangeRate(
        ctx,
        String(amount),
        byKrw ? "krw" : "npr"
    );
}

bot.command("rate", (ctx) => replyExchangeRate(ctx));

bot.command("ex", (ctx) => {
    return replyExchangeForAmount(ctx, ctx.match.trim());
});

bot.command("welcome", (ctx) => {
    if (ctx.chat.type === "private") {
        return ctx.reply("⚠️ This command only works in groups.");
    }

    if (!isOwner(ctx)) {
        return ctx.reply("🚫 Only the bot owner can use this command.");
    }

    const chatId = ctx.chat.id;
    const action = ctx.match.trim().toLowerCase();

    if (action === "on") {
        disabledWelcomeChats.delete(chatId);

        return ctx.reply(
            "✅ Welcome messages are now <b>enabled</b>.",
            { parse_mode: "HTML" }
        );
    }

    if (action === "off") {
        disabledWelcomeChats.add(chatId);

        return ctx.reply(
            "🔕 Welcome messages are now <b>disabled</b>.",
            { parse_mode: "HTML" }
        );
    }

    const disabled = disabledWelcomeChats.has(chatId);
    const status = disabled
        ? "🔕 <b>disabled</b>"
        : "✅ <b>enabled</b>";

    return ctx.reply(
        `Welcome messages are currently ${status}.\n\n` +
        `Use <code>${getPrefix(chatId)}welcome on</code> or ` +
        `<code>${getPrefix(chatId)}welcome off</code>.`,
        { parse_mode: "HTML" }
    );
});

bot.command("setprefix", (ctx) => {
    if (ctx.chat.type === "private") {
        return ctx.reply("⚠️ This command only works in groups.");
    }

    if (!isOwner(ctx)) {
        return ctx.reply("🚫 Only the bot owner can change the prefix.");
    }

    const newPrefix = ctx.match.trim();

    if (!newPrefix || newPrefix.length > 3) {
        return ctx.reply(
            "⚠️ Please provide a prefix between 1 and 3 characters.\n" +
            "Example: <code>/setprefix !</code>",
            { parse_mode: "HTML" }
        );
    }

    prefixes.set(ctx.chat.id, newPrefix);

    return ctx.reply(
        `✅ Prefix changed to <code>${newPrefix}</code>.`,
        { parse_mode: "HTML" }
    );
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const prefix = getPrefix(chatId);

    const username = ctx.me.username
        ? `@${ctx.me.username}`
        : "";

    if (username && text.includes(username)) {
        return ctx.reply(
            `👋 Hey! My current prefix here is <code>${prefix}</code>.\n\n` +
            getHelpMessage(prefix),
            { parse_mode: "HTML" }
        );
    }

    if (prefix === "/" || !text.startsWith(prefix)) {
        return;
    }

    const commandText = text.slice(prefix.length).trim();
    const [command, ...args] = commandText.split(/\s+/);
    const argument = args.join(" ").toLowerCase();

    switch (command?.toLowerCase()) {
        case "start":
            return ctx.reply(getHelpMessage(prefix), {
                parse_mode: "HTML"
            });

        case "myid":
            return sendUserId(ctx);

        case "rate":
            return replyExchangeRate(ctx);

        case "ex":
            return replyExchangeForAmount(ctx, argument);

        case "welcome": {
            if (ctx.chat.type === "private") {
                return ctx.reply("⚠️ This command only works in groups.");
            }

            if (!isOwner(ctx)) {
                return ctx.reply(
                    "🚫 Only the bot owner can use this command."
                );
            }

            if (argument === "on") {
                disabledWelcomeChats.delete(chatId);

                return ctx.reply(
                    "✅ Welcome messages are now <b>enabled</b>.",
                    { parse_mode: "HTML" }
                );
            }

            if (argument === "off") {
                disabledWelcomeChats.add(chatId);

                return ctx.reply(
                    "🔕 Welcome messages are now <b>disabled</b>.",
                    { parse_mode: "HTML" }
                );
            }

            const disabled = disabledWelcomeChats.has(chatId);
            const status = disabled
                ? "🔕 <b>disabled</b>"
                : "✅ <b>enabled</b>";

            return ctx.reply(
                `Welcome messages are currently ${status}.`,
                { parse_mode: "HTML" }
            );
        }

        case "setprefix": {
            if (ctx.chat.type === "private") {
                return ctx.reply("⚠️ This command only works in groups.");
            }

            if (!isOwner(ctx)) {
                return ctx.reply(
                    "🚫 Only the bot owner can change the prefix."
                );
            }

            const newPrefix = args[0]?.trim();

            if (!newPrefix || newPrefix.length > 3) {
                return ctx.reply(
                    `⚠️ Please provide a prefix between 1 and 3 characters.\n` +
                    `Example: <code>${prefix}setprefix !</code>`,
                    { parse_mode: "HTML" }
                );
            }

            prefixes.set(chatId, newPrefix);

            return ctx.reply(
                `✅ Prefix changed to <code>${newPrefix}</code>.`,
                { parse_mode: "HTML" }
            );
        }
    }
});

bot.callbackQuery("send_rules", async (ctx) => {
    const name = ctx.from.first_name;

    const rules =
        `📜 <b>Programming Community Rules</b>\n\n` +
        `1️⃣ <b>Format Your Code:</b> Use backticks or services such as GitHub Gists or Pastebin for larger code blocks.\n\n` +
        `2️⃣ <b>Be Respectful:</b> Treat other developers with respect. No toxic behavior or gatekeeping.\n\n` +
        `3️⃣ <b>Help & Ask:</b> Ask questions, share solutions, and help beginners when you can.\n\n` +
        `4️⃣ <b>No Spam:</b> Don't post random links or excessive self-promotion.\n\n` +
        `5️⃣ <b>Stay On-Topic:</b> Keep discussions mostly related to programming, technology, and learning.\n\n` +
        `Happy coding! 💻🚀`;

    try {
        await ctx.api.sendMessage(ctx.from.id, rules, {
            parse_mode: "HTML"
        });

        await ctx.answerCallbackQuery({
            text: `✅ Hey ${name}, I sent the rules to your DMs!`,
            show_alert: true
        });
    } catch {
        await ctx.answerCallbackQuery({
            text:
                `⚠️ Hey ${name}, I can't message you yet. ` +
                `Open my profile and send me a message first!`,
            show_alert: true
        });
    }
});

bot.on("message:new_chat_members", async (ctx) => {
    const chatId = ctx.chat.id;

    if (disabledWelcomeChats.has(chatId)) {
        return;
    }

    const newMembers = ctx.message.new_chat_members.filter(
        (member) => member.id !== ctx.me.id
    );

    if (newMembers.length === 0) {
        return;
    }

    const memberCount = await ctx.getChatMemberCount();
    const groupName = ctx.chat.title || "our community";

    const firstMemberNumber =
        memberCount - newMembers.length + 1;

    const keyboard = new InlineKeyboard().text(
        "📖 Rules",
        "send_rules"
    );

    if (newMembers.length === 1) {
        const member = newMembers[0];
        const position = getOrdinal(firstMemberNumber);

        return ctx.reply(
            `👋 Welcome to <b>${groupName}</b>, <b>${member.first_name}</b>!\n\n` +
            `You are our amazing <b>${position}</b> member! 🎉\n\n` +
            `We're happy to have you here. Read the rules and jump in! 🚀`,
            {
                parse_mode: "HTML",
                reply_markup: keyboard
            }
        );
    }

    const members = newMembers
        .map((member, index) => {
            const position = getOrdinal(
                firstMemberNumber + index
            );

            return `• <b>${member.first_name}</b> — <b>${position}</b> member`;
        })
        .join("\n");

    return ctx.reply(
        `👋 Welcome to <b>${groupName}</b>!\n\n` +
        `${members}\n\n` +
        `🎉 Glad to have you all here! Read the rules and dive in! 🚀`,
        {
            parse_mode: "HTML",
            reply_markup: keyboard
        }
    );
});

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    if (req.method !== "POST") {
        if (
            process.env.CRON_SECRET &&
            req.headers.authorization ===
                `Bearer ${process.env.CRON_SECRET}`
        ) {
            await sendHourlyRate();

            return res.status(200).send("Rate sent");
        }

        return res.status(200).send(
            "Telegram bot is running on Vercel!"
        );
    }

    try {
        await bot.init();
        await bot.handleUpdate(req.body);
    } catch (error) {
        console.error("Webhook error:", error);
    }

    return res.status(200).send("OK");
}

if (!process.env.VERCEL) {
    bot.start({
        onStart: () => {
            console.log("Bot started locally.");

            void sendHourlyRate();
            setInterval(() => void sendHourlyRate(), RATE_INTERVAL_MS);
        }
    });
}