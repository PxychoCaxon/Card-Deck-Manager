# Card Deck Manager for SillyTavern

A client-side SillyTavern extension that exposes eight function tools to the active chat model for managing card games:

- `deck_shuffle`: shuffles the remaining draw pile.
- `deck_draw`: draws 1–10 cards into the LLM's private hand. Card identities are returned to the model and hidden from the chat transcript UI.
- `deck_pass`: deals 1–10 cards to the user. The user sees the card identities in the extension panel and a notification; the model receives only the number passed.
- `deck_draw_common`: draws 1–5 community cards and reveals them publicly to both the LLM and user (for games like poker/blackjack).
- `deck_reshuffle`: returns all cards (LLM hand, user's pile, discard pile) back to the draw pile and reshuffles. Useful for starting a new round without resetting the chat.
- `deck_view_user_cards`: requests to see the user's current hand. Shows a popup asking the user for approval before revealing card identities to the LLM.
- `deck_discard`: discards 1–10 cards from the LLM's private hand into the discard pile.
- `deck_count`: reports the current count of cards in each pile (draw, LLM hand, user hand, discard).

The extension is a normal UI extension, not a server plugin. It has a settings-panel entry, a per-chat deck state, and a user-visible activity log. It does not expose a tool for listing or inspecting the entire deck.

## Requirements

- A SillyTavern build that exposes the documented `registerFunctionTool()` API.
- Chat Completion API connection with function calling supported by the provider/model.
- **Enable function calling** in SillyTavern's AI Response Configuration.

Text Completion APIs do not support function calling. Tool calls are not guaranteed to be made unless the model decides they are needed; mention the available deck tools in the character card or scenario instructions when appropriate.

## Install

### Manual

Copy the `deck-manager` folder into either:

- `SillyTavern/data/<user-handle>/extensions/deck-manager/` (user-scoped install), or
- `SillyTavern/public/scripts/extensions/third-party/deck-manager/` (legacy/global install).

Restart or refresh SillyTavern, then enable **Card Deck Manager** in Extensions → Manage Extensions. Its settings and activity panel appears under the Extensions panel.

### Git installation

Use Extensions → Install Extension and enter this repository's URL.

## Use

1. Open a character or group chat.
2. Open Extensions → Card Deck Manager.
3. Leave the custom deck blank for a standard 52-card deck, or enter one card per line and select **Save deck & reset current chat**.
4. The model must call `deck_shuffle` before `deck_draw` or `deck_pass`.
5. `deck_draw` returns actual cards to the model only. `deck_pass` reveals cards to the user only.
6. Use **Reshuffle all cards** button (or have the LLM call `deck_reshuffle`) to collect all cards back into the draw pile and shuffle for a new round.

### Customizing Tool Prompts

The extension allows you to customize the prompts/descriptions that are sent to the LLM for each tool. This is useful for:
- Adapting the tools to specific card games (e.g., changing "private hand" to "your cards" for a specific game)
- Adding game-specific rules or instructions
- Adjusting tone or formality

To customize prompts:
1. Open the Card Deck Manager settings panel
2. Scroll down to the **Customize Tool Prompts** section
3. Edit any tool's prompt in its textarea (leave blank to use default)
4. Click **Save prompts & re-register tools**
5. Use **Reset to defaults** to restore original prompts

A reset creates a fresh deck and clears the private hand and passed-card pile. The deck must be shuffled again after reset. Draw/pass requests are atomic: if there are not enough cards, nothing is removed.

**Note**: If the tool call says "...(Private)", do not expand it! Unless you would like to view the cards sorted to the LLM.

## Privacy model

SillyTavern normally displays tool-call transcript messages in chat. This extension hides `.mes.toolCall` elements with CSS so private draw results are not rendered in the chat window. It instead reports safe action summaries in its own activity panel. Passed card identities are deliberately shown only in the user-facing panel/notification and are never included in the `deck_pass` tool result.

This is UI-level privacy. A user with browser developer tools or access to the underlying chat data can inspect tool-call data. The extension does not send the deck list to the model; only cards actually drawn are returned to it.

## Validation notes

The package uses the documented `SillyTavern.getContext().registerFunctionTool()` API. By itself, the LLM may not be aware how it must manage the deck appropriately. Use a capable prompt that properly guides the model.
