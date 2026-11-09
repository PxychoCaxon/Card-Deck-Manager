# Card Deck Manager for SillyTavern

A client-side SillyTavern extension that exposes three function tools to the active chat model:

- `deck_shuffle`: shuffles the remaining draw pile.
- `deck_draw`: draws 1–10 cards into the LLM's private hand. Card identities are returned to the model and hidden from the chat transcript UI.
- `deck_pass`: deals 1–10 cards to the user. The user sees the card identities in the extension panel and a notification; the model receives only the number passed.

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

Publish this folder as the root of a Git repository, then use Extensions → Install Extension and enter that repository URL.

## Use

1. Open a character or group chat.
2. Open Extensions → Card Deck Manager.
3. Leave the custom deck blank for a standard 52-card deck, or enter one card per line and select **Save deck & reset current chat**.
4. The model must call `deck_shuffle` before `deck_draw` or `deck_pass`.
5. `deck_draw` returns actual cards to the model only. `deck_pass` reveals cards to the user only.

A reset creates a fresh deck and clears the private hand and passed-card pile. The deck must be shuffled again after reset. Draw/pass requests are atomic: if there are not enough cards, nothing is removed.

## Privacy model

SillyTavern normally displays tool-call transcript messages in chat. This extension hides `.mes.toolCall` elements with CSS so private draw results are not rendered in the chat window. It instead reports safe action summaries in its own activity panel. Passed card identities are deliberately shown only in the user-facing panel/notification and are never included in the `deck_pass` tool result.

This is UI-level privacy, not cryptographic secrecy. A user with browser developer tools or access to the underlying chat data can inspect tool-call data. The extension does not send the deck list to the model; only cards actually drawn are returned to it.

## Validation notes

The package uses the documented `SillyTavern.getContext().registerFunctionTool()` API. It has not been tested inside a live SillyTavern instance; verify the UI and tool-call behavior against the exact SillyTavern build and model/provider you use.
