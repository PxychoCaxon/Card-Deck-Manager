const EXTENSION_NAME = 'deck-manager';
const TEMPLATE_PATH = 'third-party/deck-manager';
const STATE_KEY = 'cardDeckManager';
const TOOL_NAMES = ['deck_shuffle', 'deck_draw', 'deck_pass'];
const MAX_ACTION_LOG = 25;
const MAX_DRAW_COUNT = 10;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    customDeck: '',
});

let settings;
let panelReady = false;
let lastChatKey = null;

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function notify(kind, message) {
    const fn = window.toastr?.[kind] ?? window.toastr?.info;
    if (typeof fn === 'function') fn(message, 'Card Deck Manager');
}

function getSettings() {
    const ctx = getContext();
    if (!ctx?.extensionSettings) return DEFAULT_SETTINGS;
    ctx.extensionSettings[EXTENSION_NAME] ??= {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in ctx.extensionSettings[EXTENSION_NAME])) {
            ctx.extensionSettings[EXTENSION_NAME][key] = value;
        }
    }
    settings = ctx.extensionSettings[EXTENSION_NAME];
    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function standardDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];
    return suits.flatMap(suit => ranks.map(rank => `${rank} of ${suit}`));
}

function configuredDeck() {
    const raw = String(getSettings().customDeck ?? '').trim();
    if (!raw) return standardDeck();
    return raw.split(/\r?\n/).map(card => card.trim()).filter(Boolean);
}

function getChatState(create = true) {
    const ctx = getContext();
    if (!ctx?.chatMetadata || !Array.isArray(ctx.chat)) return null;
    const metadata = ctx.chatMetadata;
    if (!metadata[STATE_KEY] && create) {
        metadata[STATE_KEY] = {
            version: 1,
            drawPile: configuredDeck(),
            llmHand: [],
            passedCards: [],
            shuffled: false,
            actionLog: [{ at: Date.now(), kind: 'system', text: 'A new deck is ready. Shuffle it before drawing or passing.' }],
        };
        persistChatState().catch(error => console.error(`[${EXTENSION_NAME}] Could not initialize deck metadata`, error));
    }
    const state = metadata[STATE_KEY];
    if (!state || !Array.isArray(state.drawPile)) return null;
    state.llmHand = Array.isArray(state.llmHand) ? state.llmHand : [];
    state.passedCards = Array.isArray(state.passedCards) ? state.passedCards : [];
    state.actionLog = Array.isArray(state.actionLog) ? state.actionLog : [];
    return state;
}

async function persistChatState() {
    const ctx = getContext();
    if (typeof ctx?.saveMetadata === 'function') {
        await ctx.saveMetadata();
    } else if (typeof ctx?.saveChat === 'function') {
        await ctx.saveChat();
    }
}

