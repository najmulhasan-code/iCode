// Script of the chat panel. It runs inside the webview, which has no access to
// files or to the VS Code API. It talks to the extension through messages only.
//
// Everything a model writes is put on the page with textContent, so it is
// always shown as plain text and never interpreted as markup.
//
// Each message the user sends gets a number. Every answer from the extension
// names that number, and an answer for any other number is ignored.
//
// A conversation put aside by "New Chat" keeps its elements and the unsent
// text of the composer here, under a key the extension chose, so that it can
// be shown again exactly as it was.
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
  /** The request that is being answered: its number and the element its reply goes into. */
  let current = null;
  /** Conversations put aside, by key: their elements and the composer text. */
  const aside = new Map();

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
    sendButton.disabled = busy || input.value.trim() === '';
  }

  /** Sends a message. Returns false when it cannot be sent right now. */
  function submit(text, token) {
    const trimmed = text.trim();
    if (current !== null || trimmed === '') {
      return false;
    }
    welcome.hidden = true;
    add('user', trimmed);
    current = { id: nextId, reply: add('assistant', '') };
    nextId += 1;
    updateControls();
    vscode.postMessage({ type: 'send', id: current.id, text: trimmed, token });
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

  /** Takes the shown conversation off the page and returns it. */
  function takeShown() {
    const elements = Array.from(messages.children).filter((element) => element !== welcome);
    for (const element of elements) {
      element.remove();
    }
    const shown = { elements, draft: input.value };
    input.value = '';
    return shown;
  }

  function show(conversation) {
    for (const element of conversation.elements) {
      messages.append(element);
    }
    welcome.hidden = conversation.elements.length > 0;
    if (conversation.draft !== '') {
      input.value = conversation.draft;
    }
    messages.scrollTop = messages.scrollHeight;
  }

  // The extension switches conversations only once no reply is being written.
  function newChat(stashKey) {
    aside.set(stashKey, takeShown());
    welcome.hidden = false;
    updateControls();
    input.focus();
  }

  function openChat(key, stashKey) {
    const conversation = aside.get(key);
    aside.delete(key);
    const shown = takeShown();
    if (stashKey !== undefined) {
      aside.set(stashKey, shown);
    } else {
      // An empty conversation is dropped, but text typed into it stays.
      input.value = shown.draft;
    }
    show(conversation ?? { elements: [], draft: '' });
    updateControls();
    input.focus();
  }

  sendButton.addEventListener('click', () => {
    if (submit(input.value)) {
      input.value = '';
      updateControls();
    }
  });
  stopButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  input.addEventListener('input', updateControls);
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
    if (message.type === 'newChat') {
      newChat(message.stashKey);
      return;
    }
    if (message.type === 'openChat') {
      openChat(message.key, message.stashKey);
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
    } else if (message.type === 'error') {
      finish(message.message, 'error');
    }
  });

  updateControls();
  vscode.postMessage({ type: 'ready' });
})();
