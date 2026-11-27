// Script of the chat panel. It runs inside the webview, which has no access to
// files or to the VS Code API. It talks to the extension through messages only.
//
// Everything a model writes is put on the page with textContent, so it is
// always shown as plain text and never interpreted as markup.
//
// Each message the user sends gets a number. Every answer from the extension
// names that number, and an answer for any other number is ignored.
//
// The extension keeps every chat. This page draws the one it is told to show,
// and reports the unsent text of that chat as it changes. Every message sent
// names the chat it was typed in, so the extension can refuse one sent just
// before a switch reached this page. Each switch is confirmed, with the final
// unsent text of the chat the page leaves.
(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const welcome = document.getElementById('welcome');
  const status = document.getElementById('status');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const stopButton = document.getElementById('stop');
  const chatView = document.getElementById('chat');
  const historyView = document.getElementById('history');
  const historyBack = document.getElementById('history-back');
  const historySearch = document.getElementById('history-search');
  const historyList = document.getElementById('history-list');
  const historyEmpty = document.getElementById('history-empty');

  const NOTE_BY_STOP_REASON = {
    cancelled: 'Stopped.',
    max_tokens: 'The reply reached the length limit.',
    refusal: 'The model declined this request.',
  };

  let nextId = 1;
  /**
   * The request that is being answered: its number, its text, the elements
   * of the message and of its reply, and the test token it came with.
   */
  let current = null;
  /** The key of the chat shown, as the extension last said. Null until then. */
  let chatKey = null;
  /** Numbers of messages put back into the composer since the last report. */
  let returned = [];

  function add(kind, text) {
    const element = document.createElement('div');
    element.className = `message ${kind}`;
    element.textContent = text;
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  }

  function updateControls() {
    const busy = current !== null;
    status.hidden = !busy;
    stopButton.hidden = !busy;
    sendButton.hidden = busy;
    sendButton.disabled = busy || chatKey === null || input.value.trim() === '';
  }

  /**
   * Tells the extension the unsent text of the chat shown, and which messages
   * put back into the composer that text now holds.
   */
  function reportDraft() {
    if (chatKey !== null) {
      vscode.postMessage({ type: 'draft', chat: chatKey, text: input.value, returned });
      returned = [];
    }
  }

  /**
   * Sends a message. Returns false when it cannot be sent right now. A message
   * typed into the composer empties it, and the send says so.
   */
  function submit(text, token, fromComposer) {
    const trimmed = text.trim();
    if (current !== null || chatKey === null || trimmed === '') {
      return false;
    }
    welcome.hidden = true;
    const user = add('user', trimmed);
    current = { id: nextId, text: trimmed, user, reply: add('assistant', ''), token };
    nextId += 1;
    updateControls();
    const draft = fromComposer ? '' : input.value;
    vscode.postMessage({
      type: 'send',
      id: current.id,
      chat: chatKey,
      text: trimmed,
      draft,
      token,
    });
    return true;
  }

  function finish(note, kind) {
    const { id, reply } = current;
    const shown = reply.textContent;
    if (shown === '') {
      reply.remove();
    }
    current = null;
    if (note !== undefined) {
      add(kind, note);
    }
    updateControls();
    input.focus();
    // Tells the extension what this page displayed for the request.
    vscode.postMessage({ type: 'shown', id, text: kind === 'error' ? note : shown });
  }

  /**
   * Takes the request that is being answered off the page and puts its text
   * back into the composer, before what the composer already holds.
   */
  function withdraw() {
    const { id, text, user, reply } = current;
    current = null;
    returned.push(id);
    user.remove();
    reply.remove();
    input.value = input.value === '' ? text : `${text}\n${input.value}`;
  }

  /**
   * The extension switches only once its last reply has ended, so a request
   * still waiting here was sent after the switch began and will be refused.
   * Its message is taken back into the composer, so nothing typed is lost.
   */
  function withdrawPending() {
    if (current === null) {
      return;
    }
    const { token } = current;
    withdraw();
    if (token !== undefined) {
      vscode.postMessage({ type: 'rejected', token });
    }
  }

  function draw(entries) {
    for (const element of Array.from(messages.children)) {
      if (element !== welcome) {
        element.remove();
      }
    }
    for (const entry of entries) {
      if (entry.kind === 'user') {
        add('user', entry.text);
      } else if (entry.kind === 'reply') {
        if (entry.text !== '') {
          add('assistant', entry.text);
        }
        const note = NOTE_BY_STOP_REASON[entry.stopReason];
        if (note !== undefined) {
          add('note', note);
        }
      } else if (entry.kind === 'error') {
        add('error', entry.text);
      }
    }
    welcome.hidden = entries.length > 0;
    messages.scrollTop = messages.scrollHeight;
  }

  function show(message) {
    withdrawPending();
    // The final unsent text of the chat this page leaves.
    const left = chatKey === null ? null : { key: chatKey, draft: input.value, returned };
    returned = [];
    vscode.postMessage({ type: 'switched', seq: message.seq, left });
    chatKey = message.key;
    draw(message.entries);
    if (!message.carry) {
      input.value = message.draft;
    }
    updateControls();
    input.focus();
  }

  // The chat list takes the place of the chat until a chat is picked or the
  // list is closed. Typing in the search box filters it. The arrow keys move
  // the highlight, Enter opens the highlighted chat, and Escape goes back.
  /** All rows of the list, and the rows that match the search. */
  let historyItems = [];
  let matching = [];
  let highlighted = -1;

  function highlight(index) {
    highlighted = index;
    Array.from(historyList.children).forEach((row, position) => {
      row.className = position === index ? 'history-item highlighted' : 'history-item';
      row.setAttribute('aria-selected', position === index ? 'true' : 'false');
      if (position === index && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
    if (index >= 0) {
      historySearch.setAttribute('aria-activedescendant', `history-item-${matching[index].key}`);
    } else {
      historySearch.removeAttribute('aria-activedescendant');
    }
  }

  function drawHistory() {
    const query = historySearch.value.trim().toLowerCase();
    matching = historyItems.filter((item) => item.title.toLowerCase().includes(query));
    for (const row of Array.from(historyList.children)) {
      row.remove();
    }
    for (const item of matching) {
      const row = document.createElement('li');
      row.id = `history-item-${item.key}`;
      row.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = item.title;
      const description = document.createElement('span');
      description.className = 'history-description';
      description.textContent = item.description;
      row.append(title);
      row.append(description);
      row.addEventListener('click', () => {
        pick(item.key);
      });
      historyList.append(row);
    }
    historyEmpty.textContent = historyItems.length === 0 ? 'No chats yet.' : 'No chats match.';
    historyEmpty.hidden = matching.length > 0;
    highlight(matching.length > 0 ? 0 : -1);
  }

  function openHistory(items) {
    historyItems = items;
    historySearch.value = '';
    chatView.hidden = true;
    historyView.hidden = false;
    drawHistory();
    historySearch.focus();
  }

  function closeHistory() {
    if (historyView.hidden) {
      return;
    }
    historyView.hidden = true;
    chatView.hidden = false;
    input.focus();
  }

  function pick(key) {
    closeHistory();
    vscode.postMessage({ type: 'open', key });
  }

  historyBack.addEventListener('click', closeHistory);
  historySearch.addEventListener('input', drawHistory);
  historySearch.addEventListener('keydown', (event) => {
    const count = matching.length;
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      highlight((highlighted + 1) % count);
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      highlight((highlighted - 1 + count) % count);
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault();
      pick(matching[highlighted].key);
    }
  });
  historyView.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHistory();
    }
  });

  sendButton.addEventListener('click', () => {
    if (submit(input.value, undefined, true)) {
      input.value = '';
      updateControls();
    }
  });
  stopButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  input.addEventListener('input', () => {
    updateControls();
    reportDraft();
  });
  input.addEventListener('keydown', (event) => {
    // Enter sends. Shift and Enter starts a new line.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendButton.click();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'submit') {
      if (!submit(message.text, message.token)) {
        vscode.postMessage({ type: 'rejected', token: message.token });
      }
      return;
    }
    if (message.type === 'show') {
      // A switch always ends on the chat itself.
      closeHistory();
      show(message);
      return;
    }
    if (message.type === 'history') {
      openHistory(message.items);
      return;
    }
    if (message.type === 'focus') {
      input.focus();
      return;
    }
    if (current === null || message.id !== current.id) {
      return;
    }
    if (message.type === 'text') {
      current.reply.textContent += message.text;
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'end') {
      finish(NOTE_BY_STOP_REASON[message.stopReason], 'note');
    } else if (message.type === 'error' && message.withdraw === true) {
      // The message was not sent. It goes back into the composer, and the reason is shown.
      const { id } = current;
      withdraw();
      add('error', message.message);
      updateControls();
      reportDraft();
      input.focus();
      vscode.postMessage({ type: 'shown', id, text: message.message });
    } else if (message.type === 'error') {
      finish(message.message, 'error');
    }
  });

  updateControls();
  vscode.postMessage({ type: 'ready' });
})();
