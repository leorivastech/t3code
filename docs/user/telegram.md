# Telegram

A thread can send you text, an image, a video, or a file such as a PDF on Telegram, and you can answer that message from your phone. The answer comes back into the same thread.

## Set it up

Open **Settings → Integrations → Telegram**. This belongs to the environment you have selected.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) and create a new bot for this T3 environment. Do not share it with another running bot service or another T3 environment.
2. Paste its token into **Bot token** and choose **Save**. You can leave the ids empty for this first save. The token is stored on the server and is not shown again.
3. Open a private chat with that bot and send `/start`. It replies with your Telegram id. Put that number in **Chats** and **Who can answer**, then save again.
4. Choose **Send test**. The bot says hello in each chat you listed. This checks sending; complete the reply check below to check both directions.

Set this up on desktop or web. The mobile app shows what a thread sent to Telegram, but has no screen for the bot.

## Groups

A group can receive what agents send. It cannot answer them.

1. Add the bot to the group. It posts the group's id there, a negative number. It only does this when someone in **Who can answer** adds it; otherwise send `/start@your_bot` in the group.
2. Add that id to **Chats** and save. **Send test** then names every chat it reached, so you can tell the ids apart.
3. Ask for the group by name: "send the report to the team group". The name has to fit one chat in **Chats**; if it fits several, the agent asks which. With no chat named, an answer to your Telegram message goes back to you, and any other send goes to the first chat in the list.

The bot finds no groups on its own and adds none to the list. It sends only to the ids in **Chats** and to the people in **Who can answer**, so a group someone else put the bot in receives nothing until you add it.

Answering works only from a private chat, and only for the people in **Who can answer**. What they type becomes a message to an agent that can run commands on this machine, so a reply inside a group is ignored, even when one of those people writes it. Leave **Who can answer** empty to turn answering off. Everyone listed can reach all open threads in this environment.

## Send and answer

Ask the agent to send something on Telegram. A JPG, PNG, or WebP image, and an MP4 video, show in the chat. Anything else, including a PDF, arrives as a file. A file can be up to 50 MB. A thread sends files from its own workspace; only a thread with full access can send a file from elsewhere on the machine.

To check replies, ask a thread to send you a short message, then reply to it in your private chat with the bot. Your text appears in that thread, the agent continues, and its answer comes back to your private chat.

Send `/threads` to see the eight most recently updated open threads. Each one arrives as its own message. Reply to the one you want. `/start` gives a short reminder of these commands, or your id if you are not in **Who can answer** yet. A message older than 30 days may have lost its thread; use `/threads` to get a fresh one.

The environment server has to be running for an answer to arrive, and Telegram keeps a message for it for up to 24 hours. Nothing is sent on its own: a result reaches Telegram when you ask the agent to send it, and only text comes back in.