async function pushLog(kind, text) {
    const state = getChatState();
    if (!state) return;
    state.actionLog.push({ at: Date.now(), kind, text });
    state.actionLog = state.actionLog.slice(-MAX_ACTION_LOG);
    try {
        await persistChatState();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Could not save chat metadata`, error);
    }
    renderPanel();
}

async function addError(message) {
    await pushLog('error', message);
    notify('error', message);
    return `ERROR: ${message}`;
}

function requireDeck() {
    const state = getChatState();
    if (!state) return { error: 'No active chat. Open a character or group chat before using the deck.' };
    if (!state.shuffled) return { error: 'The deck has not been shuffled. Call deck_shuffle before drawing or passing cards.' };
    return { state };
}

function validateCount(count) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_DRAW_COUNT) {
        return `Count must be an integer from 1 to ${MAX_DRAW_COUNT}.`;
    }
    return null;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function makeToolDefinitions() {
    return [
        {
            name: 'deck_shuffle',
            displayName: 'Shuffle Card Deck',
            description: 'Shuffle the remaining draw pile for the active card game. Call this before the first draw or pass after a deck reset. This does not reveal any card identities. Do not claim a shuffle occurred unless this tool succeeds.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {},
                required: [],
            },
            action: async () => {
                const state = getChatState();
                if (!state) return addError('No active chat. Open a character or group chat first.');
                if (state.drawPile.length === 0) return addError('The draw pile is empty. Reset the deck before shuffling again.');
                shuffleArray(state.drawPile);
                state.shuffled = true;
                await pushLog('shuffle', `LLM shuffled the remaining deck (${state.drawPile.length} card(s) in the draw pile).`);
                notify('success', `The LLM shuffled the deck. ${state.drawPile.length} card(s) remain in the draw pile.`);
                return `SUCCESS: The remaining draw pile has been shuffled. ${state.drawPile.length} card(s) remain. No card identities were revealed.`;
            },
            formatMessage: () => 'The LLM shuffled the deck.',
            stealth: false,
        },
        {
            name: 'deck_draw',
            displayName: 'Draw Cards (Private)',
            description: 'Draw 1–10 cards from the top of the shuffled draw pile into the LLM’s private hand. The returned card identities are visible to you (the LLM) but must not be shown or named to the user unless the game rules explicitly require it. The user interface hides the raw tool-call transcript. Never invent a draw; use this tool to obtain actual cards.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    count: { type: 'integer', minimum: 1, maximum: MAX_DRAW_COUNT, description: 'Number of cards to draw privately (1–10).' },
                },
                required: ['count'],
            },
            action: async ({ count }) => {
                const countError = validateCount(count);
                if (countError) return addError(countError);
                const { state, error } = requireDeck();
                if (error) return addError(error);
                if (state.drawPile.length < count) return addError(`Not enough cards remain. Requested ${count}; only ${state.drawPile.length} remain. No cards were drawn.`);
                const cards = state.drawPile.splice(0, count);
                state.llmHand.push(...cards);
                await pushLog('draw', `LLM privately drew ${count} card(s). Card identities are hidden from the user.`);
                notify('info', `The LLM privately drew ${count} card(s). Their identities are hidden.`);
                return `SUCCESS: You privately drew ${count} card(s): ${cards.join('; ')}. These cards are now in your private hand. Current private hand size: ${state.llmHand.length}. Keep their identities concealed from the user unless the game rules require a reveal.`;
            },
            formatMessage: ({ count }) => `The LLM privately drew ${count} card(s).`,
            stealth: false,
        },
        {
            name: 'deck_pass',
            displayName: 'Pass Cards to User',
            description: 'Deal 1–10 cards from the top of the shuffled draw pile directly to the user. The extension reveals the actual card identities in its user-visible panel and notification, but deliberately withholds those identities from you. Your tool result will only confirm the number passed. Do not guess, infer, or invent the passed card identities. This is distinct from deck_draw, which gives you private card knowledge.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    count: { type: 'integer', minimum: 1, maximum: MAX_DRAW_COUNT, description: 'Number of cards to pass to the user (1–10).' },
                },
                required: ['count'],
            },
            action: async ({ count }) => {
                const countError = validateCount(count);
                if (countError) return addError(countError);
                const { state, error } = requireDeck();
                if (error) return addError(error);
                if (state.drawPile.length < count) return addError(`Not enough cards remain. Requested ${count}; only ${state.drawPile.length} remain. No cards were passed.`);
                const cards = state.drawPile.splice(0, count);
                state.passedCards.push(...cards);
                const cardText = cards.join(', ');
                await pushLog('pass', `Passed to user: ${cardText}`);
                notify('success', `Passed to you: ${cardText}`);
                return `SUCCESS: Passed ${count} card(s) to the user. Their identities are withheld from you. Do not guess or disclose their identities.`;
            },
            formatMessage: ({ count }) => `The LLM dealt ${count} card(s) to you.`,
            stealth: false,
        },
    ];
}

function registerTools() {
    const ctx = getContext();
    if (!ctx?.registerFunctionTool) {
        updateStatus('Function-tool API unavailable in this SillyTavern version.');
        return false;
    }
    if (ctx.unregisterFunctionTool) {
        for (const name of TOOL_NAMES) ctx.unregisterFunctionTool(name);
    }
    for (const tool of makeToolDefinitions()) ctx.registerFunctionTool(tool);
    updateStatus(ctx.isToolCallingSupported?.()
        ? 'Tools registered. Function calling is available for the current connection.'
        : 'Tools registered, but the current connection may not support function calling.');
    return true;
}

function updateStatus(text) {
    $('#cdm_status').text(text);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderPanel() {
    if (!panelReady) return;
    const state = getChatState(false);
    if (!state) {
        $('#cdm_remaining').text('—');
        $('#cdm_hand').text('—');
        $('#cdm_passed').text('—');
        $('#cdm_shuffle_state').text('No active chat');
        $('#cdm_activity').html('<div class="cdm-empty">Open a chat to initialize its deck.</div>');
        return;
    }
    $('#cdm_remaining').text(String(state.drawPile.length));
    $('#cdm_hand').text(String(state.llmHand.length));
    $('#cdm_passed').text(String(state.passedCards.length));
    $('#cdm_shuffle_state').text(state.shuffled ? 'Shuffled' : 'Needs shuffle');
    const rows = state.actionLog.slice().reverse().map(entry => {
        const time = new Date(entry.at).toLocaleTimeString();
        const kind = String(entry.kind || 'action').toUpperCase();
        return `<div class="cdm-log-row cdm-${escapeHtml(entry.kind)}"><span class="cdm-log-time">${escapeHtml(time)}</span><b>${escapeHtml(kind)}</b><span>${escapeHtml(entry.text)}</span></div>`;
    });
    $('#cdm_activity').html(rows.join('') || '<div class="cdm-empty">No deck actions yet.</div>');
}

function resetCurrentDeck() {
    const cards = configuredDeck();
    if (cards.length < 1) {
        notify('error', 'The custom deck is empty. Add at least one card or clear the field to use a standard 52-card deck.');
        return;
    }
    if (cards.length > 200) {
        notify('error', 'A deck may contain at most 200 cards.');
        return;
    }
    const ctx = getContext();
    if (!ctx?.chatMetadata || !Array.isArray(ctx.chat)) {
        notify('error', 'Open a character or group chat before resetting the deck.');
        return;
    }
    ctx.chatMetadata[STATE_KEY] = {
        version: 1,
        drawPile: cards.slice(),
        llmHand: [],
        passedCards: [],
        shuffled: false,
        actionLog: [{ at: Date.now(), kind: 'reset', text: `Deck reset with ${cards.length} card(s). Shuffle before drawing or passing.` }],
    };
    persistChatState().catch(error => console.error(`[${EXTENSION_NAME}] Could not save reset deck`, error));
    renderPanel();
    notify('success', `Deck reset with ${cards.length} card(s). The LLM must shuffle before drawing or passing.`);
}

async function renderSettings() {
    const ctx = getContext();
    if (!ctx?.renderExtensionTemplateAsync) {
        console.error(`[${EXTENSION_NAME}] renderExtensionTemplateAsync is unavailable.`);
        return;
    }
    try {
        const html = await ctx.renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);
    panelReady = true;
    const current = getSettings();
    $('#cdm_enabled').prop('checked', current.enabled !== false);
    $('#cdm_custom_deck').val(current.customDeck ?? '');

    $('#cdm_enabled').on('change', function () {
        current.enabled = Boolean($(this).prop('checked'));
        saveSettings();
        if (current.enabled) registerTools();
        else {
            const context = getContext();
            for (const name of TOOL_NAMES) context?.unregisterFunctionTool?.(name);
            updateStatus('Extension disabled. Tool registration removed.');
        }
    });

    $('#cdm_save_deck').on('click', function () {
        current.customDeck = String($('#cdm_custom_deck').val() ?? '');
        saveSettings();
        resetCurrentDeck();
    });

    $('#cdm_reset_deck').on('click', resetCurrentDeck);
    $('#cdm_clear_log').on('click', function () {
        const state = getChatState(false);
        if (!state) return;
        state.actionLog = [];
        persistChatState().catch(error => console.error(`[${EXTENSION_NAME}] Could not clear action log`, error));
        renderPanel();
    });
    renderPanel();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to render settings template:`, error);
        notify('error', 'Failed to load extension settings. Check the browser console for details.');
    }
}

function onChatChanged() {
    const ctx = getContext();
    const key = ctx?.chatId ?? `${ctx?.characterId ?? 'none'}:${ctx?.groupId ?? 'none'}`;
    if (key !== lastChatKey) lastChatKey = key;
    getChatState(true);
    renderPanel();
}

jQuery(async () => {
    const ctx = getContext();
    if (!ctx) {
        console.error(`[${EXTENSION_NAME}] SillyTavern context is unavailable.`);
        return;
    }
    await ctx.loadExtensionSettings?.(EXTENSION_NAME);
    getSettings();
    await renderSettings();
    if (settings.enabled !== false) registerTools();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types ?? ctx.eventTypes;
    if (eventSource && eventTypes?.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    onChatChanged();
});
