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

  /** Tells the extension the unsent text of the chat shown. */
  function reportDraft() {
    if (chatKey !== null) {
      vscode.postMessage({ type: 'draft', chat: chatKey, text: input.value });
    }
  }

  /** Sends a message. Returns false when it cannot be sent right now. */
  function submit(text, token) {
    const trimmed = text.trim();
    if (current !== null || chatKey === null || trimmed === '') {
      return false;
    }
    welcome.hidden = true;
    const user = add('user', trimmed);
    current = { id: nextId, text: trimmed, user, reply: add('assistant', ''), token };
    nextId += 1;
    updateControls();
    vscode.postMessage({ type: 'send', id: current.id, chat: chatKey, text: trimmed, token });
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
    const { text, user, reply } = current;
    current = null;
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
    const left = chatKey === null ? null : { key: chatKey, draft: input.value };
    vscode.postMessage({ type: 'switched', seq: message.seq, left });
    chatKey = message.key;
    draw(message.entries);
    if (!message.carry) {
      input.value = message.draft;
    }
    updateControls();
    input.focus();
  }

  sendButton.addEventListener('click', () => {
    if (submit(input.value)) {
      input.value = '';
      updateControls();
      reportDraft();
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
      show(message);
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
