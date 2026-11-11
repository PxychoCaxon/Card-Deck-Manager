const EXTENSION_NAME = 'deck-manager';
const TEMPLATE_PATH = 'third-party/deck-manager';
const STATE_KEY = 'cardDeckManager';
const TOOL_NAMES = ['deck_shuffle', 'deck_draw', 'deck_pass', 'deck_draw_common', 'deck_reshuffle', 'deck_view_user_cards', 'deck_discard', 'deck_count'];
const MAX_ACTION_LOG = 25;
const MAX_DRAW_COUNT = 10;

const DEFAULT_TOOL_PROMPTS = Object.freeze({
    deck_shuffle: 'Shuffle the remaining draw pile for the active card game. Call this before the first draw and demonstrate yourself carrying out this action. This does not reveal any card identities.',
    deck_draw: 'Draw 1–10 cards from the top of the shuffled draw pile into your private hand. The returned card identities are visible to you but must not be shown to the user unless game rules require it.',
    deck_pass: 'Deal 1–10 cards from the top of the shuffled draw pile directly to the user. This reveals the actual card identities to the user, but withholds them from you.',
    deck_draw_common: 'Draw 1–5 community cards and reveal them publicly to both you and the user. Use this for games like poker or blackjack where certain cards are visible to everyone.',
    deck_reshuffle: 'Return all cards (from your private hand, the user\'s pile, and the discard pile) back to the draw pile and shuffle. Use this when a game round ends or you need to start fresh.',
    deck_view_user_cards: 'Request to see the cards currently held by the user. This will prompt the user for approval before revealing their card identities to you.',
    deck_discard: 'Discard 1–10 cards from your private hand into the discard pile. These cards are removed from play until reshuffled.',
    deck_count: 'Get the current counts of cards in each pile (draw, your hand, user\'s hand, discard). Useful for tracking game state.'
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    customDeck: '',
    toolPrompts: {},
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
            ctx.extensionSettings[EXTENSION_NAME][key] = JSON.parse(JSON.stringify(value));
        }
    }
    settings = ctx.extensionSettings[EXTENSION_NAME];
    return settings;
}

function getToolPrompt(toolName) {
    const s = getSettings();
    if (s.toolPrompts && typeof s.toolPrompts === 'object' && s.toolPrompts[toolName]) {
        return s.toolPrompts[toolName];
    }
    return DEFAULT_TOOL_PROMPTS[toolName] || '';
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
            version: 2,
            drawPile: configuredDeck(),
            llmHand: [],
            passedCards: [],
            discardPile: [],
            shuffled: false,
            actionLog: [{ at: Date.now(), kind: 'system', text: 'A new deck is ready. Shuffle it before drawing or passing.' }],
        };
        persistChatState().catch(error => console.error(`[${EXTENSION_NAME}] Could not initialize deck metadata`, error));
    }
    const state = metadata[STATE_KEY];
    if (!state || !Array.isArray(state.drawPile)) return null;
    // Migrate older state versions
    if (state.version < 2) {
        state.discardPile = [];
        state.version = 2;
    }
    state.llmHand = Array.isArray(state.llmHand) ? state.llmHand : [];
    state.passedCards = Array.isArray(state.passedCards) ? state.passedCards : [];
    state.discardPile = Array.isArray(state.discardPile) ? state.discardPile : [];
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
            description: getToolPrompt('deck_shuffle') + '. Do not claim a shuffle occurred unless this tool succeeds.',
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
            description: getToolPrompt('deck_draw') + '. Never invent a draw; use this tool to obtain actual cards.',
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
            description: getToolPrompt('deck_pass') + '. This is distinct from deck_draw, which gives you private card knowledge.',
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
        {
            name: 'deck_draw_common',
            displayName: 'Draw Community Card (Public)',
            description: getToolPrompt('deck_draw_common'),
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    count: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of community cards to draw and reveal publicly (1–5).' },
                },
                required: ['count'],
            },
            action: async ({ count }) => {
                if (!Number.isInteger(count) || count < 1 || count > 5) {
                    return addError('Count must be an integer from 1 to 5.');
                }
                const { state, error } = requireDeck();
                if (error) return addError(error);
                if (state.drawPile.length < count) {
                    return addError(`Not enough cards remain. Requested ${count}; only ${state.drawPile.length} remain.`);
                }
                const cards = state.drawPile.splice(0, count);
                const cardText = cards.join(', ');
                await pushLog('common', `Community cards revealed: ${cardText}`);
                notify('info', `Community cards: ${cardText}`);
                return `SUCCESS: Drew and publicly revealed ${count} community card(s): ${cardText}. Both you and the user can see these cards.`;
            },
            formatMessage: ({ count }) => {
                const state = getChatState(false);
                if (!state) return 'Community cards were drawn.';
                for (let i = state.actionLog.length - 1; i >= 0; i--) {
                    if (state.actionLog[i].kind === 'common') {
                        const text = state.actionLog[i].text.replace('Community cards revealed: ', '');
                        return `Community cards revealed: ${text}`;
                    }
                }
                return 'Community cards were drawn.';
            },
            stealth: false,
        },
        {
            name: 'deck_reshuffle',
            displayName: 'Reshuffle All Cards',
            description: getToolPrompt('deck_reshuffle'),
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {},
                required: [],
            },
            action: async () => {
                const state = getChatState();
                if (!state) return addError('No active chat. Open a character or group chat first.');
                // Collect all cards back into the draw pile
                const handCards = state.llmHand.splice(0);
                const passedCards = state.passedCards.splice(0);
                const discardCards = state.discardPile.splice(0);
                state.drawPile.push(...handCards, ...passedCards, ...discardCards);
                shuffleArray(state.drawPile);
                state.shuffled = true;
                await pushLog('reshuffle', `All ${state.drawPile.length} card(s) returned to draw pile and reshuffled.`);
                notify('success', `The LLM collected all cards back into the deck and reshuffled. ${state.drawPile.length} card(s) in the draw pile.`);
                return `SUCCESS: All cards have been returned to the draw pile and shuffled. The deck now contains ${state.drawPile.length} card(s). Your private hand is empty.`;
            },
            formatMessage: () => 'The LLM collected all cards back into the deck and reshuffled.',
            stealth: false,
        },
        {
            name: 'deck_view_user_cards',
            displayName: 'View User\'s Cards (Requires Approval)',
            description: getToolPrompt('deck_view_user_cards'),
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {},
                required: [],
            },
            action: async () => {
                const state = getChatState();
                if (!state) return addError('No active chat. Open a character or group chat first.');
                if (state.passedCards.length === 0) {
                    await pushLog('view_user', 'LLM requested to view user cards, but user has no cards yet.');
                    return 'INFO: The user currently has no cards in their hand.';
                }
                // Request user approval via popup
                const ctx = getContext();
                let approved = false;
                try {
                    if (ctx?.Popup?.show?.confirm) {
                        const result = await ctx.Popup.show.confirm(
                            'Card Deck Manager',
                            `The LLM wants to see your ${state.passedCards.length} card(s). Allow?`
                        );
                        approved = result === 1; // POPUP_RESULT.AFFIRMATIVE
                    } else {
                        // Fallback: if popup API unavailable, auto-approve with warning
                        console.warn('[deck-manager] Popup API unavailable, auto-approving view request.');
                        approved = true;
                    }
                } catch (error) {
                    console.error('[deck-manager] Error showing approval popup:', error);
                    return addError('Could not show approval dialog to user.');
                }
                if (!approved) {
                    await pushLog('view_user', 'LLM requested to view user cards, but user declined.');
                    notify('info', 'You declined the LLM\'s request to see your cards.');
                    return 'INFO: The user declined to show their cards. You do not know what they are holding.';
                }
                const cardText = state.passedCards.join(', ');
                await pushLog('view_user', `LLM viewed user cards (approved): ${cardText}`);
                notify('info', 'You allowed the LLM to see your cards.');
                return `SUCCESS: The user approved. Their current hand contains: ${cardText}. Remember these are their cards, not yours.`;
            },
            formatMessage: () => 'The LLM requested to view your cards.',
            stealth: false,
        },
        {
            name: 'deck_discard',
            displayName: 'Discard Cards from Hand',
            description: getToolPrompt('deck_discard'),
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    count: { type: 'integer', minimum: 1, maximum: MAX_DRAW_COUNT, description: 'Number of cards to discard from your hand (1–10).' },
                },
                required: ['count'],
            },
            action: async ({ count }) => {
                const countError = validateCount(count);
                if (countError) return addError(countError);
                const state = getChatState();
                if (!state) return addError('No active chat. Open a character or group chat first.');
                if (state.llmHand.length < count) {
                    return addError(`You only have ${state.llmHand.length} card(s) in your hand. Cannot discard ${count}.`);
                }
                const cards = state.llmHand.splice(0, count);
                state.discardPile.push(...cards);
                await pushLog('discard', `LLM discarded ${count} card(s): ${cards.join(', ')}`);
                notify('info', `The LLM discarded ${count} card(s) from their hand.`);
                return `SUCCESS: You discarded ${count} card(s) to the discard pile. Your private hand now has ${state.llmHand.length} card(s). Discarded cards: ${cards.join(', ')}.`;
            },
            formatMessage: ({ count }) => `The LLM discarded ${count} card(s) from their hand.`,
            stealth: false,
        },
        {
            name: 'deck_count',
            displayName: 'Check Card Counts',
            description: getToolPrompt('deck_count'),
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {},
                required: [],
            },
            action: async () => {
                const state = getChatState();
                if (!state) return addError('No active chat. Open a character or group chat first.');
                await pushLog('count', `LLM checked card counts.`);
                return `INFO: Draw pile: ${state.drawPile.length} | Your hand: ${state.llmHand.length} | User's hand: ${state.passedCards.length} | Discard pile: ${state.discardPile.length}`;
            },
            formatMessage: () => 'The LLM checked the current card counts.',
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
        $('#cdm_discard').text('—');
        $('#cdm_shuffle_state').text('No active chat');
        $('#cdm_activity').html('<div class="cdm-empty">Open a chat to initialize its deck.</div>');
        return;
    }
    $('#cdm_remaining').text(String(state.drawPile.length));
    $('#cdm_hand').text(String(state.llmHand.length));
    $('#cdm_passed').text(String(state.passedCards.length));
    $('#cdm_discard').text(String(state.discardPile.length));
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
        version: 2,
        drawPile: cards.slice(),
        llmHand: [],
        passedCards: [],
        discardPile: [],
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

        // Load custom tool prompts into UI
        const promptFields = {
            'deck_shuffle': '#cdm_prompt_shuffle',
            'deck_draw': '#cdm_prompt_draw',
            'deck_pass': '#cdm_prompt_pass',
            'deck_draw_common': '#cdm_prompt_common',
            'deck_reshuffle': '#cdm_prompt_reshuffle',
            'deck_view_user_cards': '#cdm_prompt_view',
            'deck_discard': '#cdm_prompt_discard',
            'deck_count': '#cdm_prompt_count'
        };
        for (const [toolName, selector] of Object.entries(promptFields)) {
            const customPrompt = getToolPrompt(toolName);
            if (customPrompt !== DEFAULT_TOOL_PROMPTS[toolName]) {
                $(selector).val(customPrompt);
            }
        }

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

        $('#cdm_reshuffle').on('click', async function () {
            const state = getChatState();
            if (!state) {
                notify('error', 'Open a character or group chat before reshuffling.');
                return;
            }
            // Collect all cards back into the draw pile
            const handCards = state.llmHand.splice(0);
            const passedCards = state.passedCards.splice(0);
            const discardCards = state.discardPile.splice(0);
            state.drawPile.push(...handCards, ...passedCards, ...discardCards);
            shuffleArray(state.drawPile);
            state.shuffled = true;
            await pushLog('reshuffle', `User reshuffled all ${state.drawPile.length} card(s) back into the draw pile.`);
            notify('success', `All cards collected and reshuffled. ${state.drawPile.length} card(s) in the draw pile.`);
        });

        $('#cdm_clear_log').on('click', function () {
            const state = getChatState(false);
            if (!state) return;
            state.actionLog = [];
            persistChatState().catch(error => console.error(`[${EXTENSION_NAME}] Could not clear action log`, error));
            renderPanel();
        });

        // Save custom tool prompts
        $('#cdm_save_prompts').on('click', function () {
            const promptFields = {
                'deck_shuffle': '#cdm_prompt_shuffle',
                'deck_draw': '#cdm_prompt_draw',
                'deck_pass': '#cdm_prompt_pass',
                'deck_draw_common': '#cdm_prompt_common',
                'deck_reshuffle': '#cdm_prompt_reshuffle',
                'deck_view_user_cards': '#cdm_prompt_view',
                'deck_discard': '#cdm_prompt_discard',
                'deck_count': '#cdm_prompt_count'
            };
            const s = getSettings();
            if (!s.toolPrompts || typeof s.toolPrompts !== 'object') {
                s.toolPrompts = {};
            }
            for (const [toolName, selector] of Object.entries(promptFields)) {
                const value = String($(selector).val() ?? '').trim();
                if (value && value !== DEFAULT_TOOL_PROMPTS[toolName]) {
                    s.toolPrompts[toolName] = value;
                } else {
                    delete s.toolPrompts[toolName];
                }
            }
            saveSettings();
            registerTools();
            notify('success', 'Tool prompts saved and tools re-registered.');
        });

        // Reset tool prompts to defaults
        $('#cdm_reset_prompts').on('click', function () {
            const promptFields = {
                'deck_shuffle': '#cdm_prompt_shuffle',
                'deck_draw': '#cdm_prompt_draw',
                'deck_pass': '#cdm_prompt_pass',
                'deck_draw_common': '#cdm_prompt_common',
                'deck_reshuffle': '#cdm_prompt_reshuffle',
                'deck_view_user_cards': '#cdm_prompt_view',
                'deck_discard': '#cdm_prompt_discard',
                'deck_count': '#cdm_prompt_count'
            };
            for (const selector of Object.values(promptFields)) {
                $(selector).val('');
            }
            const s = getSettings();
            s.toolPrompts = {};
            saveSettings();
            registerTools();
            notify('success', 'Tool prompts reset to defaults.');
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